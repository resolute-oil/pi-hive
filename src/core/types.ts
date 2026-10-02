// ── Types ────────────────────────────────────────────────────────────────────

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlanStage } from "../shared/openspec-artifacts";
export type { PlanStage } from "../shared/openspec-artifacts";

export type AgentStatus = "idle" | "running" | "done" | "error" | "queued";
// The three session modes:
//   normal — plain Pi chat: no hive tools, no domain/type enforcement.
//   plan   — hive active but scoped to the PLANNING team (planners + the leads
//            that route to them). The orchestrator drives planners to produce
//            OpenSpec artifacts (proposal→design/specs→tasks); no code execution.
//   hive   — full hive: delegates to coders/testers/reviewers, executes tasks.
export type HiveMode = "normal" | "plan" | "hive";

// Normalize any mode-ish value to a canonical HiveMode. Mode is never persisted,
// so this only guards against unexpected inputs; the historical "team" alias was
// dead (Phase 5.5) and has been dropped.
export function canonicalMode(mode: string | undefined): HiveMode {
  if (mode === "plan") return "plan";
  if (mode === "hive") return "hive";
  return "normal";
}

// An agent's capability type. Enforced (on top of the filesystem-domain
// boundary) by the type-policy layer: it decides which ACTIONS an agent may
// perform on which KIND of file. Distinct from the derived tree role
// (orchestrator/lead/member) which only governs delegation.
export type AgentType = "planner" | "coder" | "tester" | "reviewer" | "lead";

export interface KnowledgeRef {
  path: string;
  useWhen?: string;
  updatable?: boolean;
  allowOutsideProject?: boolean;
}

// A reviewer's structured verdict on a change. green = clean approval; yellow =
// approve with non-blocking concerns (proceed, surface concerns); red = blocked
// (populate blockers). Submitted via the reviewer-only submit_review_verdict
// tool, recorded as a telemetry event, and materialized into the plan_verdicts
// SQLite table by the dashboard on ingest.
export type ReviewVerdictLevel = "red" | "yellow" | "green";

export interface ReviewVerdict {
  changeId: string;
  reviewer: string;
  verdict: ReviewVerdictLevel;
  summary: string;
  evidence: string[];
  concerns: string[];
  blockers: string[];
  createdAt: string;
}

export interface SddChangeStatus {
  name: string;
  path: string;
  files: string[];
  nextPhase: string;
  summary: string;
}

export interface SddStatus {
  configured: boolean;
  configPath?: string;
  activeChanges: SddChangeStatus[];
  suggestedRouting: string[];
}

// A filesystem scope. Every capability must be explicit so the config is easy
// to audit: true ALLOWS, false DENIES. Optional include/exclude globs narrow a
// rule to matching files under `path` (matched relative to that path). Access is
// resolved by most-specific-wins: deeper paths beat broader paths, and matching
// include globs beat catch-all rules at the same path. Exact ties deny.
export interface DomainScope {
  path: string;
  read: boolean;
  upsert: boolean;
  delete: boolean;
  include?: string[];
  exclude?: string[];
  description?: string;
  allowOutsideProject?: boolean;
}

