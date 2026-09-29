/**
 * Wave 1 — pure budget-policy functions.
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md
 *   §2.5 Pre-flight gate (`checkBudgetPolicy`) — throws-to-refuse per Pi docs §2
 *   §2.6 Mid-run helpers: `workerConsumedTokens`, `workerConsumedCost`,
 *                          `teamUsage`, `ratioRemaining`, `crossedThreshold`
 *
 * Design notes:
 * - Pure functions only: no I/O, no SDK state, no clock reads. Inputs are
 *   passed explicitly so each helper is testable in isolation (Hard constraint).
 * - `cumulative` is taken from the LATEST ledger entry per worker (plan §3.1
 *   sequence diagram: "sum latest CustomEntry per scope"). Each ledger entry
 *   already records a running total; using the latest one gives the live
 *   state without double-counting older checkpoints.
 * - `checkBudgetPolicy` does a runtime shape check on `policy` (G-29):
 *   a `ResolvedTeamBudgets` accidentally passed where a `WorkerBudgetPolicy`
 *   is expected raises a TypeError before any cap evaluation runs.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { BudgetLedger } from "./ledger";
import type {
  BudgetBlock,
  BudgetLedgerData,
  TeamUsageTotals,
  WorkerBudgetPolicy,
} from "./types";
import { BUDGET_LEDGER_CUSTOM_TYPE } from "./ledger";

/** Minimum runtime shape of `WorkerBudgetPolicy` — used for the G-29 type-mismatch guard. */
function isWorkerBudgetPolicy(value: unknown): value is WorkerBudgetPolicy {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  // WorkerBudgetPolicy requires both `worker` and `team` keys to be plain
  // objects. A bare ResolvedTeamBudgets (which only has `tokens`/`costUsd`/...)
  // fails this — that's the G-29 mismatch we're guarding against.
  if (typeof obj.worker !== "object" || obj.worker === null) return false;
  if (typeof obj.team !== "object" || obj.team === null) return false;
  return true;
}

/** True when the entry is a `pi-hive-budget-ledger` CustomEntry. */
function isLedgerEntry(entry: SessionEntry): boolean {
  return (
    entry.type === "custom" &&
    (entry as { customType?: unknown }).customType === BUDGET_LEDGER_CUSTOM_TYPE &&
    typeof (entry as { data?: unknown }).data === "object" &&
    (entry as { data?: unknown }).data !== null
  );
}

/**
 * Read every ledger CustomEntry in `branch` and group by `data.agentSlug`.
 * Returns a map of `agentSlug -> [entries...]` in branch order (oldest first).
 * Exported for tests; not part of the public policy surface.
 */
export function indexLedgerByAgent(branch: SessionEntry[]): Map<string, BudgetLedgerData[]> {
  const map = new Map<string, BudgetLedgerData[]>();
  for (const entry of branch) {
    if (!isLedgerEntry(entry)) continue;
    const data = (entry as { data: BudgetLedgerData }).data;
    if (typeof data.agentSlug !== "string") continue;
    const list = map.get(data.agentSlug);
    if (list) list.push(data);
    else map.set(data.agentSlug, [data]);
  }
  return map;
}

/** Pull the most recent cumulative for a single worker (or zeros if absent). */
function latestCumulativeFor(branch: SessionEntry[], agentSlug: string): BudgetLedgerData["cumulative"] {
  const indexed = indexLedgerByAgent(branch);
  const list = indexed.get(agentSlug);
  if (!list || list.length === 0) return { tokens: 0, costUsd: 0, runs: 0 };
  const last = list[list.length - 1]!;
  return last.cumulative;
}

