import type { AgentRuntime, HiveState } from "../../core/types";
import { truncateToWidth } from "@earendil-works/pi-tui";

// Widget id and size caps. The widget is a normal full-width pi panel — one
// line per agent — so it does not draw its own border frame. The previous
// implementation used box-drawing characters capped at MAX_BOX_WIDTH = 88,
// which overflowed the widget area on every addHiveActivity() re-render and
// interleaved with chat scrollback. The dashboard still ingests the activity
// log through its own telemetry path; this widget only surfaces live agent
// statuses, which is what an operator wants to see at a glance.
const WIDGET_ID = "hive-activity";
const MAX_AGENTS_IN_PANEL = 12;
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
function renderAgentRow(runtime: AgentRuntime, width: number, theme: any): string {
  const icon = statusIcon(runtime.status);
  const name = runtime.config.name || "agent";
  const meta = metaOf(runtime);
  const work = workOf(runtime);
  const head = `${icon} ${name} — ${meta}`;
  const sep = work ? " — " : "";
  const line = `${theme.fg(statusColorKey(runtime.status), head)}${sep}${theme.fg("dim", work)}`;
  return truncateToWidth(line, width, theme.fg("dim", "…"));
}

// Internal helpers, exported for unit tests. Pure functions of (runtime, width).
export { renderAgentRow, statusIcon, formatElapsed, metaOf, workOf };

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
        const runtimes = Array.from(state.runtimes.values())
          // Surface live work first, then most-recently-spawned agents.
          .sort((a, b) => {
            const aw = a.status === "running" ? 0 : 1;
            const bw = b.status === "running" ? 0 : 1;
            if (aw !== bw) return aw - bw;
            return (b.startedAt || 0) - (a.startedAt || 0);
          })
          .slice(0, MAX_AGENTS_IN_PANEL);
        if (!runtimes.length) return [];
        return runtimes.map((rt) => renderAgentRow(rt, width, theme));
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
