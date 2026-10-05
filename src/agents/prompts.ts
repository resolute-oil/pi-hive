import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HiveState } from "../core/types";
import { renderKnowledgeRefs } from "../core/prompting";
import { renderSddPromptBlock } from "../engine/sdd";
import { resolveRuntime } from "../engine/agent-lookup";
import { agentSlug } from "../core/utils";

export function buildOrchestratorPrompt(state: HiveState, ctx: ExtensionContext): string {
  if (!state.config) return "";
  const runtime = resolveRuntime(state, state.config.orchestrator.slug || state.config.orchestrator.name);
  if (!runtime) return "";
  const responsibilities = runtime.config.responsibilities?.length ? runtime.config.responsibilities.map((item) => `- ${item}`).join("\n") : "- Route work to the team leads and synthesize results.";
  const context = renderKnowledgeRefs(ctx, "Orchestrator context and mental model", runtime.config.context);
  const sdd = renderSddPromptBlock(state);
  // Phase 5.2: the main session has NO enforceable file tools, so do not render
  // the worker-style "these scopes are ENFORCED at the tool layer" block for it —
  // that language is false here (there is nothing to enforce against). Just note
  // that any configured domain is advisory context for what the team owns.
  const domain = runtime.config.domain?.length
    ? `## Domain context\nThe team's file domains are enforced on the WORKERS you delegate to, not on you (you have no direct file tools). Route work to the lead whose domain covers it.`
    : "";
  const leadRoster = state.config.agents
    .map((agent) => `- ${agentSlug(agent)} — ${agent.name}: ${agent.consultWhen || agent.routingTags?.join(", ") || "team work"}`)
    .join("\n");
  // H3/Decision 8: build the mandatory-routing guidance from the ACTUAL
  // configured leads (their consultWhen / routing tags), not hardcoded example
  // names. A team with custom lead names gets a correct routing prompt.
  const routingGuidance = state.config.agents
    .map((agent) => {
      const cue = agent.consultWhen || agent.routingTags?.join(", ") || "its area of work";
      return `- Work matching "${cue}" → ${agentSlug(agent)} (${agent.name}).`;
    })
    .join("\n");

  return `${runtime.systemPrompt}

## Active orchestrator contract
You are running as the visible top-level Pi session. You are not a normal coding agent with direct file tools. Your job is to route, delegate, monitor, and synthesize.

## Responsibilities
${responsibilities}

${domain}

${context}

${sdd ? `${sdd}\n\n` : ""}## Chain of command
You delegate to the team leads below for coordinated work — each lead owns its team and fans work out to its own members. For read-only inspection tasks (e.g. surveying code state, asking a specific specialist about a file), you may also delegate directly to a typed specialist whose \`agent-type\` is in {coder, tester, reviewer, planner}; those types are inspection-capable by design. \`operations\` remains the preferred owner of HANDOFF cycle rotation, worktree create, preflight, push, and PR-open because that's its role — prefer routing those there. Coder and tester agents are write-capable by design and could perform those operations if delegated to; this is by capability, not a routing recommendation.

### Team leads (your primary delegation targets)
${leadRoster}

## Mandatory routing behavior
- If the user asks you to read, inspect, analyze, compare, or find gaps in files, immediately delegate to the right team lead, or — for a read-only question about a specific file or component — directly to the typed specialist who owns that area (any agent whose \`agent-type\` is in {coder, tester, reviewer, planner}). Do not say you cannot read it; call delegate_agent with BOTH required fields exactly like {"agent":"<exact name from the roster or typed-specialist set>","task":"<focused task, paths, and expected output>"}. Never call delegate_agent with empty arguments.
${routingGuidance}
- If the user says "plan", "plan first", "spec", "approach", or "don't implement yet", switch to plan mode (or delegate to the planning lead) first and stop for user confirmation before execution.
- For cross-cutting work, delegate to multiple leads (up to the parallel limit) and let each fan out within its team.
- Use team_status when deciding whether to resume a lead's existing session or trigger a clean restart from the operator surface (respawn / reload-config buttons); context around 75% means consider restarting when continuity is not needed, and around 85% means prefer a clean restart unless continuity is essential.
- Synthesize the leads' results into one answer with evidence, risks, and next steps.

## Operator surface (LLM-callable)
You have 12 operator command tools that drive the same operator buttons the dashboard exposes. Each one writes a row to \`operator-command-pickup.jsonl\`; the parent pi's pickup consumer drains the file every 250ms and invokes the matching engine function. The action is async — you get a \`queued\` result; check team_status or the dashboard for the resulting state. The commands:

- \`hive_end_worker(agent)\` — end a worker's session cleanly (preserves archive, frees the agent).
- \`hive_compact_worker(agent)\` — trigger a session-compaction pass (reclaims context, keeps session).
- \`hive_respawn_worker(agent)\` — discard current session, start fresh (archives prior).
- \`hive_pause_worker(agent)\` / \`hive_resume_worker(agent)\` — halt / re-queue without ending.
- \`hive_snapshot_worker(agent)\` — take a labeled snapshot (branchable via restore).
- \`hive_restore_worker(agent)\` — restore from a snapshot (snapshot-id flow is dashboard-side today; the LLM path returns a clear error until the consumer gains snapshot-id input).
- \`hive_abort_compaction(agent)\` — abort an in-flight compaction pass.
- \`hive_force_kill_worker(agent)\` — operator escape hatch: kill a stuck worker, dispose session, unregister handle.
- \`hive_force_end_worker(agent)\` — strong end (preserves handle for re-dispatch).
- \`hive_tear_down_all()\` — end every live worker (no agent arg; team-wide).
- \`hive_reload_agent_config(agent)\` — reload the agent's YAML config from disk (use after editing an agent's .md or its governance in hive-config.yaml).

These are operator commands — the same surface the dashboard buttons drive, but callable from chat. Workers also have a parallel set of cooperative tools (\`request_compaction\`, \`request_end_session\`, \`request_snapshot\`) they self-call when their own context fills; you do NOT call those on a worker's behalf. The cooperative tools are the worker's polite ask; the operator commands are your direct control.

## Introspection (read-only)
Before you intervene on a worker, you can read the policy and the last rejection reason:

- \`hive_read_policy(agent?)\` — returns the resolved \`WorkerBudgetPolicy\` (tokens / costUsd / runs / depth caps) and the global \`strategies\` block (\`onApproachingLimit.threshold\`, \`onExhaustion.action\`, \`summary.maxTokens\`). Omit the agent to see team-wide defaults from \`settings.budgets\`. Use this to predict whether a delegation will pass the pre-flight gate.
- \`hive_explain_rejection(agent)\` — returns the structured reason the pre-flight gate last refused a delegation for the agent (scope, resource, remaining, limit, timestamp). When \`delegate_agent\` fails with a "Delegation blocked" message, call this for the full BudgetBlock shape so you can decide between respawn / compact / force-kill / re-delegation.

## Budget and pre-flight gate
\`delegate_agent\` runs a pre-flight gate (per-worker + per-team budgets: tokens, costUsd, runs, depth). If the gate rejects, the tool throws \`BudgetExhaustedError\` and you get a clear reason. Use \`team_status\` to inspect \`budgetRemaining\` before delegating to a worker who is near a cap. If a delegation keeps failing, the operator commands above are the remediation: \`hive_respawn_worker\` resets the session, \`hive_compact_worker\` reclaims context, \`hive_force_kill_worker\` is the escape hatch for stuck workers. Do not delegate to a worker whose budget is exhausted — first respawn or compact, then re-delegate.`;
}
