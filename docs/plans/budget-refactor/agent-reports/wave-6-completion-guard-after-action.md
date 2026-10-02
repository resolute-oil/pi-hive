---
title: Wave 6 — completion guard (4 hard gaps) — after-action report
type: agent-report
date: 2026-10-02
status: complete
---

# Wave 6 — completion guard (4 hard gaps) — after-action report

## Mission

Close the 4 hard gaps surfaced by the final F1-F13 + plan-side audits that block the plan's overall completion guard. All deletions and one minor API migration; no new features, no refactors. Working brief: `tmp/HANDOFF-pickup.md` §3 (full file read before starting). Source branch: `refactor/budget @ cb8b2fa`. Target branch: `refactor/budget-completion-guard` (LOCAL-ONLY, no push, no PR).

## Commits

| # | Hash | Subject |
|---|---|---|
| 1 | `2ff59ed` | `chore(budget): fix eslint violations across budget/ and dispatch modules (Gap 1)` |
| 2 | `4cfd564` | `refactor(types): remove §1.1 counter fields from AgentRuntime (Gap 2)` |
| 3 | `910f052` | `chore(budget): migrate callers away from remaining.ts and delete legacy module (Gap 3)` |
| 4 | `03d76f4` | `chore(budget): remove dead cooperative tool stub exports (Gap 4)` |

## Gap 1 — `npx eslint` was failing 25 errors / 0 warnings (HIGH)

The pickup brief's "67 errors / 56 warnings" was stale; the actual count on `cb8b2fa` was **25 errors, 0 warnings** (9 eol-last auto-fixable + 16 unused). All 9 eol-last errors fixed via `eslint --fix`. 16 unused-var issues cleaned up by hand:

- **`src/engine/dispatch.ts`**: 11 unused names (6 imports from `../core/utils`, 1 import from `./budget/events`, 1 local const `DELEGATION_EVENT_MESSAGE_LIMIT`, 1 local function `finiteOrUndef`, 1 dead `let sdkCounts`, 1 dead `const sessionManager` + an unused `SessionManager` import).
- **`src/engine/budget/policy.ts`**: 2 unused (import `BudgetLedgerEntry` + local const `LEDGER_CUSTOM_TYPE`).
- **`src/engine/budget/worker-tools.ts`**: 2 unused (type param `TApi` on `DelegateAgentModel` + module-local const `COOPERATIVE_TOOL_NAMES` used only as a type). Both underscore-prefixed per the lint rule's allowed-unused shape; no behavior change.
- **`src/engine/dispatch-subscribe.ts`**: 1 unused arg `runController` on `wireDispatchSubscription` — underscore-prefixed (not deleted, because the seam signature is part of the public contract).

ESLint: `npx eslint src/engine/budget/ src/engine/dispatch.ts src/engine/dispatch-subscribe.ts src/engine/dispatch-lifecycle.ts src/engine/dispatch-end.ts` → **exit 0**.

### Deviation from recommended approach

The brief said "Delete 11 unused imports in dispatch.ts at lines 8, 11, 13-16, 36, 44, 194, 342, 473" — but only lines 8/11/13-16/36 were imports. Lines 44/194/342/473 were local declarations (`const DELEGATION_EVENT_MESSAGE_LIMIT`, `function finiteOrUndef`, `let sdkCounts`, `const sessionManager`). I deleted all 11 names as the brief's intent dictated, regardless of declaration kind. Also removed the `SessionManager` import on line 2 (only the local `sessionManager` was using it; once that was gone, the import was unused).

## Gap 2 — §1.1 counter fields removed from `AgentRuntime` (HIGH)

Per plan §0.5 + §1.1, deleted all 8 fields (`runStartInput/Output/CacheRead/CacheWrite/ReasoningTokens`, `runStartCostUsd`, `governanceTokens`, `governanceCostUsd`) from `AgentRuntime` in `src/core/types.ts`. All writers and readers updated:

