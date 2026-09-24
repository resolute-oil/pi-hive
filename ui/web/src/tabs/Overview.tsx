import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Kpis from "../components/Kpis";
import Widget from "../components/WidgetModal";
import LiveActivity from "../components/LiveActivity";
import CostTokensChart from "../components/CostTokensChart";
import ModelMix from "../components/ModelMix";
import Replay from "../components/Replay";
import { useHive } from "../store";
import { replayTopoSource } from "../store/replay";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { absTime } from "../lib/format";

// The topology graph pulls in d3-hierarchy; code-split it so that dependency
// only loads when the Overview tab (the sole consumer) actually renders.
const TopologyGraph = lazy(() => import("../components/TopologyGraph"));

// The four-color status legend shown on the topology header.
const LEGEND: { label: string; color: string }[] = [
  { label: "running", color: "var(--run)" },
  { label: "waiting", color: "var(--wait)" },
  { label: "done", color: "var(--done)" },
  { label: "error", color: "var(--crit)" },
];

function StatusLegend() {
  return (
    <div className="flex gap-[7px]">
      {LEGEND.map((l) => (
        <span key={l.label} className="flex items-center gap-1.5 text-[11px] text-ink-dim bg-well rounded-full pl-2 pr-2.5 py-1">
          <i className="w-[7px] h-[7px] rounded-full block" style={{ background: l.color }} />
          {l.label}
        </span>
      ))}
    </div>
  );
}

export default function Overview() {
  const [topologyView, setTopologyView] = useState<"hive" | "planning">("hive");
  // True while the fullscreen topology modal is open. Wired to the new
  // expand affordance in the topology pane's control cluster.
  const [topoExpanded, setTopoExpanded] = useState(false);
  const currentSession = useHive((s) => s.currentSession);
  const scopedAgents = useHive((s) => s.scopedAgents);
  const scope = useHive((s) => s.scope);
  const replay = useHive((s) => s.replay);

  // K5: when replay is active on THIS session's Overview, the topology/feed/chart
  // all render from the replay slice (events[0..cursor]); the Replay component
  // below becomes the transport. SSE keeps updating the live slice underneath.
  const replaying = replay.active && scope.level === "session" && replay.sessionId === scope.sessionId;
  const replaySlice = useMemo(
    () => (replaying ? replay.events.slice(0, replay.cursor + 1) : undefined),
    [replaying, replay.events, replay.cursor],
  );
  // replayTopoSource reads topologyByHash + the session summary via getState().
  // Subscribe to both here so the memo recomputes when a late ensureTopologyDetail
  // fetch resolves — otherwise the graph is stuck on the live fallback tree until
  // the user scrubs (M3).
  const replayHash = useHive((s) => (replaying ? s.sessionSummaries.get(replay.sessionId)?.topologyHash : undefined));
  const replayDetail = useHive((s) => (replayHash ? s.topologyByHash.get(replayHash) : undefined));
  const replaySource = useMemo(
    () => (replaySlice ? replayTopoSource(replaySlice) : undefined),
    [replaySlice, replayHash, replayDetail],
  );
  const replayTs = replaying ? replay.events[replay.cursor]?.ts : undefined;

  const topoTitle = scope.level === "session" ? "Session topology" : "Agent Topology";

  const teamCount = useHive((s) => s.scopedTeamCount);
  const agentCount = useHive((s) => s.scopedAgentCount);
  const topoMeta = `${teamCount} teams · ${agentCount} agents`;

  // First-run / empty state: no session has produced telemetry yet. Show a calm
  // in-language signature rather than a wall of empty panels.
  const isEmpty = !currentSession && scopedAgents.length === 0;
  if (isEmpty) {
    return (
      <div className="grid place-items-center py-24 text-center">
        <div className="flex flex-col items-center gap-5 max-w-[360px]">
          <div className="w-[72px] h-[72px] rounded-[20px] bg-brand-bg grid place-items-center animate-softblink">
            <svg width="40" height="40" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" fill="none" stroke="var(--brand)" strokeWidth="1.5" />
              <circle cx="12" cy="12" r="3.4" fill="var(--brand)" />
              <circle cx="12" cy="4.4" r="1.5" fill="var(--brand)" />
              <circle cx="19" cy="15.5" r="1.5" fill="var(--brand)" />
              <circle cx="5" cy="15.5" r="1.5" fill="var(--brand)" />
            </svg>
          </div>
          <div>
            <div className="text-[17px] font-bold tracking-[-.01em]">Waiting for hive telemetry</div>
            <p className="text-ink-dim text-[13px] leading-relaxed mt-2">
              Start a hive session in your project and this console lights up in real time — topology, activity, cost, and model mix.
            </p>
          </div>
          <code className="font-mono text-[11px] text-ink-dim bg-well border border-line rounded-lg px-3 py-2">pi · run a hive task</code>
        </div>
      </div>
    );
  }

  return (
    <>
      <Kpis />
      {/* Persistent replay banner (K5). Present whenever replay drives this
          Overview, naming the session and the current cursor timestamp. */}
      {replaying && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-wait/40 bg-well px-3 py-2 text-[12px] text-wait">
          <span className="w-[7px] h-[7px] rounded-full bg-wait animate-softblink" />
          <b>Replaying</b> session {scope.sessionId.slice(0, 8)} — {replayTs ? absTime(replayTs) : "…"}
          <span className="text-ink-dimmer">· event {replay.cursor + 1} / {replay.events.length}</span>
        </div>
      )}
      {/* Session replay (Phase F/K5): the transport controls. When engaged it
          drives the topology/feed/chart above; the live slice is untouched. */}
      {scope.level === "session" && (
        <div className="mb-[18px]">
          <Replay sessionId={scope.sessionId} />
        </div>
      )}
      <div className="widgets">
        <Widget
          title={topoTitle}
          className="hero"
          sub={<span className="font-mono text-[11px] text-ink-dim ml-1">{topoMeta}</span>}
          headExtra={<StatusLegend />}
        >
          <div className="topology-pane single">
            <div className="topology-pane-head">
              <div className="topology-switch" role="group" aria-label="Topology team">
                <button type="button" aria-pressed={topologyView === "hive"} className={topologyView === "hive" ? "active" : ""} onClick={() => setTopologyView("hive")}>Hive</button>
                <button type="button" aria-pressed={topologyView === "planning"} className={topologyView === "planning" ? "active" : ""} onClick={() => setTopologyView("planning")}>Planning</button>
              </div>
              {replaying ? <b className="text-wait">replay</b>
                : currentSession?.live ? <b>live</b>
                : currentSession?.topologies?.active === topologyView ? <b>active</b> : null}
            </div>
            <Suspense fallback={<div className="g-empty">Loading topology…</div>}>
              {replaying
                ? <TopologyGraph kind={topologyView} source={replaySource} statusMode="snapshot" onExpand={() => setTopoExpanded(true)} />
                : <TopologyGraph kind={topologyView} onExpand={() => setTopoExpanded(true)} />}
            </Suspense>
          </div>
        </Widget>

        <Widget
          title="Activity"
          className="hero"
          headExtra={
            replaying
              ? <span className="text-[11px] font-medium text-wait">replay</span>
              : <span className="flex items-center gap-1.5 text-[11px] font-medium text-run">
                  <span className="w-[6px] h-[6px] rounded-full bg-run animate-softblink-fast" />streaming
                </span>
          }
        >
          <LiveActivity limit={40} events={replaySlice} replayTs={replaying ? replayTs : undefined} replayStatus={replaying ? replaySource?.agents : undefined} />
        </Widget>

        <Widget
          title="Cost & Tokens"
          sub={<span className="font-medium text-ink-dim text-xs ml-1">· last 60 min</span>}
          headExtra={
            <span className="w-legend">
              <span className="lg-item"><i className="lg cost" />cost/min</span>
              <span className="lg-item"><i className="lg tok" />tokens/min</span>
            </span>
          }
        >
          <CostTokensChart mode="rate" events={replaySlice} />
        </Widget>

        <Widget title="Model Mix">
          <ModelMix />
        </Widget>
      </div>
      {/* Fullscreen topology modal: opened by the "Expand" affordance in the
          Overview's topology pane. Backdrop click, ESC, and the X button all
          close it; Tab focus is trapped inside until it does (matches the
          AgentLog and K2 modal patterns). */}
      <TopologyFullscreenModal
        open={topoExpanded}
        onClose={() => setTopoExpanded(false)}
        kind={topologyView}
        replaying={replaying}
        replaySource={replaySource}
      />
    </>
  );
}

