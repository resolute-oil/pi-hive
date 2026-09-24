import type { AgentRuntime, SessionView, TopologyNode } from "../types";
import { buildHistoryBySession, type HistPeak } from "./history";
import { demoteIfStale } from "./stale";
import { store, type ScopeAgent } from "./index";

// Module-level cache of the last heavy-tier history products so the scoped
// tier can rebuild off them without recomputing the heavy work. Owned here
// (next to its only consumer, `computeScopedAgents`) and updated by
// `recomputeHeavy` via `setHistoryBySession` so the heavy-tier orchestrator
// in `derive.ts` doesn't have to know the cache shape.
let historyBySession: Map<string, Map<string, HistPeak>> = new Map();

export function setHistoryBySession(next: Map<string, Map<string, HistPeak>>): void {
  historyBySession = next;
}

export function getHistoryBySession(): Map<string, Map<string, HistPeak>> {
  return historyBySession;
}

// Re-export for callers that import from this module for the historical
// `buildHistoryBySession` helper, which the heavy tier still owns.
export { buildHistoryBySession };

function normalizeName(name: string | undefined): string {
  return (name || "").trim().toLowerCase();
}

// Defense-in-depth copy of an array-typed field from a topology row. The
// `TopologyNode` type declares `stages?: string[]` and `domain?: string[]`,
// but SQLite round-trips occasionally hand back a string-shaped value
// (legacy configs that wrote `stages: "specs"` instead of `["specs"]`); we
// coerce that to `undefined` here so the downstream `.join()` callers can
// trust the shape. The `Array.isArray(...).every(...)` guards in
// Agents.tsx/TopologyGraph.tsx added in 9e126c9 stay as belt-and-suspenders
// — cheap and explicit — but this is the load-bearing check. Originally
// added in derive.ts:1c before the split; landed here with WT-4 because
// `buildAgentRow` is the new copy site.
const copyStringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((s) => typeof s === "string") ? value as string[] : undefined;

function inferredRoleFor(node: TopologyNode, depth: number, rootName: string | undefined, rt?: AgentRuntime): ScopeAgent["role"] {
  if (node.role || rt?.role) return (node.role || rt?.role) as ScopeAgent["role"];
  if (rootName && normalizeName(node.name) === normalizeName(rootName) && depth === 0) return "orchestrator";
  return depth <= (rootName ? 1 : 0) || (node.children || []).length ? "lead" : "member";
}


// Shared shape between the topology-walk row and the runtime-only-agent row.
// Both walks produce the same ScopeAgent fields (with `depth` as the only
// meaningful difference); extracting this helper removes the duplicate
// field-by-field construction that previously lived inline in `computeScopedAgents`.
function buildAgentRow(
  sess: SessionView,
  name: string,
  rt: AgentRuntime | undefined,
  node: Partial<TopologyNode> | undefined,
  depth: number,
  order: number,
  rootName: string | undefined,
  statusOf: (sessionId: string, name: string, snapStatus?: string) => string,
): ScopeAgent {
  const key = normalizeName(name);
  const sessHist = getHistoryBySession().get(sess.session_id);
  const h = sessHist?.get(name);
  const snapTok = (rt?.inputTokens || 0) + (rt?.outputTokens || 0);
  return {
    key: sess.session_id + "::" + key,
    name,
    role: node ? inferredRoleFor(node as TopologyNode, depth, rootName, rt) : (rt?.role as ScopeAgent["role"]) || "member",
    agentType: node?.agentType || rt?.agentType,
    model: node?.model || rt?.model,
    color: node?.color,
    status: statusOf(sess.session_id, name, rt?.status),
    tokens: Math.max(snapTok, h ? h.input + h.output : 0),
    cost: Math.max(rt?.costUsd || 0, h?.cost || 0),
    runs: Math.max(rt?.runCount || 0, h?.runs || 0),
    tools: Math.max(rt?.toolCount || 0, h?.tools || 0),
    elapsedMs: rt?.elapsedMs,
    contextPct: rt?.contextPct,
    contextTokens: rt?.contextTokens,
    contextWindow: rt?.contextWindow,
    budgetRemaining: rt?.budgetRemaining,
    task: rt?.task || rt?.lastWork,
    session_id: sess.session_id,
    depth,
    order,
    // Enforcement contract carried from the topology node (Phase 6.1).
    // Array-shaped fields go through `copyStringArray` so a malformed
    // string value from a legacy config or DB row drops to undefined
    // rather than propagating as a runtime `Array.isArray()` failure at
    // every `.join()` site downstream. `buildAgentRow` is the new copy
    // site after the derive.ts → scoped-agents.ts split (WT-4 4b).
    domain: copyStringArray(node?.domain),
    commit: node?.commit,
    stages: copyStringArray(node?.stages),
    consultWhen: node?.consultWhen,
    responsibilities: node?.responsibilities,
  };
}

export function computeScopedAgents(scopedSessions: SessionView[]): ScopeAgent[] {
  const out: ScopeAgent[] = [];
  let order = 0;
  const gs = store.getState();
  const st = gs.eventStatus;
  const now = gs.now || Date.now();
  // W1.2: the overlay marks running/waiting but only clears on delegation_end, so a
  // dead session's overlay pins an agent active forever. Demote overlay entries for
  // stale sessions before they win over the snapshot status.
  const statusOf = (sessionId: string, name: string, snapStatus?: string) =>
    demoteIfStale(st.get(sessionId)?.get(name) || snapStatus || "idle", sessionId, now);
  for (const sess of scopedSessions) {
    const seen = new Set<string>();
    const topo = sess.topologies ? sess.topologies[sess.topologies.active] : sess.topology;
    const rootName = topo?.orchestrator?.name;

    // Walk the topology tree. Each visited node produces a ScopeAgent row with
    // the topology's enforcement contract fields populated.
    const walk = (node: TopologyNode, depth: number) => {
      const key = normalizeName(node?.name);
      if (!node || !key || seen.has(key)) return;
      seen.add(key);
      const rt = sess.agents.get(node.name);
      out.push(buildAgentRow(sess, node.name, rt, node, depth, order++, rootName, statusOf));
      for (const c of node.children || []) walk(c, depth + 1);
    };
    if (topo?.orchestrator) walk(topo.orchestrator, 0);
    for (const root of topo?.agents || []) walk(root, topo?.orchestrator ? 1 : 0);

    // Runtime/event-only agents may exist before (or without) a topology row.
    // The same `buildAgentRow` shape handles them; the inferred-role path
    // falls back to `rt.role || "member"` when no topology node is supplied.
    for (const rt of sess.agents.values()) {
      const key = normalizeName(rt.name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(buildAgentRow(sess, rt.name, rt, undefined, 0, order++, rootName, statusOf));
    }
  }
  return out;
}