- **`src/engine/dispatch.ts`**: dropped `runtime.governanceTokens ??=`/`runtime.governanceCostUsd ??=` (init block, ~L374-378) and all 6 `runtime.runStart*` baseline writes (~L630-637). Kept the `tokenBudgetScope` resolution + thread-through (it is still passed to `runPromptAndFinalize` and `emitDelegationEnd` for downstream consumers; the seam is documented at the new declaration site).
- **`src/engine/dispatch-end.ts`**: dropped the per-run `delta` computation + `governance*` accumulation. The `delegation_end` event payload now carries `lifetime` (session-cumulative totals) instead of `delta` (per-run contribution). Bumped `delegationsSchema` to 2 so legacy v1 consumers can detect + skip.
- **`src/engine/observability.ts`**: dropped `governance*` + `runStart*` fields from `runtimeSummary`. The optional telemetry schema in `src/shared/telemetry.ts` is unchanged (these fields are optional `?:` and the dashboard can drop them when the v2 schema is in effect).
- **`src/engine/session.ts`**: dropped `runtime.governance* = p.governance*;` from `loadLatestRuntimes` + the `governance*` fields on the `latest` map. JSONL-loaded delegation_end records still carry the (now-historical) `governance*` fields; they are simply ignored.
- **`src/engine/budget/remaining.ts`**: legacy file consumed the deleted fields. To make Gap 2 typecheck-pass while keeping the file alive for Gap 3, added a `LegacyCounters` type alias + `legacy(runtime)` helper that typecasts the runtime. **All reads fall through to `undefined` at runtime, which is the same as the pre-removal `?? 0` fallback path.** This is the only material change in the remaining.ts file in Gap 2; the function bodies are byte-identical to before except for the cast.
- **Tests**:
  - `tests/dispatch-usage.test.ts`: 5 tests asserted on `payload.delta.*`. Updated to read `payload.lifetime.*` (session-cumulative). For the "per-run growth" assertions, computed the diff between consecutive runs' `lifetime` values. Bumped `delegationsSchema: 1` → `2` in 2 places.
  - `tests/session-branches.test.ts`: 1 test asserted `runtime.governance*` after restore. Dropped the assertions; the `runtime` no longer carries these fields.
  - `tests/budget-remaining.test.ts`: 1 test ("monotonic governance usage") used deleted fields as fixtures. **Deleted** this single test; the remaining 6 tests in the file (all about the legacy `remaining.ts` surface) were deleted as a unit in Gap 3.

### Deviation from recommended approach

The brief said "switch to `getSessionStats()` (the new ledger path)" for `dispatch-end.ts:66-71`. I interpreted this as: drop the per-run `delta` field from the event payload and emit `lifetime` (the session-cumulative values that `dispatch-lifecycle.ts:148-167` had just overwritten from `getSessionStats()`). The dashboard's per-run view is now derived by differencing consecutive `lifetime` values across events. Rationale: the per-run baseline fields are GONE (per plan §1.1, "no replacement — not needed; stats are lifetime"), so a per-run contribution cannot be computed at the event site without a previous-event read. The dashboard ingestion layer is unchanged (it still reads `p.delta`) — this means **v2 events are currently treated as legacy/cumulative by the dashboard, which over-counts across multiple runs**. This is a known follow-up: either update `src/observability/server/runtime.ts:550-571` to use `p.lifetime` (and compute the per-run delta from previous events), or revert `delegationsSchema` to 1 and re-emit the delta. The brief constrained scope to engine-only changes; the dashboard side is F13's concern.

The brief did not explicitly say to drop the `governance*` writes from `dispatch-end.ts:73-77`, but those writes are now type errors (the fields are gone from `AgentRuntime`); removing them was the only path to a clean typecheck. I did not preserve the `runtime.governanceTokens += delta` math via a different field because plan §1.1 explicitly retires this concept (lifetime aggregates from `getSessionStats` are the single source of truth).

## Gap 3 — Migrate callers away from `remaining.ts` and delete the file (MEDIUM)

`remaining.ts` was the legacy budget enforcement surface (`budgetRemaining`, `checkDispatchBudgets`, `teamUsage`, `workerConsumed*`, `effectiveWorkerGovernance` shim). Plan §1.4 retires `governance.ts` and `budget-strategy.ts`; `remaining.ts` was the relocated legacy that survived. Gap 3 deletes the relocated file too.

The "new ledger/policy API" is `src/engine/budget/policy.ts` (`checkBudgetPolicy`, `workerConsumedTokens`, `workerConsumedCost`, `teamUsage`, `ratioRemaining`, `crossedThreshold`). The new `policy.ts` functions take a `session: AgentSession` + `branch: SessionEntry[]` shape (per plan §1.3 — single call to `session.getSessionStats().tokens.total`); the legacy `remaining.ts` functions took a `(state, runtime)` shape. **For the two callers (`prompts.ts` and `observability.ts` — `tui/widget.ts` and `agents/tools.ts` were bonus importers) that just need to display remaining budget in the worker prompt, I added two new exports to `policy.ts`:**

- `effectiveWorkerGovernance(state, runtime): WorkerGovernance` — the merge shim (settings tier + per-agent tier, per-agent wins). This was in `remaining.ts`; I moved it to `policy.ts` so all 6 importers have a single canonical location.
- `budgetRemaining(state, runtime): { worker, team }` — the new implementation reads from `runtime.inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/reasoningTokens/costUsd` (the lifetime aggregates overwritten from `getSessionStats` in `dispatch-lifecycle.ts:148-167`) instead of the deleted `governanceTokens/governanceCostUsd` baselines. The team total walks the live `state.runtimes` Map (excluding the orchestrator), matching the legacy `teamUsage` shape.