/**
 * §2.5 pre-flight gate.
 *
 * Pure function: returns a `BudgetBlock` describing why delegation should be
 * refused, or `undefined` when the worker + team usage is within caps.
 *
 * `delegateAgent` throws `new BudgetExhaustedError(...)` when this returns
 * non-undefined. Returning an object does NOT mark the tool as failed
 * (per Pi docs §2).
 *
 * Throws `TypeError` (G-29) when `policy` is not a `WorkerBudgetPolicy`
 * (e.g., someone passed a bare `ResolvedTeamBudgets` instead). The
 * typebox-level validation lives here so callers get a clear runtime error
 * rather than a silent `undefined` policy field access.
 *
 * Depth cap (T2.3, plan §3.2): enforced inline via the `currentDepth`
 * argument — `delegateAgent` passes `currentDelegationDepth() + 1` so this
 * stays a pure function (no module-level reads). Per C4 the depth cap is a
 * worker-only resource (no team aggregate), so it lives in the worker
 * branch and never reads `teamUsage()`. The check fires when the dispatch
 * would push depth past the cap (strict greater-than — equal depth is OK).
 */
export function checkBudgetPolicy(
  ledger: BudgetLedger,
  policy: WorkerBudgetPolicy,
  branch: SessionEntry[],
  currentDepth: number,
): BudgetBlock | undefined {
  if (!isWorkerBudgetPolicy(policy)) {
    throw new TypeError(
      "checkBudgetPolicy: `policy` is not a WorkerBudgetPolicy (expected `{ worker, team }`); "
        + "got a structurally different object (likely a ResolvedTeamBudgets passed in error — G-29).",
    );
  }

  // Worker scope — read from the ledger's already-restored cumulative.
  const workerTokensCap = policy.worker.tokens?.cap;
  if (workerTokensCap !== undefined && ledger.cumulative.tokens >= workerTokensCap) {
    return {
      reason: `Worker token budget exhausted: ${ledger.cumulative.tokens}/${workerTokensCap}`,
      scope: "worker",
      resource: "tokens",
      remaining: { tokens: 0 },
      limit: { tokens: workerTokensCap },
    };
  }

  const workerCostCap = policy.worker.costUsd?.cap;
  if (workerCostCap !== undefined && ledger.cumulative.costUsd >= workerCostCap) {
    return {
      reason: `Worker cost budget exhausted: $${ledger.cumulative.costUsd.toFixed(2)}/$${workerCostCap}`,
      scope: "worker",
      resource: "costUsd",
      remaining: { costUsd: 0 },
      limit: { costUsd: workerCostCap },
    };
  }

  const workerRunsCap = policy.worker.runs?.cap;
  if (workerRunsCap !== undefined && ledger.cumulative.runs >= workerRunsCap) {
    return {
      reason: `Worker run budget exhausted: ${ledger.cumulative.runs}/${workerRunsCap}`,
      scope: "worker",
      resource: "runs",
      remaining: { runs: 0 },
      limit: { runs: workerRunsCap },
    };
  }

  // Depth cap — T2.3. Per C4 the `resource` discriminator is `"depth"` and
  // the cap is a positive integer (validator enforces `minimum: 1`). A
  // configured cap means "the depth THIS dispatch would create must be
  // ≤ cap"; we fire when it would exceed (strict greater-than) so a cap of
  // N permits N nested levels.
  const workerDepthCap = policy.worker.depth?.cap;
  if (workerDepthCap !== undefined && currentDepth > workerDepthCap) {
    return {
      reason: `Worker depth budget exhausted: depth=${currentDepth} > cap=${workerDepthCap}`,
      scope: "worker",
      resource: "depth",
      remaining: {},
      limit: { depth: workerDepthCap },
    };
  }

  // Team scope — sum the latest cumulative across every worker in the branch.
  const team = teamUsage(branch);
  const teamTokensCap = policy.team.tokens?.cap;
  if (teamTokensCap !== undefined && team.tokens >= teamTokensCap) {
    return {
      reason: `Team token budget exhausted: ${team.tokens}/${teamTokensCap}`,
      scope: "team",
      resource: "tokens",
      remaining: { tokens: 0 },
      limit: { tokens: teamTokensCap },
    };
  }

  const teamCostCap = policy.team.costUsd?.cap;
  if (teamCostCap !== undefined && team.costUsd >= teamCostCap) {
    return {
      reason: `Team cost budget exhausted: $${team.costUsd.toFixed(2)}/$${teamCostCap}`,
      scope: "team",
      resource: "costUsd",
      remaining: { costUsd: 0 },
      limit: { costUsd: teamCostCap },
    };
  }

  const teamRunsCap = policy.team.runs?.cap;
  if (teamRunsCap !== undefined && team.runs >= teamRunsCap) {
    return {
      reason: `Team run budget exhausted: ${team.runs}/${teamRunsCap}`,
      scope: "team",
      resource: "runs",
      remaining: { runs: 0 },
      limit: { runs: teamRunsCap },
    };
  }

  return undefined;
}