export interface AgentConfig {
  // Stable machine identifier. If omitted, derived from `name` as a kebab slug.
  // Tool calls, telemetry joins, filenames, and delegation policy should use
  // this; `name` remains the human display label.
  slug?: string;
  name: string;
  path: string;
  allowOutsideProject?: boolean;
  color?: string;
  model?: string;
  tools?: string;
  thinking?: string;
  consultWhen?: string;
  routingTags?: string[];
  responsibilities?: string[];
  // DERIVED, not user-configured (H1/Decision 7): the slugs of this node's direct
  // reports, computed from members/children during config load. A user-set
  // `allowedAgents` in hive-config.yaml is ignored (with a warning) — this is
  // purely the internal delegation-scope field.
  allowedAgents?: string[];
  context?: KnowledgeRef[];
  skills?: KnowledgeRef[];
  domain?: DomainScope[];
  members?: AgentConfig[];
  children?: AgentConfig[];
  role?: "orchestrator" | "lead" | "member";
  // The agent's capability type. REQUIRED for every agent (validation
  // hard-fails if missing). Enforced by the type-policy layer.
  agentType?: AgentType;
  // Planner-only: which planning gate artifacts this planner may write.
  // Omitted = all four gates. Ignored for non-planners.
  stages?: PlanStage[];
  // When true, this caller skips the typed-specialist widening branch in
  // `canDelegateTo` (src/engine/domain.ts) entirely: it can only delegate
  // to its direct reports (`allowedAgents`). Default false preserves the
  // PR #10 widening so the orchestrator can still route read-only
  // inspections directly to idle specialists. This is a per-caller
  // opt-out — a lead like Engineering Lead can set this to stop it from
  // dispatching to Tester or Reviewer directly (bypassing the Validation
  // Lead peer) while leaving the orchestrator's widening behavior intact.
  delegateStrict?: boolean;
  // Optional network capability for bash commands. Disabled by default. This
  // does not grant access to pi-hive's authenticated local dashboard API.
  network?: boolean;
  // Optional commit guidance. Its PRESENCE (non-empty) unlocks the commit gate
  // for this agent; the text is injected into the agent's prompt as guidance.
  // DECISION (Phase 5.6): commit capability intentionally follows this `commit:`
  // config, NOT agent-type. There is no "commit ⇒ lead" enforcement — a small
  // project may deliberately let a leaf agent commit. Do not add a type gate here.
  commit?: string;
  // Optional worker-governance overrides. Omitted fields inherit settings.workerBudgets;
  // if neither level provides a value, that resource is intentionally unlimited.
  governance?: WorkerGovernance;
  // Derived grouping label: the name of the top-level agent (the orchestrator's
  // direct report) whose subtree this agent belongs to. Not configured.
  groupName?: string;
}

// One team = a `main` (root) node plus its direct reports (each nested as deeply
// as needed). The hive team runs in hive mode; the optional planning team runs
// in plan mode. Both are ordinary agent trees; `main` IS the visible main
// session for that mode and carries its own agent-type/domain/tools.
export interface HiveTeam {
  main: AgentConfig;
  agents: AgentConfig[];
}

export interface TelemetrySettings {
  enabled: boolean;
  dashboardAutoStart: boolean;
  retentionDays: number;
  maxLogBytes: number;
  captureThinking: boolean;
  redactSensitiveData: boolean;
}

export interface WorkerGovernance {
  timeoutMs?: number;
  maxDelegationDepth?: number;
  maxRuns?: number;
  tokenBudget?: number;
  // What `tokenBudget` counts. "all" (default) keeps the original cumulative-
  // of-everything-Pi-reports accounting (input + output + cacheRead + cacheWrite
  // + reasoning). "input_output" restricts to just the input + output tokens,
  // which is what fills the model's context window on each call. Pick the
  // mode that matches how the agent's workload is metered — for an agent
  // with heavy prompt caching, "input_output" lets a 1M-token budget roughly
  // track the model's 1M-token context window instead of being dominated by
  // cached-read reuse.
  tokenBudgetScope?: "input_output" | "all";
  costBudgetUsd?: number;
  distillerRuns?: number;
  // Block 2 — optional nested §2.10 shape fields, populated when the
  // frontmatter's `budgets:` block uses the nested form (e.g. `tokens:
  // { cap: 1000 }`). These coexist with the legacy flat fields above so
  // existing callers reading the legacy fields keep working; the resolver
  // reads both shapes (`resolveWorkerBudgetPolicy` in
  // src/engine/budget/strategy.ts).
  tokens?: { cap: number; window?: WindowKind; include?: IncludeKeys };
  costUsd?: { cap: number; window?: WindowKind };
  runs?: { cap: number };
  depth?: { cap: number };
  // Agent-level override of the resolved budget strategy ("default" | "compact").
  // Surfaced via the per-agent `governance` block in agent.md frontmatter (the
  // kebab key `budget-strategy:` normalizes to this camelCase property name in
  // the runtime `governance` object). Typed on `WorkerGovernance` directly so
  // `resolveWorkerBudgetPolicy` and `resolveWorkerBudgetStrategy` both narrow
  // the same shape without an interface duplication (TS I3 / N-I3 fixup).
  ["budget-strategy"]?: WorkerBudgetStrategy;
}

