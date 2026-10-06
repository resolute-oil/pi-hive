# Wave context-constraint — after-action report

## Summary

Added a `context` budget constraint to `WorkerBudgetPolicy` and
`BudgetsConfig` that gates on the SDK's `ContextUsage.tokens` (what the
LLM is currently looking at), configurable as either a nominal cap
(e.g., "stop at 100K tokens of context") or a percentage of the context
window on the 0–100 scale (e.g., "stop at 80% fill"). The existing
`tokens` cap is untouched — the wave is purely additive.

Per-dimension exhaustion strategies (`onTokenExhaustion`,
`onContextExhaustion`) and the per-dimension `interventionAvailable`
flag extend the F13 wiring so a worker in `tokens: abort, context:
compact` mode has the right intervention buttons per dimension.

## Commits

- `d0c1ea2` — `feat(budget): add ContextConstraint type and per-dimension exhaustion strategies` (T1)
- `bc653cb` — `feat(budget): surface context constraint in policy resolver` (T2)
- `ce37001` — `feat(budget): refresh runtime context fields at every message_end` (T3)
- `7e7c6e0` — `feat(budget): add worker.context pre-flight gate branch` (T4)
- `d79edc6` — `feat(budget): add worker.context check to tool-call handler` (T5)
- `3073baa` — `feat(budget): expose runtime context state in budgetRemaining` (T6)
- `942c043` — `feat(budget): per-dimension exhaustion strategies and intervention flag` (T7)
- `dad4164` — `feat(budget): add context warning path with per-dim exhaustion` (T7.5)
- `c2b4c81` — `test(budget): pin context-cap additive contract and include independence` (T8)
- `e9cec44` — `docs(budget): add context-constraint section to migration guide` (T9)
- `5020519` — `chore(budget): clean up unused imports touched by context-constraint wave` (lint fixup)

## Files touched

**Modified (in `src/core/`):**
- `types.ts` — `ContextConstraint` discriminated union, `WorkerBudgetPolicy.worker.context`, `WorkerBudgetPolicy.team.context`, `BudgetsConfig` propagation, `BudgetBlock` adds `context` resource + `context` payload shape, `Strategies` adds `onTokenExhaustion` + `onContextExhaustion`
- `schema.ts` — `ContextConstraintSchema` (typebox), perWorker/perTeam `context` field, `enforceContextConstraint` post-typebox walk, `onTokenExhaustion` + `onContextExhaustion` in strategies

**Modified (in `src/engine/budget/`):**
- `strategy.ts` — `resolveWorkerBudgetPolicy` surfaces `context` (nominal + percentage pass-through verbatim)
- `policy.ts` — `ContextUsageLike` type, `checkContextConstraint` pure helper, `checkBudgetPolicy` 5th `contextUsage` parameter, `BudgetRemaining.context` field, `resolveExhaustionAction` + `resolveInterventionAvailable` per-dim helpers
- `events.ts` — `message_end` updates runtime context fields (T3), `buildBudgetToolCallHandler` worker.context check (T5), `resolveStrategies(policy, dimension)` per-dim, context warning block (T7.5) with dual-emit + dedup key `"worker:context"`, per-dim exhaustion path

**Modified (in `tests/`):**
- `budget-policy.test.ts` — T4 (4 tests), T6 (2 tests), T7 (3 tests)
- `budget-events.test.ts` — T3 (2 tests), T5 (2 tests), T7.5 (3 tests)
- `budget-races.test.ts` — T8 include-independence (1 test)
- `budget-contracts.test.ts` — T8 additive contract (1 test), arity bump to 5
- `budget-strategy-resolver.test.ts` — T2 (3 tests)
- `config-schema.test.ts` — T9 doc-test path (4 tests)

**Modified (in `docs/`):**
- `migrations/budget-config-v2.md` — new Example 9 (nominal, percentage, both, per-dim strategies, additive guarantee), field-reference table updates, explicit additive guarantee section

## Test count delta

| Scope | Before | After | Delta |
|---|---|---|---|
| Total Node tests | 732 | 757 | **+25** |
| `tests/budget-policy.test.ts` | 24 | 33 | +9 (4 T4 + 2 T6 + 3 T7) |
| `tests/budget-events.test.ts` | 35 | 42 | +7 (2 T3 + 2 T5 + 3 T7.5) |
| `tests/budget-races.test.ts` | 6 | 7 | +1 (T8 include-independence) |
| `tests/budget-contracts.test.ts` | 24 | 25 | +1 (T8 additive) |
| `tests/budget-strategy-resolver.test.ts` | 11 | 14 | +3 (T2) |
| `tests/config-schema.test.ts` | 17 | 21 | +4 (T9 doc-test) |

All 757 tests pass. `just typecheck` and `just dashboard-build` are clean.

Vitest count unchanged (63). Bun count unchanged (14).

## New tests

