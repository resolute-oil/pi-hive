import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { AgentConfig, HiveConfig } from "./types";
import { AGENT_TYPES, PLAN_STAGES } from "./normalize";
import { agentSlug } from "./agent-tree";

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
  // Wave 1B hard cutover: per-agent `governance:` is gone; the new frontmatter
  // shape is `budgets:` (C1). The actual frontmatter parser still has to accept
  // the new key — see src/agents/frontmatter.ts.
  validateAgentBudgets(agent.budgets, `${label}.budgets`);
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
    // Wave 1B hard cutover: legacy `workerBudgets` / `teamBudgets` flat blocks
    // are gone; the new shape is `settings.budgets:` (per-worker + per-team).
    // `HiveSettings` still carries the legacy fields for runtime backward
    // compat — Wave 2+ (F2/F9) will rewire the engine to read from the new
    // shape and delete the legacy fields.
    if ((config.settings as Record<string, unknown>).budgets !== undefined) {
      validateBudgets((config.settings as Record<string, unknown>).budgets, "settings.budgets");
    }
    validateStringList(config.settings.secretPaths, "settings.secretPaths");
    if (config.settings.distiller) {
      assertObject(config.settings.distiller, "settings.distiller");
      assertBoolean(config.settings.distiller.enabled, "settings.distiller.enabled");
      assertNumber(config.settings.distiller.conversationLines, "settings.distiller.conversationLines");
    }
  }
}

// ===========================================================================
// Wave 1B — F6 typebox schemas (T6.1, T6.7).
//
// §2.10/§2.13 of docs/reviews/28-09-2026-budget-review/04-refactor-plan.md.
// Hard cutover per G-16 — legacy `tokenBudget`/`tokenBudgetScope`/`costBudgetUsd`/
// `maxRuns`/`maxDelegationDepth`/`distillerRuns`/`timeoutMs` keys are REJECTED
// by the validator in src/core/config-validation.ts. These schemas are the
// source of truth for the new nested shape (BudgetsConfig / BudgetCap / etc.).
//
// §2.13 C4 — `BudgetCap` is a typebox `Type.Union` of four variants. The
// `resource` literal acts as the discriminator; downstream consumers narrow by
// `cap.resource === "tokens"` etc. The schema enforces "no impossible combos"
// at config-load (e.g. an unknown `window.kind` on a `tokens` variant is
// rejected before any runtime dispatch happens).
//
// §2.13 C6 — `BudgetWindowSpec` is the object form `{ kind, duration? }`. The
// Wave 0 contract in src/engine/budget/types.ts uses a flat `BudgetWindow`
// string at the resolved-policy layer; future waves reconcile by flattening
// the spec to a string at consumption time. (See WARNINGS in the wave-1b
// report.)
// ===========================================================================

/** §2.13 C2 — `IncludeKeys` literals (Usage-shape enum). */
const INCLUDE_KEY_VALUES = ["input", "output", "cacheRead", "cacheWrite", "cost"] as const;

/** §2.13 C6 — `WindowKind` literals. */
const WINDOW_KIND_VALUES = ["rolling", "per-day", "all-time"] as const;

/**
 * §2.13 C6 — Explicit window spec. `duration` is window-length in ms; required
 * for some `kind` values (validator enforces semantics in
 * `validateBudgetWindowSpec`, this file).
 */
export const BudgetWindowSpecSchema = Type.Object({
  kind: Type.Union(WINDOW_KIND_VALUES.map((value) => Type.Literal(value))),
  duration: Type.Optional(Type.Number({ minimum: 1, maximum: 365 * 24 * 60 * 60 * 1000 })),
});

// ---------------------------------------------------------------------------
// Resolved-policy-layer cap schemas — carry the `resource` literal as the
// discriminant (C4). These schemas describe what the Wave 0 contract
// (`src/engine/budget/types.ts`) carries at runtime; they are exported for the
// T6.7 discriminated-union test only. They are NOT used for YAML config
// validation (see the *YAML variants below), because the YAML layer uses the
// outer key (`tokens:`, `cost-usd:`) as the implicit resource discriminant.
// ---------------------------------------------------------------------------

