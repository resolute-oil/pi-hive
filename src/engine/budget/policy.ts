// Wave 0 contract stub — Slice 2: BudgetPolicy pure functions
//
// Pure (no I/O, no SDK calls) decision helpers consumed by BudgetLedger and
// the dispatcher. Per the refactor plan §2.5, these functions take the live
// session + ledger + branch as arguments and return a budget block or a
// numeric metric. They are the easiest to unit-test and the foundation for
// the rest of the budget module.

import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { BudgetLedger } from "./ledger";
import type { BudgetBlock, IncludeKeys, WorkerBudgetPolicy } from "../../core/types";

// Pre-flight gate: returns a BudgetBlock describing the first violated cap
// (worker or team scope; tokens/costUsd/runs/depth), or undefined when the
// ledger + branch are under every configured cap. Pure — no I/O, no SDK.
export function checkBudgetPolicy(
  _ledger: BudgetLedger,
  _policy: WorkerBudgetPolicy,
  _branch: SessionEntry[],
): BudgetBlock | undefined {
  throw new Error("not implemented");
}

// Sum a worker's consumed tokens, scoped by the include-list. Reads from
// session.getSessionStats().tokens.{input,output,cacheRead,cacheWrite} filtered
// to the keys in `scope`. Pure (no I/O; session access is read-only).
export function workerConsumedTokens(_session: AgentSession, _scope: IncludeKeys): number {
  throw new Error("not implemented");
}

// A worker's consumed cost (USD). Reads session.getSessionStats().cost.
export function workerConsumedCost(_session: AgentSession): number {
  throw new Error("not implemented");
}

// Walk the active branch's pi-hive-budget-ledger CustomEntry records and
// return the team's aggregate spend (sum of the latest snapshot per worker).
export function teamUsage(_branch: SessionEntry[]): { tokens: number; costUsd: number; runs: number } {
  throw new Error("not implemented");
}

// Pure ratio: how much of a cap remains. Used for the warning/exhausted
// threshold checks. Returns 0 when the cap is 0 (avoid divide-by-zero at
// configuration time).
export function ratioRemaining(_used: number, _cap: number): number {
  throw new Error("not implemented");
}

// Pure threshold check: did the remaining ratio cross below the threshold?
// Used to dedup the warning emit per (scope, resource, agent) pair.
export function crossedThreshold(_remaining: number, _threshold: number): boolean {
  throw new Error("not implemented");
}
