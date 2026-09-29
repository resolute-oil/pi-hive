# Current flow — `fresh=true` bug timeline

Why the budget-reset bug has resisted several rounds of fixes. The HANDOFF records three attempts and a still-unresolved fourth. This file reconstructs the trail.

## The symptom

A worker delegated with `fresh=true` is expected to start a fresh session with a fresh budget. The orchestrator uses this to respawn a worker after budget exhaustion.

After the user's most recent test, the symptom is:

```
- engineering-lead: error, runs=2 (incremented from 1), tokens=0, remaining.tokens=0, "tokens=15134 used"
- orchestrator (me): remaining.tokens=3500 (unchanged, full budget)
```

- `tokens=0` (runtime.* sum) but `remaining.tokens=0` (budget exhausted).
- `tokens=15134` was actually used (per the error message).
- The orchestrator's own budget is full (3500 remaining).

In an earlier test, the same worker used 91,260 tokens against the 3500 cap and aborted.

## Bug 1 — `freshResetRuntime` ran AFTER the budget check

**Commit `081380a`, refined in `3be33f6`.**

### What it was

`freshResetRuntime` was originally placed at `src/engine/dispatch.ts:~318`, AFTER the budget check at line ~252. So the budget check fired with `governanceTokens=1000` (cumulative from the prior session) and returned `"Delegation blocked: ... token budget exhausted"` BEFORE `freshResetRuntime` could zero it.

The orchestrator's `fresh=true` respawn silently no-op'd.

### The fix

Moved `freshResetRuntime` to line ~214, right after `reloadAgentConfig` and before any guard. The budget check now sees zeroed counters and the dispatch proceeds.

### The regression test

`tests/dispatch-usage.test.ts:385-430` pins this ordering. The test sets `worker.governanceTokens = 1000` (the exhausted value from the prior run), invokes `dispatchAgent(state, "Builder", ..., fresh=true)`, and asserts the dispatch succeeded (exitCode=0) and the post-run `governanceTokens = 265` (only the fresh run's usage). The comment at lines 376-385 documents the bug:

> "Bug 1 regression: fresh=true must zero the cumulative budget counter BEFORE checkDispatchBudgets runs. Pre-fix (commit 081380a), the reset was at line ~318 but the budget check was at line ~252, so an already-exhausted worker couldn't be respawned via fresh=true — checkDispatchBudgets returned 'Delegation blocked: ... token budget exhausted' before the reset ever ran."

## Bug 2 — mid-run budget check saw stale `governanceTokens=0`

**Commit `3be33f6`.**

### What it was

The mid-run `message_end` handler called `budgetRemaining(state, runtime)`, which used `workerConsumedTokens(runtime, scope)`. That function's pre-fix `??` chain preferred `governanceTokens ?? effectiveTokens ?? runtimeTokens(...)`.

But `governanceTokens` is only written at `agent_end` (line ~858). Mid-run, it was 0. So the mid-run check always saw 0 used, never warned, never aborted.

The worker ran past the cap. Engineering Lead used 91,260 tokens against the 3500 cap.

### The fix

Changed `workerConsumedTokens` in `src/engine/governance.ts:34-58` to return `runtimeTokens(runtime, scope)` (live) when `runtime.status === "running"`. The frozen `governanceTokens` is used post-run.

The comment at lines 36-50 explains the symmetry with `workerConsumedCost`:

> "Mid-run: return the LIVE cumulative consumption from runtime.* tokens, which the message_end handler updates incrementally after every model response. ... This is symmetric with workerConsumedCost (which already does the right thing mid-run: prior + (costUsd - runStartCostUsd))."

### Defensive cleanups in the same commit

`freshResetRuntime` now always resets (no early-exit on missing session file), archive is best-effort, and `effectiveTokens` is also zeroed.

## Bug 3 (third mystery) — post-test residual `governanceTokens=15134`

**Status: UNRESOLVED.** Documented in `../raw-evidence/2025-09-28-fresh-true-budget-bug-unresolved.md`.

### What the user observes

After Bug 1 + Bug 2 fixes were deployed (server on `9f950fb`, verified via `/hive:version`), a fresh=true dispatch of Engineering Lead aborted. The display shows `tokens=0` but `remaining.tokens=0` with `"tokens=15134 used"` in the error message.

### The mystery

If `runtime.* = 0` (display) and `workerConsumedTokens` returns `runtimeTokens(...) = 0` (Bug 2 fix path), then `remaining.tokens = 3500 - 0 = 3500`. The budget should NOT be exhausted.

For `remaining.tokens = 0` to be true, `workerConsumedTokens` must be `>= 3500`. With `runtime.*=0`, the `??` chain must be returning either `governanceTokens >= 3500` or `effectiveTokens >= 3500` (post-run frozen path).

### Top hypothesis (from HANDOFF)

The end-of-run `governanceTokens += delta` accumulation at line ~858 reads `runtime.*` BEFORE the `getSessionStats` overwrite at line ~780-815. The order is:

```ts
try {
  const stats = session.getSessionStats();
  if (stats) {
    // ...overwrite runtime.inputTokens, outputTokens, cacheRead, cacheWrite, cost from stats
  }
} catch { /* keep incremental */ }

// AFTER the overwrite:
const delta = {
  inputTokens: nonneg(runtime.inputTokens - (runtime.runStartInputTokens ?? 0)),
  // ...
};
runtime.governanceTokens = (runtime.governanceTokens || 0) + (...);
```

The order is **stats overwrite first, then delta**. So the delta SHOULD use the post-overwrite values.

UNLESS the order in the actual production code is different from what HANDOFF describes. The session-end-of-run trace needs to be re-read with the order verified.

### Alternative hypothesis (race condition)

A different theory: the abort itself might race with `getSessionStats`. When `runController.abort(...)` fires, the SDK may reset its internal counters on the aborted session BEFORE `getSessionStats()` is called from the finally block. The result is `getSessionStats` returns 0, the overwrite zeroes `runtime.*`, and `delta = 0 - 0 = 0`. The accumulated `governanceTokens` stays at whatever it was BEFORE this run — i.e., the cumulative from prior runs.

If the worker had multiple runs in its history (not just one), `governanceTokens` may legitimately be 15134 from prior runs, and the new fresh=true run added 0 because the SDK reset.

### What hasn't been tested

The HANDOFF identifies three plausible root causes:

1. End-of-run `governanceTokens` accumulation uses pre-overwrite `runtime.*` values.
2. Server isn't actually on `9f950fb` (stale process — already known to bite this codebase, HANDOFF pitfall #1).
3. A different code path bypasses the fix (e.g., `respawnWorkerSession` instead of plain `fresh=true`).

The verification steps the next session was supposed to take:

- `/hive:version` (verify SHA).
- `grep` for `freshResetRuntime` in `dispatch.ts` (verify ordering).
- `sed -n '765,870p' src/engine/dispatch.ts` (verify end-of-run order).
- Check the orchestrator's `conversation.jsonl` for the literal `delegate_agent(..., fresh: true)` call (PR #45's `[fresh=true]` flag surfacing makes this visible).