/**
 * §2.13 C4 — TokensCap variant (resolved-policy layer). Carries `include`
 * (C2) and `window` (C6).
 */
export const TokensCapSchema = Type.Object({
  resource: Type.Literal("tokens"),
  cap: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  window: Type.Optional(BudgetWindowSpecSchema),
  include: Type.Optional(Type.Array(Type.Union(INCLUDE_KEY_VALUES.map((value) => Type.Literal(value))))),
});

/** §2.13 C4 — CostUsdCap variant (resolved-policy layer). */
export const CostUsdCapSchema = Type.Object({
  resource: Type.Literal("costUsd"),
  cap: Type.Number({ minimum: 0, maximum: 1_000_000_000 }),
  window: Type.Optional(BudgetWindowSpecSchema),
});

/** §2.13 C4 — RunsCap variant (resolved-policy layer). */
export const RunsCapSchema = Type.Object({
  resource: Type.Literal("runs"),
  cap: Type.Number({ minimum: 1, maximum: 1_000_000, integer: true }),
  window: Type.Optional(BudgetWindowSpecSchema),
});

/** §2.13 C4 — DepthCap variant (resolved-policy layer). Depth is window-less. */
export const DepthCapSchema = Type.Object({
  resource: Type.Literal("depth"),
  cap: Type.Number({ minimum: 1, maximum: 128, integer: true }),
});

/**
 * §2.13 C4 — `BudgetCap` discriminated union (resolved-policy layer). The
 * `resource` literal is the discriminator; downstream consumers narrow by
 * `cap.resource === "tokens"` (etc.). Invalid combinations (e.g. an unknown
 * `window.kind` on a `tokens` variant) are rejected at runtime via the
 * typebox validator.
 *
 * Note: this schema is for the RESOLVED-policy layer (matches the Wave 0
 * contract in src/engine/budget/types.ts). The YAML config layer uses the
 * separate `*YAML` schemas below, where the resource type is provided by the
 * outer key (`tokens:`, `cost-usd:`) instead of an inline `resource:` field.
 */
export const BudgetCapSchema = Type.Union([
  TokensCapSchema,
  CostUsdCapSchema,
  RunsCapSchema,
  DepthCapSchema,
]);

// ---------------------------------------------------------------------------
// YAML config-layer cap schemas — no `resource` literal; the outer key is the
// discriminant (tokens: | cost-usd: | runs: | depth:). The resolver in
// Wave 1B+ adds `resource:` when converting to `BudgetCap` for the policy
// layer.
// ---------------------------------------------------------------------------

/** YAML-layer TokensCap (no `resource:`). */
export const TokensCapYAMLSchema = Type.Object({
  cap: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  window: Type.Optional(BudgetWindowSpecSchema),
  include: Type.Optional(Type.Array(Type.Union(INCLUDE_KEY_VALUES.map((value) => Type.Literal(value))))),
});

/** YAML-layer CostUsdCap (no `resource:`). */
export const CostUsdCapYAMLSchema = Type.Object({
  cap: Type.Number({ minimum: 0, maximum: 1_000_000_000 }),
  window: Type.Optional(BudgetWindowSpecSchema),
});

/** YAML-layer RunsCap (no `resource:`). */
export const RunsCapYAMLSchema = Type.Object({
  cap: Type.Number({ minimum: 1, maximum: 1_000_000, integer: true }),
  window: Type.Optional(BudgetWindowSpecSchema),
});

/** YAML-layer DepthCap (no `resource:`). Depth is window-less. */
export const DepthCapYAMLSchema = Type.Object({
  cap: Type.Number({ minimum: 1, maximum: 128, integer: true }),
});

// ---------------------------------------------------------------------------
// YAML-layer aggregate schemas (used by validateRawConfig and
// validateAgentBudgets).
// ---------------------------------------------------------------------------

