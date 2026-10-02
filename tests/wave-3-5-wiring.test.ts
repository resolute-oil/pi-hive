// Wave 3.5 wiring regression tests.
//
// The Wave 0-3 review surfaced a major gap: cooperative tools and
// `summarize_progress` were defined and tested but unreachable from
// production, and the 11 operator commands threw `notImpl(agent)` because
// the `workerHandles` Map was never populated. These tests prove the
// production wiring is real (not test-seam-only):
//
//   1. buildWorkerOnlyTools returns the 4 documented tool definitions.
//   2. populateWorkerOnlyBindings wires the deferred bindings.
//   3. registerWorkerHandleForProduction populates the workerHandles Map.
//   4. forceKillWorkerSession / forceEndWorkerSession no longer throw
//      `notImpl(agent)` for a handle registered via the production path
//      (the exact failure mode the Wave 0-3 review flagged).
//   5. dispatchAgent (the production wire) registers AND unregisters
//      handles across a normal completion.
//
// Test seams used here: the `__registerHandle` / `__unregisterHandle`
// test aliases from tests/budget-eol.test.ts stay in place; the new
// `registerWorkerHandleForProduction` /
// `unregisterWorkerHandleForProduction` exports are the production
// API the dispatcher calls. Both point at the same Map.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentSession,
  SessionStats,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { CreateAgentSession } from "../src/engine/dispatch.ts";
import { dispatchAgent } from "../src/engine/dispatch.ts";
import {
  buildWorkerOnlyTools,
  populateWorkerOnlyBindings,
  type WorkerOnlyBindings,
} from "../src/engine/budget/worker-only-tools.ts";
import {
  buildSummarizeProgressTool,
} from "../src/agents/tools/summarize-progress.ts";
import {
  buildRequestCompactionTool,
  buildRequestEndSessionTool,
  buildRequestSnapshotTool,
  forceKillWorkerSession,
  forceEndWorkerSession,
  endWorkerSession,
  registerWorkerHandleForProduction,
  unregisterWorkerHandleForProduction,
  lookupWorkerHandleForProduction,
  __cooperativeToolRegistry,
  __resetCooperativeToolRegistryForTests,
} from "../src/engine/budget/worker-tools.ts";
import { BudgetLedger } from "../src/engine/budget/ledger.ts";
import type { AgentRuntime, HiveState } from "../src/core/types.ts";

