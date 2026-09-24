import { useMemo } from "react";
import { useHive } from "../store";
import { selectFleet, selectProject, setActiveTab, setTheme } from "../store/raw";
import { hhmmss } from "../lib/agents";
import { bundleEvents, mergeThinking } from "../lib/activity";

// Hand-drawn inline nav icons (16×16, stroke currentColor 1.5), per the design
// spec's "small hand-drawn inline SVGs" — a 2×2 grid, two bars, a pulse line,
// a doc, a dollar sign.
function NavIcon({ name }: { name: string }) {
  const p: Record<string, JSX.Element> = {
    overview: (<>
      <rect x="2" y="2" width="5" height="5" rx="1.2" /><rect x="9" y="2" width="5" height="5" rx="1.2" />
      <rect x="2" y="9" width="5" height="5" rx="1.2" /><rect x="9" y="9" width="5" height="5" rx="1.2" />
    </>),
    sessions: (<><rect x="2" y="3" width="12" height="3" rx="1" /><rect x="2" y="10" width="12" height="3" rx="1" /></>),
    agents: (<><circle cx="8" cy="5" r="2.4" /><path d="M3 13c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5" /></>),
    activity: (<path d="M1 8h3l2-5 3 10 2-5h4" />),
    plans: (<><rect x="3" y="2" width="10" height="12" rx="1.5" /><path d="M6 6h4M6 9h4" /></>),
    cost: (<><circle cx="8" cy="8" r="6" /><path d="M8 5v6M6.4 6.5h2.2M7.4 9.5h2.2" /></>),
    settings: (<><circle cx="8" cy="8" r="2.2" /><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1" /></>),
  };
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {p[name]}
    </svg>
  );
}

// The pi-hive orbit mark: ring + center dot + 3 satellites, all --brand.
function OrbitMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="var(--brand)" strokeWidth="1.7" />
      <circle cx="12" cy="12" r="3.4" fill="var(--brand)" />
      <circle cx="12" cy="4.4" r="1.5" fill="var(--brand)" />
      <circle cx="19" cy="15.5" r="1.5" fill="var(--brand)" />
      <circle cx="5" cy="15.5" r="1.5" fill="var(--brand)" />
    </svg>
  );
}

// Live wall clock. Reads the store's 1s `now` tick — no second timer.
function Clock() {
  const now = useHive((s) => s.now);
  return (
    <span className="font-mono text-[18px] font-semibold tracking-[.04em] text-ink tabular-nums">
      {hhmmss(now || Date.now())}
    </span>
  );
}

// Recent provider back-pressure (Phase 4.11): `provider_response` is emitted
// only for non-2xx responses (429/529 rate-limit/overload). Surface a count of
// those seen in the last 5 minutes so a stalled fleet has a visible cause.
// Silent when there's no recent pressure.
//
// Reads `scopedEvents` (already filtered to the selected scope) so the
// indicator reflects pressure on what the user is actually looking at, not
// the whole fleet. The window filter is memoized so it doesn't re-scan on
// every unrelated render (the 1s `now` tick advances the window boundary,
// so it recomputes ~once a second by design, not per keystroke).
const PRESSURE_WINDOW_MS = 5 * 60_000;
function ProviderPressure() {
  const events = useHive((s) => s.scopedEvents);
  const now = useHive((s) => s.now);
  const recent = useMemo(
    () => events.filter(
      (e) => e.type === "provider_response" && (now || Date.now()) - new Date(e.ts).getTime() < PRESSURE_WINDOW_MS,
    ),
    [events, now],
  );
  if (!recent.length) return null;
  // scopedEvents is newest-first, so recent[0] is the latest pressure response.
  const last = recent[0];
  const status = last?.payload?.status;
  return (
    <span
      role="status"
      className="mt-2 flex items-center gap-[6px] text-[11px] font-semibold tracking-[.05em] text-crit"
      title={`${recent.length} provider rate-limit/overload response${recent.length === 1 ? "" : "s"} in the last 5 min (latest ${status ?? "?"})`}
    >
      <span className="w-[6px] h-[6px] rounded-full bg-crit animate-softblink-fast" aria-hidden="true" />
      {recent.length}× {status ?? "429/529"}
    </span>
  );
}

