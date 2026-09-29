/**
 * Wave 0 — barrel re-export for the `src/engine/budget/` module.
 *
 * Wave 1 implementation lives in the sibling files; this barrel exists so
 * downstream code can `import { ... } from "../engine/budget"` (or
 * `src/engine/budget/index.ts` for explicit paths).
 */

// Display helpers are imported explicitly to avoid the `BudgetRemaining`
// name collision with `./types.ts` — callers pick the contract that matches
// their needs.
export * from "./types";
export * from "./ledger";
export * from "./policy";
export * from "./strategy";
export * from "./events";
export * from "./worker-tools";
export { budgetRemaining, effectiveWorkerGovernance, type BudgetRemaining } from "./display";
