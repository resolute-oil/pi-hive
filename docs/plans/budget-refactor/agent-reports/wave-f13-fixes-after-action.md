# Wave F13 fixes — after-action report

**Branch:** `refactor/budget-f13-fixes` (based off `refactor/budget-f13-dashboard @ 9de7b97`)
**Agent:** Wave 7 F13 fixup agent
**Brief:** implicit (per orchestrator handoff)
**Date:** 2026-10-02

## Summary

The plan-side audit caught two production-wiring blockers that the F1-F13 audit missed: (1) the engine writes `budget_warning` / `budget_exhausted` to the worker's session.jsonl but the dashboard reads only the parent's telemetry log, so the F13 `interventionAvailable` flag never reached the dashboard; (2) the dashboard server writes `operator-command-pickup.jsonl` but nothing drains the file, so the 11-button operator surface was producer-only. Both blockers are fixed in production wiring (not just tests), with regression-prevention tests that would have caught the F1-F13 audit's gaps.

## Commit hashes

| # | Hash | Subject |
|---|---|---|
| 1 | `f8537aa` | `fix(engine): emit budget_warning and budget_exhausted to parent telemetry log for dashboard consumption` |
| 2 | `3cf6e67` | `feat(extension): drain operator-command-pickup.jsonl and invoke operator commands (F13 consumer half)` |
| 3 | (this report) | `docs(wave-f13-fixes): save after-action report` |

## Blocker 1 — engine → dashboard telemetry pipeline

### What was done

- **`src/engine/budget/events.ts`** — `installBudgetEventHooks` now accepts an optional `state: HiveState` and `actor: string` (both backward-compatible — the existing 41+ test sites use the 4-arg form). When `state` is supplied, the warning and exhausted paths ALSO call `emitHiveEvent(state, "budget_warning" | "budget_exhausted", ...)` in addition to the legacy per-worker `sessionManager.appendCustomMessageEntry` / `appendCustomEntry` calls. The worker's sessionId is threaded through `payload.session_id` so the dashboard reducer can key per-worker (multiple workers can share a parent session).
- **`src/engine/budget/worker-tools.ts`** — `DelegateAgentInternals.installBudgetEventHooks` is re-typed to the new 6-arg signature. The `delegateAgent` call site passes `state` and `agentName` through. `resumeWorkerSession` and `restoreWorkerSession` pass the parent's state via the `__reloadAgentConfigState` binding (the F13 dashboard command path uses the same binding to resolve state).
- **`src/engine/dispatch-subscribe.ts`** — the stale comment claiming warnings "reach the dashboard via their own session manager appends" is corrected to point at `emitHiveEvent` and explain why the legacy path was invisible to the dashboard.
- **`ui/web/src/store/status.ts`** — `buildInterventionBySession` reducer prefers `payload.session_id` (the worker) over `e.session_id` (the parent) so multiple workers in one parent session get distinct map entries.
- **`ui/web/src/store/critical.test.ts`** — 1 new test pins the payload.session_id preference.

### Regression-prevention test

`tests/budget-telemetry-emit.test.ts` (5 tests) exercises the full pipeline: invoke `installBudgetEventHooks` against a real `HiveState` whose `session.observabilityLog` points at a temp file, fire a `message_end` that crosses the 20% warning threshold, then read the parent's log and assert the `budget_warning` event is there with the right payload (including `interventionAvailable`, `session_id`, `actor`). Without the fix the log is empty. A second test pins the legacy test seam (no state → no parent log emit) so existing tests keep working.

The fifth test pins the **dedup invariant**: 100 `message_end` events past the threshold produce exactly one `budget_warning` in the parent log. This is the dedup-by-`worker:tokens` key from the F3 brief, now extended to the dashboard-readable log.

## Blocker 2 — operator-command pickup consumer

### What was done

- **`src/integration/operator-pickup.ts`** (new, 297 LOC) — exports `pickupOperatorCommandRequests` (one-shot drain) and `startOperatorCommandPickup` / `stopOperatorCommandPickup` (session-scoped polling loop, 250ms cadence). The polling loop is started from the parent's `session_start` hook and torn down on `session_shutdown` (per AGENTS.md: long-lived processes must be started from a session hook, NOT the extension factory).
- **`src/integration/hooks.ts`** — `startOperatorCommandPickup(state, ctx)` is called from `session_start` (right after the hive-loaded notify); `stopOperatorCommandPickup()` is called from `session_shutdown` (first thing, before clearing the orchestrator snapshot timer).
- **`src/observability/server/http-handler.ts`** — the allow-list is updated to 12 commands (11 base + `hive_reload_agent_config` — the T13.0 follow-up the audit flagged as a natural add). The stale comment at line 150 referring to a "T13.3 future" pickup function is corrected to point at the new module.
- **`src/integration/operator-pickup.ts`** — command routing maps each row's `command` field to the matching `worker-tools.ts` operator function. Error handling is per-row (one failure does not block the others). `tear-down-all` iterates all live worker handles (force=false default — graceful end per worker, preserves resume-ability). `force-kill` / `force-end` unregister the handle after dispose (escape-hatch semantics). `hive_reload_agent_config` is allowed without a live worker handle (it operates on the static config in `state.config.agents`).

