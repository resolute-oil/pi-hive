// Wave 5A F9 T9.1 — Legacy budget enforcement moved out of governance.ts.
//
// `budgetRemaining`, `checkDispatchBudgets`, `teamUsage`, `workerConsumed*`
// and the `effectiveWorkerGovernance` shim live here so the dispatcher can
// still enforce legacy `WorkerGovernance`-shaped caps during the cutover
//
// §1.1 shim: the `AgentRuntime` shape no longer carries the §1.1 counter
// fields (`runStart*` + `governanceTokens/governanceCostUsd`) that this
// module's helpers used to compute per-run deltas. The legacy functions
// are slated for full deletion in Gap 3; until then we typecast the runtime
// parameter locally so the file still typechecks. The runtime BEHAVIOR of
// these helpers is unchanged — call sites that still pass the legacy fields
// will silently see `undefined` for the deleted ones, which is the same as
// the pre-removal default (every read was guarded with `?? 0` fallbacks).
// window. The new enforcement path (`checkBudgetPolicy` in policy.ts) reads
// the nested `WorkerBudgetPolicy` shape — when all live dispatch sites
// migrate to it, this module is deletable.
//
// `effectiveWorkerGovernance` is the merge shim callers use when they need
// both the budget-tier fields (tokenBudgetScope, etc.) AND the per-agent
// non-budget fields (timeoutMs, distillerRuns). The policy resolver does
// NOT model timeoutMs / distillerRuns because they're per-agent concurrency
// settings, not budget caps — keeping them out of `WorkerBudgetPolicy` is
// intentional and the seam is documented at the call sites below.

import type { AgentRuntime, HiveState, TeamBudgets, WorkerGovernance } from "../../core/types";

export interface BudgetRemaining {
  runs?: number;
  tokens?: number;
  costUsd?: number;
  distillerRuns?: number;
}

export interface GovernanceBlock {
  resource: "runs" | "tokens" | "cost" | "depth" | "queue";
  scope: "worker" | "team";
  message: string;
}

export type TokenScope = "input_output" | "all";

export function effectiveWorkerGovernance(state: HiveState, runtime: AgentRuntime): WorkerGovernance {
  return { ...(state.config?.settings.workerBudgets || {}), ...(runtime.config.governance || {}) };
}

// Token totals depend on the configured scope. "all" keeps the legacy
// cumulative-of-everything-Pi-reports behavior (default, backward compatible).
// "input_output" restricts to the two dimensions that fill the model's
// context window on each call.
function runtimeTokens(runtime: AgentRuntime, scope: TokenScope = "all"): number {
  const base = runtime.inputTokens + runtime.outputTokens;
  return scope === "input_output"
    ? base
    : base + runtime.cacheReadTokens + runtime.cacheWriteTokens + runtime.reasoningTokens;
}

// §1.1 shim: the deleted `runStart*` + `governance*` fields are accessed via
// a structural typecast so this legacy module still typechecks. The fields
// resolve to `undefined` at runtime (and the helpers' `?? 0` fallbacks then
// kick in), matching the pre-removal behavior on legacy runtimes. The file
// is deleted by Gap 3 of the completion-guard work.
type LegacyCounters = {
  runStartInputTokens?: number;
  runStartOutputTokens?: number;
  runStartCacheReadTokens?: number;
  runStartCacheWriteTokens?: number;
  runStartReasoningTokens?: number;
  runStartCostUsd?: number;
  governanceTokens?: number;
  governanceCostUsd?: number;
};
function legacy(runtime: AgentRuntime): AgentRuntime & LegacyCounters {
  return runtime as AgentRuntime & LegacyCounters;
}

function runtimeTokenBaseline(runtime: AgentRuntime, scope: TokenScope): number {
  const r = legacy(runtime);
  const base = (r.runStartInputTokens || 0) + (r.runStartOutputTokens || 0);
  return scope === "input_output"
    ? base
    : base
      + (r.runStartCacheReadTokens || 0)
      + (r.runStartCacheWriteTokens || 0)
      + (r.runStartReasoningTokens || 0);
}

export function workerConsumedTokens(runtime: AgentRuntime, scope: TokenScope = "all"): number {
  const r = legacy(runtime);
  const prior = r.governanceTokens ?? runtimeTokens(runtime, scope);
  if (runtime.status !== "running" || r.governanceTokens === undefined) return prior;
  return prior + Math.max(0, runtimeTokens(runtime, scope) - runtimeTokenBaseline(runtime, scope));
}

