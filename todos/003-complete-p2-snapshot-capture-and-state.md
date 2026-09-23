---
status: complete
priority: p2
completion_date: "2026-09-23"
issue_id: "003"
tags: [pi-hive, mode-switch, snapshot, session-manager]
dependencies: ["001"]
---

# Capture snapshot leaf id on hive/plan entry using `pi.setLabel`

## Problem Statement

The mode-switch snapshot/restore design (Q2, Q7) requires capturing
the session-tree leaf id at the moment of entry into hive/plan. The
captured leaf is the branch point the conversation returns to on
hive→normal.

This leaf wires the snapshot capture into `applyMode` on the
hive/plan entry side. The restore side is a separate leaf (006).

## Findings

- Entry happens in `applyMode` when `mode !== "normal"` and the mode
  is actually changing (not a re-entry mid-cycle).
- **Use `pi.setLabel(entryId, label)`** — public method on
  `ExtensionAPI` (`dist/core/extensions/types.d.ts:1077`). No cast
  needed.
- Do NOT use `ctx.sessionManager.setLabel(...)` — `SessionManager`
  has no method by that name; the write method is
  `appendLabelChange(targetId, label)` and requires a cast.
- `state.hiveCycleSnapshotLeafId` is the new field to persist the
  captured leaf id across the hive-mode cycle. Cleared on each
  hive/plan entry transition so a fresh snapshot is taken each cycle.
- Mid-cycle re-entry (`state.mode` already hive/plan when `applyMode`
  is called again) should NOT re-snapshot — the snapshot is for the
  cycle boundary, not the entry call.

## Proposed Solutions

### Option 1: Capture only on actual transitions

Snapshot when `canonicalMode(previous) !== mode` AND `mode !== "normal"`.
The mid-cycle re-entry case (e.g., re-registering after a sub-mode
switch) skips the snapshot.

**Pros:** Matches the design's "snapshot on every transition into
hive/plan" semantics literally.

**Cons:** Requires the `canonicalMode` comparison logic that already
exists in `applyMode`.

**Effort:** ~30 minutes.

**Risk:** Low.

### Option 2: Capture unconditionally on any hive/plan applyMode call

Always snapshot, even mid-cycle.

**Pros:** Simpler logic.

**Cons:** Overwrites labels and snapshot leaf ids every call, which
is wasteful and breaks the "one cycle per trip" semantics.

**Effort:** ~15 minutes.

**Risk:** Low for the leaf itself; medium for the design's
correctness (breaks per-cycle boundaries).

## Recommended Action

**Option 1.** Match the design's "one cycle per trip" semantics. Add
the snapshot capture inside `applyMode`'s hive/plan branch, gated on
the actual-mode-change condition that already exists.

## Technical Details

**Affected files:**
- `src/ui/tui/widget.ts:131` — inside `applyMode`, after the drain
  guard and before `activateTeamRuntimes`, add the snapshot capture
  (gated on `mode !== "normal" && canonicalMode(previous) !== mode`).
- `src/core/types.ts` — add `hiveCycleSnapshotLeafId?: string` to
  `HiveState`. Clear it on hive/plan entry so a fresh snapshot is
  taken each transition.
- Possibly `src/integration/commands.ts` — verify nothing depends on
  `state` shape externally.

**Pseudocode:**
```ts
if (mode !== "normal" && canonicalMode(previous) !== mode) {
  const leafId = ctx.sessionManager.getLeafId();
  if (leafId) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    pi.setLabel(leafId, `hive-cycle-${stamp}`);
    state.hiveCycleSnapshotLeafId = leafId;
  }
}
```

