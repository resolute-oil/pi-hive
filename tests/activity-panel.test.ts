import assert from "node:assert/strict";
import { test } from "node:test";
import { formatElapsed, metaOf, renderAgentRow, statusIcon, workOf } from "../src/ui/tui/activity.ts";
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