export function workerConsumedCost(runtime: AgentRuntime): number {
  const r = legacy(runtime);
  const prior = r.governanceCostUsd ?? runtime.costUsd;
  if (runtime.status !== "running" || r.governanceCostUsd === undefined) return prior;
  return prior + Math.max(0, runtime.costUsd - (r.runStartCostUsd || 0));
}

export function teamUsage(state: HiveState, scope: TokenScope = "all"): { runs: number; tokens: number; costUsd: number } {
  let runs = 0;
  let tokens = 0;
  let costUsd = 0;
  for (const runtime of state.runtimes.values()) {
    if (runtime.config.role === "orchestrator") continue;
    runs += runtime.runCount;
    tokens += workerConsumedTokens(runtime, scope);
    costUsd += workerConsumedCost(runtime);
  }
  return { runs, tokens, costUsd };
}

export function budgetRemaining(state: HiveState, runtime: AgentRuntime): { worker: BudgetRemaining; team: BudgetRemaining } {
  const limits = effectiveWorkerGovernance(state, runtime);
  const teamLimits = state.config?.settings.teamBudgets || {};
  const workerScope = limits.tokenBudgetScope ?? "all";
  const teamScope = teamLimits.tokenBudgetScope ?? "all";
  const team = teamUsage(state, teamScope);
  const remaining = (limit: number | undefined, used: number): number | undefined => limit === undefined ? undefined : Math.max(0, limit - used);
  return {
    worker: {
      runs: remaining(limits.maxRuns, runtime.runCount),
      tokens: remaining(limits.tokenBudget, workerConsumedTokens(runtime, workerScope)),
      costUsd: remaining(limits.costBudgetUsd, workerConsumedCost(runtime)),
      distillerRuns: remaining(limits.distillerRuns, runtime.distillerRunCount || 0),
    },
    team: {
      runs: remaining(teamLimits.maxRuns, team.runs),
      tokens: remaining(teamLimits.tokenBudget, team.tokens),
      costUsd: remaining(teamLimits.costBudgetUsd, team.costUsd),
    },
  };
}

export function checkDispatchBudgets(state: HiveState, runtime: AgentRuntime, depth: number): GovernanceBlock | undefined {
  const limits = effectiveWorkerGovernance(state, runtime);
  const teamLimits: TeamBudgets = state.config?.settings.teamBudgets || {};
  const workerScope = limits.tokenBudgetScope ?? "all";
  const teamScope = teamLimits.tokenBudgetScope ?? "all";
  const team = teamUsage(state, teamScope);
  if (limits.maxDelegationDepth !== undefined && depth > limits.maxDelegationDepth) {
    return { resource: "depth", scope: "worker", message: `${runtime.config.name} maximum delegation depth exhausted (${limits.maxDelegationDepth}).` };
  }
  if (limits.maxRuns !== undefined && runtime.runCount >= limits.maxRuns) {
    return { resource: "runs", scope: "worker", message: `${runtime.config.name} run budget exhausted (${limits.maxRuns}).` };
  }
  if (limits.tokenBudget !== undefined && workerConsumedTokens(runtime, workerScope) >= limits.tokenBudget) {
    return { resource: "tokens", scope: "worker", message: `${runtime.config.name} token budget exhausted (${limits.tokenBudget}).` };
  }
  if (limits.costBudgetUsd !== undefined && workerConsumedCost(runtime) >= limits.costBudgetUsd) {
    return { resource: "cost", scope: "worker", message: `${runtime.config.name} cost budget exhausted ($${limits.costBudgetUsd}).` };
  }
  if (teamLimits.maxRuns !== undefined && team.runs >= teamLimits.maxRuns) {
    return { resource: "runs", scope: "team", message: `Team run budget exhausted (${teamLimits.maxRuns}).` };
  }
  if (teamLimits.tokenBudget !== undefined && team.tokens >= teamLimits.tokenBudget) {
    return { resource: "tokens", scope: "team", message: `Team token budget exhausted (${teamLimits.tokenBudget}).` };
  }
  if (teamLimits.costBudgetUsd !== undefined && team.costUsd >= teamLimits.costBudgetUsd) {
    return { resource: "cost", scope: "team", message: `Team cost budget exhausted ($${teamLimits.costBudgetUsd}).` };
  }
}
