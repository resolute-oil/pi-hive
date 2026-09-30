import type { AgentConfig, HiveConfig } from "./types";
import { AGENT_TYPES, PLAN_STAGES } from "./normalize";
import { agentSlug } from "./agent-tree";
import { Type, type Static } from "typebox";

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
}

function assertString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
}

function assertBoolean(value: unknown, label: string) {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`${label} must be true or false when provided.`);
}

function assertRequiredBoolean(value: unknown, label: string) {
  if (typeof value !== "boolean") throw new Error(`${label} must be explicitly set to true or false.`);
}

function assertNumber(value: unknown, label: string) {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`${label} must be a finite number when provided.`);
}

function assertStringEnum(value: unknown, label: string, allowed: readonly string[]) {
  if (value === undefined) return;
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${label} must be one of ${allowed.join(", ")} when provided; got ${JSON.stringify(value)}.`);
}

function validateGovernance(value: unknown, label: string) {
  if (value === undefined) return;
  assertObject(value, label);
  for (const key of ["timeoutMs", "maxDelegationDepth", "maxRuns", "tokenBudget", "costBudgetUsd", "distillerRuns"] as const) {
    assertNumber(value[key], `${label}.${key}`);
  }
  assertStringEnum(value.tokenBudgetScope, `${label}.tokenBudgetScope`, ["input_output", "all"]);
}

function validateKnowledgeRefs(value: unknown, label: string) {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${label} must be a list.`);
  value.forEach((entry, index) => {
    assertObject(entry, `${label}[${index}]`);
    assertString(entry.path, `${label}[${index}].path`);
  });
}

function validateStringList(value: unknown, label: string) {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${label} must be a list of strings.`);
  value.forEach((entry, index) => assertString(entry, `${label}[${index}]`));
}

function validateDomains(value: unknown, label: string) {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${label} must be a list.`);
  value.forEach((entry, index) => {
    assertObject(entry, `${label}[${index}]`);
    assertString(entry.path, `${label}[${index}].path`);
    assertRequiredBoolean(entry.read, `${label}[${index}].read`);
    assertRequiredBoolean(entry.upsert, `${label}[${index}].upsert`);
    assertRequiredBoolean(entry.delete, `${label}[${index}].delete`);
    validateStringList(entry.include, `${label}[${index}].include`);
    validateStringList(entry.exclude, `${label}[${index}].exclude`);
  });
}

function validateAgent(agent: AgentConfig, label: string, seen: Map<string, string>) {
  assertObject(agent, label);
  assertString(agent.name, `${label}.name`);
  assertString(agent.path, `${label}.path`);
  if (agent.slug !== undefined) assertString(agent.slug, `${label}.slug`);
  const key = agentSlug(agent);
  const prior = seen.get(key);
  if (prior) throw new Error(`Duplicate agent slug "${key}" at ${label}; already used at ${prior}.`);
  seen.set(key, label);
  if (agent.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(agent.color))) throw new Error(`${label}.color must be #rrggbb when provided.`);
  if (agent.routingTags !== undefined && !Array.isArray(agent.routingTags)) throw new Error(`${label}.routingTags must be a list.`);
  if (agent.responsibilities !== undefined && !Array.isArray(agent.responsibilities)) throw new Error(`${label}.responsibilities must be a list.`);
  if (agent.delegateStrict !== undefined && typeof agent.delegateStrict !== "boolean") throw new Error(`${label}.delegateStrict must be a boolean when provided.`);
  validateKnowledgeRefs(agent.context, `${label}.context`);
  validateKnowledgeRefs(agent.skills, `${label}.skills`);
  validateDomains(agent.domain, `${label}.domain`);
  validateGovernance(agent.governance, `${label}.governance`);
  if (agent.members !== undefined && !Array.isArray(agent.members)) throw new Error(`${label}.members must be a list.`);
  if (agent.children !== undefined && !Array.isArray(agent.children)) throw new Error(`${label}.children must be a list.`);
  [...(agent.members || []), ...(agent.children || [])].forEach((child, index) => validateAgent(child, `${label}.members[${index}]`, seen));
}

