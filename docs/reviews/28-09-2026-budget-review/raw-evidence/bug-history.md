# Bug history

Chronological log of every budget-related bug the project has hit, with fix references. This is the institutional memory the redesign needs to preserve.

## 2025-09-26 — PR #53 lands (`refactor/worker-budgets-rename`)

**Commit:** `1b13bcc` (merged at `2d721a9`).

**Change:** Rename `Settings.worker` → `Settings.workerBudgets` (TS + YAML). YAML key `tokenBudgetScope` → `token-budget-scope` (kebab-case; TS field stays camelCase because the YAML parser auto-camelizes).

**Tests:** 467/467 server, 49/49 dashboard. Unchanged.

**Bug class:** none — pure refactor.

## 2025-09-27 — Bug 1 discovered (fresh=true doesn't reset budget)

**First symptom:** Orchestrator delegates with `fresh=true` after a worker has exhausted its budget. The dispatch is blocked with "Delegation blocked: ... token budget exhausted" even though `fresh=true` was passed.

**Investigation:**

1. `freshResetRuntime` was at line ~318 in `dispatch.ts`.
2. `checkDispatchBudgets` was at line ~252.
3. The budget check fired before the reset ever ran.

**Fix:** Move `freshResetRuntime` to right after `reloadAgentConfig`, at line ~214.

**Commits:**

- `081380a` — initial move (early).
- `3be33f6` — refined with defensive cleanups (always reset, archive is best-effort, clear `effectiveTokens`).