export default function Sidebar() {
  const scope = useHive((s) => s.scope);
  const activeTab = useHive((s) => s.activeTab);
  const connection = useHive((s) => s.connection);
  const theme = useHive((s) => s.theme);
  const projectGroups = useHive((s) => s.projectGroups);
  const scopedStats = useHive((s) => s.scopedStats);
  const scopedEvents = useHive((s) => s.scopedEvents);
  const scopedSessions = useHive((s) => s.scopedSessions);
  const thinkingBySession = useHive((s) => s.thinkingBySession);
  const scopedAgentCount = useHive((s) => s.scopedAgentCount);

  // Count badge for the Activity nav must match what the Activity tab actually
  // shows. The tab computes items = mergeThinking(bundleEvents(scopedEvents),
  // thinking) so tool start/end pairs collapse into a single feed item and
  // transcript thinking entries are merged in. Showing the raw
  // scopedEvents.length here would overcount by exactly the number of tool
  // pairs collapsed by bundleEvents minus any thinking entries added — which is
  // exactly the discrepancy the user reported (sidebar "1000", list "692").
  const thinking = useMemo(() => {
    const out: Array<{ agent: string; ts: string; text: string; tokens?: number }> = [];
    for (const s of scopedSessions) for (const t of thinkingBySession.get(s.session_id) || []) out.push(t);
    return out;
  }, [scopedSessions, thinkingBySession]);
  const activityCount = useMemo(
    () => mergeThinking(bundleEvents(scopedEvents), thinking).length,
    [scopedEvents, thinking],
  );

  const scopeValue = scope.level === "fleet" ? "__fleet" : scope.project;
  const live = connection === "live";
  const currentGroup = scope.level !== "fleet" ? projectGroups.find((g) => g.name === scope.project) : undefined;
  const projectLabel = scope.level === "fleet" ? "All projects" : (currentGroup?.label || scope.project);

  // Settings is project-scoped: only shown when a specific project is selected.
  const projectSelected = scope.level !== "fleet";
  const nav = [
    { id: "overview", label: "Overview", count: "" },
    { id: "sessions", label: "Sessions", count: scopedStats.sessions ? String(scopedStats.sessions) : "" },
    { id: "agents", label: "Agents", count: scopedAgentCount ? String(scopedAgentCount) : "" },
    { id: "activity", label: "Activity", count: activityCount ? String(activityCount) : "" },
    { id: "plans", label: "Plans", count: "" },
    { id: "cost", label: "Cost", count: "" },
    ...(projectSelected ? [{ id: "settings", label: "Settings", count: "" }] : []),
  ];

  function chooseProject(value: string) {
    if (value === "__fleet") selectFleet();
    else selectProject(value);
  }

  const host = typeof window !== "undefined" ? window.location.host : "127.0.0.1";

  return (
    <aside className="w-[238px] flex-none bg-surface border border-line rounded-2xl flex flex-col p-[20px_14px] overflow-hidden min-h-0">
      {/* Brand row */}
      <div className="flex items-center gap-3 px-1.5 pb-5">
        <div className="w-[38px] h-[38px] rounded-xl bg-brand-bg grid place-items-center flex-none">
          <OrbitMark />
        </div>
        <div className="leading-[1.15]">
          <div className="font-extrabold tracking-[-.02em] text-[17px]">pi-hive</div>
          <div className="font-mono text-[9.5px] tracking-[.16em] text-ink-dim mt-px">MISSION CONTROL</div>
        </div>
      </div>

      {/* Project selector (styled well button wrapping a native select) */}
      <div className="relative mb-4">
        <div className="w-full flex items-center justify-between gap-2 bg-well border border-line rounded-[11px] text-ink px-3 py-[9px] text-[13px]">
          <span className="flex items-center gap-[9px] min-w-0">
            <span className="w-[7px] h-[7px] rounded-full bg-brand flex-none" />
            <span className="overflow-hidden text-ellipsis whitespace-nowrap font-medium">{projectLabel}</span>
          </span>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--ink-dim)" strokeWidth="1.5"><path d="M3 5l3 3 3-3" /></svg>
        </div>
        <select
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          aria-label="Project"
          value={scopeValue}
          onChange={(e) => chooseProject(e.target.value)}
        >
          <option value="__fleet">All projects</option>
          {projectGroups.map((g) => (
            <option key={g.name} value={g.name}>{g.live ? "● " : ""}{g.label}</option>
          ))}
        </select>
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-[3px]" aria-label="Dashboard sections">
        {nav.map((t) => {
          const on = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              aria-current={on ? "page" : undefined}
              onClick={() => setActiveTab(t.id)}
              className={`flex items-center gap-[11px] px-[11px] py-2.5 rounded-[11px] text-[13.5px] cursor-pointer text-left border-0 transition-[background,color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 ${
                on ? "text-brand bg-brand-bg font-semibold" : "text-ink-dim bg-transparent font-medium hover:text-ink hover:bg-well"
              }`}
            >
              <span className="w-[18px] flex justify-center flex-none"><NavIcon name={t.id} /></span>
              <span className="flex-1">{t.label}</span>
              {t.count && <span className="font-mono text-[11px] text-ink-dim">{t.count}</span>}
            </button>
          );
        })}
      </nav>

      <div className="flex-1" />

      {/* Connection card */}
      <div className="bg-well border border-line rounded-xl p-[12px_13px] mb-3">
        <div className="flex items-center gap-[9px] text-xs font-medium">
          <span
            className="w-2 h-2 rounded-full flex-none animate-softblink"
            style={{
              background: live ? "var(--done)" : "var(--wait)",
              boxShadow: live ? "0 0 0 3px color-mix(in srgb, var(--done) 22%, transparent)" : "none",
            }}
          />
          <span className="capitalize">{live ? "Connected" : connection}</span>
        </div>
        <div className="font-mono text-[11px] text-ink-dim mt-1.5 pl-[17px]">{host}</div>
        <ProviderPressure />
      </div>

      {/* Theme toggle (2-segment) */}
      <div className="flex bg-well border border-line rounded-[11px] p-[3px] gap-[3px] mb-3">
        {(["dark", "light"] as const).map((mode) => {
          const on = theme === mode;
          return (
            <button
              type="button"
              key={mode}
              aria-pressed={on}
              onClick={() => setTheme(mode)}
              className={`flex-1 text-center py-[7px] rounded-lg cursor-pointer border-0 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 ${
                on ? "bg-raise text-ink font-semibold" : "bg-transparent text-ink-dim font-medium"
              }`}
            >
              {mode === "dark" ? "Dark" : "Light"}
            </button>
          );
        })}
      </div>

      {/* Wall clock — its own card, matching the connection card frame. */}
      <div className="bg-well border border-line rounded-xl p-[12px_13px] flex items-center justify-center">
        <Clock />
      </div>
    </aside>
  );
}
