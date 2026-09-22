import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildHiveTools, registerTools } from "../src/agents/tools.ts";
import { canDelegateTo } from "../src/engine/domain.ts";
import { routeAgents } from "../src/engine/routing.ts";
import { runAsAgent } from "../src/engine/session.ts";
import type { AgentType, HiveState } from "../src/core/types.ts";

function runtime(dir: string, name: string, overrides: Record<string, any> = {}): any {
  return {
    config: {
      name, slug: name.toLowerCase(), path: `${name}.md`, role: "member", agentType: "coder",
      groupName: "Engineering", routingTags: [], domain: [], allowedAgents: [], ...overrides.config,
    },
    systemPrompt: "", status: "idle", task: "", lastWork: "", toolCount: 0, elapsedMs: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    costUsd: 0, contextPct: 0, runCount: 0, sessionFile: join(dir, `${name}.jsonl`),
    ...overrides,
  };
}

function toolState(dir: string): any {
  const rows = [
    runtime(dir, "Tiny", { contextPct: Number.NaN, contextWindow: Number.NaN, inputTokens: 20, outputTokens: 5 }),
    runtime(dir, "Warm", { contextPct: 76, contextWindow: 8_000, inputTokens: 1_000, outputTokens: 1_000 }),
    runtime(dir, "Full", { contextPct: 86, contextTokens: 5_000_000, contextWindow: 20_000_000, inputTokens: 20_000, outputTokens: 40_000, task: "working" }),
  ];
  return {
    pi: {}, mode: "hive", activeRuns: 2, workerQueue: [{}, {}], activeChangeId: undefined,
    config: {
      orchestrator: { name: "Orchestrator", path: "o.md", role: "orchestrator", allowedAgents: rows.map((r) => r.config.slug) },
      agents: rows.map((r) => r.config), sharedContext: [],
      settings: { subagentOutputLimit: 100, defaultTools: "read", maxParallel: 3, distiller: { enabled: false, model: "", conversationLines: 10 } },
    },
    session: { sessionId: "s1", sessionDir: dir, conversationLog: join(dir, "conversation.jsonl"), observabilityLog: join(dir, "events.jsonl") },
    runtimes: new Map(rows.map((row) => [row.config.slug, row])),
    latestVerdicts: new Map([
      ["red", { changeId: "red", reviewer: "R", verdict: "red", blockers: ["b"], concerns: [], summary: "blocked" }],
      ["yellow", { changeId: "yellow", reviewer: "R", verdict: "yellow", blockers: [], concerns: ["c"], summary: "concern" }],
      ["green", { changeId: "green", reviewer: "R", verdict: "green", blockers: [], concerns: [], summary: "clean" }],
    ]),
  };
}

const theme = {
  fg: (_color: string, value: string) => value,
  bold: (value: string) => value,
};

test("team status formats sparse context, budgets, queues, and verdict variants", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-tools-status-"));
  const state = toolState(dir);
  const tools = buildHiveTools(state, "Orchestrator") as any[];
  const status = tools.find((tool) => tool.name === "team_status");
  const result = await status.execute("id", {});
  const text = result.content[0].text;
  assert.match(text, /active_runs: 2/);
  assert.match(text, /queued_runs: 2/);
  assert.match(text, /resume-ok/);
  assert.match(text, /consider-fresh/);
  assert.match(text, /fresh-recommended/);
  assert.match(text, /1 blocker/);
  assert.match(text, /1 concern/);
  assert.equal(result.details.agents.length, 3);

  state.session = undefined;
  state.workerQueue = undefined;
  state.latestVerdicts = new Map();
  const empty = await status.execute("id", {});
  assert.match(empty.content[0].text, /session: not initialized/);
  assert.match(empty.content[0].text, /queued_runs: 0/);
});

test("team conversation rejects unsafe scopes and bounds known transcripts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-tools-conversation-"));
  const state = toolState(dir);
  const tool = (buildHiveTools(state, "Orchestrator") as any[]).find((entry) => entry.name === "team_conversation");

  const session = state.session;
  state.session = undefined;
  assert.match((await tool.execute("id", { agent: "Tiny" })).content[0].text, /not initialized/);
  state.session = session;
  assert.equal((await tool.execute("id", { lines: Number.NaN })).details.ok, false);
  assert.match((await tool.execute("id", { agent: "missing", lines: -1 })).content[0].text, /Unknown agent/);
  assert.match((await tool.execute("id", { agent: "Tiny", lines: 5 })).content[0].text, /no session transcript/);

  const tiny = state.runtimes.get("tiny");
  writeFileSync(tiny.sessionFile, Array.from({ length: 20 }, (_, i) => JSON.stringify({ i })).join("\n"));
  const result = await tool.execute("id", { agent: "tiny", lines: 50_000 });
  assert.equal(result.details.ok, true);
  assert.equal(result.details.lines, 1_000);
  assert.ok(result.content[0].text.length <= 100);
});

