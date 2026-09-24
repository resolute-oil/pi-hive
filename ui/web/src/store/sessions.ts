import type { AgentRuntime, HiveEvent, SessionView, Snapshot } from "../types";
import type { SessionSummary } from "../api";
import { projectName } from "../lib/format";
import { applyHistoryToRuntime } from "./history";
import { buildAgents } from "./topology";
import { sessionStore, sessionUpdatedAt } from "./identity";
import { getHistoryBySession } from "./scoped-agents";
import type { ScopeStats } from "./index";

export function computeAllEvents(events: HiveEvent[]): HiveEvent[] {
  const arr = events;
  arr.sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || (a.seq || 0) - (b.seq || 0));
  return arr;
}

type ProjectFields = { project_id?: string; project_root?: string; project_label?: string; cwd?: string };

export function projectFields(source: ProjectFields, sessionId: string) {
  const key = source.project_id || `legacy:${source.cwd || sessionId}`;
  const label = source.project_label || projectName(source.project_root || source.cwd);
  return { key, label };
}

export function computeSessions(allEvents: HiveEvent[], snapshots: Record<string, Snapshot>, eventStatus: Map<string, Map<string, string>>, summaries: Map<string, SessionSummary>): SessionView[] {
  const present = new Set<string>();

  const ensure = (id: string, source: ProjectFields = {}, ts?: string): SessionView => {
    let v = sessionStore.get(id);
    const identity = projectFields(source, id);
    if (!v) {
      v = {
        session_id: id,
        project_id: identity.key,
        project_root: source.project_root,
        project_label: identity.label,
        cwd: source.cwd,
        project: identity.key,
        first_ts: ts || "",
        last_ts: ts || "",
        event_count: 0,
        running: 0,
        tokens: 0,
        cost: 0,
        live: false,
        agents: new Map(),
      };
      sessionStore.set(id, v);
    } else if (source.project_id && v.project_id !== source.project_id) {
      v.project_id = source.project_id;
      v.project = source.project_id;
      v.project_root = source.project_root || v.project_root;
      v.project_label = source.project_label || v.project_label;
    }
    present.add(id);
    return v;
  };

  // reset per-recompute accumulators on the persisted objects
  for (const v of sessionStore.values()) v.event_count = 0;

  for (const e of allEvents) {
    const id = e.session_id || "unknown";
    const v = ensure(id, e, e.ts);
    if (!v.cwd && e.cwd) v.cwd = e.cwd;
    if (!v.first_ts || e.ts < v.first_ts) v.first_ts = e.ts;
    if (e.ts > v.last_ts) v.last_ts = e.ts;
    v.event_count++;
  }

  for (const snap of Object.values(snapshots)) {
    const id = snap.session_id;
    const v = ensure(id, snap, snap.updated_at);
    if (!v.cwd && snap.cwd) v.cwd = snap.cwd;
    if (snap.updated_at > v.last_ts) v.last_ts = snap.updated_at;
    sessionUpdatedAt.set(id, new Date(snap.updated_at).getTime());
    v.topology = snap.topology;
    v.topologies = snap.topologies;
    v.agents = buildAgents(snap);
    const hist = getHistoryBySession().get(id);
    if (hist) {
      for (const [name, p] of hist) {
        const a = v.agents.get(name);
        if (a) applyHistoryToRuntime(a, p);
      }
    }
    const agents = snap.agents || [];
    v.tokens = agents.reduce((sum, agent) => sum + (agent.inputTokens || 0) + (agent.outputTokens || 0), 0);
    v.cost = agents.reduce((sum, agent) => sum + (agent.costUsd || 0), 0);
  }

  // Union with the server-authoritative session list (Phase 3.4): a session whose
  // events fell outside the ~1000-row loaded window (and which has no live
  // snapshot) would otherwise be invisible in the sidebar/session list. Seed a
  // minimal row from its summary so it still appears; its authoritative
  // tokens/cost/event_count come straight from the DB. Skipped once real
  // events/snapshots arrive for it (ensure() already created the richer row).
  for (const [id, sum] of summaries) {
    const v = ensure(id, sum, sum.last_ts || sum.first_ts);
    if (sum.project_root) v.project_root = sum.project_root;
    if (sum.project_label) v.project_label = sum.project_label;
    if (!v.cwd && sum.cwd) v.cwd = sum.cwd;
    if (sum.first_ts && (!v.first_ts || sum.first_ts < v.first_ts)) v.first_ts = sum.first_ts;
    if (sum.last_ts && sum.last_ts > v.last_ts) v.last_ts = sum.last_ts;
    if (sum.event_count != null) v.event_count = sum.event_count;
    // SQL usage_events is the sole historical authority. Live snapshots remain
    // useful for per-agent status, but fresh runs/mode switches may reset their
    // counters and must never lower or replace completed historical usage.
    if (sum.tokens != null) v.tokens = sum.tokens;
    if (sum.cost != null) v.cost = sum.cost;
    v.usageStatus = sum.usageStatus;
  }

  // Event-driven status overlay: the topology reflects events instantly. Apply
  // the latest event status onto each agent (creating placeholder entries for
  // agents seen in events but not yet in a snapshot), then derive running count.
  for (const id of present) {
    const v = sessionStore.get(id)!;
    const evStatus = eventStatus.get(id) || new Map<string, string>();
    for (const [name, st] of evStatus) {
      const a = v.agents.get(name);
      if (a) a.status = st as AgentRuntime["status"];
      else v.agents.set(name, { name, status: st as AgentRuntime["status"] });
    }
    let running = 0, active = 0;
    for (const a of v.agents.values()) {
      if (a.status === "running") running++;
      if (a.status === "running" || a.status === "waiting") active++;
    }
    v.running = running;     // actually executing
    v.active = active;       // running + waiting (used for liveness)
  }

  // drop sessions that no longer exist (e.g. deleted)
  for (const id of Array.from(sessionStore.keys())) if (!present.has(id)) { sessionStore.delete(id); sessionUpdatedAt.delete(id); }

  return Array.from(sessionStore.values()).sort((a, b) => String(b.last_ts).localeCompare(String(a.last_ts)));
}

export function computeFleetStats(ss: SessionView[]): ScopeStats {
  return {
    sessions: ss.length,
    live: ss.filter((s) => s.live).length,
    running: ss.reduce((a, s) => a + s.running, 0),
    tokens: ss.reduce((a, s) => a + s.tokens, 0),
    cost: ss.reduce((a, s) => a + s.cost, 0),
  };
}
