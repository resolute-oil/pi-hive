# Round 3 — code-simplicity-reviewer

**Reviewer:** code-simplicity-reviewer (compound-engineering)
**Date:** 2026-09-28
**Scope:** `src/engine/budget/` (9 files, ~3.8k LOC) + `src/agents/tools/summarize-progress.ts`
**Baseline:** wave5/f10-review at `18a7691` (post Round 2 — dead type alias removed, lifecycle contract documented).

## Methodology

Applied the code-simplicity-reviewer checklist against the diff vs `main`:

- **Dead code**: any unused exports after Wave 5A's legacy cleanup?
- **Over-engineering**: any abstractions used only once?
- **Helper functions**: are they justified or single-use inline?
- **Test brittleness**: any tests that test implementation rather than behavior?
- **Comment rot**: any docstrings that lie about what the code does?
- **Magic numbers**: any constants that should be named?

## Findings (ranked)

### S1. `cumulativeFromRuntime` under-counts `reasoningTokens` — real bug (FIND-S1)

`src/engine/budget/worker-tools.ts:1134-1144`:

```ts
function cumulativeFromRuntime(runtime: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  runCount: number;
}): BudgetLedgerCumulative {
  return {
    tokens:
      runtime.inputTokens + runtime.outputTokens + runtime.cacheReadTokens + runtime.cacheWriteTokens,
    // ^ missing reasoningTokens
    costUsd: runtime.costUsd,
    runs: runtime.runCount,
  };
}
```

Compare with `src/engine/budget/display.ts:137` (the SDK-aligned mirror in the display layer):

```ts
function runtimeTokens(runtime: AgentRuntime): number {
  return runtime.inputTokens + runtime.outputTokens + runtime.cacheReadTokens + runtime.cacheWriteTokens + runtime.reasoningTokens;
}
```

The two paths disagree. The cooperative tools (`requestCompaction`, `requestEndSession`, `requestSnapshot`) all call `cumulativeFromRuntime(runtime)` and write the resulting `cumulative.tokens` into the ledger entry. Any worker with reasoning tokens (most Claude / GPT-5 / o-series models emit reasoning) will under-report its cooperative-action cumulative tokens in the ledger.

The test `tests/cooperative-eol.test.ts:133` sets `reasoningTokens: 0` so the bug doesn't surface. But production workers will emit non-zero reasoning tokens.

**Fix:** include `reasoningTokens` in the sum. One line addition to the function body and one field in the structural type. The `cumulativeFromRuntime` interface signature is private (not exported), so the change is local.

### S2. `summarize-progress.ts:recordProgressLedgerEntry` is double-bypass type safety (FIND-S2)

`src/agents/tools/summarize-progress.ts:152-161`:

```ts
function recordProgressLedgerEntry(ledger: BudgetLedger, signal: AbortSignal | undefined): void {
  try {
    const snapshotAny = ledger.snapshot as unknown as (
      stats: unknown,
      policy: unknown,
      kind: string,
      sig?: AbortSignal,
    ) => void;
    snapshotAny({}, {}, "progress_notes", signal);
  } catch {
    // Stub or unsupported ledger — don't fail the tool.
  }
}
```

Three smells:
1. `as unknown as` cast to widen the typed `kind: BudgetLedgerKind | "checkpoint"` parameter to `string`.
2. `stats: unknown` passed `{}` — a non-`SessionStats` value. If the ledger's `snapshot` ever succeeds without short-circuiting, it crashes on `stats.tokens.total`.
3. The `try/catch` swallows any error, so the cast is effectively `void recordProgressLedgerEntry(...)`.

This is the kind of "best-effort side effect with no observable behavior" that YAGNI cuts. The function:
- Exists only to write a `kind: "progress_notes"` ledger entry
- The kind is NOT in the typed union (plan §2.3 keeps it closed)
- Tests verify the side effect (`tests/summarize-progress.test.ts:333`) but the implementation is a stub-of-a-stub