**Regression test:** `tests/dispatch-usage.test.ts:385-430`. Pins the ordering: `worker.governanceTokens = 1000` → `dispatchAgent(..., fresh=true)` → assert exitCode=0, assert post-run `governanceTokens = 265` (fresh session's usage only).

## 2025-09-27 — Bug 2 discovered (worker overruns budget by 26x)

**First symptom:** Engineering Lead uses 91,260 tokens against the 3,500 cap. The mid-run warning and abort never fired.

**Investigation:**

1. The mid-run `message_end` handler (around line 660) called `budgetRemaining(state, runtime)`, which used `workerConsumedTokens(runtime, scope)`.
2. That function's pre-fix `??` chain preferred `governanceTokens ?? effectiveTokens ?? runtimeTokens(...)`.
3. `governanceTokens` was only written at `agent_end` (line ~818). Mid-run, it was 0.
4. The mid-run check always saw 0 used, never warned, never aborted.

**Fix:** Make `workerConsumedTokens` return live values (`runtimeTokens(runtime, scope)`) when `runtime.status === "running"`. Frozen `governanceTokens` is used post-run.

**Commit:** `3be33f6` (same commit as Bug 1 refined fix).

**Comment in `src/engine/governance.ts:34-58`:** "Mid-run: return the LIVE cumulative consumption from runtime.* tokens ... This is symmetric with workerConsumedCost."

## 2025-09-27 — kieran-typescript-reviewer round 1

**Commits reviewed:** `dd0a353` (fresh-reset fix) + `8843834` (review cleanup).

**Findings applied:** 3 should-fix items in `8843834`:

1. Use `agentSlug(runtime.config)` (not `agentName` param) for `state.runtimes.delete` and `set` in `respawnWorkerSession`.
2. Change test `state()` helper to key by `agentSlug(entry.config)` not `entry.config.name`.
3. Hoist `mockLoadRuntime` from 3 inline declarations to a single helper.

## 2025-09-28 — Bug 3 / third mystery discovered

**First symptom:** User re-tests with fresh=true after Bug 1 + Bug 2 fixes are deployed. The bug persists:

```
- engineering-lead: error, runs=2 (incremented from 1), tokens=0, remaining.tokens=0, "tokens=15134 used"
- orchestrator (me): remaining.tokens=3500 (unchanged, full budget)
```

**Top hypothesis (per `2025-09-28-fresh-true-budget-bug-unresolved.md`):**

> "the end-of-run `governanceTokens` accumulation at line ~868 reads `runtime.*` BEFORE the `getSessionStats` overwrite (or uses a cached delta). If `runtime.*=15134` at that point, `delta=15134`, `governanceTokens = 0 + 15134 = 15134`. Then the getSessionStats overwrite happens, setting `runtime.*=0`. Result: `governanceTokens=15134`, `runtime.*=0` — exactly the symptom."

**Alternative hypotheses:**

1. Server isn't actually on `9f950fb` (stale process). Fix: verify with `/hive:version`.
2. A different code path bypasses the fix. Fix: check orchestrator's `conversation.jsonl` for the literal `delegate_agent(..., fresh: true)` call.

**Status as of session end:** UNRESOLVED. The next session was supposed to:
1. Verify server SHA via `/hive:version`.
2. Read `src/engine/dispatch.ts:765-870` to confirm end-of-run order.
3. Apply a fix (options: move stats overwrite before delta, or skip accumulation if aborted).
4. Re-test.
5. Add a regression test for the abort-then-`getSessionStats()` race.

## 2025-09-28 — kieran-typescript-reviewer round 2

**Commits reviewed:** `3be33f6` (the two-bug-fix commit).

**Findings applied:** 2 should-fix items in `9f950fb`:

1. Reconcile the `message_end` `effectiveTokens` refresh comment — `effectiveTokens = 0` (a number) made the refresh dead for fresh=true runs; explained in comment that compaction_end is the path that keeps it right.
2. Add a regression test for the `fresh=true → freshResetRuntime → checkDispatchBudgets` ordering in `tests/dispatch-usage.test.ts` (sets `tokenBudget=1000` and primes `governanceTokens=1000`, asserts dispatch succeeds with no "token budget exhausted" in output).

## Bug timeline summary

```
2025-09-26  PR #53 lands — rename (no behavior change)
2025-09-27  Bug 1: fresh=true doesn't reset budget (commit 081380a → 3be33f6)
2025-09-27  Bug 2: mid-run budget check sees stale governanceTokens (commit 3be33f6)
2025-09-27  Reviewer round 1 (commit 8843834)
2025-09-28  Bug 3 / third mystery (UNRESOLVED)
2025-09-28  Reviewer round 2 (commit 9f950fb)
2025-09-28  Session ends — bug 3 still open
2025-09-28  PR #54 open at 9f950fb, awaiting user merge
```

## Lessons learned

### Lesson 1 — The dual-counter system is the bug class

Every bug in this timeline is a consequence of having two (now three) counters for the same concept: "how much has this worker consumed". The `??` fallthroughs in `workerConsumedTokens` and `workerConsumedCost` paper over the inconsistency but encode a state machine in source code that's hard to test exhaustively.

A redesign with one counter (per pi-docs `CustomEntry` for cumulative, or `UsageEntry` for per-call) would not have this bug class.

### Lesson 2 — The end-of-run order is implicit, not explicit

The current code's end-of-run sequence (stats overwrite → delta → accumulation) is correct IF `getSessionStats()` returns the full session-lifetime total. If it doesn't (aborted session, missed message_end, stats-side bug), the delta is wrong.

A redesign that makes the order explicit — e.g., captures the live value before any overwrite, uses that captured value for the delta — would be more robust.

### Lesson 3 — Tests cover the deterministic paths but not the races

The fake-session pattern in `tests/dispatch-usage.test.ts` is what caught Bug 1 and W1.1. The same pattern can be extended to test the abort-then-`getSessionStats()` race. Such a test would have caught Bug 3 if it had existed.

### Lesson 4 — Review rounds find what the first round missed

Round 1 found 3 items; round 2 found 2 more items. The Bug 2 fix passed round 1 but round 2 caught the latent `effectiveTokens = 0` inconsistency. Multi-round review is the pattern that works; the first pass is never the last.

### Lesson 5 — kieran-typescript-reviewer is a process, not a one-shot

The reviewer found real issues each time. Even after the bug fix is complete, another round is the right move. Per pitfall #30 in HANDOFF.md: "kieran-typescript-reviewer is a multi-round process."

## Open work

- **Bug 3 diagnosis:** the order of (stats overwrite, delta, accumulation) in `src/engine/dispatch.ts:765-870`. The review's hypothesis is the order is correct but `getSessionStats()` returns unexpected values for aborted sessions. Verification: read the code with order traced, and/or write a test that exercises the race.
- **Bug 3 fix:** depends on the diagnosis. Three plausible fixes:
  1. Move `getSessionStats()` overwrite to BEFORE the delta computation.
  2. Skip `governanceTokens += delta` if the run was aborted.
  3. Capture the live value before the overwrite and use it for the delta.
- **Bug 3 regression test:** a fake-session test where `prompt()` calls `runController.abort()` mid-stream and `getSessionStats()` returns a different value than the live accumulation. Assert the post-run `governanceTokens` is correct.
- **Document the bug history in `HANDOFF.md`** when the fix lands.