export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * The wire shape for arbitrary JSON payloads on telemetry events. `unknown`
 * (not `any`) so the SDK enforces narrow access — consumers must either index
 * a known field or narrow via a type guard.
 *
 * `isJsonRecord` is the runtime guard counterpart: it narrows an `unknown`
 * value (e.g. the result of `JSON.parse`) to this type. Use it at every
 * boundary that deserializes JSON — SQLite rows, SSE frames, the front-end
 * store — to make the unsafe cast explicit.
 */
export type JsonRecord = Record<string, unknown>;
export const isJsonRecord = (v: unknown): v is JsonRecord =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Per-type payload shape for the telemetry wire contract. Currently
 * homogeneous — every event type carries a `JsonRecord` payload — but the
 * mapped-type shape lets us narrow per-type later without breaking callers
 * that index it by `event.type`. Add a per-type payload interface here as
 * event types gain strict shapes; keep it exhaustive (every member of
 * `HiveTelemetryEventType` listed) so a new event type fails typecheck
 * until its payload is defined.
 */
export type EventPayloadByType = {
  [K in HiveTelemetryEventType]: JsonRecord;
};

export type HiveTelemetryEventType =
  | "session_start"
  | "user_message"
  | "assistant_message"
  | "delegation_start"
  | "delegation_end"
  | "worker_tool_start"
  | "worker_tool_end"
  | "worker_retry"
  | "worker_compaction"
  | "orchestrator_tool_start"
  | "orchestrator_tool_end"
  // Orchestrator (main-session) parity events (Phase 4): the main session's own
  // compactions, model/thinking switches, and per-turn latency were previously
  // invisible next to its workers'.
  | "orchestrator_compaction"
  | "orchestrator_message"
  | "model_select"
  | "thinking_level_select"
  | "turn"
  | "provider_response"
  // Remaining SDK event classes (Phase 4, Item): user bash commands, input
  // source, session fork/tree navigation, and session-name changes. Bounded
  // payloads; surfaced generically in the Activity feed.
  | "user_bash"
  | "input"
  | "session_fork"
  | "session_tree"
  | "session_info_changed"
  | "model_catalog"
  | "distill_start"
  | "distill_end"
  | "budget_warning"
  | "budget_exhausted"
  | "queue_update"
  // Plan-store events. Emitted by the core (which cannot reach bun:sqlite) and
  // materialized into typed plan_* tables by the dashboard on ingest (§7.4).
  | "review_verdict"
  | "plan_approval"
  | "plan_comment"
  // Emitted on delegation failure with { agent, message, stopReason }.
  | "error"
  // Legacy progress event from older telemetry logs. Filtered out at the
  // server-runtime ingest boundary (and on the dashboard store) so event
  // counts/lists stay meaningful; kept in the union so the filter check is
  // typeable. Production emit sites should never write this type.
  | "delegation_progress";

export type TelemetryAgentStatus = "idle" | "running" | "waiting" | "done" | "error";
export type TelemetryAgentRole = "orchestrator" | "lead" | "member";

export interface HiveTelemetryEvent<P = JsonRecord> {
  event_id: string;
  ts: string;
  // Tightened from `HiveTelemetryEventType | string`. The `| string` widening
  // defeated the discriminated union: `switch (event.type)` collapsed to
  // `string`, losing exhaustiveness checking. Adding a new event type to the
  // SDK without updating this union now causes a compile error at the emit
  // site — which is the desired safety.
  type: HiveTelemetryEventType;
  session_id: string;
  project_id?: string;
  project_root?: string;
  project_label?: string;
  cwd?: string;
  session_dir?: string;
  telemetry_log?: string;
  conversation_log?: string;
  state_file?: string;
  actor: string;
  pid: number;
  seq: number;
  payload: P;
}

export interface TelemetryRegistryRow {
  registered_at?: string;
  session_id?: string;
  project_id?: string;
  project_root?: string;
  project_label?: string;
  cwd?: string;
  session_dir?: string;
  conversation_log?: string;
  telemetry_log?: string;
  state_file?: string;
  pid?: number;
}

export interface TopologyNode {
  slug?: string;
  name: string;
  role?: TelemetryAgentRole;
  agentType?: string;
  stages?: string[];
  group?: string;
  color?: string;
  model?: string;
  tools?: string;
  thinking?: string;
  consultWhen?: string;
  routingTags?: string[];
  // The enforcement boundary (Phase A8): domain globs the agent may write,
  // whether it may commit, and its declared responsibilities.
  domain?: string[];
  commit?: boolean;
  responsibilities?: string;
  // SDK-reported thinking levels supported by this node's model (A10). Sidecar
  // data — excluded from the topology content hash (Decision 13).
  thinkingLevels?: string[];
  children?: TopologyNode[];
}

export interface HiveTopology {
  orchestrator?: TopologyNode;
  agents?: TopologyNode[];
}

export interface HiveTeamTopologies {
  active: "hive" | "planning";
  hive?: HiveTopology;
  planning?: HiveTopology;
}

export interface TelemetryAgentRuntime {
  slug?: string;
  name: string;
  group?: string;
  role?: TelemetryAgentRole;
  agentType?: string;
  status: TelemetryAgentStatus;
  task?: string;
  lastWork?: string;
  runCount?: number;
  distillerRunCount?: number;
  toolCount?: number;
  elapsedMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  governanceTokens?: number;
  governanceCostUsd?: number;
  contextPct?: number;
  // Raw context-window fill behind contextPct (Phase 4.7): the tokens currently
  // in context and the model's window. Threaded from the worker poll / main
  // session's turn-end capture so the UI can show the absolute numbers.
  contextTokens?: number;
  contextWindow?: number;
  sessionFile?: string;
  model?: string;
  thinking?: string;
  thinkingLevels?: string[];
  // Lifetime token counts at the start of the current run. The UI uses the
  // output baseline to compute per-run generation TOK/S (J8); input is kept for
  // telemetry symmetry and historical consumers.
  runStartInputTokens?: number;
  runStartOutputTokens?: number;
  budgetRemaining?: {
    worker: { runs?: number; tokens?: number; costUsd?: number; distillerRuns?: number };
    team: { runs?: number; tokens?: number; costUsd?: number };
  };
}

export interface HiveStateSnapshot {
  updated_at: string;
  session_id: string;
  project_id?: string;
  project_root?: string;
  project_label?: string;
  cwd?: string;
  session_dir?: string;
  telemetry_log?: string;
  conversation_log?: string;
  // Back-compat/current active team topology.
  topology?: HiveTopology;
  // Both configured team topologies, when available: execution hive + planning.
  topologies?: HiveTeamTopologies;
  // Hash of the versioned topology stored separately on the server (Phase C).
  // Slim persisted rows keep this on the snapshot so the hot cache can rehydrate
  // the full nested tree from the versioned topology_nodes table without
  // re-parsing every event. Not part of the public dashboard wire format.
  topology_hash?: string;
  // The active team of the slim row at last-write time. Phase 2.4: without
  // this flag rehydration can't recover `active` from the hash alone — it
  // must read what was actually selected, not guess from tree non-emptiness.
  active_team?: "hive" | "planning";
  active_runs?: number;
  agents?: TelemetryAgentRuntime[];
}

export interface TelemetrySessionSummary {
  session_id: string;
  project_id?: string;
  project_root?: string;
  project_label?: string;
  cwd?: string;
  session_dir?: string;
  telemetry_log?: string;
  first_ts?: string;
  last_ts?: string;
  event_count: number;
  running: number;
  tokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  cost: number;
  usageStatus?: "verified" | "legacy-unverified";
  topologyHash?: string;
}
