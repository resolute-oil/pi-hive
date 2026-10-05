export const HIVE_TOOL_NAMES = new Set(["route_agent", "delegate_agent", "team_status", "team_conversation", "hive_sdd_status", "submit_review_verdict", "plan_new", "plan_select", "plan_task_complete"]);

// Hive tools that are granted by AGENT TYPE, not by the per-agent tools list, so
// they survive dispatch's tools-list filter (a reviewer need not list its own
// verdict tool). buildHiveTools only emits them for the eligible type. Plan
// approval is no longer a tool — it happens in the dashboard's plan-review UI.
// The 12 LLM-callable operator command tools (LLM tool gap) are
// type-scoped: leads (the orchestrator and any other
// agentType: "lead") can drive the operator surface directly. Workers
// typed {coder, tester, reviewer, planner} do NOT see these tools.
// The dashboard buttons are the human's parallel path; the LLM tools
// are the orchestrator's path; the cooperative tools (worker-self
// call) are the third path. All three share the same underlying
// `operator-command-pickup.jsonl` consumer.
const OPERATOR_COMMAND_TOOL_NAMES = [
  "hive_end_worker",
  "hive_compact_worker",
  "hive_respawn_worker",
  "hive_pause_worker",
  "hive_snapshot_worker",
  "hive_restore_worker",
  "hive_resume_worker",
  "hive_abort_compaction",
  "hive_force_kill_worker",
  "hive_force_end_worker",
  "hive_tear_down_all",
  "hive_reload_agent_config",
];

// Introspection tools (LLM tool gap, should-have). Read-only
// view of policy + last rejection. Lead-only (orchestrators),
// gated by `callerType === "lead"` in `buildHiveTools`.
const INTROSPECTION_TOOL_NAMES = [
  "hive_read_policy",
  "hive_explain_rejection",
];
export const TYPE_SCOPED_TOOL_NAMES = new Set([
  "submit_review_verdict",
  "plan_new",
  "plan_select",
  "plan_task_complete",
  ...OPERATOR_COMMAND_TOOL_NAMES,
  ...INTROSPECTION_TOOL_NAMES,
]);

// Fixed layout (relative to cwd). The whole extension assumes this tree, so it is
// a convention, not a configurable knob.
export const HIVE_ROOT = ".pi/hive";
export const HIVE_AGENTS_DIR = `${HIVE_ROOT}/agents`;
export const HIVE_SESSIONS_DIR = `${HIVE_ROOT}/sessions`;