export interface TeamBudgets {
  maxRuns?: number;
  tokenBudget?: number;
  // Same semantics as WorkerGovernance.tokenBudgetScope; configurable per
  // tier so a project can mix a worker that budgets on input/output with a
  // team that budgets on the full token total.
  tokenBudgetScope?: "input_output" | "all";
  costBudgetUsd?: number;
}

export interface HiveSettings {
  subagentOutputLimit: number;
  defaultTools: string;
  // All resource governance is opt-in. Absent means unconstrained rather than a
  // hidden default. queueSize only activates fair waiting when maxParallel is hit.
  maxParallel?: number;
  queueSize?: number;
  // The canonical §2.10 nested shape. Typed in core/schema.ts via typebox
  // (`BudgetsConfigSchema`) and resolved by `resolveBudgetsConfig` so the
  // `resource:` discriminator is always set. `strategies` is the C5 conditional
  // block (Wave 3); absent means fall back to the legacy default behavior.
  budgets?: BudgetsConfig;
  // Legacy flat keys. Kept as a fallback path for users who haven't migrated
  // from the pre-v2 config (plan §2.10 / G-16 hard-cutover targets). The
  // resolver prefers `budgets` when present and falls back to these only when
  // `budgets` is undefined. Wave 5A's legacy cleanup will drop these fields
  // entirely; for the blocker fix we add the new path without breaking
  // existing configs.
  workerBudgets?: WorkerGovernance;
  teamBudgets?: TeamBudgets;
  telemetry?: TelemetrySettings;
  // Project-relative paths that no worker may read or mutate, even when a broad
  // domain would otherwise allow them. Absolute paths are supported for
  // explicitly configured external secrets.
  secretPaths?: string[];
  distiller: {
    enabled: boolean;
    model: string;
    conversationLines: number;
  };
}

export interface HiveConfig {
  // The ACTIVE team's root + reports. These mirror whichever team is active for
  // the current mode (hive team by default) so all existing code that reads
  // config.orchestrator / config.agents keeps working unchanged.
  orchestrator: AgentConfig;
  agents: AgentConfig[];
  sharedContext: string[];
  settings: HiveSettings;
  // The raw team blocks, populated by loadConfig. `hive` mirrors the legacy
  // top-level orchestrator:/agents:. `planning` is present only when a
  // planning: block is configured. Both optional so hand-built HiveConfig
  // objects (tests, ad-hoc) need not supply them — teamForMode falls back to
  // orchestrator/agents when `hive` is absent.
  hive?: HiveTeam;
  planning?: HiveTeam;
}

export interface AgentRuntime {
  config: AgentConfig;
  systemPrompt: string;
  status: AgentStatus;
  task: string;
  lastWork: string;
  toolCount: number;
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  // Reasoning ("thinking") tokens (Phase 4.8). Accumulated per message_end;
  // getSessionStats().tokens does NOT carry reasoning, so the end-of-run
  // authoritative overwrite must PRESERVE this accumulated value.
  reasoningTokens: number;
  costUsd: number;
  contextPct: number;
  // Raw context-window fill (Phase 4.7): the tokens/window behind contextPct.
  contextTokens?: number;
  contextWindow?: number;
  runCount: number;
  distillerRunCount?: number;
  sessionFile: string;
  // SDK-reported thinking levels for the runtime's effective model (A10).
  thinkingLevels?: string[];
  startedAt?: number;
  timer?: ReturnType<typeof setInterval>;
  session?: any;
}

export interface SessionState {
  sessionId: string;
  sessionDir: string;
  conversationLog: string;
  observabilityLog: string;
}

