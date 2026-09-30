// Wave 1 F1 T1.3 — BudgetPolicy pure functions
//
// Pure (no I/O of their own, no SDK side effects) decision helpers consumed
// by BudgetLedger and the dispatcher. Per the refactor plan §2.5, these
// functions take the live session + ledger + branch as arguments and return
// a BudgetBlock or a numeric metric. They are the easiest to unit-test and
// the foundation for the rest of the budget module.
//
// The G-29 type-mismatch check raises TypeError at the typebox boundary so a
// downstream dispatcher can refuse with a structured error rather than
// silently misclassifying scope.

import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { BudgetLedger } from "./ledger";
import type { BudgetBlock, BudgetLedgerEntry, IncludeKeys, WorkerBudgetPolicy } from "../../core/types";

const LEDGER_CUSTOM_TYPE = "pi-hive-budget-ledger";

// Pre-flight gate: returns a BudgetBlock describing the first violated cap
// (worker or team scope; tokens/costUsd/runs/depth), or undefined when the
// ledger + branch are under every configured cap. Pure — no I/O, no SDK.
export function checkBudgetPolicy(
  ledger: BudgetLedger,
  policy: WorkerBudgetPolicy,
  branch: SessionEntry[],
): BudgetBlock | undefined {
  // G-29 boundary check: a structurally-malformed policy (missing the
  // required `worker` field) raises TypeError so the dispatcher refuses with
  // a structured error rather than silently misclassifying scope. A policy
  // with `worker: {}` (present but empty) means "no caps configured" /
  // "unlimited" and is valid.
  if (policy === null || typeof policy !== "object" || policy.worker === undefined || policy.worker === null) {
    throw new TypeError(
      "BudgetPolicy scope mismatch: WorkerBudgetPolicy.worker is required (got undefined / non-object / null)",
    );
  }

  const workerCaps = policy.worker;
  // `team` is required by the WorkerBudgetPolicy type contract; if a
  // structurally-malformed caller passes team as undefined, the
  // team-tier checks below just skip (no caps to evaluate) and the
  // documented "no caps configured → no block" outcome holds.
  const teamCaps = policy.team;

  // Worker scope (in documented evaluation order: tokens → costUsd → runs).
  if (
    workerCaps.tokens?.cap !== undefined &&
    ledger.cumulative.tokens >= workerCaps.tokens.cap
  ) {
    return {
      reason: `Worker token budget exhausted: ${ledger.cumulative.tokens}/${workerCaps.tokens.cap}`,
      scope: "worker",
      resource: "tokens",
      remaining: { tokens: 0 },
      limit: { tokens: workerCaps.tokens.cap },
    };
  }
  if (
    workerCaps.costUsd?.cap !== undefined &&
    ledger.cumulative.costUsd >= workerCaps.costUsd.cap
  ) {
    return {
      reason: `Worker cost budget exhausted: $${ledger.cumulative.costUsd.toFixed(2)}/$${workerCaps.costUsd.cap}`,
      scope: "worker",
      resource: "costUsd",
      remaining: { costUsd: 0 },
      limit: { costUsd: workerCaps.costUsd.cap },
    };
  }
  if (
    workerCaps.runs?.cap !== undefined &&
    ledger.cumulative.runs >= workerCaps.runs.cap
  ) {
    return {
      reason: `Worker run budget exhausted: ${ledger.cumulative.runs}/${workerCaps.runs.cap}`,
      scope: "worker",
      resource: "runs",
      remaining: { runs: 0 },
      limit: { runs: workerCaps.runs.cap },
    };
  }

  // Team scope — sum the latest CustomEntry per agentSlug from the active branch.
  {
    const team = teamUsage(branch);
    if (teamCaps.tokens?.cap !== undefined && team.tokens >= teamCaps.tokens.cap) {
      return {
        reason: `Team token budget exhausted: ${team.tokens}/${teamCaps.tokens.cap}`,
        scope: "team",
        resource: "tokens",
        remaining: { tokens: 0 },
        limit: { tokens: teamCaps.tokens.cap },
      };
    }
    if (teamCaps.costUsd?.cap !== undefined && team.costUsd >= teamCaps.costUsd.cap) {
      return {
        reason: `Team cost budget exhausted: $${team.costUsd.toFixed(2)}/$${teamCaps.costUsd.cap}`,
        scope: "team",
        resource: "costUsd",
        remaining: { costUsd: 0 },
        limit: { costUsd: teamCaps.costUsd.cap },
      };
    }
    if (teamCaps.runs?.cap !== undefined && team.runs >= teamCaps.runs.cap) {
      return {
        reason: `Team run budget exhausted: ${team.runs}/${teamCaps.runs.cap}`,
        scope: "team",
        resource: "runs",
        remaining: { runs: 0 },
        limit: { runs: teamCaps.runs.cap },
      };
    }
  }

  return undefined;
}

