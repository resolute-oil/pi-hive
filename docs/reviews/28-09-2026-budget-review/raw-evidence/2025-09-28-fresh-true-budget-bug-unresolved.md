# fresh=true budget reset — UNRESOLVED BUG REPORT

**Date**: 2025-09-28 (end of session, before context limit)
**Branch**: `feat/budget-strategy` @ `9f950fb`
**Status**: PR #54 open, awaiting merge; bug not fixed despite 4 attempts

## TL;DR

Despite two kieran-typescript-reviewer rounds and what looked like correct fixes (Bug 1: move `freshResetRuntime` before `checkDispatchBudgets`; Bug 2: make `workerConsumedTokens` return live mid-run values), the bug **persists in production testing** as of session end. The user reported the same abort pattern after the fixes were deployed (server on `9f950fb`, verified via `/hive:version`).

## What the user observed

After deploying `9f950fb` and running a fresh test session, the user shared this data:

```
- engineering-lead: error, runs=2 (incremented from 1), tokens=0, remaining.tokens=0, "tokens=15134 used"
- orchestrator (me): remaining.tokens=3500 (unchanged, full budget)
```

The user said:
> "Confirmed. Same abort, same failure pattern. The bug is reproducible and independent of task content. The worker session gets tokens=0 budget on fresh=true spawn and aborts immediately."

**Earlier in the session, the same worker had used 91,260 tokens against the 3,500 cap** (the Bug 2 mid-run enforcement issue). So:
- Run 1: 91,260 tokens used, aborted at >3,500 cap (Bug 2)
- Run 2 (fresh=true): 15,134 tokens used, aborted (still failing)

The mystery: with my Bug 1 + Bug 2 fixes deployed and verified via `/hive:version`, why does the fresh=true dispatch still abort?

## What the fixes did (commits on the branch)

```
9f950fb refactor: address kieran-typescript-reviewer findings on the two-bug fix
3be33f6 fix(dispatch,governance): two related budget-enforcement bugs surfaced by testing
bd49c31 refactor(dispatch): use canonical runtime key in respawn + hoist test mocks
081380a fix(dispatch): reset governance counters and recreate runtime on fresh=true
```

**Bug 1 (commit 081380a, refined in 3be33f6)**: `freshResetRuntime` was at line ~318, but `checkDispatchBudgets` was at line ~252. The budget check fired first and returned "Delegation blocked" before the reset ever ran. Fix: move the reset to right after `reloadAgentConfig` (~line 206).

**Bug 2 (commit 3be33f6)**: The mid-run `message_end` handler used `workerConsumedTokens`, which preferred `governanceTokens` via the `??` chain. But `governanceTokens` is only written at `agent_end` (line ~818), so mid-run it was 0. Fix: change `workerConsumedTokens` to return `runtimeTokens(runtime, scope)` (live) when `runtime.status === "running"`.

**Defensive cleanups (3be33f6)**: `freshResetRuntime` now always resets, archive is best-effort, also clears `effectiveTokens`.

**Review cleanups (9f950fb)**: kieran-typescript-reviewer follow-ups — comment reconciliation, regression test, cleaner test arithmetic.

## The mystery: why does it still fail?

The user's data shows:
- `tokens=0` — `runtime.inputTokens + outputTokens + cacheRead + cacheWrite + reasoning = 0`
- `remaining.tokens=0` — `3500 - workerConsumedTokens` clamped to 0

If runtime.* are 0 AND my fixes are deployed, then `workerConsumedTokens` should be 0 (per Bug 2 fix: live path returns `runtimeTokens(runtime, scope) = 0`). So `remaining.tokens` should be `3500 - 0 = 3500`, not 0.

For `remaining.tokens=0` to be true, `workerConsumedTokens` must be `>= 3500`. With runtime.*=0, the `??` chain must be returning either `governanceTokens >= 3500` or `effectiveTokens >= 3500` (post-run frozen path).

Three plausible explanations (ranked by likelihood):

### 1. `governanceTokens` got set to a high value AFTER `freshResetRuntime` zeroed it, by the end-of-run accumulation at line ~868

**The trace**:
1. `freshResetRuntime` runs, zeros everything including `governanceTokens=0`
2. `checkDispatchBudgets` (line ~252) sees `governanceTokens=0`, passes the budget check
3. The run starts. First message uses 15,134 tokens. The mid-run handler updates `runtime.inputTokens += u.input` etc., so `runtime.* = 15134` at that point
4. Mid-run check: `workerConsumedTokens` (with Bug 2 fix, `status === "running"`) returns `runtimeTokens(runtime, scope) = 15134`. `remaining.worker.tokens = max(0, 3500 - 15134) = 0`. `exhausted=true` → `runController.abort(...)` fires
5. After abort, the dispatch continues. `session.getSessionStats()` is called. **If the SDK returns 0 for an aborted session**, the end-of-run code overwrites `runtime.*` to 0 (line ~772-790). **But** the delta accumulation at line ~868 might still use the values BEFORE the overwrite.

**Hypothesis**: the end-of-run `governanceTokens` accumulation at line 868 reads `runtime.*` BEFORE the getSessionStats overwrite (or uses a cached delta). If `runtime.*=15134` at that point, `delta=15134`, `governanceTokens = 0 + 15134 = 15134`. Then the getSessionStats overwrite happens, setting `runtime.*=0`. Result: `governanceTokens=15134`, `runtime.*=0` — exactly the symptom.

**To verify**: read the end-of-run code at `src/engine/dispatch.ts:~815-870` and check the order of (a) getSessionStats overwrite, (b) delta computation, (c) governanceTokens accumulation.

