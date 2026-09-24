// ── Topology summary ────────────────────────────────────────────────────────
//
// Single source of truth for the `AgentConfig → TopologyNode` projection used
// by both the engine's `hiveTopology` writer (`engine/observability.ts`) and
// the server's config-parse fallback path (`observability/server/runtime.ts`,
// `configuredTopologies`). Before this module, both layers carried a copy of
// the same projection — and the server-side copy silently dropped `slug`,
// which the comment "C2: mirror the extension-side summary" was guarding.
//
// Including `slug` here means the server-side fallback rows now also carry
// it. Nothing on the dashboard reads `topology_node.slug` today, and the
// topology hash in `observability/server/topology-hash.ts` deliberately
// excludes `slug` from the canonical form (Decision 13), so this addition
// is observable only as a column populated on the fallback path. The
// function remains pure: no Bun deps, no FS, no globals beyond `crypto`-free
// helpers, so it loads from either the engine or the server side.

import type { AgentConfig, HiveTeam } from "./types";
import type { HiveStateSnapshot, TopologyNode } from "../shared/telemetry";
import { agentSlug } from "./agent-tree";

export function agentSummary(agent: AgentConfig): TopologyNode {
  return {
    slug: agentSlug(agent),
    name: agent.name,
    role: agent.role,
    agentType: agent.agentType,
    stages: agent.stages,
    group: agent.groupName,
    color: agent.color,
    model: agent.model,
    tools: agent.tools,
    thinking: agent.thinking,
    consultWhen: agent.consultWhen,
    routingTags: agent.routingTags || [],
    // The enforcement boundary (A8): the glob list the agent may write, whether
    // it may commit (presence of commit guidance unlocks the gate), and its
    // declared responsibilities. These are what Phase E renders and what the
    // versioned topology (Phase C) hashes.
    domain: (agent.domain || []).map((scope) => scope.path),
    commit: Boolean(agent.commit && agent.commit.trim()),
    responsibilities: (agent.responsibilities || []).join("\n") || undefined,
    children: [...(agent.members || []), ...(agent.children || [])].map(agentSummary),
  };
}

export function teamTopology(team?: HiveTeam): HiveStateSnapshot["topology"] | undefined {
  if (!team) return undefined;
  return {
    orchestrator: team.main ? agentSummary(team.main) : undefined,
    agents: (team.agents || []).map(agentSummary),
  };
}