export interface HiveActivityEntry {
  ts: string;
  kind: "delegation_start" | "delegation_end" | "tool_start" | "tool_end" | "retry" | "compaction" | "message";
  agent?: string;
  parent?: string;
  toolName?: string;
  status?: AgentStatus | "running";
  text?: string;
}

// Accumulated telemetry for the visible main session (the orchestrator), which
// has no delegation lifecycle of its own (A5). Counters are cumulative for the
// session and folded into HiveStateSnapshot.agents as an "Orchestrator" entry.
export interface OrchestratorRuntime {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  toolCount: number;
  status?: AgentRuntime["status"];
  startedAt?: number;
  elapsedMs?: number;
  // Live context-window fill for the MAIN session (Phase 4.3), mirroring the
  // per-worker poll. Read from ctx.getContextUsage(); null until first response.
  contextPct?: number;
  tokens?: number;
  contextWindow?: number;
}

export interface YamlLine {
  indent: number;
  text: string;
}

// Shared mutable state for the extension. Replaces the closure-captured `let`
// bindings so the extension's logic can be split across modules. Functions that
// read or write any of these fields take this object as a parameter.
export interface HiveState {
  pi: ExtensionAPI;
  config: HiveConfig | null;
  session: SessionState | null;
  runtimes: Map<string, AgentRuntime>;
  widgetCtx: ExtensionContext | null;
  // The SDK ModelRegistry handle, captured from the full session_start ctx (the
  // reliable one). Feeds emitModelCatalog so the model_catalog lands on a stable
  // lifecycle point instead of the fragile mode-switch ctx that may lack it.
  modelRegistry?: unknown;
  activeRuns: number;
  // FIFO waiters created only when maxParallel and queueSize are configured.
  workerQueue?: Array<{ id: number; resolve: () => void; reject: (error: Error) => void; signal?: AbortSignal; abort?: () => void }>;
  nextQueueId?: number;
  // The current session mode. Normal = plain Pi; plan = planning team; hive =
  // execution team. (Was `teamMode`; renamed for the three-mode model.)
  mode: HiveMode;
  normalToolNames: string[];
  sddStatus: SddStatus | null;
  obsSeq: number;
  // Dashboard telemetry is registered lazily: normal chat sessions stay out of
  // the telemetry dashboard until the user enters plan/hive mode.
  telemetryRegistered?: boolean;
  dashboardActionTimer?: ReturnType<typeof setInterval>;
  dashboardActionOffset?: number;
  // The currently-selected plan change-id (set by plan_new/plan_select and
  // /hive:execute). Persists across turns; delegations are wrapped in
  // runWithChange(activeChangeId) so workers' tools see it via currentChangeId().
  activeChangeId?: string;
  // Latest verdict per change-id, tracked in-memory as reviewers submit them.
  // The core cannot read the plan_verdicts SQLite table (Bun-only), so this is
  // how team_status surfaces the most recent verdict without a DB round-trip.
  latestVerdicts?: Map<string, ReviewVerdict>;
  // Orchestrator (main-session) telemetry parity (A5). Worker runtimes live in
  // `runtimes`; the main session has no delegation lifecycle, so its own
  // tokens/cost/tool-calls are accumulated here and folded into snapshots.
  orchestratorRuntime?: OrchestratorRuntime;
  onRuntimeUpdate?: (state: HiveState) => void;
  onRuntimeFinish?: (runtime: AgentRuntime, ctx: ExtensionContext) => void;
  // The shared, global telemetry dashboard. It is a machine-wide daemon (reads
  // the global registry/DB under ~/.pi/agent/hive/), so it is started once and
  // reused across sessions, and it SURVIVES an individual session shutdown.
  // `proc` is set only for the session that spawned it; a session that merely
  // adopted an already-running daemon has `proc` undefined but still records the
  // url/port for the header indicator.
  obsServer?: {
    proc?: any;
    url: string;
    port: number;
    host: string;
    adopted?: boolean;
  };
  activityLog?: HiveActivityEntry[];
  activityRender?: () => void;
  activityWidgetInstalled?: boolean;
  // Once-per-session flag: log a warning the first time the activity widget
  // renders a panel where the runtimes map has more entries than
  // MAX_AGENTS_IN_PANEL allows. Helps diagnose the "I see N agents in the
  // panel but the map only has M" class of bugs (or, conversely, the "panel
  // is missing agents that team_status shows" class).
  activityOverflowWarned?: boolean;
  // Session lifecycle guards for fire-and-forget work. Dashboard startup results
  // and mental-model distillers must not mutate a state that has shut down.
  shuttingDown?: boolean;
  lifecycleGeneration?: number;
  backgroundTasks?: Set<Promise<void>>;
  distillQueues?: Map<string, Promise<void>>;
  backgroundDistillerSessions?: Set<any>;
  // Snapshot/restore handoff for the mode-switch flow (set in applyMode when
  // transitioning hive→normal with a baseline; `summary` is filled in by the
  // LLM's hive_cycle_summary tool call; cleared in the agent_settled handler
  // after the branching + restore completes).
  pendingHiveCycleRestore?: { snapshotLeafId: string; summary?: string };
  // Leaf id captured on the most recent hive/plan entry transition. Used as the
  // branch point for the hive→normal restore. Reset on each entry transition so
  // its presence reliably means "a snapshot was taken for the current cycle."
  hiveCycleSnapshotLeafId?: string;
}

