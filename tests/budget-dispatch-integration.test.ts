// Wave 2 Fixup — dispatch.ts delegates to delegateAgent (TDD red-green)
//
// The brief's HARD gate: "no business logic remains in dispatch.ts — it's just
// a routing layer." The Wave 2 implementing agent landed delegateAgent +
// installBudgetEventHooks but the dispatcher still uses legacy
// checkDispatchBudgets. This file exercises the production wiring.
//
// These tests stub the SDK session factory (CreateAgentSession seam) and
// verify that the dispatcher's budget pre-flight routes through delegateAgent
// — depth-cap, throw-to-refuse, and the installBudgetEventHooks call site.
// The tests assert at the PUBLIC seam (dispatchAgent's return shape) so the
// refactor can reorganize internals without breaking the test contract.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dispatchAgent, type CreateAgentSession } from "../src/engine/dispatch.ts";
import type { AgentRuntime, AgentType, HiveState } from "../src/core/types.ts";

// ── Test fixtures ─────────────────────────────────────────────────────────

function runtimeFor(name: string, sessionFile: string, governance: Record<string, any> = {}, agentType: AgentType = "lead"): AgentRuntime {
  return {
    config: { name, slug: name.toLowerCase(), path: `${name.toLowerCase()}.md`, agentType, role: "member", governance, model: "test/model", thinking: "off", tools: "read" },
    sessionFile,
    systemPrompt: "",
    task: "",
    lastWork: "",
    contextPct: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    runCount: 0,
    elapsedMs: 0,
    toolCount: 0,
    status: "idle",
  };
}

function scriptedSession(opts: { stats?: any; turns?: any[]; throwOnPrompt?: boolean } = {}) {
  const stats = opts.stats ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  return {
    subscribe(): () => void { return () => undefined; },
    getAvailableThinkingLevels(): string[] { return ["off"]; },
    getContextUsage(): { percent: number } { return { percent: 0 }; },
    getSessionStats(): any { return { tokens: { input: stats.input, output: stats.output, cacheRead: stats.cacheRead, cacheWrite: stats.cacheWrite, total: stats.input + stats.output }, cost: stats.cost }; },
    sessionManager: {
      getBranch(): any[] { return []; },
      appendCustomEntry(): void { /* noop */ },
      appendCustomMessageEntry(): void { /* noop */ },
    },
    state: { errorMessage: undefined },
    async prompt(): Promise<void> {
      if (opts.throwOnPrompt) throw new Error("prompt failed");
    },
    async abort(): Promise<void> { /* noop */ },
    dispose(): void { /* noop */ },
  } as any;
}

function hiveState(opts: { dir: string; worker: AgentRuntime; settings?: any }): HiveState {
  return {
    pi: {} as any,
    config: {
      orchestrator: { name: "Orchestrator", path: "o.md" },
      agents: [opts.worker.config],
      sharedContext: [],
      settings: { subagentOutputLimit: 100, defaultTools: "read", distiller: { enabled: false, model: "", conversationLines: 10 }, ...(opts.settings ?? {}) },
    } as any,
    session: { sessionId: "s1", sessionDir: opts.dir, conversationLog: join(opts.dir, "c.jsonl"), observabilityLog: join(opts.dir, "e.jsonl") },
    runtimes: new Map([[opts.worker.config.slug!, opts.worker]]),
    widgetCtx: null,
    activeRuns: 0,
    mode: "hive",
    normalToolNames: [],
    sddStatus: null,
    obsSeq: 0,
  } as any;
}

// ── Test 1: dispatchAgent now uses delegateAgent (throw-to-refuse propagates) ─

test("dispatchAgent routes its budget pre-flight through delegateAgent (throws BudgetExhaustedError → caught and converted)", async () => {
  // cap=0 trips the new checkBudgetPolicy's depth-cap pre-flight: at delegationDepth=0,
  // the dispatcher wires depthFn: () => currentDelegationDepth(), so the new path
  // computes (0 + 1) > 0 = cap and throws BudgetExhaustedError("Worker maximum
  // delegation depth exhausted (0)."). The legacy checkDispatchBudgets emits
  // "<runtime.config.name> maximum delegation depth exhausted (0)." — same shape
  // with the agent name as the subject. The discriminator that proves the new path
  // is active is the leading "Worker" (vs the agent name).
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-delegate-budget-"));
  const worker = runtimeFor("Builder", join(dir, "builder.jsonl"), { maxDelegationDepth: 0 }, "lead");
  const state = hiveState({ dir, worker });
  const ctx = { cwd: dir, modelRegistry: { find: () => ({ provider: "test", modelId: "model" }) } } as any;
  const create: CreateAgentSession = (async () => ({ session: scriptedSession() })) as any;

  const result = await dispatchAgent(state, "Builder", "do work", ctx, create);
  assert.equal(result.exitCode, 1, "budget block exits with code 1");
  assert.match(result.output, /Worker maximum delegation depth exhausted/i, "message format from delegateAgent's BudgetExhaustedError (not legacy 'Builder maximum delegation depth exhausted')");
  assert.equal(worker.runCount, 0, "budget-block does NOT increment runCount");
});

