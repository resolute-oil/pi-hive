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
  ContextConstraint,
  HiveConfig,
  WorkerBudgetPolicy,
  WorkerBudgetStrategy,
  WorkerGovernance,
  BudgetsConfig,
  Strategies,
  IncludeKey,
} from "../../core/types";

// ContextConstraint is the new per-worker/per-team cap type
// (wave context-constraint T1). The strategy resolver passes it
// through verbatim — typebox validation already enforced "exactly one
// of tokens/percent" at config-load (see schema.ts enforceContextConstraint),
// so the runtime does not need to re-validate. The named type is
// imported here so a future code path (per-agent governance override
// of context) can extend the resolver without re-importing.

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
  if (agent?.governance && agent.governance["budget-strategy"] !== undefined) {
    return agent.governance["budget-strategy"];
  }
  // Future: read from settings.budgets.strategies.strategy (C5).
  return "default";
}

// Read the canonical §2.10 nested budgets block from settings, falling back
// to the legacy flat keys when `settings.budgets` is absent. Returns
// `undefined` when neither is present so callers can compose with the
// per-agent override layer without a special-case for "no global at all".
//
// The fallback is intentional: the plan's G-16 hard-cutover targets users
// (the migration guide is the canonical "after" form), but the resolver
// stays additive so configs that haven't migrated continue to work. Wave
// 5A's legacy cleanup drops the fallback branch.
function readGlobalBudgets(settings: HiveConfig["settings"]): {
  perWorker?: BudgetsConfig["perWorker"];
  perTeam?: BudgetsConfig["perTeam"];
  strategies?: Strategies;
} {
  if (settings?.budgets !== undefined) {
    return {
      perWorker: settings.budgets.perWorker,
      perTeam: settings.budgets.perTeam,
      strategies: settings.budgets.strategies,
    };
  }
  // Legacy fallback: project the flat governance fields into the nested
  // shape so the rest of the resolver stays a single code path. Each legacy
  // field maps 1:1 to the §2.10 nested cap.
  const legacyWorker: BudgetsConfig["perWorker"] = {};
  const lw = settings?.workerBudgets as
    | { tokenBudget?: number; costBudgetUsd?: number; maxRuns?: number; maxDelegationDepth?: number; tokenBudgetScope?: "input_output" | "all" }
    | undefined;
  if (lw?.tokenBudget !== undefined) {
    legacyWorker.tokens = { cap: lw.tokenBudget, window: "per-session", include: tokensFromScope(lw.tokenBudgetScope) };
  }
  if (lw?.costBudgetUsd !== undefined) {
    legacyWorker.costUsd = { cap: lw.costBudgetUsd, window: "per-session" };
  }
  if (lw?.maxRuns !== undefined) {
    legacyWorker.runs = { cap: lw.maxRuns };
  }
  if (lw?.maxDelegationDepth !== undefined) {
    legacyWorker.depth = { cap: lw.maxDelegationDepth };
  }
  const legacyTeam: BudgetsConfig["perTeam"] = {};
  const lt = settings?.teamBudgets as
    | { maxRuns?: number; tokenBudget?: number; costBudgetUsd?: number; tokenBudgetScope?: "input_output" | "all" }
    | undefined;
  if (lt?.tokenBudget !== undefined) {
    legacyTeam.tokens = { cap: lt.tokenBudget, window: "per-team-lifetime", include: tokensFromScope(lt.tokenBudgetScope) };
  }
  if (lt?.costBudgetUsd !== undefined) {
    legacyTeam.costUsd = { cap: lt.costBudgetUsd, window: "per-team-lifetime" };
  }
  if (lt?.maxRuns !== undefined) {
    legacyTeam.runs = { cap: lt.maxRuns };
  }
  // `strategies` does not exist on the legacy shape — only the canonical
  // §2.13/C5 nested config carries it. Legacy users stay on the documented
  // "default" / "abort" fallback in events.ts.
  if (Object.keys(legacyWorker).length === 0 && Object.keys(legacyTeam).length === 0) {
    return {};
  }
  return { perWorker: legacyWorker, perTeam: legacyTeam };
}