/**
 * §2.6 — Sum `tokens` across the worker's own ledger entries by reading the
 * LATEST entry's `cumulative.tokens`. The ledger already records a running
 * total (single source of truth: `session.getSessionStats().tokens.total`),
 * so "sum latest" is the canonical way to read the current worker spend.
 */
export function workerConsumedTokens(branch: SessionEntry[]): number {
  const ledger = branch.filter(isLedgerEntry);
  if (ledger.length === 0) return 0;
  const last = ledger[ledger.length - 1]!;
  return (last as { data: BudgetLedgerData }).data.cumulative.tokens;
}

/**
 * §2.6 — Sum `costUsd` across the worker's own ledger entries by reading the
 * LATEST entry's `cumulative.costUsd`. Authoritative source is
 * `session.getSessionStats().cost`; the ledger mirrors that.
 */
export function workerConsumedCost(branch: SessionEntry[]): number {
  const ledger = branch.filter(isLedgerEntry);
  if (ledger.length === 0) return 0;
  const last = ledger[ledger.length - 1]!;
  return (last as { data: BudgetLedgerData }).data.cumulative.costUsd;
}

/**
 * §2.6 — Aggregate team-wide usage across the full branch by summing the
 * LATEST `cumulative` entry per distinct `agentSlug`. Each entry already
 * carries a running total, so "latest per worker then sum" gives the correct
 * team total without double-counting older checkpoints.
 *
 * NOTE: `branch` is the active branch of the worker's session, which already
 * contains the CustomEntry history for the team in scope. We do not consult
 * `state.runtimes` here (Hard constraint: ledger is the single source of truth).
 */
export function teamUsage(branch: SessionEntry[]): TeamUsageTotals {
  const indexed = indexLedgerByAgent(branch);
  let tokens = 0;
  let costUsd = 0;
  let runs = 0;
  for (const list of indexed.values()) {
    const last = list[list.length - 1]!;
    tokens += last.cumulative.tokens;
    costUsd += last.cumulative.costUsd;
    runs += last.cumulative.runs;
  }
  return { tokens, costUsd, runs };
}

/**
 * §2.6 — Compute `remaining / cap` as a ratio in [0, 1]. Returns 0 when no
 * cap is configured (treat unbounded as fully exhausted for warning purposes).
 * Negative `consumed` (shouldn't happen, but be defensive) is clamped to 0.
 */
export function ratioRemaining(consumed: number, cap: number | undefined): number {
  if (cap === undefined) return 0;
  if (cap <= 0) return 0;
  const remaining = Math.max(0, cap - Math.max(0, consumed));
  return Math.min(1, remaining / cap);
}

/**
 * §2.6 — Has the `remainingRatio` just crossed below `threshold`? Returns
 * `true` when `remainingRatio <= threshold`. Used to gate the warning emit
 * and the abort-at-0% handler. Dedup is the caller's responsibility
 * (`alreadyWarned(ledger, "tokens")` keeps each warning firing once per
 * resource per worker).
 */
export function crossedThreshold(remainingRatio: number, threshold: number): boolean {
  return remainingRatio <= threshold;
}

// Re-export the agentSlug helper used by callers (e.g. dashboard tests that
// want to pin a specific worker to a branch).
export { latestCumulativeFor };