### 2. Server isn't actually on `9f950fb`

The user said "/hive:version is correct" but didn't say what SHA. If the server is on an earlier SHA (e.g., `3be33f6` before the review cleanup, or worse, an earlier commit), the fixes might not all be deployed.

**To verify**: ask the user for the exact `/hive:version` output (it should report `feat/budget-strategy @ 9f950fb`).

### 3. A different code path bypasses the fix

Possibly: the orchestrator isn't using `fresh=true` directly but calling `respawnWorkerSession` (operator respawn) or some other path that doesn't go through `dispatchAgent`'s fresh block.

**To verify**: check the orchestrator's tool call log. `conversation.jsonl` should have the literal `delegate_agent(..., fresh: true)` call (PR #45's `[fresh=true]` flag surfacing in the render call makes this visible).

## What I planned to investigate (but ran out of context)

The most likely culprit is **#1** (the end-of-run governanceTokens accumulation uses pre-overwrite runtime.*). The fix would be either:
- (a) Move the getSessionStats overwrite to BEFORE the delta computation, so the delta uses the authoritative SDK totals
- (b) Move the delta computation BEFORE the getSessionStats overwrite, capturing the live runtime.* values
- (c) Skip the end-of-run governanceTokens accumulation if the run was aborted (no point accumulating for an aborted run)

Option (c) is the most likely fix: an aborted run shouldn't accumulate budget tokens because the work wasn't really "consumed" by the user — it was rejected by the budget guard. But this depends on the design intent.

## Files to read in the next session

1. `src/engine/dispatch.ts` lines 815-870 — the end-of-run code, specifically the order of:
   - getSessionStats overwrite (around line 772)
   - delta computation
   - `governanceTokens` accumulation (line 868)
2. The mid-run handler (around line 660) — confirm Bug 2 fix is in place
3. `src/engine/governance.ts` lines 30-50 — confirm `workerConsumedTokens` mid-run branch is in place
4. The team's HANDOFF.md `2025-09-28-fresh-true-budget-bug-unresolved.md` (this file, located in `raw-evidence/` within the budget review tree; was originally in `tmp/`)

## Diagnostic commands to run

```sh
# Verify the running server is on the latest commit
git -C /Users/cgrant/.pi/agent/git/github.com/demetere/pi-hive rev-parse HEAD
# Should show 9f950fb (or later if more commits have been added)

# Check that the Bug 2 fix is in place in governance.ts
grep -A 4 "if (runtime.status === .running.)" src/engine/governance.ts

# Check that the Bug 1 fix is in place in dispatch.ts (freshResetRuntime should be early)
grep -B 1 -A 3 "freshResetRuntime(runtime)" src/engine/dispatch.ts

# Look at the end-of-run code structure
sed -n '765,870p' src/engine/dispatch.ts
```

## What the next session should do

1. **Verify server SHA first.** Run `/hive:version` and confirm `9f950fb`. If not, restart the server with the latest code.
2. **Read the end-of-run code** at `src/engine/dispatch.ts:~815-870`. Trace the order of getSessionStats overwrite, delta computation, and governanceTokens accumulation. Determine which values are read by the delta.
3. **If the bug is in the end-of-run accumulation** (most likely per hypothesis #1), apply a fix:
   - Either move the getSessionStats overwrite earlier so it precedes the delta computation
   - Or skip the end-of-run governanceTokens accumulation if the run was aborted (check `runController.signal.aborted` or `runtime.status`)
4. **Re-test** with a fresh=false and fresh=true dispatch against engineering-lead. Verify:
   - Without fresh: `remaining.tokens=0` (prior state preserved, as expected)
   - With fresh: `remaining.tokens=3500` (full budget restored), and the run can actually use up to 3500 tokens
5. **Add a regression test** for the end-of-run governanceTokens accumulation behavior (if not already covered by the existing tests).
6. **Run kieran-typescript-reviewer** on the new fix.
7. **Commit, push, update HANDOFF.md.**

## Why this session didn't get there

This session started with a request to "test the budget strategy additions" and ended with the unresolved bug. The session covered:
- Reviewing the budget-strategy config options
- Designing a test task
- Discovering the first bug (fresh=true not resetting budget)
- Applying Bug 1 fix (commit 081380a)
- Kieran-typescript-reviewer review
- Applying review cleanups (commit 8843834)
- Discovering the second bug (worker overran budget by 26x)
- Designing Bug 2 fix
- User's choice: Option A (make workerConsumedTokens live mid-run)
- Applying Bug 2 fix (commit 3be33f6)
- Fixing tests that broke (documentation-consistency test for new hive:version command, README mention)
- Second kieran-typescript-reviewer review
- Applying review cleanups (commit 9f950fb)
- User reported the bug STILL persists
- **Session ended mid-investigation of the third mystery**

The user was running low on context and asked me to write this report and update HANDOFF.md before the session goes away.

## Commit hashes (for the next session to reference)

```
9f950fb refactor: address kieran-typescript-reviewer findings on the two-bug fix
3be33f6 fix(dispatch,governance): two related budget-enforcement bugs surfaced by testing
bd49c31 refactor(dispatch): use canonical runtime key in respawn + hoist test mocks
081380a fix(dispatch): reset governance counters and recreate runtime on fresh=true
5505ea5 feat: add budget-strategy feature (default + compact strategies, summarize_progress tool, operator intervention)
```

The first 5 commits are stacked on `feat/budget-strategy`. PR #54 is open with all 5. Force-pushed to `9f950fb` on origin.