// Validate the agent-type contract for one node. Runs AFTER frontmatter
// enrichment (agent-type lives in the .md, not hive-config.yaml). agent-type is
// REQUIRED and must be one of the five types; a clean break is acceptable
// because only a couple of repos use pi-hive today.
function validateAgentType(agent: AgentConfig, label: string) {
  const type = agent.agentType;
  if (type === undefined || type === null || String(type).trim() === "") {
    throw new Error(`${label}.agent-type is required (one of ${AGENT_TYPES.join(", ")}). Add 'agent-type:' to the agent's frontmatter.`);
  }
  if (!(AGENT_TYPES as readonly string[]).includes(String(type))) {
    throw new Error(`${label}.agent-type must be one of ${AGENT_TYPES.join(", ")}; got "${type}".`);
  }
  if (agent.stages !== undefined) {
    if (!Array.isArray(agent.stages)) throw new Error(`${label}.stages must be a list of planning gates (${PLAN_STAGES.join(", ")}).`);
    if (type !== "planner") throw new Error(`${label}.stages is only valid on an agent-type: planner (this agent is "${type}").`);
    agent.stages.forEach((stage, index) => {
      if (!(PLAN_STAGES as readonly string[]).includes(String(stage))) {
        throw new Error(`${label}.stages[${index}] must be one of ${PLAN_STAGES.join(", ")}; got "${stage}".`);
      }
    });
  }
  if (agent.network !== undefined && typeof agent.network !== "boolean") {
    throw new Error(`${label}.network must be true or false when provided.`);
  }
  if (agent.commit !== undefined && (typeof agent.commit !== "string" || !agent.commit.trim())) {
    throw new Error(`${label}.commit must be a non-empty string when provided.`);
  }
}

// Walk the enriched config tree (orchestrator + agents + nested members) and
// hard-fail if any node violates the agent-type contract.
export function validateAgentTypes(config: HiveConfig): void {
  const walk = (agent: AgentConfig | undefined, label: string) => {
    if (!agent) return;
    validateAgentType(agent, label);
    [...(agent.members || []), ...(agent.children || [])].forEach((child, index) => walk(child, `${label}.members[${index}]`));
  };
  walk(config.orchestrator, "orchestrator");
  (config.agents || []).forEach((agent, index) => walk(agent, `agents[${index}]`));
}

export function validateHiveConfigShape(config: HiveConfig): void {
  assertObject(config, "hive-config.yaml");
  validateAgent(config.orchestrator, "orchestrator", new Map());
  if (config.sharedContext !== undefined && !Array.isArray(config.sharedContext)) throw new Error("shared_context must be a list.");
  if (config.agents !== undefined && !Array.isArray(config.agents)) throw new Error("agents must be a list.");
  const seen = new Map([[config.orchestrator.name.toLowerCase(), "orchestrator"]]);
  (config.agents || []).forEach((agent, index) => validateAgent(agent, `agents[${index}]`, seen));
  if (config.settings) {
    assertObject(config.settings, "settings");
    assertNumber(config.settings.subagentOutputLimit, "settings.subagentOutputLimit");
    assertNumber(config.settings.maxParallel, "settings.maxParallel");
    assertNumber(config.settings.queueSize, "settings.queueSize");
    validateGovernance(config.settings.workerBudgets, "settings.workerBudgets");
    if (config.settings.teamBudgets) {
      assertObject(config.settings.teamBudgets, "settings.teamBudgets");
      assertNumber(config.settings.teamBudgets.maxRuns, "settings.teamBudgets.maxRuns");
      assertNumber(config.settings.teamBudgets.tokenBudget, "settings.teamBudgets.tokenBudget");
      assertStringEnum(config.settings.teamBudgets.tokenBudgetScope, "settings.teamBudgets.tokenBudgetScope", ["input_output", "all"]);
      assertNumber(config.settings.teamBudgets.costBudgetUsd, "settings.teamBudgets.costBudgetUsd");
    }
    validateStringList(config.settings.secretPaths, "settings.secretPaths");
    if (config.settings.distiller) {
      assertObject(config.settings.distiller, "settings.distiller");
      assertBoolean(config.settings.distiller.enabled, "settings.distiller.enabled");
      assertNumber(config.settings.distiller.conversationLines, "settings.distiller.conversationLines");
    }
  }
}

// ── Wave 0 contract stubs — Slice 7 typebox schemas ────────────────────────
//
// These coexist with the hand-written validators above. Wave 1 will add a
// typebox-driven validator that consumes BudgetsConfigSchema at config-load
// time and rejects invalid combinations (e.g., costUsd.window: "per-day")
// with structured errors. The hand-written validators remain in place until
// Wave 9's legacy cleanup removes them.

