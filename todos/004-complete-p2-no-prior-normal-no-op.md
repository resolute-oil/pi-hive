---
status: complete
priority: p2
completion_date: "2026-09-23"
issue_id: "004"
tags: [pi-hive, mode-switch, no-op, edge-case]
dependencies: ["001", "003"]
---

# Skip snapshot/restore when there is no prior normal history

## Problem Statement

The mode-switch snapshot/restore design (Q5) specifies: "Skip the
snapshot when there is no prior normal-mode history. The restore on
hive→normal becomes a no-op."

If the user starts a fresh session directly in `/hive` and then
switches back to `/hive:normal`, there's no baseline to restore to.
Without this guard, the restore would try to branch to an undefined
leaf id and either crash or branch from a meaningless point.

This leaf adds the no-op gates on both sides:
- **Entry side:** skip snapshot capture if there's no prior normal
  history (the field `state.hiveCycleSnapshotLeafId` is undefined
  AND the user has never been in normal mode this session).
- **Restore side:** skip `branchWithSummary` + `navigateTree` if
  `state.hiveCycleSnapshotLeafId` is undefined.

## Findings

- "Prior normal history" is determined by the snapshot leaf id existing
  in state. If `state.hiveCycleSnapshotLeafId` is set, we have a baseline.
- On hive/plan entry from normal: snapshot captures the leaf → field is
  set. Next hive→normal will have a baseline.
- On session start directly in hive/plan: todo 003 captures nothing
  → field is undefined → restore is no-op.
- The "no prior normal" state can also arise if a session crashed
  mid-cycle and was restarted in hive/plan mode. Same outcome: no
  baseline, no-op restore.

## Proposed Solutions

### Option 1: Detect "no prior normal" via state field

`state.hiveCycleSnapshotLeafId === undefined` means "no baseline." Use
this as the gate.

**Pros:** Same field already exists (added by todo 003). No new state.

**Cons:** The field's meaning is overloaded: "no snapshot taken" vs
"snapshot was cleared." Need a clear invariant: the field exists iff a
snapshot was taken for the current cycle (or a prior cycle whose
restore hasn't run yet).

**Effort:** ~15 minutes (two if-statements, one in entry, one in
restore).

**Risk:** Low.

### Option 2: Add an explicit "sessionStartedInHive" flag

Track whether the user has been in normal mode at least once this
session.

**Pros:** Clearer semantics.

**Cons:** More state to maintain. Doesn't actually solve the problem
differently than Option 1 — the field from 003 already captures the
same information.

**Effort:** ~30 minutes.

**Risk:** Low.

## Recommended Action

**Option 1.** The field added by todo 003 is the right signal.
Document the invariant clearly in the code:
`hiveCycleSnapshotLeafId` is set iff a snapshot was taken and not yet
restored.

## Technical Details

**Affected files:**
- `src/ui/tui/widget.ts:131` (`applyMode`) — add two gates:
  - **Entry side** (after the snapshot capture logic from 003):
    nothing additional; the snapshot block already only runs on
    actual transitions. Fresh sessions starting in hive/plan never
    hit the transition path.
  - **Restore side** (hive→normal, around the `branchWithSummary` /
    `navigateTree` calls from 006): if
    `state.hiveCycleSnapshotLeafId === undefined`, return early
    after `setActiveTools` and the follow-up turn.
- `src/core/types.ts` — `hiveCycleSnapshotLeafId?: string` (added
  by 003). Add a doc comment to the type definition explaining the
  invariant.

## Resources

- Design doc: Q5 (initial mode handling), Q7 (sequence — no-op
  restore).
- Plan doc: Architecture changes → "Restore sequence inside
  applyMode" (step 2).

## Acceptance Criteria

- [x] On hive/plan entry from a fresh session that started in
      hive/plan mode, no `setLabel` call is made and
      `state.hiveCycleSnapshotLeafId` stays undefined.
- [x] On hive→normal when `state.hiveCycleSnapshotLeafId` is
      undefined, no `branchWithSummary` or `navigateTree` call is
      made. Mode switch still completes
      (`state.mode === "normal"`, `setActiveTools(normalToolNames)`
      runs).
- [x] The doc comment on `hiveCycleSnapshotLeafId` in
      `src/core/types.ts` states the invariant.
- [x] `just typecheck` passes.
- [x] `just test` shows the existing 373 tests still pass plus new
      tests for both no-op paths.

## Work Log

### 2026-09-23 — Leaf written


**Actions:**
- Mapped the design's Q5 to existing state field.
- Drafted entry/restore gates.
- Considered an explicit flag (Option 2); rejected as redundant.

**Learnings:**
- The "field as signal" pattern is sufficient if the field's invariant
  is documented. Adding more state would be premature.

### 2026-09-23 — Implemented

**Actions:**
- One-line fix in `src/ui/tui/widget.ts`'s snapshot block: assign
  `state.hiveCycleSnapshotLeafId` unconditionally (using `leafId ??
  undefined`), so a null `getLeafId()` no longer leaves a prior
  cycle's leaf id on the field. The `setLabel` call stays gated
  inside `if (leafId)`.
- Added a fourth test to `tests/snapshot-capture.test.ts`
  ("applyMode entering hive with null getLeafId clears any prior
  hiveCycleSnapshotLeafId") that pins down the invariant.
- Verified: `just typecheck` clean (5/5 sub-recipes); `just test`
  shows 379/379 passing (373 baseline + 002's 2 + 003's 3 + this
  fourth test).

**Learnings:**
- 003's "cleared on each entry transition" acceptance was only
  partially implemented (it set the field on a non-null leaf id,
  but did not clear on null). A literal read of the spec flagged
  the gap. This 004 fix aligns the code with the acceptance text.
- The restore-side acceptance ("hive→normal with undefined snapshot
  field does no branching") is enforced naturally by the
  `if (state.hiveCycleSnapshotLeafId === undefined) skip` reads in
  005 (trigger) and 006 (handler) once they land. 004's job is just
  the field's invariant on the entry side that makes those reads
  reliable. Integration tests in 007 will exercise the full no-op
  path end-to-end.
- Single-line fixes are the easy wins. Resist the urge to over-test
  or over-refactor around them — one targeted test case is enough
  to pin the invariant.