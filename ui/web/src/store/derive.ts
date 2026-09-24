import type { ProjectGroup, SessionView } from "../types";
import { buildHistoryBySession } from "./history";
import { buildEventStatus } from "./status";
import { sessionUpdatedAt } from "./identity";
import { computeAllEvents, computeFleetStats, computeSessions } from "./sessions";
import { computeScopedAgents, setHistoryBySession } from "./scoped-agents";
import { STALE_LIVE_MS, sessionIsStale } from "./stale";
import { sessionSlug } from "../lib/format";
import { store, type HiveState, type ScopeStats, type ScopeTitle } from "./index";
import { flattenTopology } from "./topology";

// ── heavy tier: events/snapshots changed ─────────────────────────────────────
// A burst of SSE frames or initial snapshots should trigger one bounded rebuild,
// not one full derivation per row. 32 ms keeps live UI latency imperceptible while
// limiting heavy work to roughly one pass per two animation frames.
let heavyTimer: ReturnType<typeof setTimeout> | undefined;
export function scheduleHeavyRecompute(): void {
  if (heavyTimer) return;
  heavyTimer = setTimeout(() => {
    heavyTimer = undefined;
    recomputeHeavy();
  }, 32);
}

export function flushHeavyRecompute(): void {
  if (heavyTimer) clearTimeout(heavyTimer);
  heavyTimer = undefined;
  recomputeHeavy();
}

export function recomputeHeavy() {
  const s = store.getState();
  const allEvents = computeAllEvents(s.eventRing.values());
  const history = buildHistoryBySession(allEvents);
  setHistoryBySession(history);
  const eventStatus = buildEventStatus(allEvents);
  const sessions = computeSessions(allEvents, s.snapshots, eventStatus, s.sessionSummaries);
  const sessionsById = new Map<string, SessionView>();
  for (const sess of sessions) sessionsById.set(sess.session_id, sess);
  store.setState({ allEvents, eventStatus, sessions, sessionsById });
  // heavy inputs feed the scoped + live tiers
  recomputeLive();
  recomputeScoped();
}

// ── live tier: 1s tick (freshness) ───────────────────────────────────────────
export function recomputeLive() {
  const s = store.getState();
  const t = s.now || Date.now();
  const live = new Set<string>();
  // R3-1.2: demote the shared event-status overlay AT THE SOURCE for stale
  // sessions. buildEventStatus (heavy tier) rebuilds this map raw, marking
  // running/waiting and clearing only on delegation_end — the one event a killed
  // process never emits — so a dead session's overlay would pin an agent active
  // forever. Every consumer reads this same map (TopologyGraph.useStatus, the
  // computeSessions overlay-apply loop, computeScopedAgents.statusOf), so demoting
  // here heals ALL of them at once instead of per-render-path.
  //
  // R4.3: cheap pre-scan first — only a stale session with a still-running/waiting
  // entry needs demoting. If none, skip the whole map allocation (this runs every
  // 1s tick, so an unchanging overlay must not churn GC). The copy + setState are
  // built only when there's actually something to demote.
  let overlayChanged = false;
  for (const [sid, agents] of s.eventStatus) {
    if (!sessionIsStale(sid, t)) continue;
    for (const st of agents.values()) {
      if (st === "running" || st === "waiting") { overlayChanged = true; break; }
    }
    if (overlayChanged) break;
  }
  let nextStatus: typeof s.eventStatus | undefined;
  if (overlayChanged) {
    nextStatus = new Map();
    for (const [sid, agents] of s.eventStatus) {
      const stale = sessionIsStale(sid, t);
      const copy = new Map<string, string>();
      for (const [name, st] of agents) copy.set(name, stale ? (st === "running" || st === "waiting" ? "idle" : st) : st);
      nextStatus.set(sid, copy);
    }
  }
  for (const v of s.sessions) {
    const at = sessionUpdatedAt.get(v.session_id) || new Date(v.last_ts).getTime() || 0;
    const fresh = at > 0 && t - at < STALE_LIVE_MS;
    const isLive = (v.active ?? v.running) > 0 && fresh;
    v.live = isLive;
    if (isLive) live.add(v.session_id);
    // Phase 6.4: per-agent stuck-"running" staleness. An agent whose process died
    // without a final delegation_end stays "running" forever in the status
    // overlay/topology. Once its session is stale (same window as session
    // liveness), demote any running/waiting agent to idle and zero the running
    // count so a dead worker stops rendering as active.
    if (!fresh) {
      let anyDemoted = false;
      for (const a of v.agents.values()) {
        if (a.status === "running" || a.status === "waiting") { a.status = "idle"; anyDemoted = true; }
      }
      if (anyDemoted) { v.running = 0; v.active = 0; }
    }
  }
  if (nextStatus) store.setState({ eventStatus: nextStatus });
  // Project groups for the sidebar; live flag derived from the live set.
  const overrides = s.projectOverrides;
  const groups = new Map<string, ProjectGroup>();
  for (const sess of s.sessions) {
    let g = groups.get(sess.project);
    if (!g) {
      g = { name: sess.project, derivedLabel: sess.project_label, label: sess.project_label, sessions: [], live: false, totalCost: 0, cwds: [] };
      groups.set(sess.project, g);
    }
    g.sessions.push(sess);
    g.live = g.live || live.has(sess.session_id);
    g.totalCost += sess.cost;
    if (sess.cwd && !g.cwds.includes(sess.cwd)) g.cwds.push(sess.cwd);
  }
  // Display names are presentation only; grouping remains keyed by project ID.
  for (const g of groups.values()) g.label = overrides.get(g.name) || g.derivedLabel;
  const projectGroups = Array.from(groups.values()).sort((a, b) => Number(b.live) - Number(a.live) || a.label.localeCompare(b.label));
  store.setState({ liveSet: live, projectGroups, fleetStats: computeFleetStats(s.sessions) });
}

