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

// Per-cap schemas. `resource:` is REQUIRED on every variant — the
// discriminated union depends on each member carrying its own resource
// tag so `switch (cap.resource)` is exhaustive and type-narrowing. Users
// who omit `resource:` are handled by `enforceResourceDiscriminator`
// (which runs BEFORE the typebox validator on a synthesized shape with
// the discriminator filled in from the parent key) or by
// `resolveBudgetsConfig` injecting the discriminator from the parent
// nesting BEFORE typechecking. After injection the typed object lands
// here with `resource:` always set, so this schema validates the post-
// injection shape and the discriminated-union contract holds end-to-end.
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

// Context-window-fill constraint (wave context-constraint). Either a nominal
// `tokens:` cap (absolute threshold against the SDK's `ContextUsage.tokens`)
// OR a `percent:` cap (against the SDK's `ContextUsage.tokens / contextWindow
// * 100` — 0-100 scale, NOT 0-1). The "exactly one" rule is enforced by the
// post-typebox `enforceContextConstraint` walk in `validateBudgetsConfig`;
// typebox itself accepts the optional-either form. Rejecting both fields at
// the schema level would need a discriminated union with a `kind:` tag
// (intrusive for users); rejecting both at the typebox level would need
// `additionalProperties: false` plus a oneOf (verbose). Post-typebox
// enforcement matches the pattern already used for `enforceResourceDiscriminator`
// and `enforceWindowByTier`.
const ContextConstraintSchema = Type.Object({
  tokens: Type.Optional(Type.Number({ minimum: 0 })),
  percent: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
});

export const BudgetCap = Type.Union([TokensCap, CostUsdCap, RunsCap, DepthCap]);
export type BudgetCap = Static<typeof BudgetCap>;

