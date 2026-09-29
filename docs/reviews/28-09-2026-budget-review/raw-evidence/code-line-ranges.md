# Code line ranges — every budget-relevant line

This file is the index of every budget-relevant line of code in the current `feat/budget-strategy` HEAD (`9f950fb`). Use it as a lookup table when reading `current-flow/*.md` or any other doc in this review.

All citations are `path:line` form against `feat/budget-strategy` at `9f950fb`.

## `src/engine/governance.ts` — budget math (175 LOC total)

| Lines | What it does |
|---|---|
| `1-13` | Imports and the `BudgetRemaining`, `GovernanceBlock`, `TokenScope` types. |
| `15-19` | `TokenScope` union and the `runtimeTokens` helper that scopes tokens by "input_output" vs "all". |
| `20-22` | `effectiveWorkerGovernance` — merges `state.config.settings.workerBudgets` with `runtime.config.governance`. Per-agent override wins. |
| `24-31` | `runtimeTokens` helper used by `workerConsumedTokens` and `workerConsumedCost`. |
| `33-58` | `workerConsumedTokens` — the dual-counter picker. **Critical.** |
| `60-70` | `workerConsumedCost` — symmetric with `workerConsumedTokens` (live while running, frozen after). |
| `72-103` | `teamUsage` + `budgetRemaining` + `checkDispatchBudgets` — the eight-condition budget guard. |
| `105-138` | `acquireWorkerSlot` — worker-slot semaphore with optional FIFO queue. |
| `140-156` | `releaseWorkerSlot`, `cancelWorkerQueue`. |

### Bug-pinning comments to read in this file

- `workerConsumedTokens` at lines 33-58 has a 17-line comment explaining the Bug 2 fix (mid-run live path). The decision (status === "running" → live; otherwise → frozen ?? live) is encoded in 6 lines of code but 17 lines of comment.

## `src/engine/budget-strategy.ts` — strategy application (200 LOC total, NEW in `feat/budget-strategy`)

| Lines | What it does |
|---|---|
| `1-13` | File-level comment summarizing the wire. |
| `15-20` | `DEFAULT_PROGRESS_SUMMARY_TOKEN_LIMIT = 2000`. |
| `22-26` | `estimateProgressTokens` — cheap 4-chars-per-token heuristic. |
| `28-30` | `BudgetWarningInfo` type. |
| `32-36` | `resolveBudgetStrategy` — settings-level + runtime-override resolution. |
| `38-43` | `progressSummaryTokenLimit` — config resolution with defensive clamp. |
| `45-69` | `applyBudgetStrategy` — returns the prompt hint for the resolved strategy. |
| `71-76` | `shouldInterveneAvailable` — gates operator commands under "default" strategy. |
| `78-117` | `emitBudgetWarning` — emits the event AND mutates `runtime.systemPrompt` with the hint (sentinel-deduped). |
| `119-135` | `validateProgressNotes` — size cap check. |
| `137-180` | `triggerSummarizeProgress` — stores notes, conditionally triggers `session.compact(notes)`. |

## `src/engine/dispatch.ts` — the central flow (key sections only)

### Budget-relevant pre-dispatch (`src/engine/dispatch.ts`)

| Lines | What it does |
|---|---|
| `73-110` | `freshResetRuntime` — archives prior session + zeros all counters. |
| `188-201` | `dispatchAgent` signature. |
| `207-211` | `resolveRuntime` lookup. |
| `213-214` | `if (fresh) { reloadAgentConfig; freshResetRuntime }` — Bug 1 fix location. |
| `252-258` | First `checkDispatchBudgets` call. |
| `277-293` | `acquireWorkerSlot`. |
| `295-296` | `slot` result handling. |
| `302-309` | **Second** `checkDispatchBudgets` call (post-queue). |
| `316-325` | `runtime.governanceTokens ??= <initial value>` — initial governance accounting. |
| `929-944` | Operator command exports — `OperatorAction`, `OperatorCommandResult`, `findWorkerRuntime`. |
| `946-968` | `endWorkerSession`. |
| `970-1004` | `compactWorkerSession`. |
| `1006-1099` | `respawnWorkerSession`. |

