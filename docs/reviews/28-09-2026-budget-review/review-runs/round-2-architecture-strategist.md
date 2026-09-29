# Round 2 — architecture-strategist

**Reviewer:** architecture-strategist (compound-engineering)
**Date:** 2026-09-28
**Scope:** `src/engine/budget/` (9 files, ~3.8k LOC) + `src/engine/dispatch.ts` slim + `src/engine/worker-session-factory.ts`
**Baseline:** wave5/f10-review at `d9cc749` (post Round 1 — dead re-exports and type aliases removed).

## Methodology

Applied the architecture-strategist checklist against the diff vs `main`:

- **Module boundaries**: does `src/engine/budget/` cleanly own budget logic? Any leaks into `src/engine/dispatch.ts`?
- **Dependency direction**: do budget modules depend on `src/core/` correctly? No reverse deps?
- **Single source of truth**: is `session.getSessionStats()` truly the only cumulative read? Any places still using `governanceTokens` / `effectiveTokens` / `runtime.*` for spend?
- **Public API surface**: are exports minimal? Anything that should be private but isn't?
- **Lifecycle ownership**: who owns teardown of `installBudgetEventHooks`? Documented?

## Findings (ranked)

### A. Module boundaries — clean

`src/engine/budget/` owns budget logic. Imports from `src/core/{types,utils}` are pure data — types and pure helpers (`agentSlug`). `worker-tools.ts` does reach into `src/engine/session.ts` (`currentDelegationDepth`) and `src/engine/agent-lookup.ts` (`resolveRuntime`), which is acceptable: those are runtime-context helpers, not budget state. No budget module reads or mutates `state.runtimes` directly outside the cooperative-tool path (`requestCompaction` / `requestEndSession` / `requestSnapshot` read `state.runtimes[callerName]`, but only to look up the worker that called the cooperative tool).

`src/engine/dispatch.ts` does NOT carry budget math anymore — pre-flight is delegated to `runBudgetPreflight`, mid-run hooks are delegated to `installWorkerBudgetHooks` (in `worker-session-factory.ts`). The only budget-shaped code in `dispatch.ts` is the duck-typed `BudgetExhaustedError` translate-to-`{ output, exitCode: 1 }` envelope.

**No action needed.** Module boundary is clean.

### B. Dependency direction — clean

`grep "from \"\\.\\./\\.\\./core\\|from \"\\.\\./session\\|from \"\\.\\./agent-lookup\"" src/engine/budget/*.ts` shows budget imports `core` (types + utils) and two engine helpers (session depth, runtime lookup). No reverse deps: `grep "from \"\\.\\./budget" src/core/ src/engine/session.ts src/engine/agent-lookup.ts` returns zero matches.

**No action needed.** Direction is correct.

### C. Single source of truth — clean

`governanceTokens` / `effectiveTokens` are zero matches in production code (only docstring references in `display.ts`, `observability.ts`, `dispatch.ts`, `summarize-progress.ts` describe the legacy field removal). `runtime.inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens + costUsd` is the SDK-aligned mirror used as the display surface (`display.ts:runtimeTokens`); `events.ts:readAuthoritativeTotals` reads `stats.tokens.total` and `stats.cost` for the live ledger writes.

**No action needed.** Single source of truth is established.

### D. Public API surface — minor leaks (FIND-D1, FIND-D2)

**FIND-D1 — `BudgetWarningDetails` interface is unused.** `src/engine/budget/types.ts:320` declares:

```ts
export interface BudgetWarningDetails {
  scope: BudgetScope;
  resource: BudgetResource;
  remaining: number;
  cap: number | undefined;
}
```

Zero references in `src/` or `tests/`. The T3.2 warning emit in `events.ts:evaluateThresholds` builds the inline `{ scope, resource, remaining, cap, interventionAvailable }` object passed to `appendCustomMessageEntry` without consulting the typed shape — that's why this interface was never wired up. Dead export from Wave 0 stub.

**FIND-D2 — Worker-session-factory discards the budget unsubscribe.** `src/engine/worker-session-factory.ts:134` calls `installBudgetEventHooks(...)` but does NOT capture the returned unsubscribe function. The factory returns the `BudgetLedger`, not the unsubscribe. The lifecycle (`worker-lifecycle.ts:WorkerRunLifecycle`) only tracks ONE `unsubscribe` (the dispatch's `handleEvent`), and `close()` calls `session.dispose()` which the SDK's `agent-session.js:dispose()` clears `_eventListeners` entirely — so the budget subscription is dropped on dispose. **The unsubscribe is functionally redundant** because `dispose()` clears the array, but the API surface still claims to return it. Two fixes are possible:

- (a) Document the lifecycle contract: `installWorkerBudgetHooks` does NOT need to return the unsubscribe because `WorkerRunLifecycle.close()` invokes `session.dispose()` which drops all listeners.
- (b) Plumb the unsubscribe through to `lifecycle.attachSubscription` so both subscriptions are tracked symmetrically.

**(a) is documentation-only and matches the current behavior; (b) requires a signature change to `installWorkerBudgetHooks`. Going with (a) this round — surgical only.**

### F. Lifecycle ownership — duplicated error handling (FIND-F1)

`src/engine/dispatch.ts:155-172` and `src/engine/dispatch.ts:196-211` both handle `BudgetExhaustedError` the same way:

```ts
catch (error: any) {
  if (error?.name === BUDGET_EXHAUSTED_ERROR_NAME) {
    emitHiveEvent(state, "budget_exhausted", {
      agent: runtime.config.name,
      resource: error.resource,
      scope: error.scope,
      remaining: budgetRemaining(state, runtime),
    }, caller);
    return { output: `Delegation blocked: ${error?.message || String(error)}`, exitCode: 1, elapsed: 0 };
  }
  throw error;
}
```

The two calls to `runBudgetPreflight` (pre-slot and post-slot) deliberately re-run the check; the error-translation is the same in both places. A 6-line helper inside `worker-tools.ts` (`translateBudgetExhausted`) would eliminate the duplication.

**Severity:** low — duplication is small (~10 lines) and the two call sites differ slightly (pre-slot does not call `releaseWorkerSlot`; post-slot does). Extracting the helper has a small chance of changing the call-site behavior; safer to leave the duplication as-is for this round.

### G. Type discrimination — minor inconsistency (FIND-G1)

`events.ts:createBudgetToolCallGuard` returns the BudgetBlock as `JSON.stringify(block satisfies BudgetBlock)`. The `satisfies` operator is a nice modern TypeScript touch — preserves the literal type while asserting compatibility. **No action needed** but kept as a positive note for the review.

## Should-fix items (max 5)

1. **FIND-D1 — Remove unused `BudgetWarningDetails` interface from `types.ts`.** No callers; it's dead.

2. **FIND-D2 — Document the lifecycle contract for the discarded budget unsubscribe.** Add a one-line comment on the `installBudgetEventHooks` call site explaining that `WorkerRunLifecycle.close()` → `session.dispose()` clears `_eventListeners`, so the discarded unsubscribe is safe.

## Items NOT fixed this round (with reason)

- **FIND-F1 (duplicated budget-exhausted handler):** Extracting the helper has a small risk of changing the call-site behavior (pre-slot vs post-slot differ in slot release). Out of scope for a surgical round — would warrant a separate refactor PR.

## Verification after fixes

Re-ran the gate:
- `just typecheck` → exit 0
- `just test` → 626 pass / 0 fail
- `npx eslint src/ tests/` → 0 errors / 0 new warnings (52 pre-existing warnings in `src/observability/server/db.ts`)

No test changes required (neither item is referenced by tests).