// ── Budget refactor (Wave 0 contract stubs) ─────────────────────────────────
//
// The types below are pinned here so the engine/budget/* stubs compile against
// a stable contract. Slice 3 / 4 / 7 / 8 will refine them (WorkerBudgetPolicy
// gets Strategies/etc., BudgetLedgerEntry gets the full data schema); the
// initial shapes match the plan §2.5 / §2.10 / §2.13 / §2.14 enough for
// compilation. Forward-reference is fine (per the Wave 0 contract notes).

// Slice 3 — WorkerBudgetPolicy (the resolved policy object). Composed of
// worker + team blocks, each with optional tokens/costUsd/runs/depth caps
// (per §2.10 nested shape). The WindowKind / IncludeKeys / Strategies fields
// land in slice 7 but are forward-referenced here so the slice 3 stub
// typechecks. `strategies` is optional because most projects will rely on
// the global strategies default.
export interface WorkerBudgetPolicy {
  worker: {
    tokens?: { cap: number; window?: WindowKind; include?: IncludeKeys };
    costUsd?: { cap: number; window?: WindowKind };
    runs?: { cap: number };
    depth?: { cap: number };
  };
  team: {
    tokens?: { cap: number; window?: WindowKind; include?: IncludeKeys };
    costUsd?: { cap: number; window?: WindowKind };
    runs?: { cap: number };
  };
  strategies?: Strategies;
}

// Slice 8 — BudgetLedgerEntry. The persisted CustomEntry shape that
// BudgetLedger writes via appendCustomEntry. Caps are keyed by the §2.3
// documented names (workerTokens, workerCostUsd, workerRuns, workerDepth,
// teamTokens, teamCostUsd, teamRuns); marker and kind are optional so the
// throttled-cadence writes (no marker / no kind) compose with the operator
// + cooperative writes (marker: "checkpoint", kind: <documented kind>).
// G-08 fix: kind is typed (not `string`) so a typo in a Wave 3 call site
// fails typecheck before runtime.
//
// Dual-customType design (C D3 / TS N6 / Completeness D3 + E1):
// pi-hive-budget-ledger (this entry shape) carries the cumulative spend
// snapshot — restore() reduces the latest one per agentSlug into the
// authoritative ledger state. pi-hive-budget-compaction (a separate
// SessionEntry below) carries ONLY the savings number from each completed
// compaction; it does NOT pollute BudgetLedgerEntry.data (no field for
// savings here on purpose) and the reduce path skips it. The two coexist
// in the branch but filter cleanly in both restore() and the dashboard
// (`WHERE customType IN (...)`).
export type BudgetLedgerKind =
  | "end"
  | "compact"
  | "respawn"
  | "pause"
  | "snapshot"
  | "restore"
  | "resume"
  | "compact-aborted"
  | "force-kill"
  | "force-end"
  | "tear-down-all"
  | "cooperative-compact"
  | "cooperative-end"
  | "cooperative-snapshot";