const TokensCap = Type.Object({
  resource: Type.Literal("tokens"),
  cap: Type.Number({ minimum: 0 }),
  window: Type.Optional(Type.Union([
    Type.Literal("per-session"),
    Type.Literal("per-run"),
    Type.Literal("per-day"),
    Type.Literal("per-team-lifetime"),
  ])),
  include: Type.Optional(Type.Array(Type.Union([
    Type.Literal("input"),
    Type.Literal("output"),
    Type.Literal("cacheRead"),
    Type.Literal("cacheWrite"),
    Type.Literal("reasoning"),
  ]))),
});
const CostUsdCap = Type.Object({
  resource: Type.Literal("costUsd"),
  cap: Type.Number({ minimum: 0 }),
  window: Type.Optional(Type.Union([
    Type.Literal("per-session"),
    Type.Literal("per-team-lifetime"),
  ])),
});
const RunsCap = Type.Object({
  resource: Type.Literal("runs"),
  cap: Type.Number({ minimum: 0 }),
});
const DepthCap = Type.Object({
  resource: Type.Literal("depth"),
  cap: Type.Number({ minimum: 0 }),
});

export const BudgetCap = Type.Union([TokensCap, CostUsdCap, RunsCap, DepthCap]);
export type BudgetCap = Static<typeof BudgetCap>;

export const BudgetsConfigSchema = Type.Object({
  defaultsEnabled: Type.Optional(Type.Boolean()),
  perWorker: Type.Object({
    tokens: Type.Optional(TokensCap),
    costUsd: Type.Optional(CostUsdCap),
    runs: Type.Optional(RunsCap),
    depth: Type.Optional(DepthCap),
  }),
  perTeam: Type.Object({
    tokens: Type.Optional(TokensCap),
    costUsd: Type.Optional(CostUsdCap),
    runs: Type.Optional(RunsCap),
  }),
  strategies: Type.Optional(Type.Object({
    onApproachingLimit: Type.Object({
      action: Type.Union([Type.Literal("wrap-up"), Type.Literal("compact"), Type.Literal("none")]),
      threshold: Type.Number({ minimum: 0, maximum: 1 }),
      hint: Type.String(),
    }),
    onExhaustion: Type.Object({
      action: Type.Union([Type.Literal("compact"), Type.Literal("abort"), Type.Literal("none")]),
      customInstructions: Type.Optional(Type.String()),
    }),
    summary: Type.Object({
      maxTokens: Type.Number({ minimum: 0 }),
    }),
  })),
});
export type BudgetsConfig = Static<typeof BudgetsConfigSchema>;

// ── Wave 1 (F6) — typebox-driven validator ──────────────────────────────────
//
// Validates the new nested-budget config (T6.1) against BudgetsConfigSchema.
// Throws with a path-bearing error so callers can surface the offending
// config key (e.g., `settings.budgets.perWorker.tokens/cap`). Used by the
// config-loading layer (src/core/config.ts) once the hard cutover lands; the
// hand-written validators above stay in place until Wave 9 cleans them up.
import { Value } from "typebox/value";

function formatPath(path: string): string {
  // typebox returns JSON Pointer paths like "/perWorker/tokens/cap"; turn
  // them into the dotted/indexed form the rest of the schema uses
  // (`settings.budgets.perWorker.tokens.cap`).
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => /^\d+$/.test(segment) ? `[${segment}]` : segment)
    .join(".")
    .replace(/\.([^.]+)$/, "/$1");
}

export function validateBudgetsConfig(value: unknown): asserts value is BudgetsConfig {
  assertObject(value, "budgets");
  const errors = Value.Errors(BudgetsConfigSchema, value);
  if (errors.length > 0) {
    // Surface the most specific error (skip root-level "missing required
    // property" complaints when a deeper path also fails). Otherwise the
    // user sees "must have required properties perTeam" when the real bug
    // is a negative cap deep inside perWorker.
    const leaf = errors.find((err) => err.instancePath && err.instancePath !== "") ?? errors[0];
    const path = leaf.instancePath ? formatPath(leaf.instancePath) : "<root>";
    const detail = leaf.message ?? "value does not match BudgetsConfigSchema";
    throw new Error(`budgets.${path}: ${detail}`);
  }
}