### Regression-prevention tests

`tests/operator-pickup.test.ts` (12 tests) covers:
1. Single-row drain (end → invokes `endWorkerSession`, file cleared).
2. Multi-row drain (end + pause — both invoked in order, file cleared).
3. Partial failure (one row with no live handle fails, others succeed, file cleared).
4. Idempotency (second pickup on cleared file is total=0).
5. `tear-down-all` iterates all live worker handles.
6. `force-kill` unregisters the handle (subsequent pause fails).
7. Malformed JSON rows are skipped (valid rows still drain).
8. Unknown command names are reported as failed (not thrown).
9. `hive_reload_agent_config` is in the allow-list (and does not require a live worker handle).
10. **End-to-end integration** (producer writes a row, consumer drains it, file is cleared).
11. `startOperatorCommandPickup` / `stopOperatorCommandPickup` idempotency.
12. `operatorCommandQueuePath` resolves to `<hive-dir>/operator-command-pickup.jsonl` (path-shape regression guard).

## Deviations

- **`hive_reload_agent_config` was added to the allow-list** (per the audit's "Also consider" section). The audit said "only if it's bounded work" — it was bounded: 4 lines of new routing code, 1 new test. The allow-list grows from 11 to 12; the existing `server-routes.spec.ts` test still passes because it only tests one of the 11 commands and a rejection path (the new command is in the same allow-list shape, so no test changes are needed).
- **`restore` command returns a "not yet supported" error** in the consumer — the dashboard UI does not surface a restore-with-id flow, so the routing is defensive. The audit said the consumer must be "idempotent (don't re-invoke the same row twice) and bounded (don't run forever without pause)" — both are met. A future dashboard UI can add a snapshot-picker and the consumer can support restore-with-id by reading the snapshot id from the row payload.

## Verification gates

| Gate | Status |
|---|---|
| `just typecheck` (4 projects: core / bun / tests / dashboard) | clean |
| `just test` (Node) | **693 pass**, 0 fail (+17 vs baseline 676) |
| `bun test tests/server-routes.spec.ts` | **11 pass**, 0 fail (unchanged) |
| `just dashboard-build` | clean (570 modules, 0 warnings beyond chunk-size advisory) |
| `cd ui/web && npm run test:unit` | **60 pass**, 0 fail (+1 vs prior 59 — new reducer test) |
| `npx eslint` on touched files | 0 errors, 53 pre-existing `any` warnings in `db.ts` unchanged |

## Test count delta vs pre-Wave-7 baseline (676 Node)

| Change | Δ |
|---|---|
| `tests/budget-telemetry-emit.test.ts` (Blocker 1) | +5 |
| `tests/operator-pickup.test.ts` (Blocker 2) | +12 |
| Vitest reducer test for payload.session_id preference | +1 |
| **Net Node** | **+17 (676 → 693)** |
| Vitest dashboard | +1 (59 → 60) |
| Bun `server-routes.spec.ts` | 0 (still 11) |

## Risks / unresolved follow-ups

- **T13.3 mode-independence is structural-only**, per the plan-side audit. The F13 brief was approved with structural parity (TUI / RPC / print / JSON modes all work because the operator commands take only `(agent, ...)` and the dashboard server's `/operator-command` accepts the JSON payload regardless of which pi mode the parent runs). A real smoke test in all 4 modes is out of scope for Wave 7 — that work is the `tests/f13-mode-independence.test.ts` shape (4 contract tests) plus a future live verification by a human session.

- **`restore` operator command is a stub** in the consumer. The dashboard UI does not surface a snapshot-picker; a future UI can add this and the consumer can support restore-with-id by reading the snapshot id from the row payload (the row currently does not carry one — the dashboard's payload contract would need to grow). Flag for the next session.

- **Idempotency of the consumer is "drain + unlink"**, not per-row tracking. If the parent pi crashes between invoke and unlink, the next pickup re-invokes. The F13 brief accepts this — the operator sees the failure on the dashboard and re-issues. A more robust design would track per-row status in a separate file; that's out of scope for Wave 7.

- **Consumer does not own a process lock**. Two concurrent parent-pi sessions polling the same file would both see the rows; the first unlink wins, the second reads an empty file (no double-invocation). A cross-process file lock would be defensive but the F1-F13 design assumes a single parent pi session per DB.

- **T13.0 `hive_reload_agent_config` operator command requires a bound state + ctx** (the F13 `bindReloadAgentConfigState` wiring). When unbound (e.g., a session that has not dispatched any worker), the command returns `reloaded=false` with a clear error message. The consumer surfaces this as a per-row failure; the dashboard UI is expected to handle the failure gracefully.

## Worktree state

Branch: `refactor/budget-f13-fixes` (2 new commits on top of `9de7b97`)
Working tree: clean
Push/PR: none (LOCAL-ONLY per project rules)
