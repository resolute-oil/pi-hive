---
title: Wave 6.5 — followup fixup (5 fixes) — after-action report
type: agent-report
date: 2026-10-02
status: complete
---

# Wave 6.5 — followup fixup (5 fixes) — after-action report

## Mission

Resolve the 5 remaining items the Wave 6 audit surfaced but could not address in its scope. All deletions, one minor schema revert, one regression test, no new features. Source branch: `refactor/budget-completion-guard @ 608063b` (5 commits on top of `cb8b2fa`). Target branch: `refactor/budget-completion-guard` (LOCAL-ONLY, no push, no PR).

## Commits

| # | Hash | Subject |
|---|---|---|
| 1 | `aad22ec` | `refactor(types): remove §1.1 counter fields from OrchestratorRuntime and RuntimeSummary (Fix A)` |
| 2 | `375a2d5` | `fix(events): revert delegation_end schema to v1 with producer-computed delta (Fix B)` |
| 3 | `5e6751f` | `refactor(state): delete HiveState.budgetWarnings and migrate to CustomEntry walk (Fix C)` |
| 4 | *(no commit)* | `chore(budget): remove dead operator command stubs at worker-tools.ts (Fix D)` — see Deviations |
| 5 | `ab31a7a` | `test(budget): pin budgetRemaining(state, runtime) live-mirror semantics (Fix E)` |

## Fix A — §1.1 fields removed from `OrchestratorRuntime` + `TelemetryAgentRuntime` (HIGH)

Plan §1.1 calls for these 8 fields to be removed from every type that carries them. Wave 6 only removed them from `AgentRuntime`. Two more surfaces had them:

| Type | File | Fields |
|---|---|---|
| `OrchestratorRuntime` | `src/core/types.ts:319-320` | `runStartInputTokens?`, `runStartOutputTokens?` |
| `TelemetryAgentRuntime` (the "RuntimeSummary" from the brief) | `src/shared/telemetry.ts:189-205` | `governanceTokens`, `governanceCostUsd`, `runStartInputTokens`, `runStartOutputTokens` |

**Approach:** deleted the 6 fields (2 from `OrchestratorRuntime`, 4 from `TelemetryAgentRuntime`); migrated every reader/writer.

- **`src/integration/hooks.ts:120-121`** (writer): the `setOrchestratorStatus` handler captured the input/output baselines at run start to support per-run TOK/S. The §1.1 design retires per-run baselines (lifetime aggregates from `getSessionStats` are the single source of truth), so the writes are gone.
- **`src/engine/observability.ts:147-148`** (reader): the `withOrchestratorUsage` overlay read the orchestrator's `runStart*` baselines. The reads are gone.
- **`ui/web/src/components/TopologyGraph.tsx:404`** + **`ui/web/src/lib/agents.ts:152-163`** (dashboard consumer): `tokPerSec` used the `runStartOutputTokens` baseline to compute per-run generation throughput. Removed the unused parameters from the function signature; updated the call site to drop the deleted fields. The per-run TOK/S display now falls back to lifetime output (the pre-J8 behavior). Rebuilt the dashboard dist via `just dashboard-build` (new dist hash `TopologyGraph-DCp8wyF7.js`).
- **`tests/dashboard-helpers.test.ts:32-39`**: the existing test for `tokPerSec` exercised the deleted baseline-subtraction path. Updated to assert the new (pre-J8) behavior — lifetime output / elapsed, input ignored. Test count unchanged.

### Deviation from the brief

