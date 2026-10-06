---
title: Context-window-fill budget constraint strategy
type: refactor
wave: context-constraint
date: 2026-10-02
status: ready-for-implementation
---

# Wave context-constraint — Context-window-fill budget strategy

## Goal

Add a `context` budget constraint to `WorkerBudgetPolicy` and `BudgetsConfig` that gates on the SDK's `ContextUsage` (what the LLM is currently looking at), configurable as either a nominal cap (e.g., "stop at 100K tokens of context") or a percentage of the context window (e.g., "stop at 80% fill"). **The existing `tokens` constraint stays intact — this wave is purely additive.**

The user's motivation: "tokens do not line up nicely with context usage." The `tokens` cap measures cumulative cost across the session; the `context` cap measures the LLM's current view of the conversation. Both are useful — they answer different questions.

## Source of truth & operating conventions

**Consult in this order:** this brief → `../refactor-plan/docs/reviews/28-09-2026-budget-review/04-refactor-plan.md` (§2.5 cap-shape, §2.6 strategies, §2.10 nested shape) → `../refactor-plan/docs/reviews/28-09-2026-budget-review/06-final-review.md` (F13 promotion precedent) → `docs/migrations/budget-config-v2.md` (the existing migration guide) → `docs/plans/budget-refactor/wave-f13-dashboard.md` (template for brief structure).

**Disagreement rules:** brief vs. plan → **plan wins** (brief is a summary). Plan vs. review → **review wins** for walkthrough-touched items. Still unclear → surface via `ask_user` (inline mode per AGENTS.md).

**Worktree init:** per-phase worktree under `APP_ROOT/.worktrees/refactor-budget-context-constraint/`, **based off `refactor/budget` (NOT `main`, NOT a remote ref)**. **Do NOT symlink `node_modules`** from APP_ROOT — APP_ROOT pins SDK 0.80.7 vs worktree 0.99.1; run `just install` independently.

**Stale-process trap:** after editing `src/engine/budget/**`, `src/engine/dispatch.ts`, `src/engine/dispatch-lifecycle.ts`, `src/observability/server/**`, or `src/engine/review.ts`: `PID=$(lsof -nP -iTCP:43191 -sTCP:LISTEN -t) && kill "$PID"; just pi-dev`.

**Marking done:** flip `[ ]` → `[x]` in this brief's Tasks table **at commit time, in the same commit** that lands the task. Future sessions read this brief before HANDOFF.md.

**Branches:** stay local per LOCAL-ONLY — no `git push`, no PR.

## Design decisions (locked)