// Fullscreen topology surface. Renders nothing when closed. Re-mounts a fresh
// TopologyGraph so panning/zoom state starts clean inside the modal — matches
// how the K2 version modal in Sessions.tsx wraps the same component.
function TopologyFullscreenModal(props: {
  open: boolean;
  onClose: () => void;
  kind: "hive" | "planning";
  replaying: boolean;
  replaySource: ReturnType<typeof replayTopoSource> | undefined;
}) {
  const trapRef = useFocusTrap<HTMLDivElement>(props.open);
  useEffect(() => {
    if (!props.open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") props.onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props.open, props.onClose]);
  if (!props.open) return null;
  return createPortal(
    <div className="modal-backdrop" onClick={props.onClose}>
      <div
        ref={trapRef}
        className="modal-panel-fullscreen"
        role="dialog"
        aria-modal="true"
        aria-label="Agent topology"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-line flex-none">
          <b className="text-[13px] text-ink">Agent Topology <span className="text-ink-dim font-normal">— {props.kind === "hive" ? "Hive" : "Planning"}</span></b>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close topology"
            title="Close (Esc)"
            className="w-[28px] h-[28px] rounded-md border border-line bg-surface text-ink-dim hover:text-ink grid place-items-center"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 min-h-0">
          <Suspense fallback={<div className="g-empty">Loading topology…</div>}>
            {/* The inner graph deliberately omits onExpand: there's no larger
                surface to escalate to from here, and rendering the button
                would invite nested-modal recursion if the user clicked it. */}
            {props.replaying
              ? <TopologyGraph kind={props.kind} source={props.replaySource} statusMode="snapshot" />
              : <TopologyGraph kind={props.kind} />}
          </Suspense>
        </div>
      </div>
    </div>,
    document.body,
  );
}