The brief listed 8 fields on `RuntimeSummary` (`src/telemetry/types.ts:189-205`): `governanceTokens`, `governanceCostUsd`, `runStartInputTokens`, `runStartOutputTokens`, `runStartCacheReadTokens`, `runStartCacheWriteTokens`, `runStartReasoningTokens`, `runStartCostUsd`. Only the first 4 were present in the actual file (`src/shared/telemetry.ts:189-205`, which is `TelemetryAgentRuntime` — the brief's "RuntimeSummary" path was stale; `src/telemetry/types.ts` does not exist). The cache/reasoning/cost `runStart*` fields were never declared on `TelemetryAgentRuntime`. I removed the 4 that actually existed.

The brief said "Re-run grep — must return zero hits." After the deletions, `grep -rn "runStartInputTokens|runStartOutputTokens|...|governanceTokens|governanceCostUsd" src/ tests/ ui/web/src/` returns 4 hits, all benign:

- `tests/budget-races.test.ts:203, 228` — historical-context comments only (not assertions).
- `tests/session-branches.test.ts:138, 145` — JSONL fixture data with `governanceTokens: 25, governanceCostUsd: 0.75` testing the loader's robustness to legacy data; comment at line 145 documents the §1.1 design.

These references do not "carry" the fields — they exist to verify the loader ignores them. The brief's "zero hits" target is unattainable without breaking the loader-robustness test, which is itself a §1.1 design verification. I left them and document here for review.

## Fix B — Dashboard v2 schema revert with producer-computed delta (HIGH)

Plan §1.1 design called for the dashboard to compute per-run delta from cumulative + prior ledger snapshot. Wave 6 implemented this as `delegationsSchema: 2, lifetime: {...}` and noted the dashboard now over-counts across multiple runs (a known follow-up). The simpler producer-side path is to revert to v1 (`delegationsSchema: 1, delta: {...}`) with the delta computed in the dispatcher from a `priorLifetime` capture.

**Approach:** capture the runtime's lifetime totals BEFORE the prompt runs (in `src/engine/dispatch.ts` after the fresh-reset block, before `runPromptAndFinalize`); thread `priorLifetime` through `PostPromptInput` to `emitDelegationEnd`; compute `delta = current_lifetime - priorLifetime` (clamped nonneg) in `emitDelegationEnd`; emit `delegationsSchema: 1, delta, lifetime` (lifetime kept for backward compatibility per the brief).

- **`src/engine/dispatch.ts:683-696`**: `priorLifetime` capture point. After the `if (fresh && existsSync(...))` reset block (so fresh=true has prior=0) and before `runPromptAndFinalize` (so per-message reasoning accumulation from `dispatch-subscribe.ts` is not yet on the runtime).
- **`src/engine/dispatch-lifecycle.ts`**: `PostPromptInput` and `PostPromptInput` destructuring + `emitDelegationEnd` call site updated to thread `priorLifetime` through.
- **`src/engine/dispatch-end.ts`**: `DelegationEndInput` gains `priorLifetime`; the new `deltaClamp` helper computes the per-run delta; the emit is `delegationsSchema: 1, delta, lifetime, runtime: runtimeSummary(...)`.
- **`src/engine/dispatch.ts:155-181`** (setup-failure path): the `emitSetupFailure` helper calls `emitDelegationEnd` without going through `runPromptAndFinalize`; it passes the runtime's current values as `priorLifetime` so the emitted delta is 0 (no new spend occurred during setup failure).
- **`tests/dispatch-usage.test.ts`**: 4 test sites updated for v1 contract — the per-run deltas test (line 420) now asserts `delegationsSchema: 1, delta, lifetime`; the W1.1 fresh-re-run test (line 478) now asserts `run2.delta` equals `run2.lifetime` (fresh prior is 0); the R3-1.1 restore-survives test (line 545) now asserts `run3.delta` equals the run-3-only growth (50/25/4/2/0.05); the Phase 4.8 reasoning test (line 595) now asserts `end.delta.reasoningTokens = 50`.

### Deviation from the brief

The brief said the dashboard ingestion layer at `src/observability/server/runtime.ts:550-571` and `src/observability/server/db.ts:862` is already correct for v1 (it reads `p.delta`). Confirmed: the dashboard reads `p.delta` when `delegationsSchema >= 1` and falls back to `runtime.*` only when `delta` is absent. With v1 events carrying both `delta` and `lifetime`, the dashboard uses `delta` (correct). No dashboard changes needed.

The brief listed "Update the event schema in `src/core/schema.ts` (or wherever the delegation payload schema lives)." There is no TypeBox or JSON schema for the delegation payload — `EventPayloadByType` in `src/shared/telemetry.ts:26` is a uniform `JsonRecord` per event type, and the runtime types are checked structurally at the dashboard's read site. No schema file to update.

**Trade-off flagged in the brief's terms:** the producer-side delta computation is non-trivial because reasoning tokens are accumulated during the run (from `message_end` events in `dispatch-subscribe.ts`), not from `getSessionStats()`. If `priorLifetime` is captured AFTER the prompt, the prior for reasoning includes the run's accumulated value, and the delta is 0. Solution: capture `priorLifetime` in `dispatch.ts` BEFORE the prompt runs. The capture is one-shot (6 field reads) and the test confirms the result. Documented in code comments at the capture site and at `PostPromptInput.priorLifetime`.

The brief also asked: "If the producer-side delta computation turns out to be non-trivial, document the trade-off in the commit message and flag it in the after-action report." This is that flag. The trade-off is: the capture point moved from `AgentRuntime.runStart*` (a per-runtime field, dropped by §1.1) to a per-run local in `dispatch.ts` threaded through `PostPromptInput` to `emitDelegationEnd`. The runtime stays clean (no §1.1 violations) at the cost of one extra parameter on the input struct.

## Fix C — `HiveState.budgetWarnings` deletion (MEDIUM)

Plan §1.1 explicit removal: "Dedup moves to `CustomEntry` walk."

**Approach:** deleted the field and the initialization. Grep found 2 hits (the declaration and the initializer) and no readers or writers — the field was never used.

- **`src/core/types.ts:348`**: `budgetWarnings?: Set<string>` removed.
- **`src/engine/state.ts:24`**: `budgetWarnings: new Set()` removed.
- `grep -rn "budgetWarnings" src/ tests/`: 0 hits after deletion. The brief's "zero hits" target met.

The brief said: "For each reader, migrate to the `CustomEntry` walk mechanism. Find the `CustomEntry` walk code (likely in the budget module) and replace `state.budgetWarnings.has(...)` calls with the new mechanism." There were no readers, so the `CustomEntry` walk was not needed for this deletion. The dedup mechanism lives in `policy.ts:checkBudgetPolicy` (which already walks the branch via `sm.getBranch()` to find `BudgetLedgerEntry` markers — the §1.1 CustomEntry walk for budget dedup).

## Fix D — Operator command stubs at `worker-tools.ts:515, 533, 541` (LOW)

**The brief's premise is wrong here.** The "stubs" are not dead code. Each is a runtime guard at the start of a fully-implemented function:

- `respawnWorkerSession` (line 515): `if (typeof agent === "string") throw new Error("not implemented");` followed by a real `WorkerContext` implementation that disposes the old session, creates a new `SessionManager`, branches the old leaf, and writes a `'respawn'` ledger entry. T5.3 tests in `tests/budget-eol.test.ts:701-817` exercise the full happy path + error paths.
- `snapshotWorkerSession` (line 533): same shape — guard for the unsupported string-arg input, then a real implementation that calls `branchWithSummary(leafId, label)` and writes a `'snapshot'` ledger entry. T5.5 tests in `tests/budget-eol.test.ts:821-879` cover the full path.
- `restoreWorkerSession` (line 541): same shape — guard, then a real implementation that calls the SDK chain `createBranchedSession → open → createAgentSession`, restores the `BudgetLedger`, and writes a `'restore'` ledger entry. T5.6 tests in `tests/budget-eol.test.ts:885-1111` cover the full SDK-ordering path.

The `"not implemented"` message is a **legitimate runtime guard** for an input shape the public surface does not support. The contract test in `tests/budget-contracts.test.ts:237-240` explicitly asserts the rejection:

```ts
await assert.rejects(workerTools.respawnWorkerSession("agent", "reason"), /not implemented/);
```

Per the brief's "do NOT fabricate implementations" rule, deleting the guard lines would break the contract test (and the rejection is intentional, not a leftover). I left the code unchanged. The brief's commit message `chore(budget): remove dead operator command stubs at worker-tools.ts (Fix D)` was not used because there were no dead stubs to remove.

**Region markers in `worker-tools.ts` are byte-identical** vs. `cb8b2fa`. Verified via `git diff cb8b2fa -- src/engine/budget/worker-tools.ts | grep "region:"` → no matches (the only changes to the file since `cb8b2fa` are Wave 6's Gap 4 stub deletion of the cooperative `request_*` exports at lines 575-577, which the brief acknowledged in the after-action report).

### Follow-up: nothing to do

The brief suggested this might be "a real gap, not a dead-stub deletion." It is neither — it is a working feature with full test coverage. The "stub" appearance is a `typeof agent === "string"` runtime check that rejects an unsupported input shape. No follow-up needed unless the user wants to ADD a real string-arg implementation (which would mean re-resolving a worker name to a `WorkerContext`, a separate feature).

## Fix E — Regression test for `budgetRemaining(state, runtime)` (MEDIUM)

Wave 6's Gap 3 (remaining.ts → policy.ts migration) changed `budgetRemaining` from "cumulative across runs" to "live mirror of the current session's lifetime." The function reads `runtime.inputTokens + runtime.outputTokens [+ cache* + reasoning]` (per the scope flag) directly from the runtime, and the runtime is overwritten from `getSessionStats` at run end (Wave 5A Decision 1).

**Approach:** 4 new tests in `tests/budget-policy.test.ts` (added as Test 12+ in the existing test sequence), each pinning a distinct aspect of the new semantics:

1. **Single running session** (`scope=all`): `runtime.inputTokens=700, output=300, cacheRead=100, cacheWrite=50, reasoning=25` → `rem.tokens = 2000 - 1175` (full lifetime used).
2. **Multiple completed runs** (`scope=all`): `runCount=3` but the lifetime totals reflect the current session (e.g., 900+400+200+100+50=1650 used). Pre-Wave-6 would have shown `cap - 3×1650 = 50` (cumulative across runs); post-Wave-6 shows `cap - 1650 = 3350` (current session only). The brief's "NOT cumulative across runs" requirement is pinned here.
3. **No session / no usage**: zeroed runtime → `rem = cap` (full budget remaining).
4. **`input_output` scope**: only `input + output` counts toward the tokens used; cache and reasoning are ignored.

Test count: 666 → 670 (+4).

## Final verification

| Gate | Status |
|---|---|
| `npx eslint src/engine/budget/ src/engine/dispatch.ts src/engine/dispatch-subscribe.ts src/engine/dispatch-lifecycle.ts src/engine/dispatch-end.ts` | **exit 0** |
| `npx eslint ui/web/src/components/TopologyGraph.tsx ui/web/src/lib/agents.ts tests/dashboard-helpers.test.ts tests/budget-policy.test.ts` | **exit 0** |
| `just typecheck` (core + bun + tests + dashboard) | **clean** |
| `just test` (Node) | **670/670 pass** |
| `worker-tools.ts` region markers vs. `cb8b2fa` | **byte-identical** (no Fix D changes) |
| `git push` / `gh pr create` activity | **none** (LOCAL-ONLY per project rules) |
| Dashboard dist rebuilt (Fix A) | **yes** — `just dashboard-build`; new hash `TopologyGraph-DCp8wyF7.js` |

## Test count delta

- Started: 666 Node tests passing on `608063b` (Wave 6 baseline)
- After Fix A: 666 (no test count change; `tests/dashboard-helpers.test.ts:tokPerSec` assertions were updated in place)
- After Fix B: 666 (no test count change; `tests/dispatch-usage.test.ts` assertions were updated in place for the v1 contract)
- After Fix C: 666 (no test count change; the field had no test coverage)
- After Fix D: 666 (no change — no commit)
- After Fix E: 670 (+4 — 4 new `budgetRemaining` regression tests)

## Files touched

**Fix A:**
- `src/core/types.ts` (-2: removed `runStartInputTokens?`, `runStartOutputTokens?` from `OrchestratorRuntime`)
- `src/engine/observability.ts` (-2: removed `runStart*` overlay reads)
- `src/integration/hooks.ts` (-2: removed `runStart*` writes in `setOrchestratorStatus`)
- `src/shared/telemetry.ts` (-7: removed `governanceTokens?`, `governanceCostUsd?`, `runStartInputTokens?`, `runStartOutputTokens?` from `TelemetryAgentRuntime`)
- `tests/dashboard-helpers.test.ts` (updated `tokPerSec` test assertions for new 3-arg signature)
- `ui/web/src/components/TopologyGraph.tsx` (removed `runStart*` args from `tokPerSec` call)
- `ui/web/src/lib/agents.ts` (removed `runStart*` params from `tokPerSec` signature; updated comment)
- `ui/web/dist/...` (rebuilt; new hash)

**Fix B:**
- `src/engine/dispatch.ts` (+ priorLifetime capture block, + `priorLifetime` arg to `runPromptAndFinalize` call, + setup-failure `priorLifetime` derivation)
- `src/engine/dispatch-lifecycle.ts` (+ `priorLifetime` field on `PostPromptInput`, + destructure, + pass to `emitDelegationEnd`)
- `src/engine/dispatch-end.ts` (+ `priorLifetime` field on `DelegationEndInput`, + `delta` computation, + emit `delegationsSchema: 1, delta, lifetime`)
- `tests/dispatch-usage.test.ts` (4 test sites updated to v1 contract)

**Fix C:**
- `src/core/types.ts` (-1: removed `budgetWarnings?: Set<string>` field)
- `src/engine/state.ts` (-1: removed `budgetWarnings: new Set()` initializer)

**Fix D:** *(no commit — see Deviations)*

**Fix E:**
- `tests/budget-policy.test.ts` (+4 regression tests for `budgetRemaining` live-mirror semantics; + 2 helper functions: `runtimeFor`, `stateFor`)

## Worktree state

Branch: `refactor/budget-completion-guard` (4 new commits on top of `608063b`)
Working tree: clean
Push/PR: none (LOCAL-ONLY)

## Open follow-ups (out of scope for this wave)

None new. Wave 6's open follow-ups (dashboard over-counting, telemetry schema fields) are now closed by Fix B (dashboard ingestion is correct for v1) and Fix A (telemetry schema no longer carries the §1.1 fields).