### What the current code DOES guarantee

Even with Bug 3 unresolved, the regression tests pin:

- **Bug 1 ordering** — fresh=true zeros counters before checkDispatchBudgets. Pin: `tests/dispatch-usage.test.ts:385`.
- **W1.1 fresh-delta** — fresh run's delta equals its own usage. Pin: `tests/dispatch-usage.test.ts:489`.
- **R3-1.1 fresh-delta survives mode-switch restore** — third run after a fresh + restore doesn't resurrect old totals. Pin: `tests/dispatch-usage.test.ts:544`.

These tests exercise the code path with deterministic fake `createSession` factories and assert specific values. They do NOT exercise the `runController.abort()` race against `getSessionStats()` that Bug 3 hypothesizes.

## Why incremental fixes haven't closed it

Three structural reasons:

### 1. The dual-counter system is the bug

`governanceTokens` (monotonic) and `runtime.*` (session-lifetime, overwritten) are two different views of "how much has this worker consumed". Every code path that updates one must update the other, in the right order, at the right moment.

The mid-run fix made `workerConsumedTokens` return live values while running. That fix is correct. But the LIVE values are overwritten by `getSessionStats()` at the end, and the OVERWRITE happens between the live update and the final accumulation. There is a window where the two views disagree.

### 2. The end-of-run order is implicit, not explicit

The current code's end-of-run sequence is:

1. `session.prompt()` returns or throws.
2. `getSessionStats()` overwrites `runtime.*`.
3. Compute `delta = runtime.* - runStart*`.
4. `governanceTokens += delta`.

This order is correct IF `getSessionStats()` returns the full session-lifetime total for the aborted session. The order is WRONG if `getSessionStats()` returns 0 for an aborted session (because then `delta = 0` and the consumed budget is lost from the live view, but the cumulative `governanceTokens` correctly retains prior runs).

### 3. There is no single source of truth

Even if Bug 3 is fixed in the current design, the next bug class is one step away. The current design has three counters, each with its own write site and read site, and consumers must pick the right one. A future refactor that adds a fourth counter (e.g., "tokens consumed across the whole session tree") will reintroduce the same class of bug.

## What the redesign needs to do

The refactor options explore this in detail. The structural fix is:

- **Make ONE counter authoritative** for "what has this worker consumed". Either:
  - The session file (Option B — `UsageEntry` per call, aggregated by `getBranch()` on `session_start`).
  - A single in-memory counter with explicit write/read sites (Option C — `BudgetLedger` module).
  - The current code minus the strategy layer (Option D — narrow feature surface).

The current design's `runtime.*` + `governanceTokens` + `effectiveTokens` trio is the source of complexity. Collapsing to one of these options removes the bug class.

See `04-refactor-options.md` for the trade-off matrix and `refactor-options/option-A-minimal-fix.md` for the smallest viable change.