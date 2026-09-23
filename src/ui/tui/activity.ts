import type { AgentRuntime, HiveState } from "../../core/types";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { agentSlug } from "../../core/agent-tree";

// Widget id and size caps. The widget is a normal full-width pi panel — one
// line per agent — so it does not draw its own border frame. The previous
// implementation used box-drawing characters capped at MAX_BOX_WIDTH = 88,
// which overflowed the widget area on every addHiveActivity() re-render and
// interleaved with chat scrollback. The dashboard still ingests the activity
// log through its own telemetry path; this widget only surfaces live agent
// statuses, which is what an operator wants to see at a glance.
//
// MAX_AGENTS_IN_PANEL bounds the widget's row count regardless of how many
// agents state.runtimes holds. Pi's widget API only passes width, not height,
// so we don't know the widget's allocated area at render time — capping
// defensively at a small number (5) avoids the rows bleeding into the command
// prompt when pi gives the widget a small vertical slot. Sessions with more
// than 5 active workers are rare in practice; the cap suppresses the
// pathological "rows spilling below the panel" symptom that surfaced during
// planner smoke tests.
const WIDGET_ID = "hive-activity";
const MAX_AGENTS_IN_PANEL = 5;
const MAX_AGENTS_IN_LOG = 40;

function nowIso() {
  return new Date().toISOString();
}

function statusIcon(status?: AgentRuntime["status"]): string {
  if (status === "running") return "●";
  if (status === "done") return "✓";
  if (status === "error") return "✗";
  return "•";
}

function statusColorKey(status?: AgentRuntime["status"]): string {
  if (status === "running") return "accent";
  if (status === "done") return "success";
  if (status === "error") return "error";
  return "muted";
}

