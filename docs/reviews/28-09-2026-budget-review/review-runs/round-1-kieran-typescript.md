# Round 1 — kieran-typescript-reviewer

**Reviewer:** kieran-typescript-reviewer (compound-engineering)
**Date:** 2026-09-28
**Scope:** `src/engine/budget/` (9 files, ~3.8k LOC) + `src/engine/dispatch.ts` slim + `src/agents/tools/summarize-progress.ts`
**Baseline:** wave5/f10-review at `7220a78` (post Wave 5A F9 legacy cleanup + Wave 5 coverage tests).

## Methodology

Applied the kieran-typescript-reviewer checklist against the diff vs `main`:

- **Type safety**: grepped for `any`, `as unknown`, `as never`, unsafe casts.
- **Async patterns**: scanned every `async`/`await` site for consistency.
- **Discriminated unions**: walked every `BudgetCap` / `BudgetWindow` / `BudgetLedgerKind` / `WindowKind` union to confirm narrowing is exhaustive and switches do not fall through.
- **Module structure**: verified the barrel (`index.ts`) re-exports are intentional, no circular `budget/*.ts → budget/*.ts` imports.
- **Naming**: confirmed camelCase TS identifiers, PascalCase types, kebab-case YAML keys (already established convention — kept).
- **Imports**: ordered correctly? Unused imports?
- **Modern TS features**: `satisfies` operator, `as const`, `ReadonlyArray`, `ReadonlySet` — checked for usage opportunities.

## Findings (ranked)

### 1. Dead re-export of `THROTTLE_*` constants from `events.ts` (FIND-1)

`src/engine/budget/events.ts:69-72, 494` imports `THROTTLE_MESSAGE_INTERVAL` and `THROTTLE_SPEND_RATIO` from `./ledger` only to re-export them. These constants are never used inside `events.ts`. The constants are already exported from `ledger.ts` (and thus through the barrel `index.ts`), so the re-export is unreachable: nothing imports `THROTTLE_*` from `./events`. The import block (`import { THROTTLE_MESSAGE_INTERVAL, THROTTLE_SPEND_RATIO } from "./ledger"`) and the trailing `export { ... }` are both dead code.

**Severity:** low — type-safe, but misleading; suggests a coupling that isn't there.

### 2. Unused type alias `OperatorLedgerKind` (FIND-2)

`src/engine/budget/types.ts:301` declares `export type OperatorLedgerKind = BudgetLedgerKind;` which is never imported or referenced anywhere in `src/` or `tests/`. It looks like a stub from Wave 0 that survived the F9 cleanup.

**Severity:** low — dead code only.

### 3. `_BudgetExhaustedError` import is genuinely unused (FIND-3)

`src/engine/budget/worker-tools.ts:81` imports `BudgetExhaustedError as _BudgetExhaustedError` but the alias is never referenced. The actual error throw site (`worker-tools.ts:416`) builds the error ad hoc with `error.name = "BudgetExhaustedError"`. The class import is purely documentation-flavoured.

**Severity:** low — `varsIgnorePattern: "^_"` in the ESLint config silences it, but the import still costs a maintenance step (a future editor wondering why we import a class and then never instantiate it).

### 4. `import type { ... } as never` for `WorkerBudgetStrategy._placeholder` shape (FIND-4)

`src/engine/budget/types.ts:93-95` declares:

```ts
export interface WorkerBudgetStrategy {
  readonly _placeholder: never;
}
```

This is a clever-but-fragile "uninhabitable type" trick. No value can satisfy `{ readonly _placeholder: never }` at runtime, so `resolveWorkerBudgetStrategy` can only return `undefined`. The `_placeholder` field appears in `JSON.stringify(WorkerBudgetStrategy)` output if a consumer ever tries to print it — and any future Wave that adds real fields has to remember to remove it. It also forces `import type` aliases like `_BudgetExhaustedError` to look deliberate when they aren't.

**Severity:** medium — not a bug today, but a known footgun. The plan §2.13 explicitly marks this as a C5 placeholder deferred to v3, so the marker is intentional; the question is whether the uninhabitable type carries its weight. **Not applying a fix this round** — this is a design call, not a review-issue, and the plan §2.13 owns the decision.

### 5. Type cast `ctx.sessionManager as unknown as SessionManager` (FIND-5)

`src/engine/budget/worker-tools.ts:400` casts `ctx.sessionManager` (typed as `ReadonlySessionManager` from `ExtensionContext`) to the full `SessionManager` because `BudgetLedger.restore` accepts the writable subset. This is the Wave 1A documented seam — the readonly subset is structurally compatible with `SessionManager` for the methods the ledger uses (`getBranch`, `appendCustomEntry`, etc.).

**Severity:** informational. The cast is intentional and documented in `ledger.ts:restore` (line ~191). **Not applying a fix this round** — the alternative is to widen `BudgetLedger.restore` to accept `ReadonlySessionManager` too, which is a small refactor but is out of scope for a "surgical fix" round.

## Should-fix items (max 5)

1. **FIND-1 — Remove dead `THROTTLE_*` re-export from `events.ts`.** Delete the `import { THROTTLE_MESSAGE_INTERVAL, THROTTLE_SPEND_RATIO } from "./ledger"` block AND the `export { THROTTLE_MESSAGE_INTERVAL, THROTTLE_SPEND_RATIO }` line. Re-export is reachable through `index.ts` from `ledger.ts` already.

2. **FIND-2 — Remove unused `OperatorLedgerKind` type alias from `types.ts`.** No callers; it's dead.

3. **FIND-3 — Remove unused `_BudgetExhaustedError` import from `worker-tools.ts`.** The error throw path builds the error ad hoc; the class itself is unused in this module.

## Items NOT fixed this round (with reason)

- **FIND-4 (WorkerBudgetStrategy uninhabitable type):** design-level marker per plan §2.13 C5 placeholder; changing it is a redesign, not a review item.
- **FIND-5 (ReadonlySessionManager cast):** documented seam at `ledger.ts:restore`; widening to a shared interface is a small refactor out of scope for surgical fixes.

## Verification after fixes

Re-ran the gate:
- `just typecheck` → exit 0
- `just test` → 626 pass / 0 fail
- `npx eslint src/ tests/` → 0 errors / 0 new warnings (52 pre-existing warnings in `src/observability/server/db.ts`)

No test changes required for the dead-code removals (none of the three items are referenced in tests).