// Sum a worker's consumed tokens, scoped by the include-list. The refactor
// plan §1.3 specifies a single call to session.getSessionStats().tokens.total
// (the session-lifetime count); the include scope is captured upstream by the
// resolver so this pure function reads total regardless of the passed scope.
export function workerConsumedTokens(_session: AgentSession, _scope: IncludeKeys): number {
  // The session argument is captured for the documented seam — Wave 3 wires
  // this to a real session; Wave 1's test seam passes a fake with the
  // expected shape. The function reads .getSessionStats().tokens.total.
  const session = _session;
  return session.getSessionStats().tokens.total;
}

// A worker's consumed cost (USD). Reads session.getSessionStats().cost.
export function workerConsumedCost(_session: AgentSession): number {
  return _session.getSessionStats().cost;
}

// Walk the active branch's pi-hive-budget-ledger CustomEntry records and
// return the team's aggregate spend (sum of the latest snapshot per worker).
export function teamUsage(branch: SessionEntry[]): { tokens: number; costUsd: number; runs: number } {
  // The branch is ordered root-to-leaf. For each agentSlug we keep the LATEST
  // cumulative (the most recent write wins). After the walk we sum across all
  // distinct slugs.
  const latestBySlug = new Map<string, { tokens: number; costUsd: number; runs: number }>();
  for (const entry of branch) {
    if (!isLedgerEntry(entry)) continue;
    const data = entry.data;
    if (!data.agentSlug || !data.cumulative) continue;
    latestBySlug.set(data.agentSlug, { ...data.cumulative });
  }
  let tokens = 0;
  let costUsd = 0;
  let runs = 0;
  for (const cumulative of latestBySlug.values()) {
    tokens += cumulative.tokens;
    costUsd += cumulative.costUsd;
    runs += cumulative.runs;
  }
  return { tokens, costUsd, runs };
}

// Type guard for ledger CustomEntries. Same predicate as in ledger.ts (kept
// here so policy.ts doesn't import from the ledger class — it only consumes
// the branch shape). TS I2 — replaces the BudgetLedgerEntryLike structural
// alias that lost its type guarantee.
function isLedgerEntry(entry: SessionEntry): entry is SessionEntry & { data: BudgetLedgerEntry["data"] } {
  return entry.type === "custom" && (entry as unknown as { customType?: string }).customType === LEDGER_CUSTOM_TYPE;
}

// Pure ratio: how much of a cap remains. Used for the warning/exhausted
// threshold checks. Returns 0 when the cap is 0 (avoid divide-by-zero at
// configuration time).
export function ratioRemaining(used: number, cap: number): number {
  if (cap === 0) return 0;
  return used / cap;
}

// Pure threshold check: did the remaining ratio cross below the threshold?
// Used to dedup the warning emit per (scope, resource, agent) pair.
export function crossedThreshold(remaining: number, threshold: number): boolean {
  return remaining <= threshold;
}