export const BudgetsConfigSchema = Type.Object({
  defaultsEnabled: Type.Optional(Type.Boolean()),
  // Both `perWorker` and `perTeam` are OPTIONAL — real user configs commonly
  // declare only one tier (e.g., a worker-only project that doesn't need
  // team-tier caps, or a planner-only project that only declares team
  // policies). Required-objects here would fail schema validation with the
  // generic "must be object" message and force users to include both
  // blocks; the documented "one tier is enough" path is now first-class.
  // Consumers (resolveBudgetsConfig, enforceContextConstraint,
  // enforceResourceDiscriminator, enforceWindowByTier, plus the resolver
  // in strategy.ts) handle the `undefined` case — see each call site.
  perWorker: Type.Optional(Type.Object({
    tokens: Type.Optional(TokensCap),
    costUsd: Type.Optional(CostUsdCap),
    runs: Type.Optional(RunsCap),
    depth: Type.Optional(DepthCap),
    context: Type.Optional(ContextConstraintSchema),
  })),
  perTeam: Type.Optional(Type.Object({
    tokens: Type.Optional(TokensCap),
    costUsd: Type.Optional(CostUsdCap),
    runs: Type.Optional(RunsCap),
    context: Type.Optional(ContextConstraintSchema),
  })),
  strategies: Type.Optional(Type.Object({
    // Both global strategy blocks are OPTIONAL so a user who declares only
    // the per-dimension `onTokenExhaustion` / `onContextExhaustion`
    // overrides (the documented escape hatch for context-constraint-aware
    // configs) doesn't have to invent a placeholder for the global fields
    // they don't need. The resolver falls back to documented defaults when
    // a field is absent (see the per-dimension comment below).
    onApproachingLimit: Type.Optional(Type.Object({
      action: Type.Union([Type.Literal("wrap-up"), Type.Literal("compact"), Type.Literal("none")]),
      threshold: Type.Number({ minimum: 0, maximum: 1 }),
      hint: Type.String(),
    })),
    onExhaustion: Type.Optional(Type.Object({
      action: Type.Union([Type.Literal("compact"), Type.Literal("abort"), Type.Literal("none")]),
      customInstructions: Type.Optional(Type.String()),
    })),
    // Per-dimension exhaustion overrides (wave context-constraint). Optional
    // so existing configs without these fields keep working unchanged. The
    // resolver falls back to `onExhaustion.action` (then `"abort"`) when the
    // per-dimension field is absent. Each accepts the same `action` enum as
    // the global onExhaustion plus an optional `customInstructions` (parity
    // with the global field). The "abort" / "compact" / "none" semantics are
    // described in the global onExhaustion field; the per-dimension overrides
    // are a slice of that, not a new behavior.
    onTokenExhaustion: Type.Optional(Type.Object({
      action: Type.Union([Type.Literal("compact"), Type.Literal("abort"), Type.Literal("none")]),
      customInstructions: Type.Optional(Type.String()),
    })),
    onContextExhaustion: Type.Optional(Type.Object({
      action: Type.Union([Type.Literal("compact"), Type.Literal("abort"), Type.Literal("none")]),
      customInstructions: Type.Optional(Type.String()),
    })),
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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("budgets must be an object.");
  }
  // Block 4: the schema now requires `resource:` on every cap variant (the
  // discriminated union is real). User YAML commonly OMITS `resource:` per
  // the plan §2.13 examples — inject the discriminator from the parent
  // nesting position BEFORE typebox runs so the validator accepts both
  // forms without losing the discriminated-union contract end-to-end.
  // injectResourceDiscriminators returns a new (post-injection) object;
  // we apply its per-tier branches back onto `value` so the assertion
  // signature still narrows `value` to BudgetsConfig (Block 4 contract:
  // downstream consumers — resolveBudgetsConfig, the resolver — read
  // `resource:` on every cap). The mutation is explicit here at the
  // validator boundary, not hidden inside the helper.
  const injected = injectResourceDiscriminators(value as Record<string, unknown>);
  (value as Record<string, unknown>).perWorker = injected.perWorker;
  (value as Record<string, unknown>).perTeam = injected.perTeam;
  const errors = Value.Errors(BudgetsConfigSchema, value);
  if (errors.length > 0) {
    // Surface the most specific error (skip root-level "missing required
    // property" complaints when a deeper path also fails). Otherwise the
    // user sees "must have required properties perTeam" when the real bug
    // is a negative cap deep inside perWorker.
    const leaf = errors.find((err) => err.instancePath && err.instancePath !== "") ?? errors[0];
    const path = leaf.instancePath ? formatPath(leaf.instancePath) : "<root>";
    let detail = leaf.message ?? "value does not match BudgetsConfigSchema";
    // Improve typebox's bare "must be equal to constant" message for the
    // `resource:` discriminator case. The parent key tells the user which
    // literal was expected; surfacing it makes the copy-paste-bug class
    // easier to diagnose.
    if (detail === "must be equal to constant" && path.endsWith("/resource")) {
      // Use the raw JSON-pointer path (leaf.instancePath) to extract the
      // immediate parent segment — `path` is already formatPath'd into the
      // dotted form which makes the segment harder to isolate.
      const segments = leaf.instancePath.split("/").filter(Boolean);
      const parentSegment = segments[segments.length - 2];
      detail = `must match the parent key "${parentSegment}" (or omit \`resource:\` and let the parent position disambiguate)`;
    }
    throw new Error(`budgets.${path}: ${detail}`);
  }
  // C4 tier-aware window restriction: perWorker forbids per-day and
  // per-team-lifetime; perWorker.costUsd forbids per-team-lifetime. typebox
  // doesn't enforce context-sensitive constraints, so we layer a structural
  // walk over the schema-validated value.
  enforceWindowByTier(value as BudgetsConfig);
  // If the user DID include a `resource:` field on a nested cap, it must
  // match the parent position. Omission is fine (parent-nesting disambiguates)
  // and gets injected by `resolveBudgetsConfig`. typebox's Type.Literal
  // already rejects wrong literals, but this check documents the contract
  // and acts as a safety net if the schema is ever relaxed.
  enforceResourceDiscriminator(value as BudgetsConfig);
  // Wave context-constraint: the `context:` field is optional at the
  // perWorker/perTeam tier, but when present it must set exactly one of
  // `tokens:` or `percent:`. typebox's optional-either object can't enforce
  // "exactly one" without a discriminator tag (intrusive for users), so we
  // layer the structural check here, matching the pattern above.
  enforceContextConstraint(value as BudgetsConfig);
}

// Window values allowed per (tier, resource). Per C6 the documented matrix
// is: tokens windows = per-session | per-run | per-day | per-team-lifetime,
// costUsd windows = per-session | per-team-lifetime. Per C4 the tier narrows
// that further: perWorker cannot use per-day or per-team-lifetime for either
// resource (those are team-lifetime semantics), and perWorker.costUsd cannot
// use per-team-lifetime for the same reason. perTeam accepts the full set.
const WORKER_TOKENS_WINDOWS = ["per-session", "per-run"] as const;
const WORKER_COST_USD_WINDOWS = ["per-session"] as const;

// C6 defaults: perWorker windows default to per-session, perTeam windows
// default to per-team-lifetime (matching the previous implicit behavior
// where worker scope = per-session and team scope = per-team-lifetime).
const WORKER_DEFAULT_WINDOW: WindowKind = "per-session";
const TEAM_DEFAULT_WINDOW: WindowKind = "per-team-lifetime";

import type { WindowKind } from "./types";

// G-10 per-day roll-over helpers. `currentUtcDayStart` returns the UTC
// midnight (ms) that begins the day containing `nowMs`. `isWithinDayWindow`
// answers the per-day cap question — is `entryMs` inside the current UTC
// day? — using `Date.now()` for the reference, which lets tests stub it to
// simulate midnight. The runtime consumer (Wave 1 1A policy.ts) feeds each
// ledger entry's timestamp through isWithinDayWindow when window === "per-day".
export function currentUtcDayStart(nowMs: number): number {
  const date = new Date(nowMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0);
}

export function isWithinDayWindow(entryMs: number, nowMs: number = Date.now()): boolean {
  return entryMs >= currentUtcDayStart(nowMs);
}

export function resolveBudgetsConfig(config: BudgetsConfig): BudgetsConfig {
  // Walk each tier and apply the default window when omitted. Pure (no I/O).
  // Also injects the `resource:` discriminator from the parent nesting when
  // the user omitted it (most common case — plan §2.13 examples don't show
  // the discriminator). Downstream consumers (Wave 1 1A policy.ts, Wave 2
  // dispatcher) receive `BudgetCap` instances with `resource:` always set.
  // Block 4: `resource:` is REQUIRED on each schema variant, so the
  // discriminated union is restored and `switch (cap.resource)` is
  // exhaustive end-to-end. This function is what bridges user-authored
  // configs (which omit the discriminator) and the typed schema (which
  // requires it).
  const resolveCap = <T extends { resource?: "tokens" | "costUsd" | "runs" | "depth"; window?: WindowKind }>(cap: T | undefined, defaultWindow: WindowKind, expectedResource: "tokens" | "costUsd" | "runs" | "depth"): T | undefined => {
    if (!cap) return cap;
    return { ...cap, resource: cap.resource ?? expectedResource, window: cap.window ?? defaultWindow };
  };
  // Both perWorker and perTeam are optional on the schema (real configs
  // commonly declare one tier only). Spreading `undefined` would throw, so
  // fall back to an empty tier that the resolver leaves untouched — every
  // cap below is itself optional and resolveCap returns its input
  // unchanged when it's undefined, so a missing tier resolves to an empty
  // resolved tier rather than silently dropping user data.
  const perWorker = config.perWorker ?? {};
  const perTeam = config.perTeam ?? {};
  return {
    ...config,
    perWorker: {
      ...perWorker,
      tokens: resolveCap(perWorker.tokens, WORKER_DEFAULT_WINDOW, "tokens"),
      costUsd: resolveCap(perWorker.costUsd, WORKER_DEFAULT_WINDOW, "costUsd"),
      runs: resolveCap(perWorker.runs, WORKER_DEFAULT_WINDOW, "runs"),
      depth: resolveCap(perWorker.depth, WORKER_DEFAULT_WINDOW, "depth"),
    },
    perTeam: {
      ...perTeam,
      tokens: resolveCap(perTeam.tokens, TEAM_DEFAULT_WINDOW, "tokens"),
      costUsd: resolveCap(perTeam.costUsd, TEAM_DEFAULT_WINDOW, "costUsd"),
      runs: resolveCap(perTeam.runs, TEAM_DEFAULT_WINDOW, "runs"),
    },
  };
}

// Discriminator check: if the user DID include a `resource:` field on a nested
// cap, it must match the parent position. Omission is fine (parent-nesting
// disambiguates and `resolveBudgetsConfig` injects the literal). A wrong
// explicit value is almost always a copy-paste bug and should fail at config
// load rather than silently mis-budget.
function injectResourceDiscriminators(value: Record<string, unknown>): Record<string, unknown> {
  // Walk perWorker.* and perTeam.* and inject `resource:` from the parent
  // nesting key when the user omitted it. Returns a new object instead of
  // mutating `value` in place — pure functional style matches
  // resolveBudgetsConfig and avoids surprising callers that pass a
  // deep-frozen or shared config (the prior in-place mutation was
  // documented but invisible to the type system). Typebox needs the
  // post-injection shape; callers MUST use the return value.
  const walkTier = (tier: "perWorker" | "perTeam"): Record<string, unknown> | undefined => {
    const block = value[tier] as Record<string, unknown> | undefined;
    if (!block || typeof block !== "object") return block;
    const next: Record<string, unknown> = { ...block };
    for (const key of ["tokens", "costUsd", "runs", "depth"] as const) {
      const cap = block[key] as Record<string, unknown> | undefined;
      // perTeam has no `depth` field; skip silently.
      if (key === "depth" && tier === "perTeam") continue;
      if (!cap || typeof cap !== "object") continue;
      next[key] = cap.resource === undefined ? { ...cap, resource: key } : cap;
    }
    return next;
  };
  return {
    ...value,
    perWorker: walkTier("perWorker"),
    perTeam: walkTier("perTeam"),
  };
}

function enforceResourceDiscriminator(config: BudgetsConfig): void {
  const check = (tier: "perWorker" | "perTeam", key: "tokens" | "costUsd" | "runs" | "depth", cap: { resource?: string } | undefined, expected: string): void => {
    if (!cap) return;
    if (cap.resource !== undefined && cap.resource !== expected) {
      throw new Error(`budgets.${tier}.${key}.resource: expected "${expected}" (from parent nesting), got "${cap.resource}".`);
    }
  };
  // Optional chaining through the now-optional tier — `check` short-circuits
  // on undefined caps so a missing whole tier is silently accepted.
  check("perWorker", "tokens", config.perWorker?.tokens, "tokens");
  check("perWorker", "costUsd", config.perWorker?.costUsd, "costUsd");
  check("perWorker", "runs", config.perWorker?.runs, "runs");
  check("perWorker", "depth", config.perWorker?.depth, "depth");
  check("perTeam", "tokens", config.perTeam?.tokens, "tokens");
  check("perTeam", "costUsd", config.perTeam?.costUsd, "costUsd");
  check("perTeam", "runs", config.perTeam?.runs, "runs");
}

// Wave context-constraint: the `context:` field on perWorker/perTeam must
// set exactly one of `tokens:` (nominal cap) or `percent:` (percentage cap on
// the 0-100 scale). Both set, or neither set, are configuration mistakes
// that the brief flags as a strict rejection. The check is tier-aware so
// the error message points at the offending path.
function enforceContextConstraint(config: BudgetsConfig): void {
  const check = (tier: "perWorker" | "perTeam", ctx: { tokens?: number; percent?: number } | undefined): void => {
    if (ctx === undefined) return;
    const hasTokens = ctx.tokens !== undefined;
    const hasPercent = ctx.percent !== undefined;
    if (hasTokens && hasPercent) {
      throw new Error(`budgets.${tier}.context: set either \`tokens:\` or \`percent:\` but not both.`);
    }
    if (!hasTokens && !hasPercent) {
      throw new Error(`budgets.${tier}.context: must set either \`tokens:\` or \`percent:\`.`);
    }
  };
  // Optional chaining through the now-optional tier — `check` returns
  // silently when the whole tier (or just the context block) is missing.
  check("perWorker", config.perWorker?.context);
  check("perTeam", config.perTeam?.context);
}
function enforceWindowByTier(config: BudgetsConfig): void {
  const check = (tier: "perWorker" | "perTeam", block: { tokens?: BudgetCap; costUsd?: BudgetCap } | undefined, allowed: ReadonlySet<string>): void => {
    if (!block) return;
    if (block.tokens && "window" in block.tokens && block.tokens.window !== undefined && !allowed.has(block.tokens.window)) {
      throw new Error(`budgets.${tier}.tokens.window: ${JSON.stringify(block.tokens.window)} is not allowed on ${tier}; permitted values are ${[...allowed].join(", ")}.`);
    }
    if (block.costUsd && "window" in block.costUsd && block.costUsd.window !== undefined) {
      // costUsd has its own narrower allow-list regardless of tier.
      const costAllowed = tier === "perWorker" ? new Set(WORKER_COST_USD_WINDOWS) : new Set(["per-session", "per-team-lifetime"]);
      if (!costAllowed.has(block.costUsd.window)) {
        throw new Error(`budgets.${tier}.costUsd.window: ${JSON.stringify(block.costUsd.window)} is not allowed on ${tier}; permitted values are ${[...costAllowed].join(", ")}.`);
      }
    }
  };
  const workerAllowed = new Set<string>(WORKER_TOKENS_WINDOWS);
  check("perWorker", config.perWorker as { tokens?: BudgetCap; costUsd?: BudgetCap } | undefined, workerAllowed);
  check("perTeam", config.perTeam as { tokens?: BudgetCap; costUsd?: BudgetCap } | undefined, new Set(["per-session", "per-run", "per-day", "per-team-lifetime"]));
}
