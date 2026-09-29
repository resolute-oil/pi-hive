/**
 * Wave 1 — `WorkerBudgetStrategy` resolver (C5 placeholder).
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md
 *   §2.13 C5 (structured strategies) — PLACEHOLDER ONLY; deferred to v3 unless
 *          the user overrides. The current `default | compact` flat enum is
 *          collapsed into a stub that returns `undefined` until the structured
 *          strategy config is implemented.
 *
 * Design notes:
 * - The `WorkerBudgetStrategy` type carries `readonly _placeholder: never`, so
 *   no value can satisfy it at runtime — the resolver MUST return `undefined`.
 * - The cooperative tool `summarize_progress` falls back to its default
 *   `compact` behavior when no strategy is configured. See T5.7 (Wave 1
 *   Agent 1D) for the wiring.
 * - `resolveWorkerBudgetPolicy` is intentionally NOT in this module: it lives
 *   in `worker-tools.ts` because it needs the resolved `AgentConfig` for the
 *   target agent (a Wave 2 concern, T2.2).
 */

import type { HiveState } from "../../core/types";
import type { WorkerBudgetStrategy } from "./types";

/**
 * Resolve the effective `WorkerBudgetStrategy` for an agent.
 *
 * C5 placeholder: always returns `undefined`. The structured strategy config
 * (on-approaching-limit.action, on-exhaustion.action, summary.max-tokens,
 * etc.) is deferred to v3 unless a user-supplied override lands first.
 */
export function resolveWorkerBudgetStrategy(
  _state: HiveState,
  _agentName: string,
): WorkerBudgetStrategy | undefined {
  return undefined;
}

/**
 * Convenience: does the resolved strategy request a wrap-up hint when the
 * worker crosses the approaching-limit threshold? (C5 placeholder always
 * returns `false`.)
 */
export function strategyRequestsWrapUp(
  _strategy: WorkerBudgetStrategy | undefined,
): boolean {
  return false;
}

/**
 * Convenience: does the resolved strategy request an automatic compaction at
 * exhaustion (vs. an abort)? (C5 placeholder always returns `false`.)
 */
export function strategyRequestsCompactOnExhaustion(
  _strategy: WorkerBudgetStrategy | undefined,
): boolean {
  return false;
}