// Resolve an agent's full budget policy by composing: project budgets default
// (settings.budgets preferred, settings.workerBudgets/teamBudgets as legacy
// fallback) → per-agent overrides (agent.governance). Pure function over
// config.
//
// Per-agent ALWAYS wins (per the refactor plan §2.5: per-agent overrides are
// the closest-to-source settings and override project-wide defaults). The
// merge returns the documented §2.10 shape (WorkerBudgetPolicy with worker /
// team blocks of optional tokens / costUsd / runs / depth, plus the C5
// strategies block when the user declared one).
export function resolveWorkerBudgetPolicy(
  config: HiveConfig,
  agentName: string,
): WorkerBudgetPolicy {
  const agent = findAgent(config, agentName);
  const settings = config.settings ?? {};
  const global = readGlobalBudgets(settings);
  const globalWorker = global.perWorker ?? {};
  const globalTeam = global.perTeam ?? {};
  const perAgent: WorkerGovernance = agent?.governance ?? {};

  // Project the per-agent governance fields (canonical nested shape from
  // parseAgentBudgetsFrontmatter OR the legacy flat shape) into the §2.10
  // nested WorkerBudgetPolicy. Each field falls back to the global setting
  // if absent at the per-agent tier. Absent at every tier → the cap is
  // omitted from the resolved shape (unlimited).
  const worker: WorkerBudgetPolicy["worker"] = {};
  const team: WorkerBudgetPolicy["team"] = {};

  // Worker.tokens — accept the new nested shape (perAgent.tokens.cap) and the
  // legacy scalar (perAgent.tokenBudget) so agent.md frontmatter with either
  // form lands in the same resolved policy. Block 2 fix gives frontmatter
  // both shapes; this resolver reads both.
  if (perAgent.tokens?.cap !== undefined) {
    worker.tokens = { cap: perAgent.tokens.cap, window: perAgent.tokens.window ?? "per-session", include: perAgent.tokens.include ?? ["input", "output"] };
  } else if (perAgent.tokenBudget !== undefined) {
    worker.tokens = { cap: perAgent.tokenBudget, window: "per-session", include: tokensFromScope(perAgent.tokenBudgetScope) };
  } else if (globalWorker.tokens?.cap !== undefined) {
    worker.tokens = { cap: globalWorker.tokens.cap, window: globalWorker.tokens.window ?? "per-session", include: globalWorker.tokens.include ?? ["input", "output"] };
  }
  // Worker.costUsd
  if (perAgent.costUsd?.cap !== undefined) {
    worker.costUsd = { cap: perAgent.costUsd.cap, window: perAgent.costUsd.window ?? "per-session" };
  } else if (perAgent.costBudgetUsd !== undefined) {
    worker.costUsd = { cap: perAgent.costBudgetUsd, window: "per-session" };
  } else if (globalWorker.costUsd?.cap !== undefined) {
    worker.costUsd = { cap: globalWorker.costUsd.cap, window: globalWorker.costUsd.window ?? "per-session" };
  }
  // Worker.runs
  if (perAgent.runs?.cap !== undefined) {
    worker.runs = { cap: perAgent.runs.cap };
  } else if (perAgent.maxRuns !== undefined) {
    worker.runs = { cap: perAgent.maxRuns };
  } else if (globalWorker.runs?.cap !== undefined) {
    worker.runs = { cap: globalWorker.runs.cap };
  }
  // Worker.depth
  if (perAgent.depth?.cap !== undefined) {
    worker.depth = { cap: perAgent.depth.cap };
  } else if (perAgent.maxDelegationDepth !== undefined) {
    worker.depth = { cap: perAgent.maxDelegationDepth };
  } else if (globalWorker.depth?.cap !== undefined) {
    worker.depth = { cap: globalWorker.depth.cap };
  }
  // Worker.context (wave context-constraint). The ContextConstraint is
  // passed through verbatim — the schema-level `enforceContextConstraint`
  // already validated "exactly one of tokens/percent is set," so the
  // resolver can carry the object as-is. Per-agent governance does not
  // currently expose a context override; if a future frontmatter key is
  // added, this branch would extend to honor it. For now: global only.
  if (globalWorker.context !== undefined) {
    worker.context = globalWorker.context;
  }

  // Team.tokens — global only; teams don't carry per-agent overrides.
  if (globalTeam.tokens?.cap !== undefined) {
    team.tokens = { cap: globalTeam.tokens.cap, window: globalTeam.tokens.window ?? "per-team-lifetime", include: globalTeam.tokens.include ?? ["input", "output", "cacheRead", "cacheWrite", "reasoning"] };
  }
  // Team.costUsd
  if (globalTeam.costUsd?.cap !== undefined) {
    team.costUsd = { cap: globalTeam.costUsd.cap, window: globalTeam.costUsd.window ?? "per-team-lifetime" };
  }
  // Team.runs
  if (globalTeam.runs?.cap !== undefined) {
    team.runs = { cap: globalTeam.runs.cap };
  }
  // Team.context (wave context-constraint). Per the brief, the include list
  // does NOT apply to context (getContextUsage().tokens is a single coherent
  // number from the SDK; including the include list would be double-counting).
  // Pass through verbatim, same as worker.context above.
  if (globalTeam.context !== undefined) {
    team.context = globalTeam.context;
  }

  // Strategies block (C5 conditional). Propagate from the canonical nested
  // config; absent when the user didn't opt in. Events.ts applies its
  // documented defaults (warningThreshold=0.20, onExhaustionAction="abort").
  const strategies = global.strategies;
  return strategies === undefined ? { worker, team } : { worker, team, strategies };
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
// cacheWrite, reasoning). Default for workers is input + output. TS I10
// — adds "reasoning" to the "all" default (the resolver reads
// session.runtime.reasoningTokens as a first-class dimension).
function tokensFromScope(scope: "input_output" | "all" | undefined): IncludeKey[] {
  if (scope === "all") return ["input", "output", "cacheRead", "cacheWrite", "reasoning"];
  return ["input", "output"];
}