**Surgical fix:** inline the call into the `try/catch` at the call site (`summarize-progress.ts:272`), so the cast is one line at one site, not a separate helper. This consolidates the workaround into the single place that knows about the type widening.

### S3. `effectiveWorkerGovernance` interface lists 7 fields that never get set (FIND-S3)

`src/engine/budget/display.ts:106-114`:

```ts
export interface EffectiveWorkerGovernance {
  timeoutMs?: number;
  maxDelegationDepth?: number;
  maxRuns?: number;
  tokenBudget?: number;
  tokenBudgetScope?: "input_output" | "all";
  costBudgetUsd?: number;
  distillerRuns?: number;
}
```

The function returns `Object.freeze({}) as EffectiveWorkerGovernance` — every field is always `undefined`. The interface is documentation of the legacy shape. Consumers (`distiller.ts:140-141,153`, `tools.ts:158`) read `tokenBudgetScope` and `distillerRuns` — both always undefined, making those checks dead.

This is a cleanup concern but is in the consumer code, not in `display.ts`. Not in scope for a budget-module fix.

### S4. `WorkerBudgetPolicy.strategy === undefined` branch is always taken (FIND-S4)

`src/engine/budget/events.ts:260`:

```ts
if (policy.strategy === undefined) {
  evaluateThresholds(...);
}
```

`policy.strategy` is never set by `resolveWorkerBudgetPolicy` (`worker-tools.ts:241-249`). The `if` is always true; the dead `else` has no implementation. The branch is intentional per the comment ("kept as an explicit branch so the structured-strategy path has a place to diverge"), but it adds 2-line nesting that does nothing today.

**Not fixing this round** — the branch documents intent per plan §2.13 C5 deferred to v3. Removing it would be a redesign (changes the contract for the future structured-strategy path).

### S5. `strategy.ts` is a placeholder module with placeholder tests (FIND-S5)

`src/engine/budget/strategy.ts` (57 lines) declares three functions that all return `false` / `undefined`. `tests/budget-strategy-resolver.test.ts` (99 lines) asserts that the three functions return their placeholder values. This is the textbook YAGNI anti-pattern: dead code with explicit tests pinning the dead behavior.

**Not fixing this round** — `strategy.ts` is the documented Wave 0 contract surface for plan §2.13 C5 deferred to v3. Removing it would invalidate the plan's deferred-to-v3 entry.

## Should-fix items (max 5)

1. **FIND-S1 — Fix `cumulativeFromRuntime` to include `reasoningTokens`.** One-line addition to the function body plus adding `reasoningTokens: number` to the structural type. Cooperative tools will then write the correct cumulative tokens into the ledger.

2. **FIND-S2 — Inline `recordProgressLedgerEntry` into the call site and drop the `as unknown as` helper.** The function is a 10-line wrapper around a single `try/catch`. Inlining keeps the workaround at one site and removes the misleading helper name.

## Items NOT fixed this round (with reason)

- **FIND-S3 (EffectiveWorkerGovernance interface):** cleanup is in consumer code (`distiller.ts`, `tools.ts`), not in the budget module. Out of scope.
- **FIND-S4 (events.ts dead `policy.strategy === undefined` branch):** intentional per plan §2.13 C5 deferred; removing it changes the future-extension contract.
- **FIND-S5 (strategy.ts placeholder + tests):** Wave 0 surface per plan §2.13; removal invalidates the plan.

## Verification after fixes

Re-ran the gate:
- `just typecheck` → exit 0
- `just test` → 626 pass / 0 fail
- `npx eslint src/ tests/` → 0 errors / 0 new warnings (52 pre-existing warnings in `src/observability/server/db.ts`)

No new test changes required (existing cooperative-eol tests pass with `reasoningTokens: 0`; the inlining of `recordProgressLedgerEntry` is byte-identical from the ledger's POV).