`checkDispatchBudgets` was only used by tests; deleted with the legacy test file. `workerConsumed*` and `teamUsage` (legacy shape) were only used by `remaining.ts` internals + the legacy test file; both fully replaced. **No production caller ever used these directly** (the new policy.ts equivalents took their place in Wave 1).

Migrated 6 importers:

| File | Before | After |
|---|---|---|
| `src/engine/prompts.ts` | `from "./budget/remaining"` | `from "./budget/policy"` |
| `src/engine/observability.ts` | `from "./budget/remaining"` | `from "./budget/policy"` |
| `src/ui/tui/widget.ts` | `from "../../engine/budget/remaining"` | `from "../../engine/budget/policy"` |
| `src/agents/tools.ts` | `from "../engine/budget/remaining"` | `from "../engine/budget/policy"` |
| `src/engine/distiller.ts` | `from "./budget/remaining"` | `from "./budget/policy"` |
| `src/engine/dispatch.ts` | `from "./budget/remaining"` | `from "./budget/policy"` |

Deleted files (git rm):

- `src/engine/budget/remaining.ts` (130 lines)
- `tests/budget-remaining.test.ts` (7 tests, all about the legacy `remaining.ts` surface)

### Deviation from recommended approach

The brief said "Likely candidates: `BudgetLedger.snapshot`, `getSessionStats`, or new `policy.ts` functions." I added two new functions to `policy.ts` rather than calling `getSessionStats()` from the call sites. Rationale: the call sites (`prompts.ts:128`, `observability.ts:128`, `tui/widget.ts:280`, `agents/tools.ts:165`) only have `(state, runtime)` in scope, not a `session: AgentSession` (the session is a delegate-internal object, not a field on `AgentRuntime`). Adding a thin `(state, runtime) → { worker, team }` wrapper in `policy.ts` keeps the call sites small and the per-dimension accounting in one place. The new `budgetRemaining` uses `runtime.inputTokens` etc. (the lifetime aggregates already overwritten from `getSessionStats` in `dispatch-lifecycle.ts:148-167`), so the data flow is `getSessionStats → runtime.* → budgetRemaining → caller`, not a direct `session.getSessionStats()` call from each caller.

The brief also said "Plan §1.4 deletes `governance.ts` and `budget-strategy.ts`" — those were already deleted in earlier waves (Wave 5A F9 T9.1). Only `remaining.ts` survived the cutover window, and that's the one I removed.

## Gap 4 — Dead cooperative tool stubs deleted (LOW)

Deleted 3 lines at `src/engine/budget/worker-tools.ts:575-577`:

```ts
export async function request_compaction(_customInstructions?: string, _signal?: AbortSignal): Promise<{ ledgerSnapshot: BudgetLedgerEntry }> { throw new Error("not implemented"); }
export async function request_end_session(_reason: string, _signal: AbortSignal): Promise<{ ledgerSnapshot: BudgetLedgerEntry }> { throw new Error("not implemented"); }
export async function request_snapshot(_label: string, _signal: AbortSignal): Promise<{ ledgerSnapshot: BudgetLedgerEntry }> { throw new Error("not implemented"); }
```

Confirmed zero callers via `grep -rn "request_compaction\|request_end_session\|request_snapshot" src/ tests/` — the only references to those exact names are to the real factories (`buildRequestCompactionTool`, etc.) in `src/engine/budget/worker-only-tools.ts:143-145` and the cooperative-tool registry's string-list uses. The test that asserted the stubs throw `"not implemented"` (`tests/budget-contracts.test.ts` Slice 5) was rewritten to assert: (a) the `request_*` symbols are no longer exported, (b) the real `buildRequest*Tool` factories ARE exported. The "cooperative tool signatures match §2.8" test was rewritten to read the factory source string via `readFileSync` (the factories are multi-line, so the original `fn.toString()` regex didn't capture the signature).

**Region markers in `worker-tools.ts` are byte-identical.** Verified via `git diff cb8b2fa -- src/engine/budget/worker-tools.ts | grep "region:"` → no matches (line numbers shifted up by 3, but the text of `// >>> region: agent-3D (T5.10, T5.11, T5.12)` and `// <<< region: agent-3D` is unchanged).

### Deviation from recommended approach

None. The brief said "delete the 3 stub exports + verify no callers + run tests" — that's exactly what I did. The contract-test rewrite is the expected cost of the deletion (per the brief: "the `throw 'not implemented'` shape was the Wave 0 contract stub, which is now superseded by the real factories").

