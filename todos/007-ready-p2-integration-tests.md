---
status: ready
priority: p2
issue_id: "007"
tags: [pi-hive, mode-switch, testing, integration]
dependencies: ["001", "002", "003", "004", "005", "006"]
---

# Integration tests for the event-driven snapshot/restore flow

## Problem Statement

The mode-switch snapshot/restore design (Q9) requires integration
tests that exercise the end-to-end flow using Pi's
`SessionManager.inMemory()` (no disk). The tests must cover:

- Snapshot on first hive entry.
- Tool stashes summary in pending state.
- Restore on subsequent return (via `agent_settled` handler).
- No-op restore when no baseline.
- Retry-then-fall-back on `sm` / `navigateTree` failure.

Per the verified pi-context pattern, the branching happens in an
event handler, NOT in `applyMode`. The tests must reflect this:
they exercise `applyMode` (snapshot + trigger) AND the
`agent_settled` handler (branching + retry) separately and
end-to-end.

This leaf adds the test file. Tests are added after the
implementation leaves (deps include 001–006).

## Findings

- `SessionManager.inMemory()` is available in Pi's SDK per design
  doc verification.
- Existing test patterns:
  - `tests/activity-panel.test.ts` — builds a `HiveState` for unit
    testing; good model for the integration tests.
  - `tests/policy.test.ts` — uses `realpathSync` to canonicalize
    macOS tmpdir paths (from PR #17/19).
- Test loader: `node --import tsx --import
  ./tests/register-ts-loader.mjs --test tests/<file>.test.ts`.
- The existing 373-test baseline (per HANDOFF.md) must still pass;
  this leaf adds new tests rather than modifying existing ones.
- The new flow is event-driven: tests need to manually invoke the
  `agent_settled` handler after setting up state, since there's no
  real agent loop in tests.

## Proposed Solutions

### Option 1: Single new test file `tests/mode-switch-restore.test.ts`

All ~6-8 cases in one file, grouped by:
1. Snapshot side (1-2 cases).
2. Tool side (1 case).
3. Trigger side (1 case).
4. Restore side (1-2 cases).
5. No-op (1 case).
6. Retry + best-effort (2 cases).

**Pros:** Single file = single test command, single failure surface.
Easy to find.

**Cons:** Bigger file than usual.

**Effort:** ~60 minutes.

**Risk:** Low.

### Option 2: Multiple test files split by case

One file per case group. Matches the repo's existing pattern of
small, focused test files.

**Pros:** Smaller files.

**Cons:** More test runs; more setup duplication (build `HiveState`,
mock `pi`, capture CommandCtx, etc.).

**Effort:** ~75 minutes (setup duplication).

**Risk:** Low.

## Recommended Action

**Option 1.** Single file. The cases are tightly coupled (all
exercise the snapshot/restore flow at different points); splitting
them across files adds setup cost without analytical benefit.

## Technical Details

**Affected files:**
- `tests/mode-switch-restore.test.ts` (new) — integration tests.

**Test fixture:** a `HiveState` built minimally (mode, snapshot
leaf id, pending state), a `SessionManager.inMemory()`, a mocked
`pi` (with `setActiveTools`, `sendUserMessage`, `setLabel`,
`sendMessage`, `on`, `registerTool`, etc. as no-ops or spies), and
a captured `commandCtx` mock that exposes `waitForIdle`,
`navigateTree`, `sessionManager`, `ui`.

**Case sketches:**

- **Case 1 — Snapshot on first hive entry.**
  - Setup: `state.mode === "normal"`,
    `state.hiveCycleSnapshotLeafId === undefined`.
  - Action: `applyMode(state, ctx, "hive")`.
  - Assert: `pi.setLabel` was called with the current leaf id and a
    label matching `hive-cycle-<ISO>`.
  - Assert: `state.hiveCycleSnapshotLeafId` is set to the current
    leaf.

- **Case 2 — Tool stashes summary.**
  - Setup: `state.pendingHiveCycleRestore = { snapshotLeafId: "abc" }`.
  - Action: call `hive_cycle_summary.execute` with
    `{ summary: "did X, Z" }`.
  - Assert: `state.pendingHiveCycleRestore.summary === "did X, Z"`.
  - Action (negative): call with no pending state.
  - Assert: result has `isError: true`; state not mutated.

- **Case 3 — Trigger fires on hive→normal.**
  - Setup: `state.hiveCycleSnapshotLeafId = "abc"`.
  - Action: `applyMode(state, ctx, "normal")`.
  - Assert: `state.pi.sendUserMessage` was called once with the
    documented trigger text and `{ deliverAs: "followUp" }`.
  - Assert: `state.pendingHiveCycleRestore.snapshotLeafId === "abc"`.
  - Assert: `state.pendingHiveCycleRestore.summary` is undefined
    (tool hasn't fired).

- **Case 4 — Restore via `agent_settled` handler.**
  - Setup: `state.pendingHiveCycleRestore = { snapshotLeafId: "abc", summary: "did X" }`.
  - Action: invoke the `agent_settled` handler.
  - Assert: `commandCtx.sessionManager.branchWithSummary` called
    with `("abc", "did X")`.
  - Assert: `commandCtx.sessionManager.branch("abc")` called
    (after branchWithSummary).
  - Assert: `commandCtx.navigateTree(nid, { summarize: false })`
    called.
  - Assert: `state.pendingHiveCycleRestore === undefined` after
    handler runs.
  - Assert: `pi.sendMessage` (custom-type) called with the
    post-restore notification.

- **Case 5 — No-op restore when no baseline.**
  - Setup: `state.hiveCycleSnapshotLeafId === undefined`.
  - Action: `applyMode(state, ctx, "normal")`.
  - Assert: `sendUserMessage` was NOT called.
  - Assert: `state.pendingHiveCycleRestore` is undefined.

- **Case 6 — No-op `agent_settled` when no pending state.**
  - Setup: `state.pendingHiveCycleRestore === undefined`.
  - Action: invoke the `agent_settled` handler.
  - Assert: `branchWithSummary` was NOT called.
  - Assert: `navigateTree` was NOT called.

- **Case 7 — Retry with empty summary on first failure.**
  - Setup: `state.pendingHiveCycleRestore = { snapshotLeafId: "abc", summary: "did X" }`.
  - Mocks: `branchWithSummary` throws on first call (with summary),
    succeeds on second call (with empty).
  - Action: invoke the `agent_settled` handler.
  - Assert: `branchWithSummary` was called twice — first with
    `"did X"`, second with `""`.
  - Assert: `navigateTree` was called once with the nid from the
    second `branchWithSummary`.

- **Case 8 — Best-effort fallback on second failure.**
  - Setup: same as Case 7.
  - Mocks: `branchWithSummary` always throws.
  - Action: invoke the `agent_settled` handler.
  - Assert: `branchWithSummary` was called twice.
  - Assert: `commandCtx.ui.notify` (or console.warn) was issued
    with a warning.
  - Assert: handler did NOT throw.

## Resources

- Design doc: Q9 (test strategy).
- Plan doc: Top-level acceptance criteria.
- HANDOFF.md: workflow commands for running tests.
- Existing test patterns:
  `tests/activity-panel.test.ts`,
  `tests/policy.test.ts`.

## Acceptance Criteria

- [ ] `tests/mode-switch-restore.test.ts` exists.
- [ ] At least 6 of the 8 case sketches above are implemented (6
      minimum per Q9; 8 is the natural full coverage).
- [ ] All new tests pass alongside the existing 373 (`just test`
      shows 373 + N, all green).
- [ ] `just verify` passes (typecheck + lint + tests).
- [ ] `SessionManager.inMemory()` is used (no disk writes).
- [ ] No mocking of `sm` methods themselves (the design's Q9
      rejection of Option A — mocks would miss integration bugs).
      The mocks should be at the pi-API level
      (`pi.sendUserMessage`, `pi.setLabel`, `pi.sendMessage`) and at
      the `commandCtx.navigateTree` level.
- [ ] macOS tmpdir path canonicalization (`realpathSync`) is applied
      wherever `mkdtempSync` is used (PR #17/19 pattern).
- [ ] The `agent_settled` handler is invoked manually in tests
      (since there's no real agent loop in test mode).

## Work Log

### 2026-09-23 — Leaf written (revised from previous "test applyMode branching" sketch)

**By:** Claude Code (planning session)

**Actions:**
- Mapped Q9's "5-10 cases" to 8 specific case sketches covering the
  new event-driven flow.
- Recommended single file (Option 1) over split files.
- Pinned test loader command and macOS canonicalization pattern.
- Documented that tests manually invoke the `agent_settled`
  handler — there's no real agent loop in test mode.

**Learnings:**
- The "no mock of `sm` methods" rule still applies. But the
  branching is now in an event handler that calls `commandCtx`
  methods — those CAN be mocked (we're testing our usage, not the
  SDK).
- macOS tmpdir canonicalization is now a per-repo convention;
  future tests inherit it.