export interface BudgetLedgerEntry {
  type: "custom";
  customType: "pi-hive-budget-ledger";
  data: {
    caps: {
      workerTokens?: number;
      workerCostUsd?: number;
      workerRuns?: number;
      workerDepth?: number;
      teamTokens?: number;
      teamCostUsd?: number;
      teamRuns?: number;
    };
    cumulative: { tokens: number; costUsd: number; runs: number };
    writtenAt: number;
    agentSlug: string;
    marker?: "warning" | "exhausted" | "checkpoint";
    kind?: BudgetLedgerKind;
  };
}

// Companion entry for the dual-customType design (C D3, see BudgetLedgerEntry
// block above). Carries the per-compaction savings number so the dashboard's
// pre/post-compaction accounting survives across reloads without polluting
// BudgetLedgerEntry.data (which has no `savings` field on purpose). Restore()
// reads both customTypes but the cumulative reduction skips compaction entries.
export interface BudgetCompactionEntry {
  type: "custom";
  customType: "pi-hive-budget-compaction";
  data: {
    agentSlug: string;
    savings: number;
    writtenAt: number;
  };
}

// Slice 4 — BudgetBlock. The discriminated union describing a budget refusal;
// returned by checkBudgetPolicy() when a worker/team cap is exceeded. The full
// shape is finalized here (slice 4) so policy.ts can import it directly.
export interface BudgetBlock {
  reason: string;
  scope: "worker" | "team";
  resource: "tokens" | "costUsd" | "runs" | "depth";
  remaining: { tokens?: number; costUsd?: number; runs?: number };
  limit: { tokens?: number; costUsd?: number; runs?: number; depth?: number };
}

// Slice 7 — IncludeKeys (the C2 typebox-projected shape from §2.13). The
// WindowKind / Strategies shape lands in slice 7; the include list is needed
// here for workerConsumedTokens.
export type IncludeKey = "input" | "output" | "cacheRead" | "cacheWrite" | "reasoning";
export type IncludeKeys = IncludeKey[];

// Slice 7 — WindowKind + Strategies + per-tier config shapes. The full
// structured-strategies shape lands here (C5 conditional — the type is
// unconditionally available; runtime honors the user's strategies block when
// present and falls back to the legacy "default" | "compact" strategy enum
// otherwise).
export type WindowKind = "per-session" | "per-run" | "per-day" | "per-team-lifetime";

export interface Strategies {
  onApproachingLimit: { action: "wrap-up" | "compact" | "none"; threshold: number; hint: string };
  onExhaustion: { action: "compact" | "abort" | "none"; customInstructions?: string };
  summary: { maxTokens: number };
}

export interface BudgetsConfig {
  defaultsEnabled?: boolean;
  perWorker: WorkerBudgetPolicy["worker"];
  perTeam: WorkerBudgetPolicy["team"];
  strategies?: Strategies;
}

// Per-agent and per-team config shapes for the typebox schema projection.
// These mirror the worker/team sub-blocks of WorkerBudgetPolicy but are exposed
// as standalone types so the schema can reference them without cycling.
export interface WorkerBudgetConfig {
  tokens?: { cap: number; window?: WindowKind; include?: IncludeKeys };
  costUsd?: { cap: number; window?: WindowKind };
  runs?: { cap: number };
  depth?: { cap: number };
}

export interface TeamBudgetConfig {
  tokens?: { cap: number; window?: WindowKind; include?: IncludeKeys };
  costUsd?: { cap: number; window?: WindowKind };
  runs?: { cap: number };
}

// Slice 3 — WorkerBudgetStrategy (the flat enum that the strategies: object
// in §2.13/C5 projects to). Two values: default vs compact EOL behavior.
// (Strategies / BudgetsConfig are declared in the slice 7 block above.)
export type WorkerBudgetStrategy = "default" | "compact";
