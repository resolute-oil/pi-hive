/**
 * Wave 0 contract stubs — pure budget-policy functions.
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md
 *   §2.5 Pre-flight gate (`checkBudgetPolicy`) — throws-to-refuse per Pi docs §2
 *   §2.6 Mid-run helpers: `workerConsumedTokens`, `workerConsumedCost`,
 *                          `teamUsage`, `ratioRemaining`, `crossedThreshold`
 *
 * Bodies throw — Wave 1 fills them in.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { BudgetLedger } from "./ledger";
import type {
  BudgetBlock,
  TeamUsageTotals,
  WorkerBudgetPolicy,
} from "./types";

/**
 * §2.5 pre-flight gate.
 *
 * Pure function: returns a `BudgetBlock` describing why delegation should be
 * refused, or `undefined` when the worker + team usage is within caps.
 *
 * `delegateAgent` throws `new BudgetExhaustedError(...)` when this returns
 * non-undefined. Returning an object does NOT mark the tool as failed
 * (per Pi docs §2).
 */
export function checkBudgetPolicy(
  _ledger: BudgetLedger,
  _policy: WorkerBudgetPolicy,
  _branch: SessionEntry[],
): BudgetBlock | undefined {
  throw new Error("not implemented");
}

/**
 * §2.6 — Sum `tokens` across the worker's own ledger entries (excluding
 * cache write, per the legacy `input_output` scope default for workers).
 */
export function workerConsumedTokens(_branch: SessionEntry[]): number {
  throw new Error("not implemented");
}

/**
 * §2.6 — Sum `costUsd` across the worker's own ledger entries.
 */
export function workerConsumedCost(_branch: SessionEntry[]): number {
  throw new Error("not implemented");
}

/**
 * §2.6 — Aggregate team-wide usage across the full branch (every worker
 * belonging to the same team, plus the orchestrator's own spend).
 */
export function teamUsage(_branch: SessionEntry[]): TeamUsageTotals {
  throw new Error("not implemented");
}

/**
 * §2.6 — Compute `remaining / cap` as a ratio in [0, 1]. Returns 0 when no
 * cap is configured (treat unbounded as fully exhausted for warning purposes).
 */
export function ratioRemaining(_consumed: number, _cap: number | undefined): number {
  throw new Error("not implemented");
}

/**
 * §2.6 — Has the `remainingRatio` just crossed below `threshold` since the
 * last snapshot? Used to gate `appendCustomMessageEntry("budget_warning", ...)`
 * so the warning fires exactly once per resource per worker.
 */
export function crossedThreshold(
  _remainingRatio: number,
  _threshold: number,
): boolean {
  throw new Error("not implemented");
}
