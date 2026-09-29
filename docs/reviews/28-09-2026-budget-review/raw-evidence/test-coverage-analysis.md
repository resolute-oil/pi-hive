# Test coverage analysis

What the existing tests pin, what they don't, and where the gaps create risk. References every budget-relevant test in the current `feat/budget-strategy` HEAD.

## Coverage matrix by concern

| Concern | Pinned by | Coverage |
|---|---|---|
| **Unlimited budget** (no cap = no block) | `tests/governance.test.ts:25-39` | full |
| **Per-agent governance overrides** | `tests/governance.test.ts:25-39` | full |
| **Independent worker + team blocks** | `tests/governance.test.ts:41-60` | full |
| **Monotonic governance (Bug 1, W1.1)** | `tests/governance.test.ts:62-67`, `tests/dispatch-usage.test.ts:385-535` | full |
| **FIFO queue + cancellation** | `tests/governance.test.ts:69-94` | full |
| **`tokenBudgetScope: input_output`** | `tests/governance.test.ts:131-167` | full |
| **First `checkDispatchBudgets` block** | `tests/governance.test.ts:41-60` | full |
| **Second `checkDispatchBudgets` (post-queue)** | NONE | gap |
| **`fresh=true` ordering** | `tests/dispatch-usage.test.ts:385` | full (Bug 1) |
| **`fresh=true` archive + counter reset** | `tests/dispatch-usage.test.ts:489-535` | full (W1.1) |
| **Fresh-delta survives mode-switch restore** | `tests/dispatch-usage.test.ts:544-585` | full (R3-1.1) |
| **Mid-run warning at ≤20%** | `tests/budget-strategy.test.ts` (likely the "default strategy emits wrap-up hint" tests) | full |
| **Mid-run abort at 0%** | `tests/budget-strategy.test.ts` | partial — covers the abort trigger, not the post-abort end-of-run math |
| **End-of-run `governanceTokens` accumulation** | `tests/dispatch-usage.test.ts:489-535` | partial — covers the deterministic path, not the abort-then-`getSessionStats()` race |
| **`getSessionStats()` overwrite order** | NONE | gap |
| **Compaction recalc savings math** | `tests/budget-strategy.test.ts` | full |
| **Compaction recalc no-op on missing fields** | `tests/budget-strategy.test.ts` | full |
| **Cost not recalculated by compaction** | `tests/budget-strategy.test.ts` | full |
| **`summarize_progress` size cap** | `tests/budget-strategy.test.ts` | full |
| **`summarize_progress` strategy-conditional compact** | `tests/budget-strategy.test.ts` | full |
| **`summarize_progress` no_runtime / over_cap / compact_failed paths** | `tests/budget-strategy.test.ts` | full |
| **`endWorkerSession` semantics** | `tests/budget-strategy.test.ts` | full |
| **`compactWorkerSession` semantics** | `tests/budget-strategy.test.ts` | full |
| **`respawnWorkerSession` semantics** | `tests/budget-strategy.test.ts` | full |
| **Config validation rejects unknown strategy** | `tests/budget-strategy.test.ts` | full |
| **`interventionAvailable` flag (default strategy)** | `tests/budget-strategy.test.ts` | full |
| **Operator intervention wired before dashboard UI** | NONE (UI out of scope for PR #54) | gap — but is a UI gap, not an engine gap |
| **Abort-then-`getSessionStats()` race (Bug 3)** | NONE | **critical gap** |

## Where the gaps are

### Gap 1 — second `checkDispatchBudgets` after queue

The dispatcher calls `checkDispatchBudgets` twice: once before slot acquisition (line 252) and once after (line 302). The first is well-tested. The second is not — `tests/governance.test.ts` covers the function but not the call-from-dispatch pattern.

### Gap 2 — `getSessionStats()` overwrite order

The third-mystery bug hypothesis is that the order of (stats overwrite → delta computation → governanceTokens accumulation) is wrong, or that `getSessionStats()` returns unexpected values for aborted sessions. No test exercises this.

Tests use deterministic fake `createSession` factories that always return predictable `getSessionStats` values. A real SDK abort path is not exercised.

### Gap 3 — abort-then-`getSessionStats()` race

This is the Bug 3 hypothesis. Even if the order is correct, an aborted session might cause `getSessionStats()` to return values that disagree with the live accumulation. Tests do not exercise this race.

### Gap 4 — concurrent parallel delegations

The orchestrator can call `delegate_agent` twice in the same turn (parallel tool calls). The budget counter is updated by sibling handlers in any order. Tests do not exercise parallel updates to the team total.

### Gap 5 — operator commands without UI

`endWorkerSession`, `compactWorkerSession`, `respawnWorkerSession` are tested. The dashboard UI that invokes them is missing. The gap is in the dashboard, not the engine.

## Test architecture observations

The tests are well-structured:

- `tests/governance.test.ts` is a pure-function test suite — no fixtures, no real SDK. It uses `runtime(name, overrides)` and `state(runtimes, settings)` helpers to construct mock state. Fast, deterministic.
- `tests/budget-strategy.test.ts` follows the same pattern.
- `tests/dispatch-usage.test.ts` is a higher-fidelity suite that uses `createAgentSession` injection to drive `dispatchAgent` end-to-end with fake sessions.

The fake-session pattern in `dispatch-usage.test.ts` is what catches Bug 1 and W1.1 — without it, the tests would only cover the pure-function budget math and miss the ordering issue.

The same fake-session pattern can be extended to test the abort-then-`getSessionStats()` race. A test that:
1. Sets up a fake session whose `prompt()` calls `runController.abort()` mid-stream.
2. Has `getSessionStats()` return a different value than the live accumulation.
3. Asserts the post-run `governanceTokens` matches expectations.

Such a test would have caught Bug 3 if it had existed before the user's deployment test.

## Total counts

Per the HANDOFF.md baseline (as of the start of the feat/budget-strategy session): 467/467 server, 49/49 dashboard.

The relevant subset:
- `tests/governance.test.ts` — 9 tests
- `tests/budget-strategy.test.ts` — 38 tests (new in feat/budget-strategy)
- `tests/dispatch-usage.test.ts` — many tests; ~3 directly budget-related (Bug 1, W1.1, R3-1.1)

Total: ~50 tests covering budget behavior. Reasonable coverage for a complex feature; gaps are in the edge cases the bug timeline exposes.