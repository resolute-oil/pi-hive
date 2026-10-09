import { fetchSessionEvents } from "../api";
import type { TopologyDetail } from "../api";
import { store, type ReplayState } from "./index";
import { ensureTopologyDetail } from "./wiring";
import { buildEventStatus } from "./status";
import type { AgentRuntime, HiveEvent, SessionView, TeamTopologies } from "../types";
import type { TopoSource } from "../components/TopologyGraph";

// Replay controller (Phase F). A self-contained slice: entering replay pages the
// whole session history into a local buffer; the scrubber moves `cursor` over
// that buffer; play/pause advances it by wall-clock deltas at 1×/10×/60×. No SSE
// frame ever touches this slice, so the live view is unaffected.

function setReplay(patch: Partial<ReplayState>) {
  store.setState({ replay: { ...store.getState().replay, ...patch } });
}

let playTimer: ReturnType<typeof setInterval> | undefined;

function stopTimer() {
  if (playTimer) { clearInterval(playTimer); playTimer = undefined; }
}

export async function enterReplay(sessionId: string) {
  stopTimer();
  setReplay({ active: true, sessionId, events: [], loading: true, loadedCount: 0, cursor: 0, playing: false, speed: 1, truncatedStart: false, historyStartsAt: "" });
  // Prefetch the session's versioned topology (K5) so the replayed graph renders
  // the tree it actually ran under, not the live current-session tree.
  const topoHash = store.getState().sessionSummaries.get(sessionId)?.topologyHash;
  if (topoHash) void ensureTopologyDetail(topoHash);
  const { events, fetchedTotal } = await fetchSessionEvents(sessionId, (n) => setReplay({ loadedCount: n }));
  // Guard against a session switch mid-load.
  if (store.getState().replay.sessionId !== sessionId) return;
  // F3/I4: compare the RAW fetched count (delegation_progress included) against
  // the server's authoritative sessions.event_count. A shortfall means early
  // history was pruned. `sessionsById` is the client-derived view (its count
  // only reflects loaded events), so it can't detect this — we use the summary.
  const recorded = store.getState().sessionSummaries.get(sessionId)?.event_count;
  const truncatedStart = recorded != null && fetchedTotal < recorded;
  const historyStartsAt = truncatedStart && events.length ? events[0].ts : "";
  setReplay({ events, loading: false, cursor: events.length ? events.length - 1 : 0, truncatedStart, historyStartsAt });
}

export function exitReplay() {
  stopTimer();
  setReplay({ active: false, playing: false, events: [], loadedCount: 0, cursor: 0 });
}

export function seekReplay(cursor: number) {
  const { events } = store.getState().replay;
  const clamped = Math.max(0, Math.min(events.length - 1, cursor));
  setReplay({ cursor: clamped });
}

export function setReplaySpeed(speed: 1 | 10 | 60) {
  setReplay({ speed });
  if (store.getState().replay.playing) { pauseReplay(); playReplay(); }
}

// Advance by real elapsed time × speed, stepping the cursor to the last event
// whose timestamp is ≤ the virtual playhead. Pauses at the end.
export function playReplay() {
  const r = store.getState().replay;
  if (!r.events.length) return;
  if (r.cursor >= r.events.length - 1) setReplay({ cursor: 0 }); // restart from the top
  stopTimer();
  setReplay({ playing: true });
  const tickMs = 200;
  playTimer = setInterval(() => {
    const s = store.getState().replay;
    if (!s.playing || !s.events.length) { stopTimer(); return; }
    const cur = s.events[s.cursor];
    const virtualAdvance = tickMs * s.speed;
    const targetTs = new Date(cur.ts).getTime() + virtualAdvance;
    let next = s.cursor;
    while (next < s.events.length - 1 && new Date(s.events[next + 1].ts).getTime() <= targetTs) next++;
    // Always progress at least one event so a burst of same-timestamp events
    // doesn't stall the playhead.
    if (next === s.cursor && s.cursor < s.events.length - 1) next = s.cursor + 1;
    if (next >= s.events.length - 1) { setReplay({ cursor: s.events.length - 1, playing: false }); stopTimer(); return; }
    setReplay({ cursor: next });
  }, tickMs);
}

export function pauseReplay() {
  stopTimer();
  setReplay({ playing: false });
}

// Inputs `replayTopoSource` consumes beyond the events slice. Exposed so call
// sites can satisfy react-hooks/exhaustive-deps by listing the values they
// actually pass through. `topologyDetail` and `topologyHash` together drive the
// versioned-tree path; `liveSession` is the fallback before the detail has
// loaded (and the source for the persisted active-team tag once it's loaded).
export interface ReplayTopoContext {
  sessionId: string;
  topologyHash: string | undefined;
  topologyDetail: TopologyDetail | undefined;
  liveSession: SessionView | undefined;
}

// Build the TopoSource the Overview's TopologyGraph renders during replay (K5):
// the session's versioned topology tree (fetched by hash into the store cache)
// plus an agents map whose statuses are derived purely from events[0..cursor].
// Pure over the replay slice + the supplied context; returns undefined until
// either the topology detail or the live session snapshot is available.
export function replayTopoSource(slice: HiveEvent[], ctx: ReplayTopoContext): TopoSource | undefined {
  const statusBySession = buildEventStatus(slice);
  const statuses = statusBySession.get(ctx.sessionId) || new Map<string, string>();
  const agents = new Map<string, AgentRuntime>();
  for (const [name, status] of statuses) agents.set(name, { name, status } as AgentRuntime);
  // Prefer the versioned tree; if the detail hasn't loaded, fall back to the live
  // session's topology so the graph still renders (statuses still from replay).
  if (ctx.topologyDetail) {
    const detail = ctx.topologyDetail;
    // Prefer the session's persisted active team (Phase 2.4) — the server now
    // stores it on the snapshot rather than re-guessing from tree shape. Fall
    // back to the structural guess only when the live snapshot isn't loaded.
    const liveActive = ctx.liveSession?.topologies?.active;
    const active: "hive" | "planning" = liveActive
      ?? (detail.hive?.orchestrator || detail.hive?.agents?.length ? "hive" : "planning");
    const topologies: TeamTopologies = { active, hive: detail.hive, planning: detail.planning };
    return { session_id: ctx.sessionId, topologies, agents };
  }
  if (ctx.liveSession) return { session_id: ctx.sessionId, topology: ctx.liveSession.topology, topologies: ctx.liveSession.topologies, agents };
  return undefined;
}
