/**
 * Wave 0 contract stubs — `WorkerBudgetStrategy` resolver.
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md
 *   §2.13 C5 (structured strategies) — PLACEHOLDER ONLY; deferred to v3 unless
 *          the user overrides. The current `default | compact` flat enum is
 *          collapsed into a stub that returns `undefined` until the structured
 *          strategy config is implemented.
 *
 * Bodies throw — Wave 1 fills them in.
 */

import type { HiveState } from "../../core/types";
import type { WorkerBudgetStrategy } from "./types";

/**
 * Resolve the effective `WorkerBudgetStrategy` for an agent.
 *
 * C5 placeholder: returns `undefined` (no structured strategy; the cooperative
 * tool `summarize_progress` will fall back to its default `compact` behavior).
 * `// TODO C5: deferred to v3 unless user overrides` applies to this entire
 * module — keep it minimal.
 */
export function resolveWorkerBudgetStrategy(
  _state: HiveState,
  _agentName: string,
): WorkerBudgetStrategy | undefined {
  throw new Error("not implemented");
}

/**
 * Convenience: does the resolved strategy request a wrap-up hint when the
 * worker crosses the approaching-limit threshold? (C5 placeholder always
 * returns `false`.)
 */
export function strategyRequestsWrapUp(
  _strategy: WorkerBudgetStrategy | undefined,
): boolean {
  throw new Error("not implemented");
}

/**
 * Convenience: does the resolved strategy request an automatic compaction at
 * exhaustion (vs. an abort)? (C5 placeholder always returns `false`.)
 */
export function strategyRequestsCompactOnExhaustion(
  _strategy: WorkerBudgetStrategy | undefined,
): boolean {
  throw new Error("not implemented");
}