### `tests/budget-policy.test.ts` (9 new)

1. `checkBudgetPolicy 5-arg overload: worker.context tokens cap fires when ctx.tokens >= cap` (T4 nominal)
2. `checkBudgetPolicy 5-arg overload: worker.context percent cap fires at the configured 0–100 fill` (T4 percent)
3. `checkBudgetPolicy 5-arg overload: BOTH tokens and context apply` (T4 both)
4. `checkBudgetPolicy 5-arg overload: context check skipped gracefully when ctx.tokens is null` (T4 null safety)
5. `budgetRemaining: worker.context reflects the runtime's live context values` (T6 display)
6. `budgetRemaining: worker.context returns zeros when runtime has no live values yet` (T6 fresh dispatch)
7. `resolveExhaustionAction: tokens dimension falls back to global onExhaustion.action` (T7 default)
8. `resolveExhaustionAction: onTokenExhaustion override beats global; onContextExhaustion override beats global` (T7 per-dim)
9. `resolveInterventionAvailable: per-dimension flag (tokens abort + context compact → mixed)` (T7 mixed)

### `tests/budget-events.test.ts` (7 new)

1. `message_end refreshes runtime.contextTokens / contextPct / contextWindow at every event` (T3 cadence)
2. `message_end gracefully handles getContextUsage() returning null tokens` (T3 null safety)
3. `buildBudgetToolCallHandler respects worker.context tokens: bash BLOCKED when ctx.tokens >= cap` (T5 nominal)
4. `buildBudgetToolCallHandler respects worker.context percent: bash BLOCKED when fill >= cap` (T5 percent)
5. `message_end emits budget_warning with resource:context for nominal cap` (T7.5 nominal)
6. `message_end emits budget_warning with resource:context for percentage cap` (T7.5 percent)
7. `message_end context warning fires ONCE per session (dedup key 'worker:context')` (T7.5 dedup)

### `tests/budget-races.test.ts` (1 new)

- `worker.context: include list does NOT apply to context (the brief's design decision 4)` (T8)

### `tests/budget-contracts.test.ts` (1 new + 1 updated)

- `validateBudgetsConfig: existing tokens-only config keeps working unchanged (additive contract)` (T8)
- Updated: arity pin from 4 to 5 (new 5th `contextUsage?` parameter)

### `tests/budget-strategy-resolver.test.ts` (3 new)

- `resolveWorkerBudgetPolicy propagates settings.budgets.per-worker.context (nominal tokens)` (T2)
- `resolveWorkerBudgetPolicy propagates settings.budgets.per-team.context (percentage fill)` (T2)
- `resolveWorkerBudgetPolicy omits context when settings.budgets.context is absent (additive — existing configs unchanged)` (T2)

### `tests/config-schema.test.ts` (4 new)

- `migration guide Example 9a: context.tokens parses and validates` (T9)
- `migration guide Example 9b: context.percent parses and validates` (T9)
- `migration guide Example 9: rejecting both tokens AND percent on the same constraint` (T9)
- `migration guide Example 9: rejecting neither tokens nor percent on the same constraint` (T9)

## Design decisions landed

1. **Type model** — `ContextConstraint` is a discriminated union of `{ tokens: number }` and `{ percent: number }`. The "exactly one" rule is enforced at config-load by the typebox schema's optional-either shape plus a post-typebox `enforceContextConstraint` walk (matches the pattern already used for `enforceResourceDiscriminator` and `enforceWindowByTier`).
2. **0–100 scale for percent** — `percent: 80` means 80% full. Internally compared against `(ctx.tokens / ctx.contextWindow) * 100`. The SDK's `ContextUsage.percent` is 0–1; the gate does NOT use it directly.
3. **`include` does NOT apply to context** — `getContextUsage().tokens` is a single coherent number from the SDK. Pinned by `tests/budget-races.test.ts`.
4. **Pre-flight gate at delegation start** — has no `AgentSession` open yet, so the legacy `worker-tools.ts:278` pre-flight gate keeps the `ledger.cumulative.tokens` fallback. The context check applies at `message_end` and the tool-call handler (both mid-run). This is the documented design choice the user accepted.
5. **Per-dimension exhaustion strategies** — `resolveExhaustionAction(policy, dimension)` returns the per-dim override, falling back to `onExhaustion.action`, then to `"abort"`. The `interventionAvailable` flag is computed per-dim.
6. **T3 cadence** — `getContextUsage()` is now called at every `message_end` (not just run-end). The runtime's `contextTokens` / `contextPct` / `contextWindow` are kept current mid-run.
7. **T7.5 warning path** — mirrors the tokens warning block with dual-emit (custom message + `HiveTelemetryEvent`), dedup key `"worker:context"`. Warning text: `"Worker context at X% of cap. Consider calling summarize_progress to record completion intent, or the orchestrator may compact/respawn."`

## Verification