// ── scoped tier: scope/selectedSession changed (also after heavy/live) ───────
export function recomputeScoped() {
  const s = store.getState();
  const scope = s.scope;
  const sessions = s.sessions;

  const scopedSessions = scope.level === "fleet" ? sessions
    : scope.level === "project" ? sessions.filter((x) => x.project === scope.project)
    : sessions.filter((x) => x.session_id === scope.sessionId);

  const ids = new Set(scopedSessions.map((x) => x.session_id));
  const scopedEvents = [...s.allEvents].filter((e) => ids.has(e.session_id)).reverse();
  // Typed delegation deltas for the scoped sessions (Phase 3.1) — feeds the
  // cost/token history + CACHE, untruncated by the raw event window.
  const scopedDelegations = s.delegations.filter((d) => ids.has(d.sessionId));

  const scopedStats: ScopeStats = {
    sessions: scopedSessions.length,
    live: scopedSessions.filter((x) => x.live).length,
    running: scopedSessions.reduce((a, x) => a + x.running, 0),
    tokens: scopedSessions.reduce((a, x) => a + x.tokens, 0),
    cost: scopedSessions.reduce((a, x) => a + x.cost, 0),
  };

  // currentSession: at session scope it's that session; at project/fleet scope
  // it's the most recently active session within the scope (prefer live).
  let currentSession: SessionView | undefined;
  if (scope.level === "session") currentSession = s.sessionsById.get(scope.sessionId) || sessions[0];
  else {
    const inScope = scope.level === "project" ? sessions.filter((x) => x.project === scope.project) : sessions;
    currentSession = inScope.find((x) => x.live) || inScope[0];
  }

  const scopedAgents = computeScopedAgents(scopedSessions);
  // Collapse per-(session,agent) rows to distinct names for any headline count
  // (donut "N AGENTS", "M teams · N agents", Agents tab badge). Without this a
  // project shows K× its real roster, one copy per session that ran it.
  const distinctNames = new Set<string>();
  const teamNames = new Set<string>();
  for (const a of scopedAgents) {
    const n = a.name.trim().toLowerCase();
    if (!n) continue;
    distinctNames.add(n);
    if (a.role === "lead") teamNames.add(n);
  }
  const scopedAgentCount = distinctNames.size;
  const scopedTeamCount = teamNames.size;

  // Display label for the scoped project (override its derived name if set).
  const labelFor = (project: string) => {
    const session = s.sessions.find((candidate) => candidate.project === project);
    return s.projectOverrides.get(project) || session?.project_label || project;
  };

  // scope title + breadcrumb
  let scopeTitle: ScopeTitle;
  if (scope.level === "fleet") scopeTitle = { title: "Overview", crumbs: ["Overview"], live: scopedStats.live };
  else if (scope.level === "project") { const pl = labelFor(scope.project); scopeTitle = { title: pl, crumbs: ["Overview", pl], live: scopedStats.live }; }
  else {
    const sess = s.sessionsById.get(scope.sessionId);
    const pl = labelFor(scope.project);
    scopeTitle = { title: pl, crumbs: ["Overview", pl, sessionSlug(scope.sessionId)], live: scopedStats.live, session: sess };
  }

  store.setState({ scopedSessions, scopedEvents, scopedDelegations, scopedStats, currentSession, scopedAgents, scopedAgentCount, scopedTeamCount, scopeTitle });
}

export { flattenTopology };
export type { HiveState };