Note: `getLeafId()` returns `string | null`. Handle null gracefully
(skip the snapshot — there's no leaf to snapshot).

**Label format:** `hive-cycle-<ISO-timestamp-without-colons>` — keeps
labels filesystem-safe and grep-friendly.

**Mid-cycle re-entry:** the `canonicalMode(previous) !== mode` check
already prevents this. If a future change reorders these checks, the
test must lock it in.

## Resources

- Design doc: Q2 (timing), Q7 (sequence), "Terms" (snapshot
  definition).
- Plan doc: Architecture changes → "Restore sequence inside
  applyMode" (entry side).
- Verified SDK API: `pi.setLabel` is on `ExtensionAPI`, no cast
  required.

## Acceptance Criteria

- [x] On `applyMode(state, ctx, mode)` where `mode !== "normal"` and
      mode is actually changing, the current leaf id is captured via
      `ctx.sessionManager.getLeafId()`.
- [x] The captured leaf is labeled via
      `pi.setLabel(leafId, "hive-cycle-<stamp>")` where `<stamp>` is
      an ISO timestamp with `:` and `.` replaced.
- [x] `state.hiveCycleSnapshotLeafId` is set to the captured leaf id.
- [x] If `getLeafId()` returns null, the snapshot is skipped (no
      label written, no state field set).
- [x] Mid-cycle re-entry (mode is already hive/plan) does NOT
      re-snapshot or overwrite the label.
- [x] `state.hiveCycleSnapshotLeafId` is cleared on each entry
      transition (so the field's "exists" reliably means "a snapshot
      was taken for this cycle").
- [x] `just typecheck` passes.
- [x] `just test` shows the existing 373 tests still pass plus new
      snapshot-capture tests pass.

## Work Log

### 2026-09-23 — Leaf written (revised from original sketch)


**Actions:**
- Corrected the original sketch's `ctx.sessionManager.setLabel(...)`
  — that's not a method on `SessionManager`. The write method is
  `appendLabelChange` and requires a cast. Better: use
  `pi.setLabel` which is public on `ExtensionAPI` with no cast.
- Documented null-handling for `getLeafId()`.
- Re-confirmed Option 1 (transition-gated) over Option 2 (always).

**Learnings:**
- The public `pi.setLabel` is the cleanest label-writing path.
  Reserve the cast `ctx.sessionManager as SessionManager` for
  `branchWithSummary` / `branch` where no public alternative exists.

### 2026-09-23 — Implemented

**Actions:**
- Added `hiveCycleSnapshotLeafId?: string` to `HiveState` in
  `src/core/types.ts`, next to `pendingHiveCycleRestore` from todo 002.
- In `src/ui/tui/widget.ts`'s `applyMode`: between the drain guard and
  `state.mode = mode`, added a snapshot block gated on
  `mode !== "normal" && changesMode`. Captures
  `ctx.sessionManager.getLeafId()`; if non-null, calls
  `state.pi.setLabel(leafId, "hive-cycle-<ISO-stamp>")` with `:` and
  `.` replaced for filesystem-safety, and stores the leaf id on
  `state.hiveCycleSnapshotLeafId`.
- Mid-cycle re-entry is naturally gated by `changesMode` being false
  when mode is unchanged; no extra check needed.
- Used `ctx.sessionManager?.getLeafId?.()` (defensive optional chain)
  so test fixtures with stripped `sessionManager` objects don't crash.
- Added `getLeafId: () => null` to `tests/session-lifecycle.integration.test.ts`'s
  ctx mock so its existing `applyMode(state, ctx, "hive", { notify: false })`
  call exercises the new path explicitly.
- Added `tests/snapshot-capture.test.ts` with three cases: entering
  hive-from-normal captures leaf+label; mid-cycle re-entry leaves
  snapshot untouched; null `getLeafId` skips silently.
- Verified: `just typecheck` clean (5/5 sub-recipes); `just test`
  shows 378/378 passing (373 baseline + 2 (todo 002) + 3 (todo 003)).

**Learnings:**
- The defensive optional chain on `ctx.sessionManager?.getLeafId?.()`
  is necessary because `applyMode`'s existing tests exercise both
  stripped and full ctx shapes. Production ctx always has a full
  `ExtensionContext`; only test mocks vary.
- The mid-cycle re-entry guard `mode !== "normal" && changesMode` is
  enough — no extra "is hive already?" check needed. `changesMode`
  is the only signal that matters.
- Capturing the leaf BEFORE `state.mode = mode` is more honest
  semantically (the snapshot is what the user was at), though
  timing-wise identical: `getLeafId` only changes when an entry is
  appended, which doesn't happen during `applyMode`.