1. **Data source** — `session.getContextUsage().tokens` (SDK's purpose-built "what the LLM is currently looking at" field). NOT `stats.tokens.input`, NOT cumulative.
2. **Context update cadence** — call `getContextUsage()` at every `message_end` event (not just run end), so the runtime's `contextTokens`/`contextPct` fields stay current mid-run.
3. **Both `tokens` and `context` apply when both are set** — the worker is blocked when either fires. They are not mutually exclusive.
4. **`include` list does NOT apply to `context`** — `getContextUsage().tokens` is a single coherent number from the SDK; including the `include` list would be double-counting.
5. **Per-dimension exhaustion strategies** — tokens and context each have their own exhaustion action. The `Strategies` config gains two new optional fields, `onTokenExhaustion` and `onContextExhaustion`, that override the global `onExhaustion` for their respective dimension. The global `onExhaustion` remains the default for any dimension without a specific override. Backward compat: existing configs that only set `onExhaustion` apply the same action to both dimensions.
6. **`interventionAvailable` flag is per-dimension** — the F13 wiring currently uses a single flag computed from both dimensions. The new per-dimension strategies mean the flag must be computed per-dimension too (e.g., a worker in `tokens: abort, context: compact` mode should have `interventionAvailable: true` for the token warning, since the operator can still rescue on the token side). The `budget_warning` event payload includes the flag for the dimension that fired.

## Scope

**In scope:**

- T1 — **Type + schema additions.** Add `ContextConstraint` type:

  ```ts
  type ContextConstraint = 
    | { tokens: number }      // nominal: stop when getContextUsage().tokens >= tokens
    | { percent: number }    // percentage of context window, 0-100 scale (e.g. 80 means 80% full, NOT 0.80)
    | undefined;
  ```

  Add `context?: ContextConstraint` to `WorkerBudgetPolicy.worker`, `WorkerBudgetPolicy.team`, and `BudgetsConfig.perWorker`/`perTeam`. Files: `src/core/types.ts`, `src/core/schema.ts`. Typebox validation: `percent` field has `minimum: 0, maximum: 100`; reject configs with both `tokens` and `percent` set, or neither set, on the same constraint object.

  Also extend the `Strategies` type to add per-dimension exhaustion overrides:

  ```ts
  type Strategies = {
    onApproachingLimit?: { threshold?: number; action?: "wrap-up" | "compact" | "none" };
    onExhaustion?: { action: "abort" | "compact" | "none" };
    onTokenExhaustion?: { action: "abort" | "compact" | "none" };    // NEW — overrides for tokens
    onContextExhaustion?: { action: "abort" | "compact" | "none" };  // NEW — overrides for context
  };
  ```

  Validation: each field is optional. The resolver falls back to the global `onExhaustion.action` (then to `"abort"`) when the per-dimension field is absent. Backward compat: existing configs without the new fields work unchanged.
- T2 — **Policy resolver.** `resolveWorkerBudgetPolicy` surfaces the `context` field from the global `BudgetsConfig` + per-agent `governance` overrides (per-agent wins, matching the existing merge rules). Files: `src/engine/budget/strategy.ts`.
- T3 — **Context update cadence.** Move the `getContextUsage()` call from run-end-only (`src/engine/dispatch-lifecycle.ts:127-130`) to also fire at every `message_end` event. The runtime's `contextTokens`/`contextPct`/`contextWindow` fields must stay current so the mid-run tool-call gate can use them. Files: `src/engine/dispatch-lifecycle.ts`, `src/engine/budget/events.ts`.
- T4 — **Pre-flight gate.** Add a `checkContextConstraint` branch to `checkBudgetPolicy`. The gate reads `session.getContextUsage()` and compares against `worker.context.tokens` (nominal) or `worker.context.percent` (percentage, 0-100 scale — multiply the SDK's `getContextUsage().percent` by 100 to compare, OR compute `(ctx.tokens / ctx.contextWindow) * 100 >= worker.context.percent`). Files: `src/engine/budget/policy.ts`.
- T5 — **Tool-call handler.** Add a context check alongside the existing tokens check in `buildBudgetToolCallHandler`. Same logic: nominal cap OR percentage cap. Files: `src/engine/budget/events.ts`.
- T6 — **Display.** `budgetRemaining` exposes `context.tokens` (current value) and `context.percent` (current fill). The existing `formatContextFill` helper at `src/agents/tools.ts:79` can be reused. Files: `src/engine/budget/policy.ts`, `src/agents/tools.ts`.
- T7 — **Strategy interaction.** Per-dimension exhaustion action resolution:
  - New `resolveExhaustionAction(policy, dimension: "tokens" | "context")` helper in `src/engine/budget/policy.ts`. Returns `policy.strategies.onTokenExhaustion?.action ?? policy.strategies.onExhaustion?.action ?? "abort"` for tokens; same shape with `onContextExhaustion` for context. Pure function, no SDK calls.
  - The existing `resolveStrategies` in `src/engine/budget/events.ts` is updated to either (a) take a dimension parameter and return the per-dimension action, or (b) be split into `resolveStrategies(policy, "tokens")` and `resolveStrategies(policy, "context")` calls at the message_end site. Pick whichever keeps the diff smaller.
  - The `interventionAvailable` flag becomes per-dimension: `dimensionExhaustionAction !== "compact" && dimensionApproachingAction !== "compact"`. The `budget_warning` event payload includes the flag for the dimension that fired.
  - The existing tokens warning block in `message_end` uses the tokens dimension. The new context warning block (T7.5) uses the context dimension. Both dual-emit with their dimension-specific `interventionAvailable` flag.
  - The `controller.abort(...)` call for tokens exhaustion respects the per-dimension action. The same for context exhaustion.
  - Files: `src/engine/budget/events.ts`, `src/engine/budget/policy.ts`.
- T7.5 — **Context warning path.** Mirror the existing tokens warning block in `message_end` for the new context constraint, so the worker LLM gets advance notice before the gate aborts. Specifically:
  - Compute `ctxUsage = session.getContextUsage()`. If `tokens == null` or `contextWindow == 0`, skip (graceful handling — same as the gate).
  - For nominal `context.tokens`: warn at `warningThreshold` of the cap (same as tokens — `ctxUsage.tokens / context.tokens >= 1 - warningThreshold`).
  - For percentage `context.percent` (0-100 scale): warn at `warningThreshold` of the percentage cap (`(ctxUsage.tokens / ctxUsage.contextWindow) * 100 >= context.percent * (1 - warningThreshold)`).
  - **Dual-emit** the warning (mirrors tokens): `sessionManager.appendCustomMessageEntry("budget_warning", messageText, true, warningDetails)` so the worker LLM sees it on the next turn AND `emitHiveEvent(state, "budget_warning", warningDetails, emitActor)` for the dashboard/Orchestrator.
  - **Dedup key:** `"worker:context"` (separate from `"worker:tokens"` so each warning fires once per session).
  - **Warning message text:** `"Worker context at X% of cap. Consider calling summarize_progress to record completion intent, or the orchestrator may compact/respawn."` (note: `X%` is the current fill, computed once and inserted).
  - **`budget_warning` event payload:** `{ scope: "worker", resource: "context", remaining, cap, interventionAvailable, session_id: workerSessionId }` (`cap` is the nominal tokens OR the percentage, depending on which flavor).
  - **Exhaustion also gets the dual-emit path:** same `onExhaustion.action` dispatch (abort / compact / none) as tokens. Already covered by T7; this task extends T7's coverage to the warning emit, not just the exhaustion emit.
  - **Edge case:** if `strategies.onExhaustion.action === "compact"`, the warning still fires (worker should know context is filling), but the abort is skipped (T7 handles this).
  - Files: `src/engine/budget/events.ts`.
- T8 — **Tests.** Cover all new behavior:
  - Nominal cap fires at the right threshold
  - Percentage cap fires at the right fill level
  - Both `tokens` and `context` apply (worker blocked by either)
  - `include` list does NOT apply to `context` (pinned)
  - Mid-run tool-call handler respects context
  - `getContextUsage()` returns `null` tokens — graceful handling (no block, just skip the check)
  - Per-team context aggregate (sum across workers)
  - Migration: existing configs without `context` keep working unchanged
  Files: `tests/budget-policy.test.ts`, `tests/budget-events.test.ts`, `tests/budget-races.test.ts`, `tests/budget-contracts.test.ts`.
- T9 — **Migration guide update.** Document the new `context` field in `docs/migrations/budget-config-v2.md` with examples (nominal, percentage, both) and the "additive" guarantee (no breaking changes). Files: `docs/migrations/budget-config-v2.md`.

**Out of scope:**

- Removing or modifying the existing `tokens` cap (additive only)
- New strategies (`abort`/`compact`/`none` are reused; no new strategy enum)
- Dashboard UI for context (the existing `formatContextFill` already surfaces it; new UI is its own wave)
- LLM tool for context introspection (the existing `hive_explain_rejection` should be checked — does it surface context? If not, that's a follow-up)

## Tasks

Tasks must complete in order (T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9). T1-T2 are small foundations; T3 is a cross-cutting change; T4-T5 are the enforcement; T6-T7 are display/strategy; T8-T9 are verification + docs.

| Task | Description |
|---|---|
| [x] T1 | Type + schema additions for `ContextConstraint`. Gate: `just typecheck` clean; `grep -rn "ContextConstraint" src/core/types.ts` returns the new type |
| [ ] T2 | Policy resolver surfaces `context`. Gate: `just typecheck` clean; unit test asserts a config with `context: { tokens: 100_000 }` resolves to the expected policy shape |
| [ ] T3 | Context update cadence — `getContextUsage()` at every `message_end`. Gate: existing tests still pass; new test asserts `runtime.contextTokens` updates within one event of `message_end` |
| [ ] T4 | Pre-flight gate context check. Gate: 3 new tests in `budget-policy.test.ts` — nominal cap, percentage cap, both-cap (tokens + context) |
| [ ] T5 | Tool-call handler context check. Gate: 2 new tests in `budget-events.test.ts` — nominal + percentage |
| [ ] T6 | Display — `budgetRemaining` exposes context state. Gate: existing dashboard tests still pass; new test asserts `budgetRemaining` returns the context fields |
| [ ] T7 | Strategy interaction — `onExhaustion.action` and `interventionAvailable` work for context. Gate: 2 new tests asserting both behaviors |
| [ ] T7.5 | Context warning path — `message_end` emits `budget_warning` (with `resource: "context"`) when context crosses the warning threshold, with dual-emit (custom message + HiveTelemetryEvent) and dedup key `"worker:context"`. Gate: 2 new tests in `budget-events.test.ts` — nominal cap warning, percentage cap warning; both verify the worker session receives the custom message and the parent telemetry log receives the event |
| [ ] T8 | All tests. Gate: `just test` passes; test count delta recorded in Test delta section below |
| [ ] T9 | Migration guide update. Gate: `docs/migrations/budget-config-v2.md` has the new section; example configs compile (validated by `just typecheck` on the doc-test path if one exists) |

## Files touched

**Modified (in `src/core/`):**
- `types.ts` — `ContextConstraint` type, `WorkerBudgetPolicy.worker.context`, `WorkerBudgetPolicy.team.context`, `BudgetsConfig.worker.context`, `BudgetsConfig.team.context`
- `schema.ts` — typebox schema accepts the new `context` field

**Modified (in `src/engine/budget/`):**
- `strategy.ts` — `resolveWorkerBudgetPolicy` surfaces `context`
- `policy.ts` — `checkBudgetPolicy` context branch, `budgetRemaining` exposes context, new helper `checkContextConstraint(stats, contextWindow, config)` (or inline branch)
- `events.ts` — `buildBudgetToolCallHandler` context check, `installBudgetEventHooks` `message_end` calls `getContextUsage()` and updates `runtime.contextTokens`/`contextPct`/`contextWindow`; **new context warning block (T7.5)** that mirrors the existing tokens warning block with the dual-emit pattern + `"worker:context"` dedup key

**Modified (in `src/engine/`):**
- `dispatch-lifecycle.ts` — `getContextUsage()` call stays at run end (or moves entirely to message_end if T3 consolidates; the brief allows either)

**Modified (in `src/agents/`):**
- `tools.ts` — `formatContextFill` may need a small update if the new field names differ; verify in T6

**Modified (in `tests/`):**
- `budget-policy.test.ts` — 3 new tests (T4)
- `budget-events.test.ts` — 2 new tests (T5), 1 new test (T3 cadence)
- `budget-races.test.ts` — 1 new test pinning that `include` does not apply to context
- `budget-contracts.test.ts` — 1 new test pinning the additive contract (existing configs work unchanged)

**Modified (in `docs/`):**
- `migrations/budget-config-v2.md` — new section documenting `context` field

## Sub-agent roster

Single agent (`refactor/budget-context-constraint`). The 9 tasks touch 6 source files + 4 test files + 1 doc. The work is sequential (later tasks depend on the type/resolver work in T1-T2), so a single agent is appropriate. If the agent exhausts its 300-turn budget, the pickup protocol from `HANDOFF.md` §6 applies: produce a thorough pickup report, dispatch a continuation agent with that report as the brief.

| Agent | Branch | Worktree |
|---|---|---|
| Context-constraint | `refactor/budget-context-constraint` | `.worktrees/refactor-budget-context-constraint/` |

**Worktree node_modules.** Per `tmp/HANDOFF-pickup.md` §2: "Don't symlink `node_modules` from APP_ROOT (SDK version mismatch). Each worktree needs its own `just install`." The context-constraint worktree needs its own `just install` for the latest `node_modules`.

## Gates

- All 9 task checkboxes (T1-T9) marked
- `just typecheck` clean (5 tsc invocations: core, tests, bun, web, and the source for the worktree)
- `just test` clean — test count delta recorded in Test delta below
- `just dashboard-build` clean
- `npx eslint` on touched files — 0 errors
- Existing tests still pass (the additive guarantee is the central gate — nothing breaks)

**Cross-cutting gates (per `04-refactor-plan.md` overall completion guard):**

- Backward compatibility: existing `tokens`-only configs work unchanged
- Strategy compatibility: `onExhaustion.action` works for context (not just tokens)
- Display compatibility: `team_status` exposes context state in the existing `budgetRemaining` shape

## Risks

- **SDK contract drift.** `session.getContextUsage()` is a relatively new SDK surface. If the SDK's `ContextUsage` shape changes in a future version, the constraint silently breaks. Pin the shape with a typebox schema and a unit test against a fake.
- **`getContextUsage()` returning `null` tokens.** Per the SDK contract, `tokens: number | null` (null when "right after compaction, before next LLM response"). The gate must skip the check gracefully — not block, not crash. The implementation must check for `null` explicitly. Tests cover this case (T8).
- **Per-worker `getContextUsage()` may not be available in all runtimes.** If the SDK doesn't expose it for a specific mode (TUI vs RPC vs print vs JSON), the gate falls back to "no context constraint applied." Document this. Tests don't cover this — the SDK is mocked.
- **Strategy interaction with `interventionAvailable`.** The F13 wiring uses `onExhaustionAction !== "compact" && onApproachingLimitAction !== "compact"` to set the flag. If the context constraint fires under a different code path, the flag may not be set. The T7 task explicitly tests this.
- **Per-dimension `interventionAvailable` semantics (T7).** With per-dimension strategies, the flag must be computed per-dimension too. A worker in `tokens: abort, context: compact` mode has `interventionAvailable: true` for the token warning (operator can still rescue) and `interventionAvailable: false` for the context warning (system handles it). The `budget_warning` event payload includes the flag for the dimension that fired, not a single global flag. Tests must cover the per-dimension computation.
- **Warning message text (T7.5).** The warning text mentions `summarize_progress` and "the orchestrator may compact/respawn" — these are the worker LLM's documented responses. The text must be informative without being prescriptive (different workers may have different completion semantics). The implementer should match the tone of the existing tokens warning at `events.ts` (informative, suggests `summarize_progress`, doesn't force a specific action).
- **Backwards compat for `getContextUsage()` frequency change.** Moving the call from run-end-only to every `message_end` increases the per-event cost. Profile a long-running worker to confirm the overhead is negligible.
- **Stale-process trap.** T3, T4, T5, T6, T7 all touch `src/engine/budget/**` and may touch `src/engine/dispatch.ts` (indirectly). Per AGENTS.md: kill the dev server before re-running.

## Test delta

- New: ~14 tests across 4 test files
- Modified: 0 existing tests should change (additive — the existing tests don't use `context`)
- Target: 732 + ~17 = **~749 Node tests** + 63 vitest (unchanged) + 14 bun (unchanged)
- Per-test breakdown:
  - T1: 0 (covered by `just typecheck`)
  - T2: 1 (resolver unit test)
  - T3: 1 (cadence test)
  - T4: 3 (nominal, percentage, both)
  - T5: 2 (nominal, percentage)
  - T6: 1 (display test)
  - T7: 5 (strategy + per-dimension exhaustion: 2 existing + 3 new — `onTokenExhaustion` override, `onContextExhaustion` override, `interventionAvailable` per-dimension)
  - T7.5: 2 (nominal cap warning, percentage cap warning — both verify dual-emit)
  - T8: 1 (`include` does not apply; 1 contract test for backward compat)
  - T9: 0 (covered by `just typecheck` on the doc-test path)

## Notes

- **Additive only.** This is the central design decision. The user explicitly said: "I don't want to get rid of the token config/implementation. I want to enhance the config/implementation with a context constraint strategy." If an implementer feels tempted to consolidate `tokens` and `context` into a single "spend" cap, surface the temptation in the after-action report and DO NOT do it. They are distinct concepts.
- **`percent` uses the 0-100 scale, not 0-1.** A value of `80` means 80% of the context window. The implementer must NOT use the SDK's `getContextUsage().percent` directly (which is 0-1) — convert by multiplying by 100. The typebox schema validates `percent` in the `0-100` range. This matches typical user-facing config conventions (e.g., "stop at 80%") and avoids the "is it 0.80 or 80?" ambiguity.
- **Why the user wants this.** "tokens do not line up nicely with context usage." A worker can have a low cumulative `tokens` count but be at 95% of its context window (because cache hits kept the cumulative low but the conversation is long). The `context` cap catches this; the `tokens` cap doesn't.
- **Context is what the LLM sees, not what was sent.** `getContextUsage().tokens` is the SDK's estimate of what's currently in the LLM's input. Cache hits count, cache misses count, the system prompt counts, the conversation history counts. This is the "context window fill" semantic the user is asking about.
- **Pre-flight gate at delegation start** — has no `AgentSession` open yet, so it can't call `getContextUsage()`. The gate at `worker-tools.ts:278` keeps the legacy `ledger.cumulative.tokens` fallback for the pre-flight check. The new context check applies at `message_end` (mid-run) and at the tool-call handler (also mid-run), not at pre-flight. This is a documented design choice; the user accepted it.
- **C5 strategies.** The existing `onExhaustion.action` (`abort` / `compact` / `none`) is the global default. The new per-dimension overrides (`onTokenExhaustion`, `onContextExhaustion`) let the user set different strategies for tokens vs context. Backward compat: existing configs that only set `onExhaustion` apply the same action to both dimensions. The `interventionAvailable` flag is computed per-dimension and emitted with the `budget_warning` event for whichever dimension fired.
- **Per-dimension strategies rationale (T7).** The user requested independent exhaustion strategies for token and context limits because they're conceptually different resources: tokens measure cumulative cost, context measures the LLM's current view. A user might want `tokens: abort` (block immediately when cost exceeds budget) but `context: compact` (auto-compact when context fills) — the two are not coupled. Per-dimension strategies let the user express this. The implementer must NOT collapse them back into a single strategy (defeats the purpose).
- **Context warning mirrors tokens warning (T7.5).** T7.5 adds the warning path for context, parallel to the existing tokens warning block in `message_end`. The worker LLM gets advance notice before the gate aborts — it can call `summarize_progress`, wrap up, or signal that the orchestrator should intervene (`hive_compact_worker`, `hive_respawn_worker`, etc.). Without this, the worker's first signal is the `controller.abort(...)` from the gate, which is too late to do anything useful. The dual-emit pattern (custom message entry + HiveTelemetryEvent) is the same as tokens, with a separate dedup key (`"worker:context"`) so each warning fires once per session.
- **F13 dashboard.** The dashboard already exposes `formatContextFill` (in `team_status`). No dashboard work is required for this wave. The F13 `interventionAvailable` flag now also fires for context, which is automatically reflected in the dashboard.
- **Cooperative tool trigger** (the previously skipped scope) is still out of scope. This wave doesn't add a cooperative context trigger; the operator commands cover equivalent operations.
- **No LOC targets.** Per `HANDOFF.md` §2.1, completeness is the only driving factor.

## Follow-ups (flagged but out of scope for this wave)

1. **Reasoning dimension plumbing for `tokensForInclude`** — from the budget-include-filter wave's after-action. Future work; unrelated to context.
2. **Per-agent context overhead** — when a worker is in `compact` strategy, the context window is being managed. The `context` cap should probably interact with `compact` (auto-compact when context fills). Future work.
3. **Dashboard visual for context** — the existing `formatContextFill` exists; new visual treatment is a separate wave.
4. **Visual review** — per F13 T13.1 gate, requires human click-through. The context constraint makes the dashboard more useful but doesn't change the visual review scope.
5. **§11.7 master plan staleness** — pre-existing follow-up; not affected by this wave.

*End of context-constraint brief. Spawn 1 sub-agent after F13 + Wave 7 chain lands (i.e., after `refactor/budget` is at the current tip with the operator-writer-consolidation and budget-include-filter waves). Worktree setup: `git worktree add .worktrees/refactor-budget-context-constraint -b refactor/budget-context-constraint refactor/budget && cd .worktrees/refactor-budget-context-constraint && just install`.*
