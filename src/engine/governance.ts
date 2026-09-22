import type { AgentRuntime, HiveState, TeamBudgets, WorkerGovernance } from "../core/types";

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
  return { ...(state.config?.settings.worker || {}), ...(runtime.config.governance || {}) };
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

function runtimeTokenBaseline(runtime: AgentRuntime, scope: TokenScope): number {
  const base = (runtime.runStartInputTokens || 0) + (runtime.runStartOutputTokens || 0);
  return scope === "input_output"
    ? base
    : base
      + (runtime.runStartCacheReadTokens || 0)
      + (runtime.runStartCacheWriteTokens || 0)
      + (runtime.runStartReasoningTokens || 0);
}

export function workerConsumedTokens(runtime: AgentRuntime, scope: TokenScope = "all"): number {
  const prior = runtime.governanceTokens ?? runtimeTokens(runtime, scope);
  if (runtime.status !== "running" || runtime.governanceTokens === undefined) return prior;
  return prior + Math.max(0, runtimeTokens(runtime, scope) - runtimeTokenBaseline(runtime, scope));
}

export function workerConsumedCost(runtime: AgentRuntime): number {
  const prior = runtime.governanceCostUsd ?? runtime.costUsd;
  if (runtime.status !== "running" || runtime.governanceCostUsd === undefined) return prior;
  return prior + Math.max(0, runtime.costUsd - (runtime.runStartCostUsd || 0));
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

export async function acquireWorkerSlot(state: HiveState, signal?: AbortSignal): Promise<"acquired" | "parallel" | "queue-full" | "cancelled"> {
  const max = state.config?.settings.maxParallel;
  if (max === undefined || state.activeRuns < max) {
    state.activeRuns++;
    return "acquired";
  }
  const queueSize = state.config?.settings.queueSize;
  if (queueSize === undefined) return "parallel";
  const queue = state.workerQueue ||= [];
  if (queue.length >= queueSize) return "queue-full";
  return new Promise((resolve) => {
    const id = state.nextQueueId = (state.nextQueueId || 0) + 1;
    const waiter = {
      id,
      signal,
      resolve: () => resolve("acquired" as const),
      reject: () => resolve("cancelled" as const),
      abort: undefined as (() => void) | undefined,
    };
    waiter.abort = () => {
      const index = queue.findIndex((entry) => entry.id === id);
      if (index >= 0) queue.splice(index, 1);
      resolve("cancelled");
    };
    if (signal?.aborted) return waiter.abort();
    signal?.addEventListener("abort", waiter.abort, { once: true });
    queue.push(waiter);
  });
}

export function releaseWorkerSlot(state: HiveState): void {
  state.activeRuns = Math.max(0, state.activeRuns - 1);
  const waiter = state.workerQueue?.shift();
  if (!waiter) return;
  if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
  state.activeRuns++;
  waiter.resolve();
}

export function cancelWorkerQueue(state: HiveState, reason = "Hive session ended"): void {
  const queue = state.workerQueue?.splice(0) || [];
  for (const waiter of queue) {
    if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
    waiter.reject(new Error(reason));
  }
}