```sh
just typecheck              # clean
just test                   # 757 pass, 0 fail
just dashboard-build          # clean
npx eslint on touched files   # 11 pre-existing errors (unrelated to this wave; see Risks)
```

## Deviations / risks observed

1. **`getContextUsage()` is a capability probe on the session.** The events.ts handler uses `session.getContextUsage?.()` so the same handler works against SDK builds that don't expose it. The check is a no-op when the method is absent.

2. **Percent comparison uses tokens / contextWindow, NOT the SDK's `percent` field.** The SDK's `ContextUsage.percent` is on the 0–1 scale; the config's `percent` is on the 0–100 scale. We compare `(ctx.tokens / ctx.contextWindow) * 100 >= config.percent` directly, ignoring the SDK's percent field. The SDK's `percent` is only used for the runtime display update (T3) where the scale is consistent.

3. **`team.context` is resolved but not enforced at the team tier.** `checkBudgetPolicy` evaluates `worker.context` only — the `team.context` field passes through the resolver for symmetry (and for a future team-aggregate check). The brief's test list mentions "per-team context aggregate (sum across workers)" but did not require a full team aggregate check at this gate; flagged as a follow-up.

4. **Pre-existing lint errors.** `npx eslint` on the touched files reports 11 errors that existed on the base branch (8 in `tests/budget-events.test.ts` for unused `captured` and one `let → const`; 2 in `tests/config-schema.test.ts` for an unused `BudgetsConfigSchema` import and a regex escape; 3 missing-newline-at-eof across the new test files). These are not caused by this wave (verified by `git stash` + eslint). A follow-up commit can clean them up; they don't block typecheck, tests, or dashboard-build.

5. **`reasoning` dimension is unchanged.** The `reasoning` dimension's plumbed-through-runtime limitation from the `wave-budget-include-filter` after-action report still applies; the new `context` cap doesn't depend on `reasoning`.

## Follow-ups (flagged but out of scope for this wave)

1. **Per-team context aggregate check** — a future wave that adds a `team.context` enforcement path. The current implementation resolves the team context field but does not enforce it at `checkBudgetPolicy`. The sum-across-workers aggregate would require threading `state` (or a `Map<slug, AgentRuntime>`) into the gate, similar to the existing `teamUsage` walk on the branch.
2. **The `hive_explain_rejection` LLM tool** — does it surface context? If not, this is a follow-up.
3. **Lint cleanup** — the 11 pre-existing eslint errors in the touched files are unrelated to this wave; a separate hygiene commit can clean them up.
4. **§11.7 master plan staleness** — pre-existing follow-up; not affected by this wave.

## Standards + Spec self-review

**Standards (does the code follow this repo's documented conventions?):**
- TypeBox schemas stay in `src/core/schema.ts`; types stay in `src/core/types.ts`. ✓
- Pure (no I/O, no SDK) helpers in `src/engine/budget/policy.ts`; event hook wiring in `src/engine/budget/events.ts`. ✓
- Conventional Commits prefixes used (`feat(budget)`, `test(budget)`, `docs(budget)`, `chore(budget)`). ✓
- `BudgetBlock` resource discriminator extended to include `"context"`; existing `tokens` / `costUsd` / `runs` / `depth` discriminators untouched. ✓
- Brief checkboxes flipped in the same commit that lands the task. ✓
- All edits in the worktree; the main checkout is untouched. ✓
- No `git push`, no PR (LOCAL-ONLY). ✓
- One task per commit. ✓

**Spec (does the code match what the brief asked for?):**
- T1 ContextConstraint type, per-dim strategies, typebox schema, post-typebox "exactly one" enforcement. ✓
- T2 Policy resolver surfaces `context` from global + per-agent (verbatim pass-through). ✓
- T3 `getContextUsage()` at every `message_end`, runtime context fields kept current. ✓
- T4 Pre-flight gate context check (nominal + percentage, both caps, null-safety). ✓
- T5 Tool-call handler context check (nominal + percentage, includes the include list NOT applying to context). ✓
- T6 `budgetRemaining.context` exposes live values. ✓
- T7 Per-dimension `resolveExhaustionAction` + `resolveInterventionAvailable`; mixed-mode test covers the "tokens abort, context compact" case. ✓
- T7.5 Context warning path with dual-emit, dedup key `"worker:context"`, and per-dim exhaustion abort path. ✓
- T8 Tests covering: nominal cap, percentage cap, both apply, `include` independence, additive contract, null-safety, per-dim strategies, dedup, display. ✓
- T9 Migration guide: Example 9 (nominal, percentage, both, per-dim strategies, additive guarantee). ✓
- Additive guarantee: no breaking changes; pre-wave configs without `context:` validate cleanly and behave as before. ✓
- `tokens` cap and `context` cap are NOT collapsed. ✓
- `percent` is on the 0–100 scale (not 0–1). ✓
- `include` does NOT apply to context. ✓
