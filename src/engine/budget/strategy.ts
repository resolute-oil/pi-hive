// Wave 1 F1 T1.4 — WorkerBudgetStrategy + resolver
//
// The strategy resolver maps an agent's identity to one of two strategies
// ("default" | "compact"). It is the runtime expression of the agent's
// declared `budget-strategy:` setting (or the project-wide default). The
// resolved policy is the §2.10 nested-shape WorkerBudgetPolicy that the
// dispatcher and BudgetLedger consume.
//
// The resolver is PURE: no I/O, no SDK access. It composes project defaults
// with per-agent overrides — the per-agent overrides ALWAYS win (per the
// refactor plan §2.5 / §2.10 nested-shape merge).

import type {
  AgentConfig,
  HiveConfig,
  WorkerBudgetConfig,
  WorkerBudgetPolicy,
  WorkerBudgetStrategy,
  TeamBudgetConfig,
} from "../../core/types";

// Resolve an agent's budget strategy from its config + the project defaults.
// Pure function over config — no I/O, no SDK. The (config, agentName) signature
// is the contract Wave 1 must preserve.
//
// Resolution rules (Wave 1):
//   - If the agent declares an explicit strategy in its config, that wins.
//   - Otherwise the strategy is "default".
// The Wave 0 contract pinned the "default" | "compact" union; future agents
// (F6 schema-validator for C5) may add a third value but the resolver
// surface stays the same.
export function resolveWorkerBudgetStrategy(
  config: HiveConfig,
  agentName: string,
): WorkerBudgetStrategy {
  const agent = findAgent(config, agentName);
  // Wave 0 / Wave 1 contract: WorkerBudgetStrategy is the flat enum, NOT the
  // structured Strategies object (which lands in slice 7 / F6 T6.9 if the
  // user approves C5). For now, the strategy is the documented legacy
  // "default" | "compact" — derived from the resolved policy's optional
  // strategies block, defaulting to "default".
  if (agent?.governance && (agent.governance as unknown as { "budget-strategy"?: WorkerBudgetStrategy })["budget-strategy"] !== undefined) {
    return (agent.governance as unknown as { "budget-strategy": WorkerBudgetStrategy })["budget-strategy"];
  }
  // Future: read from settings.budgets.strategies.strategy (C5).
  return "default";
}

// Resolve an agent's full budget policy by composing: project budgets default
// (settings.workerBudgets + settings.teamBudgets) → per-agent overrides
// (agent.governance). Pure function over config.
//
// Per-agent ALWAYS wins (per the refactor plan §2.5: per-agent overrides are
// the closest-to-source settings and override project-wide defaults). The
// merge returns the documented §2.10 shape (WorkerBudgetPolicy with worker /
// team blocks of optional tokens / costUsd / runs / depth).
export function resolveWorkerBudgetPolicy(
  config: HiveConfig,
  agentName: string,
): WorkerBudgetPolicy {
  const agent = findAgent(config, agentName);
  const settings = config.settings ?? {};
  const globalWorker = (settings as { workerBudgets?: WorkerBudgetConfig }).workerBudgets ?? {};
  const globalTeam = (settings as { teamBudgets?: TeamBudgetConfig }).teamBudgets ?? {};
  const perAgent = (agent?.governance as unknown as WorkerGovernanceLike | undefined) ?? {};

  // Project the legacy flat governance fields into the nested §2.10 shape.
  // Each field falls back to the global setting if absent at the per-agent
  // tier. Absent at every tier → the cap is omitted from the resolved shape
  // (unlimited).
  const worker: WorkerBudgetPolicy["worker"] = {};
  const team: WorkerBudgetPolicy["team"] = {};

  // Worker.tokens
  if (perAgent.tokenBudget !== undefined) {
    worker.tokens = { cap: perAgent.tokenBudget, window: "per-session", include: tokensFromScope(perAgent.tokenBudgetScope) };
  } else if (globalWorker.tokens?.cap !== undefined) {
    worker.tokens = { cap: globalWorker.tokens.cap, window: "per-session", include: globalWorker.tokens.include ?? ["input", "output"] };
  }
  // Worker.costUsd
  if (perAgent.costBudgetUsd !== undefined) {
    worker.costUsd = { cap: perAgent.costBudgetUsd, window: "per-session" };
  } else if (globalWorker.costUsd?.cap !== undefined) {
    worker.costUsd = { cap: globalWorker.costUsd.cap, window: "per-session" };
  }
  // Worker.runs
  if (perAgent.maxRuns !== undefined) {
    worker.runs = { cap: perAgent.maxRuns };
  } else if (globalWorker.runs?.cap !== undefined) {
    worker.runs = { cap: globalWorker.runs.cap };
  }
  // Worker.depth
  if (perAgent.maxDelegationDepth !== undefined) {
    worker.depth = { cap: perAgent.maxDelegationDepth };
  } else if (globalWorker.depth?.cap !== undefined) {
    worker.depth = { cap: globalWorker.depth.cap };
  }

  // Team.tokens
  if (globalTeam.tokens?.cap !== undefined) {
    team.tokens = { cap: globalTeam.tokens.cap, window: "per-team-lifetime", include: globalTeam.tokens.include ?? ["input", "output", "cacheRead", "cacheWrite"] };
  }
  // Team.costUsd
  if (globalTeam.costUsd?.cap !== undefined) {
    team.costUsd = { cap: globalTeam.costUsd.cap, window: "per-team-lifetime" };
  }
  // Team.runs
  if (globalTeam.runs?.cap !== undefined) {
    team.runs = { cap: globalTeam.runs.cap };
  }

  return { worker, team };
}

// Find an agent in the config's agent tree by name. Walks the flat
// `config.agents` first (the active team's direct reports) and falls back to
// the orchestrator's tree (nested `members` / `children`). Returns undefined
// if the agent is not found. Tolerates partial configs (no orchestrator /
// agents) so the contract test's `{} as HiveConfig` smoke check doesn't blow
// up — the resolver falls back to the global defaults.
function findAgent(config: HiveConfig, agentName: string): AgentConfig | undefined {
  const direct = config.agents?.find((a) => a.name === agentName);
  if (direct) return direct;
  if (config.orchestrator) return walk(config.orchestrator, agentName);
  return undefined;
}

function walk(node: AgentConfig, name: string): AgentConfig | undefined {
  if (node.name === name) return node;
  for (const child of [...(node.members ?? []), ...(node.children ?? [])]) {
    const found = walk(child, name);
    if (found) return found;
  }
  return undefined;
}

// Project the legacy "input_output" | "all" scope into the new §2.13/C2
// `include` list (the new key set from §2.13: input, output, cacheRead,
// cacheWrite, reasoning). Default for workers is input + output.
function tokensFromScope(scope: "input_output" | "all" | undefined): ["input", "output"] | ["input", "output", "cacheRead", "cacheWrite"] {
  if (scope === "all") return ["input", "output", "cacheRead", "cacheWrite"];
  return ["input", "output"];
}

// Local alias for the legacy flat WorkerGovernance fields, with the
// documented `budget-strategy` extension point. Slice 7 / F6 will refine
// this when the new nested schema lands.
interface WorkerGovernanceLike {
  tokenBudget?: number;
  tokenBudgetScope?: "input_output" | "all";
  costBudgetUsd?: number;
  maxRuns?: number;
  maxDelegationDepth?: number;
  ["budget-strategy"]?: WorkerBudgetStrategy;
}