// ── Test 2: depth-cap pre-flight fires in production wiring ─────────────

test("dispatchAgent depth-cap pre-flight uses currentDelegationDepth() and throws BudgetExhaustedError at cap+1", async () => {
  // Brief Blocker 2: the depthFn seam in delegateAgent defaults to undefined, so
  // depth=0 always, and the cap is inert in production. This test asserts
  // dispatchAgent wires depthFn so the cap actually fires when a nested
  // delegation is over the cap.
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-delegate-depth-"));
  const worker = runtimeFor("Builder", join(dir, "builder.jsonl"), { maxDelegationDepth: 1 }, "lead");
  const state = hiveState({ dir, worker });
  const ctx = { cwd: dir, modelRegistry: { find: () => ({ provider: "test", modelId: "model" }) } } as any;
  const create: CreateAgentSession = (async () => ({ session: scriptedSession() })) as any;

  // Simulate nesting at depth=1 (the first call inside runAtDelegationDepth(1)).
  // delegateAgent computes depth+1 = 2 > cap=1 → BudgetExhaustedError.
  const { runAtDelegationDepth } = await import("../src/engine/session.ts");
  const result = await runAtDelegationDepth(1, () => dispatchAgent(state, "Builder", "too deep", ctx, create));
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /Worker maximum delegation depth exhausted/i, "new-path message format");
});

// ── Test 3: installBudgetEventHooks is wired into the session in production ─

test("dispatchAgent installs budget event hooks on the session (delegated, not inline)", async () => {
  // Brief's Blocker 1 fix: installBudgetEventHooks must actually be invoked
  // by dispatchAgent in production. We hook into the session's subscribe()
  // and assert that AT LEAST one listener was registered by installBudgetEventHooks
  // (the budget hooks subscribe with their own listener; dispatch-subscribe
  // ALSO subscribes). A session with ZERO budget hooks would be a regression.
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-delegate-hooks-"));
  const worker = runtimeFor("Builder", join(dir, "builder.jsonl"), {}, "lead");
  const state = hiveState({ dir, worker });
  const ctx = { cwd: dir, modelRegistry: { find: () => ({ provider: "test", modelId: "model" }) } } as any;

  let subscribeCalls = 0;
  const create: CreateAgentSession = (async () => ({ session: {
    subscribe(): () => void { subscribeCalls += 1; return () => undefined; },
    getAvailableThinkingLevels(): string[] { return ["off"]; },
    getContextUsage(): { percent: number } { return { percent: 0 }; },
    getSessionStats(): any { return { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }; },
    sessionManager: { getBranch: () => [], appendCustomEntry: () => {}, appendCustomMessageEntry: () => {} },
    state: { errorMessage: undefined },
    async prompt(): Promise<void> { /* noop */ },
    async abort(): Promise<void> { /* noop */ },
    dispose(): void { /* noop */ },
  } as any })) as any;

  await dispatchAgent(state, "Builder", "do work", ctx, create);
  // 1 subscriber from installBudgetEventHooks (via delegateAgent) + 1 from
  // wireDispatchSubscription (the streaming/telemetry handler). Pre-fixup
  // the count would be 1 (only the dispatch-subscribe handler).
  assert.ok(subscribeCalls >= 2, `expected ≥2 subscribe() calls (budget + telemetry); got ${subscribeCalls}`);
});

// ── Test 4: dispatchAgent assigns runtime.timer (regression: dispatch slim) ─

test("dispatchAgent assigns runtime.timer before session.prompt() runs (regression: dispatch slim dropped the call site)", async () => {
  // The Wave 2 dispatch slim (commit 90a308f) extracted startElapsedTimer()
  // but left an orphan truncated comment where the call site used to live,
  // so runtime.timer stayed undefined for the entire worker run and the 1s
  // ticker that updates runtime.elapsedMs / contextPct / contextTokens never
  // fired — caught by the post-slim verification agent and fixed in 9a71425.
  // This test guards against a re-slim losing the call site again.
  //
  // WorkerRunLifecycle.close() clears the timer during the post-prompt
  // cleanup tail, so by the time dispatchAgent returns runtime.timer is
  // already undefined again. Capture the reference from inside prompt()
  // instead, which is the one moment it's reliably observable.
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-runtime-timer-"));
  const worker = runtimeFor("Builder", join(dir, "builder.jsonl"));
  const state = hiveState({ dir, worker });
  const ctx = { cwd: dir, modelRegistry: { find: () => ({ provider: "test", modelId: "model" }) } } as any;

  let timerDuringRun: NodeJS.Timeout | undefined;
  const create: CreateAgentSession = (async () => ({ session: {
    ...scriptedSession(),
    async prompt(): Promise<void> {
      timerDuringRun = worker.timer;
    },
  } as any })) as any;

  await dispatchAgent(state, "Builder", "do work", ctx, create);
  assert.ok(timerDuringRun, "runtime.timer must be assigned before session.prompt() runs (slim lost the call site at dispatch.ts:650)");
  assert.equal(timerDuringRun!.constructor.name, "Timeout", "setInterval returns a Node Timeout object");
});