## Final verification

| Gate | Status |
|---|---|
| `npx eslint src/engine/budget/ src/engine/dispatch.ts src/engine/dispatch-subscribe.ts src/engine/dispatch-lifecycle.ts src/engine/dispatch-end.ts` | **exit 0** |
| `just typecheck` (core + bun + tests + dashboard) | **clean** |
| `just test` (Node, 666 tests) | **666/666 pass** |
| `just test-db` (Bun, 75 tests) | **73/75 pass**; 2 pre-existing failures in `tests/plan-server.spec.ts` (unrelated to this work; both fail identically on `cb8b2fa` HEAD before any of my changes — verified by stashing the worktree + re-running) |
| `worker-tools.ts` region markers vs. `cb8b2fa` | **byte-identical** |
| `git push` / `gh pr create` activity | **none** (LOCAL-ONLY per project rules) |

## Test count delta

- Started: 674 Node tests passing on `cb8b2fa`
- After Gap 1: 674 (no test changes)
- After Gap 2: 673 (-1 — deleted the "monotonic governance usage" test in `tests/budget-remaining.test.ts:71-75` which asserted on a deleted field)
- After Gap 3: 666 (-7 — deleted the entire `tests/budget-remaining.test.ts` file as the legacy `remaining.ts` surface is gone)
- After Gap 4: 666 (no test count change; the contract-test rewrite is in-place)

The brief's "674/674 still pass" target was relaxed by the §1.1 removal's "Tests may need updates if they asserted on these fields — those test assertions are the bug, not the production code; update the tests to read from the new path." The 8 deleted tests (1 + 7) all asserted on the deleted `governanceTokens`/`governanceCostUsd`/`runStart*` fields and the legacy `checkDispatchBudgets`/`workerConsumed*` surface — they are correctly retired, not regressions. All other tests were updated to the new schema.

## Open follow-ups (out of scope for this wave)

1. **Dashboard ingestion for v2 delegation_end events**: `src/observability/server/runtime.ts:550-571` and `src/observability/server/db.ts:862` read `payload.delta` to stamp per-run rows. v2 events have `payload.lifetime` (cumulative) instead. The dashboard currently treats v2 events as legacy/cumulative (schemaVersion=0), which over-counts across multiple runs. Fix: read `p.lifetime`, compute the per-run delta by differencing previous events, OR re-emit a derived `delta` from the dispatcher. Tracked under F13 / followup.
2. **Pre-existing flaky tests**: `tests/plan-server.spec.ts:93,135` ("planDetail exposes executionReady", "plan detail caches by artifact metadata") fail in this environment even at the parent commit `cb8b2fa` — verified by `git stash` + re-run. Not caused by any of my changes. Needs separate investigation (likely an environment / ports / fixture issue).
3. **Telemetry schema fields**: `src/shared/telemetry.ts:189-190, 204-205` still declare `governanceTokens?`/`governanceCostUsd?`/`runStartInputTokens?`/`runStartOutputTokens?` as optional fields. The runtime no longer populates them (Gap 2 removed the writers in `runtimeSummary`). They are optional, so the type contract is intact, but a future dashboard cleanup can drop them. Tracked under F13.

## Files touched

**Engine (Gap 1):** `src/engine/dispatch.ts`, `src/engine/dispatch-end.ts`, `src/engine/dispatch-lifecycle.ts`, `src/engine/dispatch-subscribe.ts`, `src/engine/budget/events.ts`, `src/engine/budget/ledger.ts`, `src/engine/budget/policy.ts`, `src/engine/budget/remaining.ts`, `src/engine/budget/strategy.ts`, `src/engine/budget/worker-only-tools.ts`, `src/engine/budget/worker-tools.ts`

**Types (Gap 2):** `src/core/types.ts` (+ changes to `src/engine/dispatch.ts`, `src/engine/dispatch-end.ts`, `src/engine/observability.ts`, `src/engine/session.ts`)

**Migration (Gap 3):** `src/engine/budget/remaining.ts` (deleted), `src/engine/budget/policy.ts` (gained `effectiveWorkerGovernance` + `budgetRemaining`), `src/engine/prompts.ts`, `src/engine/observability.ts`, `src/engine/distiller.ts`, `src/engine/dispatch.ts`, `src/ui/tui/widget.ts`, `src/agents/tools.ts`; `tests/budget-remaining.test.ts` (deleted)

**Stubs (Gap 4):** `src/engine/budget/worker-tools.ts`, `tests/budget-contracts.test.ts`

## Worktree state

Branch: `refactor/budget-completion-guard` (4 new commits on top of `cb8b2fa`)
Working tree: clean
Push/PR: none (LOCAL-ONLY)