test("tool renderers remain bounded for partial, expanded, success, and error states", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-tools-render-"));
  const state = toolState(dir);
  const delegate = (buildHiveTools(state, "Orchestrator") as any[]).find((tool) => tool.name === "delegate_agent");

  // delegate_agent renders the prompt across multiple rows (header + one
  // per newline-separated line) and truncates each row to the terminal
  // width via truncateToWidth(). The width-aware truncation is mandatory:
  // pi's TUI throws uncaughtException when a rendered line exceeds the
  // visible width, so unbounded lines (e.g. a 2809-char smoke-test prompt
  // on a 136-col terminal) would crash the session.
  const headerOnly = delegate.renderCall({}, theme).render(80);
  assert.equal(headerOnly.length, 1);
  assert.match(headerOnly[0], /delegate_agent/);
  const withTask = delegate.renderCall({ agent: "Tiny", task: "inspect" }, theme).render(80);
  assert.equal(withTask.length, 2);
  assert.match(withTask[0], /delegate_agent/);
  assert.match(withTask[0], /Tiny/);
  assert.equal(withTask[1], "inspect");
  const multiLine = delegate.renderCall(
    { agent: "Tiny", task: "line one\nline two\nline three" },
    theme,
  ).render(80);
  assert.deepEqual(multiLine, [withTask[0], "line one", "line two", "line three"]);
  // Regression guard for the original crash: a very long single-line task
  // (the smoke-test failure had ~2809 chars) must be truncated to fit the
  // terminal width, not rendered at full length. visibleWidth() accounts for
  // ANSI escape codes (theme.fg wraps the line in color codes that don't
  // count toward terminal columns), so use it for the contract check.
  const longTask = "x".repeat(2809);
  const longRender = delegate.renderCall({ agent: "Tiny", task: longTask }, theme).render(136);
  assert.equal(longRender.length, 2);
  for (const line of longRender) {
    assert.ok(visibleWidth(line) <= 136, `line exceeds width 136: vis=${visibleWidth(line)}`);
  }
  assert.deepEqual(delegate.renderResult({ details: { status: "running" } }, { isPartial: true }, theme).render(80), []);
  assert.equal(delegate.renderResult({ details: { agent: "Tiny", status: "done", elapsed: 1_500, outputPreview: "ok" } }, { expanded: true }, theme).render(80).length, 2);
  assert.equal(delegate.renderResult({ details: { agent: "missing", status: "error" } }, {}, theme).render(80).length, 1);
});

test("routing handles empty matches and registerTools exposes every base tool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-tools-route-"));
  const state = toolState(dir);
  const route = (buildHiveTools(state, "Orchestrator") as any[]).find((tool) => tool.name === "route_agent");
  const noMatch = await route.execute("id", { task: "zz", limit: Number.POSITIVE_INFINITY });
  assert.match(noMatch.content[0].text, /No strong route found/);
  const match = await route.execute("id", { task: "implement engineering code", limit: 2.9 });
  assert.ok(match.details.recommendations.length > 0);
  assert.ok(match.details.recommendations.length <= 2);

  const registered: string[] = [];
  registerTools({ registerTool(tool: any) { registered.push(tool.name); } } as any, state);
  assert.ok(registered.includes("delegate_agent"));
  assert.ok(registered.includes("plan_new"));
});

// --- T6/T7: orchestrator delegation widening surfaces typed specialists ---
// With the orchestrator's allowedAgents restricted to a single slug, the
// other coder-typed workers should still be reachable via the new
// agent-type widening in canDelegateTo (and therefore in routeAgents).