/**
 * §2.10 — Per-worker budgets (YAML layer). `depth` is worker-only.
 */
export const WorkerBudgetConfigSchema = Type.Object({
  tokens: Type.Optional(TokensCapYAMLSchema),
  costUsd: Type.Optional(CostUsdCapYAMLSchema),
  runs: Type.Optional(RunsCapYAMLSchema),
  depth: Type.Optional(DepthCapYAMLSchema),
});

/** §2.10 — Per-team budgets (YAML layer). `depth` is intentionally absent. */
export const TeamBudgetConfigSchema = Type.Object({
  tokens: Type.Optional(TokensCapYAMLSchema),
  costUsd: Type.Optional(CostUsdCapYAMLSchema),
  runs: Type.Optional(RunsCapYAMLSchema),
});

/**
 * §2.10/§2.13 — Root budgets block (YAML layer). Lives at `settings.budgets:`
 * in `hive-config.yaml`. Per C3 (SKIPPED per G-16) there are no defaults: an
 * absent block means every resource is intentionally unlimited.
 *
 * `strategies` is reserved for §2.13 C5 (deferred to v3 unless the user
 * overrides). The validator (`validateBudgets` below) accepts it as `never`
 * today and will reject any concrete value.
 */
export const BudgetsConfigSchema = Type.Object({
  perWorker: Type.Optional(WorkerBudgetConfigSchema),
  perTeam: Type.Optional(TeamBudgetConfigSchema),
  strategies: Type.Optional(Type.Never()),
});

/** §2.13 C1 — Per-agent override block (YAML layer; frontmatter `budgets:` key). */
export const AgentBudgetsOverrideSchema = Type.Object({
  tokens: Type.Optional(TokensCapYAMLSchema),
  costUsd: Type.Optional(CostUsdCapYAMLSchema),
  runs: Type.Optional(RunsCapYAMLSchema),
  depth: Type.Optional(DepthCapYAMLSchema),
});

/** Static TS types inferred from the schemas above. Kept for downstream consumers. */
export type BudgetsConfigType = Static<typeof BudgetsConfigSchema>;
export type WorkerBudgetConfigType = Static<typeof WorkerBudgetConfigSchema>;
export type TeamBudgetConfigType = Static<typeof TeamBudgetConfigSchema>;
export type BudgetCapType = Static<typeof BudgetCapSchema>;
export type TokensCapType = Static<typeof TokensCapSchema>;
export type CostUsdCapType = Static<typeof CostUsdCapSchema>;
export type RunsCapType = Static<typeof RunsCapSchema>;
export type DepthCapType = Static<typeof DepthCapSchema>;
export type BudgetWindowSpecType = Static<typeof BudgetWindowSpecSchema>;
export type AgentBudgetsOverrideType = Static<typeof AgentBudgetsOverrideSchema>;

// ===========================================================================
// Wave 1B — F6 budget validators (T6.1, T6.2, T6.3, T6.5, T6.7, T6.8, T6.10).
//
// The runtime validators below sit alongside the typebox schemas above so the
// schema definition and the check that consumes it live next to each other.
// They are imported by src/core/config-validation.ts (for `settings.budgets:`)
// and exercised directly by tests/config-schema.test.ts (for the discriminated
// union shape).
//
// Hard cutover (G-16): legacy keys (`workerBudgets`, `teamBudgets`,
// `governance`, `tokenBudget`, `tokenBudgetScope`, `costBudgetUsd`, `maxRuns`,
// `maxDelegationDepth`, `distillerRuns`, `timeoutMs`) are NOT in the
// SETTINGS_KEYS / AGENT_KEYS allowlists in src/core/config-validation.ts.
// Presenting them in a config fails the `keys(...)` whitelist before these
// validators are even called — see the comment at the top of that file.
// ===========================================================================

function object(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
}

function allowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label}.${key} is not a recognized configuration key.`);
  }
}

/** Format typebox errors into a single readable message tagged with the field path. */
function formatTypeboxErrors(errors: ReturnType<typeof Value.Errors>, label: string): string {
  if (!errors.length) return `${label} failed schema validation.`;
  const first = errors[0];
  const path = first.instancePath ? `${label}.${first.instancePath.replace(/^\//, "").replace(/\//g, ".")}` : label;
  const detail = first.message || first.keyword || "invalid value";
  return `${path} ${detail}`;
}

/** §2.13 C6 — Validate a single `BudgetWindowSpec` value. */
function validateBudgetWindowSpec(value: unknown, label: string): void {
  object(value, label);
  allowedKeys(value as Record<string, unknown>, ["kind", "duration"], label);
  const v = value as Record<string, unknown>;
  if (!Value.Check(BudgetWindowSpecSchema, v)) {
    throw new Error(formatTypeboxErrors(Value.Errors(BudgetWindowSpecSchema, v), label));
  }
  // Semantic: `kind: "rolling"` requires `duration` (a rolling window needs a length).
  if (v.kind === "rolling" && (typeof v.duration !== "number" || !Number.isFinite(v.duration))) {
    throw new Error(`${label}.duration is required when kind is "rolling" (a rolling window must specify its length in milliseconds).`);
  }
  // Semantic: `kind: "all-time"` MUST NOT carry a `duration` (it's the unbounded default).
  if (v.kind === "all-time" && v.duration !== undefined) {
    throw new Error(`${label}.duration is not allowed when kind is "all-time" (the window is intentionally unbounded).`);
  }
}

/**
 * §2.10 — Root budgets block (`settings.budgets:`). Validates `per-worker`
 * and `per-team` against the typebox schema. C3 (defaults) is skipped per G-16;
 * an absent block means every resource is intentionally unlimited.
 *
 * After the typebox check passes, walks the per-worker + per-team cap blocks
 * and re-runs the semantic window checks (rolling-without-duration, etc.)
 * via `validateBudgetWindowSpec`. Typebox can't easily encode those
 * cross-field rules, so they live here.
 */
export function validateBudgets(value: unknown, label: string): void {
  if (value === undefined) return;
  object(value, label);
  if (!Value.Check(BudgetsConfigSchema, value)) {
    throw new Error(formatTypeboxErrors(Value.Errors(BudgetsConfigSchema, value), label));
  }
  const v = value as Record<string, unknown>;
  const blocks = [
    ["perWorker", v.perWorker],
    ["perTeam", v.perTeam],
  ] as const;
  for (const [blockName, block] of blocks) {
    if (!block || typeof block !== "object") continue;
    for (const [capName, cap] of Object.entries(block as Record<string, unknown>)) {
      if (!cap || typeof cap !== "object") continue;
      const window = (cap as Record<string, unknown>).window;
      if (window !== undefined) {
        validateBudgetWindowSpec(window, `${label}.${blockName}.${capName}.window`);
      }
    }
  }
  // §2.13 C5 placeholder: `strategies` is reserved for v3; today any concrete
  // value is rejected by the `Type.Never()` schema, so we don't need an extra
  // check here. The TODO marker below makes the deferral explicit for readers.
  // TODO C5: deferred to v3 unless user overrides (plan §2.13 C5).
}

/**
 * §2.13 C1 + §2.10 — Per-agent override block (frontmatter `budgets:` key).
 * Validates the block and re-runs the window semantic checks on any
 * `window:` field present.
 */
export function validateAgentBudgets(value: unknown, label: string): void {
  if (value === undefined) return;
  object(value, label);
  if (!Value.Check(AgentBudgetsOverrideSchema, value)) {
    throw new Error(formatTypeboxErrors(Value.Errors(AgentBudgetsOverrideSchema, value), label));
  }
  for (const [capName, cap] of Object.entries(value as Record<string, unknown>)) {
    if (!cap || typeof cap !== "object") continue;
    const window = (cap as Record<string, unknown>).window;
    if (window !== undefined) {
      validateBudgetWindowSpec(window, `${label}.${capName}.window`);
    }
  }
}