### Budget-relevant event handlers (in `session.subscribe` callback)

| Lines | What it does |
|---|---|
| `527-533` | `compaction_start` handler. |
| `535-633` | `compaction_end` handler — recalculates team total via `effectiveTokens` debit. |
| `646-708` | `message_end` handler — live accumulation + warning + abort at 0%. |
| `707-714` | `agent_end` handler — final message accumulation (no usage math here). |
| `780-815` | `getSessionStats()` overwrite — **the order in this block is the Bug 3 hypothesis location.** |
| `858-866` | `governanceTokens += delta` — end-of-run accumulation. |
| `867-868` | `governanceCostUsd += delta`. |

### Worker-slot and budget wiring

| Lines | What it does |
|---|---|
| `364-371` | `runtime.runCount++` and per-run state setup. |
| `392-396` | `runStart*` baseline capture. |
| `450-455` | `abortWorker` (called from `lifecycle.watchParentAbort`). |
| `727-758` | `session.prompt(...)` inside `runAtDelegationDepth` / `runAsAgent` / `runWithChange`. |
| `850-880` | End-of-run bookkeeping, delegation_end event emission. |

## `src/agents/tools/summarize-progress.ts` — the tool (117 LOC, NEW)

| Lines | What it does |
|---|---|
| `1-11` | File-level comment. |
| `13-22` | Imports and the tool's TypeBox parameter schema. |
| `24-27` | `compactOutcomeMessage` helper. |
| `37-104` | `buildSummarizeProgressTool` — returns the tool definition with `execute`, `renderCall`, `renderResult`. |
| `42` | Tool name `summarize_progress`. |
| `43-51` | Description and parameters. |
| `52-103` | `execute()` implementation — runtime lookup, validation, call to `triggerSummarizeProgress`. |
| `105-110` | `renderCall` — header + preview of the first line of notes. |
| `111-117` | `renderResult` — compact one-line summary. |

## `src/agents/tools.ts` — registration

| Lines | What it does |
|---|---|
| `16` | Imports `buildSummarizeProgressTool`. |
| `363-367` | Registers `summarize_progress` for ALL callers (workers and orchestrator). |

## `src/core/types.ts` — type definitions

| Lines | What it does |
|---|---|
| `13` | `AgentStatus` union. |
| `180-205` | `WorkerGovernance` interface — all the budget strategy fields. |
| `207-214` | `TeamBudgets` interface. |
| `215-244` | `HiveSettings` interface — `workerBudgets` and `teamBudgets` are here. |
| `222-273` | `AgentRuntime` interface — the budget-relevant fields: `governanceTokens`, `governanceCostUsd`, `effectiveTokens`, `progressNotes`, `runStart*`. |

## `src/core/schema.ts` and `src/core/config-validation.ts` — validation

### `src/core/schema.ts`

| Lines | What it does |
|---|---|
| `36-43` | `validateGovernance` — the schema-level governance validator. |
| `130-138` | `validateAgent` — calls `validateGovernance` for `agent.governance`. |
| `160-161` | `validateHiveConfigShape` — calls `validateGovernance` for `settings.workerBudgets`. |

### `src/core/config-validation.ts` (different file, different schema)

| Lines | What it does |
|---|---|
| `34-37` | `BUDGET_STRATEGIES = ["default", "compact"]` — the only allowed strategies. |
| `44-47` | `GOVERNANCE_KEYS` — the allowed governance keys at config-load time. |
| `49-62` | `governance` validator — positive-integer / positive-number / string-enum checks. |
| `156-172` | `validateRawConfig` — calls `governance(settings.workerBudgets, ...)`. |
| `160-169` | Validates `settings.teamBudgets` separately. |