test("canDelegateTo widens to a non-direct-report coder when orchestrator allowedAgents is restricted", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-tools-can-"));
  // Build a fixture that mirrors the domain-routing.test.ts style: the
  // orchestrator IS in state.runtimes so canDelegateTo's caller resolution
  // finds it. toolState() leaves the orchestrator in state.config only,
  // which is why this test does not use that helper.
  const worker = (name: string, agentType: AgentType, role: "lead" | "member" = "member", configOverrides: any = {}): any => ({
    config: {
      name, slug: name.toLowerCase(), path: `${name}.md`, role, agentType,
      groupName: "Engineering", routingTags: [], domain: [], allowedAgents: [], ...configOverrides,
    },
    systemPrompt: "", status: "idle", task: "", lastWork: "", toolCount: 0, elapsedMs: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    costUsd: 0, contextPct: 0, runCount: 0, sessionFile: join(dir, `${name}.jsonl`),
  });
  const orchestrator = worker("Orchestrator", "lead", "orchestrator" as any, { allowedAgents: ["tiny"] });
  const tiny = worker("Tiny", "coder");
  const warm = worker("Warm", "coder");
  const full = worker("Full", "coder");
  const state: HiveState = {
    pi: {} as any,
    config: null,
    session: null,
    runtimes: new Map([["orchestrator", orchestrator], ["tiny", tiny], ["warm", warm], ["full", full]]),
    widgetCtx: null,
    activeRuns: 0,
    mode: "hive",
    normalToolNames: [],
    sddStatus: null,
    obsSeq: 0,
  };
  runAsAgent("Orchestrator", () => {
    assert.deepEqual(canDelegateTo(state, "Orchestrator", "Warm"), { ok: true });
    assert.deepEqual(canDelegateTo(state, "Orchestrator", "Full"), { ok: true });
    // Re-typing warm as a lead should NOT widen — lead stays tree-bound.
    warm.config.agentType = "lead";
    assert.equal(canDelegateTo(state, "Orchestrator", "warm").ok, false);
  });
});

test("routeAgents surfaces typed specialists not in the orchestrator's allowedAgents", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-tools-route-widen-"));
  const worker = (name: string, agentType: AgentType, role: "lead" | "member" = "member", configOverrides: any = {}): any => ({
    config: {
      name, slug: name.toLowerCase(), path: `${name}.md`, role, agentType,
      groupName: "Engineering", routingTags: [], domain: [], allowedAgents: [], ...configOverrides,
    },
    systemPrompt: "", status: "idle", task: "", lastWork: "", toolCount: 0, elapsedMs: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    costUsd: 0, contextPct: 0, runCount: 0, sessionFile: join(dir, `${name}.jsonl`),
  });
  const orchestrator = worker("Orchestrator", "lead", "orchestrator" as any, { allowedAgents: ["tiny"] });
  const tiny = worker("Tiny", "coder", "member", { routingTags: ["tiny-tag"] });
  const warm = worker("Warm", "coder", "member", { routingTags: ["react"] });
  const full = worker("Full", "coder", "member", { routingTags: ["react"] });
  const state: HiveState = {
    pi: {} as any,
    config: null,
    session: null,
    runtimes: new Map([["orchestrator", orchestrator], ["tiny", tiny], ["warm", warm], ["full", full]]),
    widgetCtx: null,
    activeRuns: 0,
    mode: "hive",
    normalToolNames: [],
    sddStatus: null,
    obsSeq: 0,
  };
  runAsAgent("Orchestrator", () => {
    const matches = routeAgents(state, "react component", 5);
    const slugs = matches.map((m) => m.slug);
    // warm and full carry the "react" routing tag; tiny does not. All three
    // are reachable via the widening (they're typed coder), so the route
    // surfaces all of them. warm and full should rank above tiny because
    // the tag bonus (+8) outweighs the coder-type bonus alone (+3).
    assert.ok(slugs.includes("warm"), `expected warm in widened route: got ${slugs.join(",")}`);
    assert.ok(slugs.includes("full"), `expected full in widened route: got ${slugs.join(",")}`);
    const warmIdx = slugs.indexOf("warm");
    const fullIdx = slugs.indexOf("full");
    const tinyIdx = slugs.indexOf("tiny");
    assert.ok(warmIdx < tinyIdx, `expected warm (${warmIdx}) ranked above tiny (${tinyIdx}): ${slugs.join(",")}`);
    assert.ok(fullIdx < tinyIdx, `expected full (${fullIdx}) ranked above tiny (${tinyIdx}): ${slugs.join(",")}`);
  });
});