function formatElapsed(ms: number): string {
  if (!ms || ms < 1000) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function metaOf(runtime: AgentRuntime): string {
  const elapsed = formatElapsed(runtime.elapsedMs);
  const tools = runtime.toolCount ? `${runtime.toolCount} tools` : "";
  const parts = [elapsed, tools].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  if (runtime.status === "done") return "done";
  if (runtime.status === "error") return "error";
  return "queued";
}

function workOf(runtime: AgentRuntime): string {
  return (runtime.lastWork || runtime.task || "").trim();
}

// Render one agent row. `width` is the full panel width — no custom border,
// no MAX_BOX_WIDTH cap. truncateToWidth (visible-width aware, handles ANSI
// escapes) keeps the row inside the panel.
//
// `displaySuffix` is an optional short string appended after the name in
// dim text (e.g. `(design-planner)`). The widget passes a slug for rows whose
// display name collides with another row in the same panel, so operators can
// distinguish them at a glance. Pass empty/undefined for the common case.
function renderAgentRow(runtime: AgentRuntime, width: number, theme: any, displaySuffix?: string): string {
  const icon = statusIcon(runtime.status);
  const name = runtime.config.name || "agent";
  const suffix = displaySuffix ? theme.fg("dim", ` (${displaySuffix})`) : "";
  const meta = metaOf(runtime);
  const work = workOf(runtime);
  const head = `${icon} ${name}${suffix} — ${meta}`;
  const sep = work ? " — " : "";
  const line = `${theme.fg(statusColorKey(runtime.status), head)}${sep}${theme.fg("dim", work)}`;
  return truncateToWidth(line, width, theme.fg("dim", "…"));
}

// Build a name→count histogram over the visible panel. Used by the widget
// render to decide which rows need a slug suffix for disambiguation.
function nameHistogram(runtimes: AgentRuntime[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rt of runtimes) {
    const name = String(rt.config.name || "agent");
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return counts;
}

// Build the single-line header rendered above the panel. Layout is
// `─…─ <label> ─…─` with the label centered (modulo one extra dash on the
// right when the available space is odd) and the label themed dim. The
// count uses the *map* size (caller decides), not the visible-row count,
// so a truncated panel surfaces the real number to the operator.
function headerLine(width: number, count: number, theme: any): string {
  const DASH = "─";
  const noun = count === 1 ? "agent" : "agents";
  const label = ` Hive Activity · ${count} ${noun} `;
  if (width <= label.length) {
    // Too narrow for the dashes-and-label layout; return just the label
    // (possibly truncated) so the operator still sees what the block is.
    return truncateToWidth(label.trim(), width, theme.fg("dim", "…"));
  }
  const remaining = width - label.length;
  const leftLen = Math.floor(remaining / 2);
  const rightLen = remaining - leftLen;
  return DASH.repeat(leftLen) + theme.fg("dim", label) + DASH.repeat(rightLen);
}

// Internal helpers, exported for unit tests. Pure functions of (runtime, width).
export { renderAgentRow, statusIcon, formatElapsed, metaOf, workOf, nameHistogram, headerLine };

export function addHiveActivity(state: HiveState, entry: { ts?: string } & Record<string, unknown>) {
  if (state.mode === "normal") return;
  // Retained as a typed record so dispatch.ts's call sites stay intact; the
  // widget below no longer reads state.activityLog. The dashboard receives
  // activity through its own telemetry path (HiveEvent stream), not via this
  // log. We still bound the array so a runaway session cannot leak memory.
  state.activityLog ||= [];
  state.activityLog.push({ ...entry, ts: entry.ts || nowIso() } as never);
  if (state.activityLog.length > MAX_AGENTS_IN_LOG) {
    state.activityLog.splice(0, state.activityLog.length - MAX_AGENTS_IN_LOG);
  }
  state.activityRender?.();
}

export function updateHiveActivityWidget(state: HiveState) {
  const ctx = state.widgetCtx;
  if (!ctx || ctx.mode !== "tui") return;

  if (state.mode === "normal") {
    if (state.activityWidgetInstalled) ctx.ui.setWidget(WIDGET_ID, undefined);
    state.activityWidgetInstalled = false;
    state.activityRender = undefined;
    return;
  }

  if (state.activityWidgetInstalled) {
    state.activityRender?.();
    return;
  }

  state.activityWidgetInstalled = true;
  ctx.ui.setWidget(WIDGET_ID, (tui: any, theme: any) => {
    state.activityRender = () => tui.requestRender();
    return {
      invalidate() {},
      render(width: number): string[] {
        if (!width || width < 4) return [];
        const allRuntimes = Array.from(state.runtimes.values());
        // Surface live work first, then most-recently-spawned agents.
        const sorted = allRuntimes
          .sort((a, b) => {
            const aw = a.status === "running" ? 0 : 1;
            const bw = b.status === "running" ? 0 : 1;
            if (aw !== bw) return aw - bw;
            return (b.startedAt || 0) - (a.startedAt || 0);
          });
        // Cap the widget's row count regardless of how many agents are in the
        // map — see MAX_AGENTS_IN_PANEL comment for why this is a defensive
        // bound and not a config knob.
        const runtimes = sorted.slice(0, MAX_AGENTS_IN_PANEL);
        // Single-line border above the panel. Combines a labeled header
        // (`Hive Activity · N agents`) with the box-drawing horizontal rule
        // the user requested, so the panel is visually demarcated from chat
        // scrollback above it and the label tells operators what the block is
        // (without having to remember). The count is the *map* size, not the
        // visible row count, so a truncated panel surfaces the real number.
        const header = headerLine(width, allRuntimes.length, theme);
        if (!runtimes.length) return [header];
        // Detect duplicate display names so each colliding row can render with
        // its slug in parens. Operators see distinct rows instead of N rows that
        // all say "Design Planner" and look like a bug.
        const nameCounts = nameHistogram(runtimes);
        // Diagnostic: log once per render when the panel contains more rows
        // than the cap allows, OR when the map holds more agents than the
        // panel shows. The first indicates a cap interaction worth tuning; the
        // second indicates that callers are looking at truncated data and
        // should be aware (e.g. for `team_status` user prompts).
        if (allRuntimes.length > MAX_AGENTS_IN_PANEL && !state.activityOverflowWarned) {
          console.warn(
            `[pi-hive] activity widget: ${allRuntimes.length} runtimes in map, ` +
            `panel showing ${MAX_AGENTS_IN_PANEL}. Excess agents not visible — check ` +
            `team_status for the full roster.`,
          );
          state.activityOverflowWarned = true;
        }
        const rows = runtimes.map((rt) => {
          const name = String(rt.config.name || "agent");
          const suffix = nameCounts.get(name) && nameCounts.get(name)! > 1 ? agentSlug(rt.config) : undefined;
          return renderAgentRow(rt, width, theme, suffix);
        });
        return [header, ...rows];
      },
    };
  });
}

export function clearHiveActivityWidget(state: HiveState) {
  const ctx = state.widgetCtx;
  if (ctx?.mode === "tui") ctx.ui.setWidget(WIDGET_ID, undefined);
  state.activityWidgetInstalled = false;
  state.activityRender = undefined;
}