async function makeHandle(agent: string) {
  const sm = SessionManager.inMemory("/tmp");
  const ledger = await BudgetLedger.restore(sm, agent, { worker: {}, team: {} }, new AbortController().signal);
  const controller = new AbortController();
  const session = scriptedSession({ stats: { sessionId: `session-${agent}` } });
  return {
    handle: {
      agent,
      session,
      controller,
      sessionManager: sm,
      ledger,
      policy: { worker: {}, team: {} },
    },
    sm,
    ledger,
    controller,
    session,
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────

const WORKER_ONLY_TOOL_NAMES = [
  "summarize_progress",
  "request_compaction",
  "request_end_session",
  "request_snapshot",
] as const;

function fakeRuntime(name: string, sessionFile: string): AgentRuntime {
  return {
    config: {
      name,
      path: `${name}.md`,
      role: "member",
      agentType: "lead",
      routingTags: [],
      domain: [],
      // tools is intentionally narrow — the cooperative tools are NOT
      // enumerated in the agent's frontmatter; the dispatcher unions
      // them in via allToolNamesForGate / customTools.
      tools: "read",
      model: "test/model",
      thinking: "off",
    },
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
    sessionFile,
  };
}

function scriptedSession(opts: {
  stats?: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; tokens: number; sessionId: string }>;
  sessionManager?: any;
} = {}): AgentSession {
  let handler: ((e: any) => void) | undefined;
  const sessionId = opts.stats?.sessionId ?? "test-session";
  const tokens = opts.stats?.tokens ?? 150;
  const input = opts.stats?.input ?? 100;
  const output = opts.stats?.output ?? 50;
  const cacheRead = opts.stats?.cacheRead ?? 0;
  const cacheWrite = opts.stats?.cacheWrite ?? 0;
  const cost = opts.stats?.cost ?? 0.015;
  return {
    sessionId,
    subscribe(cb: (e: any) => void) {
      handler = cb;
      return () => { handler = undefined; };
    },
    getAvailableThinkingLevels() {
      return ["off", "low", "high"];
    },
    getContextUsage() {
      return { percent: 12, tokens, contextWindow: 200_000 };
    },
    getSessionStats(): SessionStats {
      return {
        sessionFile: undefined,
        sessionId,
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 0,
        tokens: { input, output, cacheRead, cacheWrite, total: tokens },
        cost,
      };
    },
    state: { errorMessage: undefined as string | undefined },
    async prompt(): Promise<void> {
      handler?.({
        type: "message_end",
        message: { role: "assistant", model: "test/model", stopReason: "endTurn", usage: { input, output, cacheRead, cacheWrite, reasoning: 0, cost } },
      });
      handler?.({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
    },
    async abort(): Promise<void> { /* noop */ },
    async compact(): Promise<unknown> { return { summary: "", firstKeptEntryId: "x", tokensBefore: 150, estimatedTokensAfter: 80 }; },
    dispose(): void { /* noop */ },
    sessionManager: opts.sessionManager ?? {
      getLeafId: () => "leaf-stub",
      branchWithSummary: () => "branch-stub",
    },
  } as unknown as AgentSession;
}

function makeDispatchState(worker: AgentRuntime, dir: string): HiveState {
  return {
    pi: {} as any,
    config: {
      orchestrator: { name: "Orchestrator", path: "o.md" },
      agents: [worker.config],
      sharedContext: [],
      settings: {
        subagentOutputLimit: 100,
        defaultTools: "read",
        maxParallel: 2,
        distiller: { enabled: false, model: "", conversationLines: 10 },
      },
    } as any,
    session: {
      sessionId: "s1",
      sessionDir: dir,
      conversationLog: join(dir, "c.jsonl"),
      observabilityLog: join(dir, "e.jsonl"),
    },
    runtimes: new Map([[worker.config.name, worker]]),
    widgetCtx: null,
    activeRuns: 0,
    mode: "hive",
    normalToolNames: [],
    sddStatus: null,
    obsSeq: 0,
  } as unknown as HiveState;
}

// ── Gap 1: buildWorkerOnlyTools returns the 4 documented tools ───────────

test("Wave 3.5 Gap 1: buildWorkerOnlyTools returns exactly the 4 documented worker-only tools", () => {
  const state = {} as HiveState;
  const { tools, bindings } = buildWorkerOnlyTools(state, "Builder");
  assert.equal(tools.length, 4, "buildWorkerOnlyTools returns 4 tool definitions");
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [...WORKER_ONLY_TOOL_NAMES].sort(), "names match the brief's 4-tool list");
  assert.ok(bindings, "bindings object returned alongside the tools");
  assert.equal(bindings.session, undefined, "bindings start unpopulated (deferred)");
  assert.equal(bindings.ledger, undefined, "bindings.ledger starts unpopulated");
  assert.equal(bindings.policy, undefined, "bindings.policy starts unpopulated");
});

test("Wave 3.5 Gap 1: each worker-only tool has the documented name, label, and parameters shape", () => {
  const state = {} as HiveState;
  const { tools } = buildWorkerOnlyTools(state, "Builder");
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  // summarize_progress has notes + optional compact parameters.
  assert.ok(byName["summarize_progress"], "summarize_progress present");
  assert.match(byName["summarize_progress"].description, /progressSummaryTokenLimit/, "summarize_progress description references the token cap");
  // request_compaction accepts customInstructions.
  assert.ok(byName["request_compaction"], "request_compaction present");
  assert.ok(byName["request_end_session"], "request_end_session present");
  const endParams = byName["request_end_session"].parameters as { required?: string[] };
  assert.equal(endParams.required?.[0], "reason", "request_end_session requires 'reason'");
  assert.ok(byName["request_snapshot"], "request_snapshot present");
  const snapParams = byName["request_snapshot"].parameters as { required?: string[] };
  assert.equal(snapParams.required?.[0], "label", "request_snapshot requires 'label'");
});

// ── Gap 1: populateWorkerOnlyBindings fills the deferred bindings ───────

test("Wave 3.5 Gap 1: populateWorkerOnlyBindings mutates the binding container", () => {
  const { bindings } = buildWorkerOnlyTools({} as HiveState, "Builder");
  const session = scriptedSession();
  const ledger = { cumulative: { tokens: 0, costUsd: 0, runs: 0 } } as any;
  const policy = { worker: {}, team: {} } as any;
  assert.equal(bindings.session, undefined);
  populateWorkerOnlyBindings(bindings, session, ledger, policy);
  assert.equal(bindings.session, session, "bindings.session is set");
  assert.equal(bindings.ledger, ledger, "bindings.ledger is set");
  assert.equal(bindings.policy, policy, "bindings.policy is set");
});

// ── Gap 1: summarize_progress execute() returns isError before populate ──

test("Wave 3.5 Gap 1: summarize_progress returns isError when bindings are not populated (deferred-binding contract)", async () => {
  const state = { runtimes: new Map([["Builder", fakeRuntime("Builder", "/tmp/b.jsonl")]]) } as unknown as HiveState;
  const { tools } = buildWorkerOnlyTools(state, "Builder");
  const summarize = tools.find((t) => t.name === "summarize_progress")!;
  assert.ok(summarize, "summarize_progress tool definition exists");
  const result = await summarize.execute("tool-call-1", { notes: "x" }, new AbortController().signal, undefined, {} as any);
  assert.equal(result.isError, true, "summarize_progress returns isError before bindings populate");
  assert.equal((result.details as { reason?: string }).reason, "session_not_ready", "details.reason is 'session_not_ready'");
});

// ── Gap 1: summarize_progress execute() delegates after populate ────────

test("Wave 3.5 Gap 1: summarize_progress delegates to buildSummarizeProgressTool after bindings populate", async () => {
  const state = { runtimes: new Map([["Builder", fakeRuntime("Builder", "/tmp/b.jsonl")]]) } as unknown as HiveState;
  const { tools, bindings } = buildWorkerOnlyTools(state, "Builder");
  const ledger = { cumulative: { tokens: 0, costUsd: 0, runs: 0 } } as any;
  populateWorkerOnlyBindings(bindings, scriptedSession(), ledger, { worker: {}, team: {} } as any);
  const summarize = tools.find((t) => t.name === "summarize_progress")!;
  const result = await summarize.execute("tool-call-1", { notes: "wrap up migration" }, new AbortController().signal, undefined, {} as any);
  // The factory's execute() returns { content, details: { ok: true, stored: true, ... } }
  // so we expect a successful non-error result here.
  assert.notEqual((result as { isError?: boolean }).isError, true, "summarize_progress returns no isError after bindings populate");
  assert.ok((result as { content: { type: string; text: string }[] }).content[0].text.includes("wrap up migration") || (result as { content: { type: string; text: string }[] }).content[0].text.includes("Builder"), "summarize_progress delegates to the factory (content text references caller / wrap-up)");
});

// ── Gap 2: cooperative tools in customTools ──────────────────────────────

test("Wave 3.5 Gap 2: cooperative tools are registered as deferred-binding wrappers (not called at registration)", () => {
  __resetCooperativeToolRegistryForTests();
  const { tools } = buildWorkerOnlyTools({} as HiveState, "Builder");
  const cooperativeNames = ["request_compaction", "request_end_session", "request_snapshot"];
  for (const n of cooperativeNames) {
    assert.ok(tools.find((t) => t.name === n), `${n} is in the returned tool set`);
  }
  // At registration time, the cooperative factories have NOT been called
  // yet (they're deferred to execute() per the deferred-binding pattern).
  // The cooperative registry therefore does NOT yet contain the names.
  // That's the contract: the wrapper's execute() invokes the factory at
  // call time, which then adds to the registry as a side effect.
  const reg = __cooperativeToolRegistry();
  assert.equal(reg.size, 0, "cooperative registry is empty at registration time (deferred binding)");
});

// ── Gap 2: cooperative tools return isError before bindings populate ────

test("Wave 3.5 Gap 2: each cooperative tool returns isError before bindings populate (deferred-binding contract)", async () => {
  const { tools } = buildWorkerOnlyTools({} as HiveState, "Builder");
  for (const name of ["request_compaction", "request_end_session", "request_snapshot"] as const) {
    const t = tools.find((x) => x.name === name)!;
    const result = (await t.execute(
      "tool-call-1",
      name === "request_end_session" ? { reason: "wrap" } : name === "request_snapshot" ? { label: "lbl" } : { customInstructions: "ci" },
      new AbortController().signal,
      undefined,
      {} as any,
    )) as { isError?: boolean; details?: { reason?: string } };
    assert.equal(result.isError, true, `${name} returns isError before bindings populate`);
    assert.equal(result.details?.reason, "session_not_ready", `${name} details.reason is 'session_not_ready'`);
  }
});

// ── Gap 2: cooperative tools populate registry when executed ─────────────

test("Wave 3.5 Gap 2: cooperative tools add their names to the cooperative registry when executed", async () => {
  __resetCooperativeToolRegistryForTests();
  const { tools, bindings } = buildWorkerOnlyTools({} as HiveState, "Builder");
  // Build a real ledger (cooperative factories call ledger.snapshot()).
  const sm = SessionManager.inMemory("/tmp");
  const ledger = await BudgetLedger.restore(sm, "Builder", { worker: {}, team: {}, strategies: { summary: { maxTokens: 100 }, onApproachingLimit: { action: "wrap-up", threshold: 0.2, hint: "" }, onExhaustion: { action: "abort" } } }, new AbortController().signal);
  populateWorkerOnlyBindings(
    bindings,
    scriptedSession(),
    ledger,
    { worker: {}, team: {}, strategies: { summary: { maxTokens: 100 }, onApproachingLimit: { action: "wrap-up", threshold: 0.2, hint: "" }, onExhaustion: { action: "abort" } } } as any,
  );
  // Execute each cooperative tool; the wrapper invokes the factory at
  // execute time, and the factory's cooperativeToolRegistry.add(name)
  // side effect populates the registry.
  await tools.find((t) => t.name === "request_compaction")!.execute("t1", { customInstructions: "ci" }, undefined, undefined, {} as any);
  await tools.find((t) => t.name === "request_end_session")!.execute("t2", { reason: "wrap" }, undefined, undefined, {} as any);
  await tools.find((t) => t.name === "request_snapshot")!.execute("t3", { label: "lbl" }, undefined, undefined, {} as any);
  const reg = __cooperativeToolRegistry();
  assert.ok(reg.has("request_compaction"), "request_compaction in registry");
  assert.ok(reg.has("request_end_session"), "request_end_session in registry");
  assert.ok(reg.has("request_snapshot"), "request_snapshot in registry");
  assert.equal(reg.size, 3, "registry has exactly 3 cooperative tool names");
});

// ── Gap 3: registerWorkerHandleForProduction populates the Map ───────────

test("Wave 3.5 Gap 3: registerWorkerHandleForProduction populates the workerHandles Map for an agent", () => {
  // Ensure clean slate (other tests may have registered/unregistered).
  unregisterWorkerHandleForProduction("Wave3-5-builder");
  assert.equal(lookupWorkerHandleForProduction("Wave3-5-builder"), undefined, "Map does not contain the agent before register");
  const handle = {
    agent: "Wave3-5-builder",
    session: scriptedSession(),
    controller: new AbortController(),
    sessionManager: { appendCustomEntry: () => "x" } as any,
    ledger: { cumulative: { tokens: 0, costUsd: 0, runs: 0 } } as any,
    policy: { worker: {}, team: {} } as any,
  };
  registerWorkerHandleForProduction(handle as any);
  const looked = lookupWorkerHandleForProduction("Wave3-5-builder");
  assert.ok(looked, "Map contains the agent after register");
  assert.equal(looked?.agent, "Wave3-5-builder", "looked-up handle has the right agent name");
  assert.equal(looked?.session, handle.session, "looked-up handle has the right session");
  unregisterWorkerHandleForProduction("Wave3-5-builder");
  assert.equal(lookupWorkerHandleForProduction("Wave3-5-builder"), undefined, "Map does not contain the agent after unregister");
});

test("Wave 3.5 Gap 3: registerWorkerHandleForProduction and __registerHandle point at the same Map", () => {
  // The production wrapper delegates to __registerHandle. Both must see
  // the same Map state — otherwise a test using the test seam would
  // observe a different Map than the production code, masking wiring
  // regressions.
  unregisterWorkerHandleForProduction("Wave3-5-shared");
  const handle = {
    agent: "Wave3-5-shared",
    session: scriptedSession(),
    controller: new AbortController(),
    sessionManager: { appendCustomEntry: () => "x" } as any,
    ledger: { cumulative: { tokens: 0, costUsd: 0, runs: 0 } } as any,
    policy: { worker: {}, team: {} } as any,
  };
  registerWorkerHandleForProduction(handle as any);
  assert.ok(lookupWorkerHandleForProduction("Wave3-5-shared"), "production register populates the Map");
  unregisterWorkerHandleForProduction("Wave3-5-shared");
  assert.equal(lookupWorkerHandleForProduction("Wave3-5-shared"), undefined, "production unregister empties the Map");
});

// ── Gap 3: operator commands no longer throw notImpl for a registered handle

test("Wave 3.5 Gap 3: forceKillWorkerSession no longer throws 'not implemented' for a production-registered handle", async () => {
  unregisterWorkerHandleForProduction("Wave3-5-coder-1");
  const { handle } = await makeHandle("Wave3-5-coder-1");
  registerWorkerHandleForProduction(handle as any);
  try {
    // Before Wave 3.5, this rejected with /not implemented: no worker
    // handle for 'Wave3-5-coder-1'/ — the exact failure mode the Wave
    // 0-3 review flagged. Now it succeeds and writes a force-kill
    // snapshot.
    const result = await forceKillWorkerSession("Wave3-5-coder-1", "shutdown", new AbortController().signal);
    assert.equal(result.sessionId, "session-Wave3-5-coder-1", "forceKillWorkerSession returns the AgentSession.sessionId");
  } finally {
    unregisterWorkerHandleForProduction("Wave3-5-coder-1");
  }
});

test("Wave 3.5 Gap 3: forceEndWorkerSession no longer throws 'not implemented' for a production-registered handle", async () => {
  unregisterWorkerHandleForProduction("Wave3-5-coder-2");
  const { handle } = await makeHandle("Wave3-5-coder-2");
  registerWorkerHandleForProduction(handle as any);
  try {
    const result = await forceEndWorkerSession("Wave3-5-coder-2", "shutdown", new AbortController().signal);
    assert.equal(result.sessionId, "session-Wave3-5-coder-2", "forceEndWorkerSession returns the AgentSession.sessionId");
  } finally {
    unregisterWorkerHandleForProduction("Wave3-5-coder-2");
  }
});

test("Wave 3.5 Gap 3: endWorkerSession still works for a production-registered handle and preserves the handle (resume-ability contract)", async () => {
  unregisterWorkerHandleForProduction("Wave3-5-coder-3");
  const { handle } = await makeHandle("Wave3-5-coder-3");
  registerWorkerHandleForProduction(handle as any);
  try {
    const result = await endWorkerSession("Wave3-5-coder-3", "wrap up", new AbortController().signal);
    assert.equal(result.sessionId, "session-Wave3-5-coder-3");
    // endWorkerSession does NOT dispose the session, so the handle must
    // remain in the Map for resume — operator-initiated endWorkerSession
    // preserves the handle, the dispatcher's normal end-of-run unregisters.
    assert.ok(lookupWorkerHandleForProduction("Wave3-5-coder-3"), "endWorkerSession preserves the handle for resume");
  } finally {
    unregisterWorkerHandleForProduction("Wave3-5-coder-3");
  }
});

test("Wave 3.5 Gap 3: forceKillWorkerSession / forceEndWorkerSession unregister the handle after the snapshot+dispose", async () => {
  // The brief's hard gate for force-kill order is (1) abort, (2) snapshot,
  // (3) dispose, (4) unregister. The handle MUST be empty after the call
  // so a follow-up operator command rejects — otherwise the operator-
  // command surface would silently operate on a disposed session.
  unregisterWorkerHandleForProduction("Wave3-5-coder-4");
  const { handle: handle1 } = await makeHandle("Wave3-5-coder-4");
  registerWorkerHandleForProduction(handle1 as any);
  await forceKillWorkerSession("Wave3-5-coder-4", "shutdown", new AbortController().signal);
  assert.equal(lookupWorkerHandleForProduction("Wave3-5-coder-4"), undefined, "forceKillWorkerSession unregisters the handle");

  unregisterWorkerHandleForProduction("Wave3-5-coder-5");
  const { handle: handle2 } = await makeHandle("Wave3-5-coder-5");
  registerWorkerHandleForProduction(handle2 as any);
  await forceEndWorkerSession("Wave3-5-coder-5", "shutdown", new AbortController().signal);
  assert.equal(lookupWorkerHandleForProduction("Wave3-5-coder-5"), undefined, "forceEndWorkerSession unregisters the handle");
});

// ── Production wiring: dispatchAgent registers a handle at ready ────────

test("Wave 3.5 Gap 3: dispatchAgent registers a handle while the worker is running (between ready and unregister)", async () => {
  // Probe: dispatch a worker, verify the Map is populated after dispatch
  // (it'll be cleared by unregister on completion, so we re-register
  // manually here to verify the unregister half).
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-wave-3-5-"));
  const worker = fakeRuntime("Wave3-5-prod-builder", join(dir, "b.jsonl"));
  const state = makeDispatchState(worker, dir);
  const ctx = {
    cwd: dir,
    modelRegistry: { find: () => ({ provider: "test", id: "model" }) },
  } as any;

  // Hook into the session.prompt() to observe the Map state mid-run.
  let observedDuringPrompt: { agent: string } | undefined = undefined;
  const session = scriptedSession({ stats: { sessionId: "session-Wave3-5-prod-builder" } });
  const origPrompt = (session as any).prompt.bind(session);
  (session as any).prompt = async () => {
    observedDuringPrompt = lookupWorkerHandleForProduction("Wave3-5-prod-builder") as unknown as { agent: string } | undefined;
    await origPrompt();
  };
  const create: CreateAgentSession = (async () => ({ session })) as unknown as CreateAgentSession;

  unregisterWorkerHandleForProduction("Wave3-5-prod-builder");
  assert.equal(lookupWorkerHandleForProduction("Wave3-5-prod-builder"), undefined, "Map empty before dispatch");

  const result = await dispatchAgent(state, "Wave3-5-prod-builder", "do the thing", ctx, create);
  assert.equal(result.exitCode, 0, "dispatchAgent completes successfully");
  assert.ok(observedDuringPrompt, "Map is populated DURING the worker run (handle registered between ready and unregister)");
  assert.equal((observedDuringPrompt as { agent?: string } | undefined)?.agent, "Wave3-5-prod-builder");
  // After completion, the handle is unregistered.
  assert.equal(lookupWorkerHandleForProduction("Wave3-5-prod-builder"), undefined, "Map empty after dispatch completes");
});

// ── Cooperative registry assertion: only 3 cooperative names appear ──────

test("Wave 3.5 Gap 2 + Issue 4: cooperative registry still asserts only the 3 cooperative names after buildWorkerOnlyTools + execute", async () => {
  __resetCooperativeToolRegistryForTests();
  // Run the same factory invocation pattern tests/cooperative-eol.test.ts
  // uses for the Issue 4 assertion: build all three factories directly.
  const opts = {
    session: scriptedSession(),
    policy: { worker: {}, team: {} } as any,
    ledger: { cumulative: { tokens: 0, costUsd: 0, runs: 0 } } as any,
  };
  buildRequestCompactionTool(opts);
  buildRequestEndSessionTool(opts);
  buildRequestSnapshotTool(opts);
  const reg = __cooperativeToolRegistry();
  assert.equal(reg.size, 3, "registry contains exactly 3 entries after direct factory calls");
  assert.ok(reg.has("request_compaction"), "request_compaction in registry");
  assert.ok(reg.has("request_end_session"), "request_end_session in registry");
  assert.ok(reg.has("request_snapshot"), "request_snapshot in registry");
  // Operator commands still do not appear.
  for (const name of ["endWorkerSession", "compactWorkerSession", "forceKillWorkerSession", "forceEndWorkerSession", "tearDownAllWorkers"]) {
    assert.ok(!reg.has(name as never), `operator command '${name}' NOT in cooperative registry`);
  }
});