## `src/ui/tui/widget.ts` — display

| Lines | What it does |
|---|---|
| `11` | Imports `budgetRemaining` from `engine/governance`. |
| `280-290` | `teamRemaining` calculation in the dashboard widget. |

## `src/engine/prompts.ts` — prompt injection

| Lines | What it does |
|---|---|
| `6` | Imports `budgetRemaining`. |
| `128-130` | Calls `budgetRemaining(state, runtime)` to inject budget visibility into the worker prompt. |

## `src/engine/observability.ts` — telemetry emission

| Lines | What it does |
|---|---|
| `13` | Imports `budgetRemaining`. |
| `119-135` | `runtimeSummary` — surfaces `governanceTokens` and `budgetRemaining` in the snapshot. |

## `src/engine/session.ts` — mode-switch restore

| Lines | What it does |
|---|---|
| `244-290` | The mode-switch restore logic. Line 271 (`governanceTokens: Number(rt.governanceTokens ?? ...)`) and line 288 (`runtime.governanceTokens = p.governanceTokens`) are where the runtime state is rebuilt across a mode switch. This is the path the **R3-1.1 regression test** exercises (mode switch after a fresh run must not resurrect old totals). |

## `src/engine/distiller.ts` — distillation budget

| Lines | What it does |
|---|---|
| `141` | Emits `budget_exhausted` for distiller runs (separate resource: `distillerRuns`). |

## `src/shared/telemetry.ts` — event types

| Lines | What it does |
|---|---|
| `62-63` | The `budget_warning` and `budget_exhausted` event types. |
| `182` | `governanceTokens?: number` field on the telemetry payload. |
| `199` | `budgetRemaining?: { worker, team }` field. |

## `src/observability/server/runtime.ts` — materialization

| Lines | What it does |
|---|---|
| `623-624` | Cases for `budget_warning` and `budget_exhausted` — **no-op**. The events are streamed live to the dashboard but not materialized into SQLite tables. The dashboard reads the live telemetry JSONL stream. |

## Tests

### `tests/governance.test.ts` (167 LOC, 9 tests)

| Line | Test name |
|---|---|
| `25-39` | worker governance unlimited when omitted; per-agent overrides |
| `41-60` | worker + team budgets block independently |
| `62-67` | monotonic governance usage prevents fresh transcript reset from bypassing budgets |
| `69-94` | FIFO queue + cancellation |
| `96-114` | parallel cap without queue; queued cancellation frees capacity |
| `131-138` | `tokenBudgetScope: input_output` excludes cache |
| `140-146` | `tokenBudgetScope: all` (default) keeps cumulative |
| `148-159` | team scope independent of worker scope |
| `161-167` | `tokenBudgetScope` defaults to `all` (backward compat) |

### `tests/budget-strategy.test.ts` (667 LOC, ~38 tests, NEW in `feat/budget-strategy`)

Coverage areas:
- Strategy resolution (default vs compact vs override).
- `emitBudgetWarning` event emission and prompt mutation.
- `summarize_progress` validation (size cap, no_runtime, compact_failed).
- Operator commands (`endWorkerSession`, `compactWorkerSession`, `respawnWorkerSession`).
- Compaction recalc (savings math, no-op on missing fields).
- Respawn (old runtime gone, new runtime created, team_budget_recalculated event).
- Config validation rejection (unknown strategy value).

### `tests/dispatch-usage.test.ts` (835 LOC)

| Line | Test name | Pins |
|---|---|---|
| `385-430` | Bug 1 regression: fresh=true zeros counters before checkDispatchBudgets | the ordering fix |
| `489-535` | W1.1: fresh re-run resets lifetime counters; delta is fresh session's usage, not clamped ~0 | the W1.1 fix |
| `544-585` | R3-1.1: fresh-delta survives mode-switch restore | the R3-1.1 fix |
| `804-835` | Resumed session (fresh=false, existing transcript) gets lean task only | fix #3b |