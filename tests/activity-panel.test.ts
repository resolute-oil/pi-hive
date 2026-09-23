import assert from "node:assert/strict";
import { test } from "node:test";
import { formatElapsed, metaOf, nameHistogram, renderAgentRow, statusIcon, workOf } from "../src/ui/tui/activity.ts";
import type { AgentRuntime } from "../src/core/types.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

// Minimal theme stub. The widget uses theme.fg/bold to color tokens; for unit
// tests we only care that the formatter runs and produces a line whose visible
// width fits the panel.
function theme() {
  const wrap = (code: string, s: string) => `\x1b[${code}m${s}\x1b[0m`;
  return {
    fg: (name: string, s: string) => {
      const code = name === "accent" ? "33" : name === "success" ? "32" : name === "error" ? "31" : "2";
      return wrap(code, s);
    },
    bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  };
}

function runtime(partial: Partial<AgentRuntime>): AgentRuntime {
  return {
    config: { name: "operations", agentType: "coder" } as AgentRuntime["config"],
    systemPrompt: "",
    status: "idle",
    task: "",
    lastWork: "",
    toolCount: 0,
    elapsedMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    contextPct: 0,
    runCount: 0,
    sessionFile: "",
    ...partial,
  } as AgentRuntime;
}

test("statusIcon maps status to a single-glyph icon", () => {
  assert.equal(statusIcon("running"), "●");
  assert.equal(statusIcon("done"), "✓");
  assert.equal(statusIcon("error"), "✗");
  assert.equal(statusIcon(undefined), "•");
  assert.equal(statusIcon("queued"), "•");
});

test("formatElapsed rounds to seconds or minutes:seconds", () => {
  assert.equal(formatElapsed(0), "");
  assert.equal(formatElapsed(500), "");
  assert.equal(formatElapsed(1_000), "1s");
  assert.equal(formatElapsed(52_000), "52s");
  assert.equal(formatElapsed(72_000), "1m12s");
  assert.equal(formatElapsed(125_000), "2m05s");
});

test("metaOf returns elapsed + tool count, or status fallback", () => {
  assert.equal(metaOf(runtime({ status: "running", elapsedMs: 52_000, toolCount: 13 })), "52s · 13 tools");
  assert.equal(metaOf(runtime({ status: "done", elapsedMs: 12_000 })), "12s");
  assert.equal(metaOf(runtime({ status: "error", toolCount: 3 })), "3 tools");
  assert.equal(metaOf(runtime({ status: "error" })), "error");
  assert.equal(metaOf(runtime({ status: "done" })), "done");
  assert.equal(metaOf(runtime({ status: "queued" })), "queued");
});

test("workOf prefers lastWork and trims", () => {
  assert.equal(workOf(runtime({ lastWork: "  Quick read-only inspection  " })), "Quick read-only inspection");
  assert.equal(workOf(runtime({ task: "run smoke test" })), "run smoke test");
  assert.equal(workOf(runtime({})), "");
});

test("renderAgentRow fits within the requested visible width", () => {
  const rt = runtime({ status: "running", elapsedMs: 52_000, toolCount: 13, lastWork: "Quick read-only inspection" });
  const line = renderAgentRow(rt, 100, theme());
  assert.ok(visibleWidth(line) <= 100, `expected ≤ 100 cols, got ${visibleWidth(line)}`);
  assert.match(line, /operations/);
  assert.match(line, /52s/);
  assert.match(line, /13 tools/);
  assert.match(line, /Quick read-only inspection/);
});

test("renderAgentRow truncates with ellipsis when content exceeds width", () => {
  const rt = runtime({ status: "running", elapsedMs: 1_000, lastWork: "x".repeat(500) });
  const line = renderAgentRow(rt, 30, theme());
  assert.ok(visibleWidth(line) <= 30, `expected ≤ 30 cols, got ${visibleWidth(line)}`);
  // truncateToWidth ends with the visible ellipsis glyph; raw line may carry a
  // trailing ANSI reset after it, so match the dim-ellipsis ANSI sequence.
  // eslint-disable-next-line no-control-regex
  assert.match(line, /\x1b\[2m…/);
});

test("renderAgentRow emits one separator dash when work is empty", () => {
  const rt = runtime({ status: "queued", elapsedMs: 0, toolCount: 0, lastWork: "", task: "" });
  const line = renderAgentRow(rt, 200, theme());
  // One em-dash after name+meta, no trailing separator.
  const dashes = (line.match(/ — /g) || []).length;
  assert.equal(dashes, 1);
});

// ── Disambiguation suffix for duplicate display names ─────────────────────

test("renderAgentRow omits the suffix when displaySuffix is undefined", () => {
  const rt = runtime({ config: { name: "Design Planner", slug: "design-planner", agentType: "coder" } as any, status: "running", elapsedMs: 5_000 });
  const line = renderAgentRow(rt, 200, theme());
  // No parenthesised slug after the name.
  assert.doesNotMatch(line, /Design Planner \(/);
  assert.match(line, /Design Planner/);
});

test("renderAgentRow appends the suffix in dim text when displaySuffix is provided", () => {
  const rt = runtime({ config: { name: "Design Planner", slug: "design-planner-alt", agentType: "coder" } as any, status: "running", elapsedMs: 5_000 });
  const line = renderAgentRow(rt, 200, theme(), "design-planner-alt");
  // The slug appears, parenthesised, between the name and the meta dash.
  // Match the visible content (ANSI escapes around the dim suffix are fine).
  assert.match(line, /Design Planner/);
  assert.match(line, /\(design-planner-alt\)/);
});

test("renderAgentRow suffix stays inside the requested visible width when truncated", () => {
  const rt = runtime({ config: { name: "Design Planner", slug: "design-planner-alt", agentType: "coder" } as any, status: "running", elapsedMs: 5_000, lastWork: "x".repeat(500) });
  const line = renderAgentRow(rt, 30, theme(), "design-planner-alt");
  assert.ok(visibleWidth(line) <= 30, `expected ≤ 30 cols, got ${visibleWidth(line)}`);
});

// ── nameHistogram drives the duplicate-name detection ─────────────────────

test("nameHistogram returns 1 for each unique name", () => {
  const a = runtime({ config: { name: "Specs Planner" } as any });
  const b = runtime({ config: { name: "Design Planner" } as any });
  const c = runtime({ config: { name: "Tester" } as any });
  const counts = nameHistogram([a, b, c]);
  assert.equal(counts.size, 3);
  assert.equal(counts.get("Specs Planner"), 1);
  assert.equal(counts.get("Design Planner"), 1);
  assert.equal(counts.get("Tester"), 1);
});

test("nameHistogram counts duplicates so the widget can flag them", () => {
  const a = runtime({ config: { name: "Design Planner" } as any });
  const b = runtime({ config: { name: "Design Planner" } as any });
  const c = runtime({ config: { name: "Specs Planner" } as any });
  const counts = nameHistogram([a, b, c]);
  assert.equal(counts.get("Design Planner"), 2, "duplicate name counted twice");
  assert.equal(counts.get("Specs Planner"), 1);
});

test("nameHistogram falls back to 'agent' for runtimes without a name", () => {
  const a = runtime({ config: {} as any });
  const b = runtime({ config: {} as any });
  const counts = nameHistogram([a, b]);
  assert.equal(counts.get("agent"), 2);
});
