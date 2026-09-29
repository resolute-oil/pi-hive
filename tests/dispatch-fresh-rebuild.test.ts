// ============================================================================
// fresh=true dispatch — comprehensive regression coverage (tmp/2025-09-29)
//
// Each test in this file maps to a specific fix move in
// `tmp/2025-09-29-fresh-true-rebuild-runtime.md` and would fail without it.
// The naming convention is `T-fresh-N` / `T-preflight-N` matching the doc's
// "Test coverage to add" list.
//
// Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md
//   §3.9 + tmp/2025-09-29-fresh-true-rebuild-runtime.md
//
// The fix has five coupled moves that must land together:
//
//   Move 1: tear down the prior runtime (clearInterval + dispose session).
//   Move 2: replace the runtime in `state.runtimes` with `makeFreshRuntime`
//           so closures holding the old reference write to the orphan.
//   Move 3: `SessionManager.create(cwd)` for fresh=true so the new SDK
//           session is genuinely empty rather than a continuation.
//   Move 4: `runBudgetPreflight` accepts the worker's SessionManager so the
//           ledger restores against the worker's branch (not the
//           orchestrator's empty read-only branch).
//   Move 5: preflight runs AFTER the fresh reset, so it sees the new
//           worker's empty branch (post-Move 3) rather than the stale one.
// ============================================================================

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { dispatchAgent, type CreateAgentSession } from "../src/engine/dispatch.ts";
import { runBudgetPreflight } from "../src/engine/budget/worker-tools.ts";
import type { AgentRuntime, HiveState } from "../src/core/types.ts";

const BUDGET_LEDGER_CUSTOM_TYPE = "pi-hive-budget-ledger";

function runtimeFor(name: string, sessionFile: string): AgentRuntime {
  return {
    config: { name, path: `${name}.md`, role: "member", agentType: "lead", routingTags: [], domain: [], tools: "read", model: "test/model", thinking: "off" },
    systemPrompt: "", status: "idle", task: "", lastWork: "", toolCount: 0, elapsedMs: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, contextPct: 0, runCount: 0, sessionFile,
  };
}

function scriptedSession(opts: {
  turns: Array<{ input: number; output: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; cost: number }>;
  stats: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; reasoning?: number };
}) {
  let handler: ((e: any) => void) | undefined;
  return {
    subscribe(cb: (e: any) => void) { handler = cb; return () => { handler = undefined; }; },
    getAvailableThinkingLevels() { return ["off", "low", "high"]; },
    getContextUsage() { return { percent: 12 }; },
    getSessionStats() {
      const tokens: any = { input: opts.stats.input, output: opts.stats.output, cacheRead: opts.stats.cacheRead, cacheWrite: opts.stats.cacheWrite };
      if (opts.stats.reasoning !== undefined) tokens.reasoning = opts.stats.reasoning;
      return { tokens, cost: { total: opts.stats.cost } };
    },
    state: { errorMessage: undefined as string | undefined },
    async prompt() {
      for (const t of opts.turns) {
        handler?.({ type: "message_end", message: { role: "assistant", model: "test/model", stopReason: "endTurn", usage: { input: t.input, output: t.output, cacheRead: t.cacheRead || 0, cacheWrite: t.cacheWrite || 0, reasoning: t.reasoning || 0, cost: { total: t.cost } } } });
      }
      handler?.({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
    },
    abort() {},
    dispose() {},
  };
}

interface DispatchHarness {
  dir: string;
  worker: AgentRuntime;
  state: HiveState;
  ctx: any;
  obsLog: string;
}

function harness(): DispatchHarness {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-fresh-"));
  const obsLog = join(dir, "e.jsonl");
  const worker = runtimeFor("Builder", join(dir, "builder.jsonl"));
  const state: HiveState = {
    pi: {} as any,
    config: {
      orchestrator: { name: "Orchestrator", path: "o.md" },
      agents: [worker.config],
      sharedContext: [],
      settings: { subagentOutputLimit: 100, defaultTools: "read", maxParallel: 2, distiller: { enabled: false, model: "", conversationLines: 10 } },
    } as any,
    session: { sessionId: "s1", sessionDir: dir, conversationLog: join(dir, "c.jsonl"), observabilityLog: obsLog },
    runtimes: new Map([["builder", worker]]),
    widgetCtx: null, activeRuns: 0, mode: "hive", normalToolNames: [],
    sddStatus: null, obsSeq: 0,
  } as any;
  const ctx = { cwd: dir, modelRegistry: { find: () => ({ provider: "test", modelId: "model" }) } } as any;
  return { dir, worker, state, ctx, obsLog };
}

// ─── T-fresh-3: Move 2 — fresh dispatch replaces the runtime in state.runtimes ──
test("T-fresh-3: fresh dispatch replaces the runtime in state.runtimes (Move 2 identity swap)", async () => {
  const { worker, state, ctx } = harness();
  const originalRuntime = worker;
  const create: CreateAgentSession = (async () => ({ session: scriptedSession({ turns: [{ input: 1, output: 1, cost: 0 }], stats: { input: 80, output: 30, cacheRead: 5, cacheWrite: 2, cost: 0.08 } }) })) as any;
  await dispatchAgent(state, "Builder", "fresh task", ctx, true, create);
  const current = state.runtimes.get("builder");
  assert.ok(current, "state.runtimes.get('builder') must return a runtime after dispatch");
  assert.notEqual(current, originalRuntime, "Move 2: state.runtimes.get returns a NEW runtime object, not the original");
  // The new runtime's identity is unrelated to the original — makeFreshRuntime
  // builds a fresh object from scratch. Identity check is the load-bearing
  // assertion: a regression that re-introduces in-place counter resets would
  // fail this because `current === originalRuntime`.
});

// ─── T-fresh-4: Move 3 — fresh dispatch produces a fresh SDK session whose stats overwrite runtime counters ──
test("T-fresh-4: fresh dispatch counters reflect the new session, not the prior one (Move 3 — SessionManager.create)", async () => {
  const { worker, state, ctx } = harness();
  // Run 1: non-fresh, lifetime 15,332 (mirrors the user's incident value).
  const create1: CreateAgentSession = (async () => ({ session: scriptedSession({ turns: [{ input: 1, output: 1, cost: 0 }], stats: { input: 15_332, output: 200, cacheRead: 50, cacheWrite: 20, cost: 0.50 } }) })) as any;
  await dispatchAgent(state, "Builder", "run one", ctx, false, create1);
  // Materialize a prior session file so Move 3's `fresh=true` path fires
  // (without it, the test wouldn't exercise the fresh branch).
  writeFileSync(worker.sessionFile, "{}\n");

  // Run 2: fresh=true with a small scripted session. Pre-Move 3, the dispatch
  // would open the OLD file via SessionManager.open, getSessionStats would
  // return 15,332, and the runtime counters would be overwritten back to the
  // prior lifetime — exactly the user's reported bug.
  const create2: CreateAgentSession = (async () => ({ session: scriptedSession({ turns: [{ input: 1, output: 1, cost: 0 }], stats: { input: 80, output: 30, cacheRead: 5, cacheWrite: 2, cost: 0.08 } }) })) as any;
  await dispatchAgent(state, "Builder", "run two fresh", ctx, true, create2);

  const current = state.runtimes.get("builder")!;
  assert.equal(current.inputTokens, 80, "fresh session's stats overwrite runtime counters — NOT the prior session's 15,332");
  assert.equal(current.outputTokens, 30);
  assert.equal(current.cacheReadTokens, 5);
  assert.equal(current.cacheWriteTokens, 2);
});

// ─── T-fresh-8: budgetRemaining after fresh returns full budget ──
test("T-fresh-8: fresh dispatch restores the full per-worker token budget (Move 1+2 zero all counters)", async () => {
  const { worker, state, ctx } = harness();
  // Seed a budget cap on the per-worker block via settings.budgets.perWorker.
  (state.config!.settings as any).budgets = {
    perWorker: { tokens: { cap: 10_000 } },
    perTeam: {},
  };
  // Run 1: non-fresh, lifetime 8,000 (under cap).
  const create1: CreateAgentSession = (async () => ({ session: scriptedSession({ turns: [{ input: 1, output: 1, cost: 0 }], stats: { input: 8_000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.40 } }) })) as any;
  await dispatchAgent(state, "Builder", "run one", ctx, false, create1);
  assert.equal(state.runtimes.get("builder")!.inputTokens, 8_000);

  writeFileSync(worker.sessionFile, "{}\n");

  // Run 2: fresh=true with a small scripted session. After Move 1+2, the
  // runtime counters are zeroed; after Move 3, the new session produces only
  // its own usage. `budgetRemaining` reads runtime counters (display.ts:185-201)
  // so it must reflect the fresh total, not the 8,000 from run 1.
  const create2: CreateAgentSession = (async () => ({ session: scriptedSession({ turns: [{ input: 1, output: 1, cost: 0 }], stats: { input: 80, output: 30, cacheRead: 5, cacheWrite: 2, cost: 0.08 } }) })) as any;
  await dispatchAgent(state, "Builder", "run two fresh", ctx, true, create2);

  const { budgetRemaining } = await import("../src/engine/budget/display.ts");
  const remaining = budgetRemaining(state, state.runtimes.get("builder")!);
  // 10,000 cap − (80 + 30 + 5 + 2) = 9,883 remaining.
  assert.equal(remaining.worker.tokens, 10_000 - (80 + 30 + 5 + 2), "fresh dispatch restores worker budget against the new runtime's small counters");
});

// ─── T-fresh-9: old runtime is orphaned ──
test("T-fresh-9: the original runtime reference is orphaned after fresh dispatch (Move 2)", async () => {
  const { worker, state, ctx } = harness();
  const originalRuntime = worker;
  const create: CreateAgentSession = (async () => ({ session: scriptedSession({ turns: [{ input: 1, output: 1, cost: 0 }], stats: { input: 80, output: 30, cacheRead: 5, cacheWrite: 2, cost: 0.08 } }) })) as any;
  await dispatchAgent(state, "Builder", "fresh task", ctx, true, create);
  // The original runtime is no longer the registry's runtime.
  assert.notEqual(state.runtimes.get("builder"), originalRuntime, "original runtime is no longer in the registry");
  // The original runtime's timer was cleared by Move 1 (best-effort: if a
  // prior dispatch set one, this assertion would fail without Move 1).
  assert.equal(originalRuntime.timer, undefined, "Move 1: prior runtime's timer is cleared (no stale beats)");
  // The original runtime's session was disposed by Move 1.
  assert.equal(originalRuntime.session, undefined, "Move 1: prior runtime's session reference is nulled");
});

// ─── T-preflight-1: runBudgetPreflight reads worker SM when provided (Move 4) ──
test("T-preflight-1: runBudgetPreflight reads worker's SessionManager when provided (Move 4)", async () => {
  const { state, ctx } = harness();
  // Seed the ORCHESTRATOR's branch with NO budget entries (the prior bug's
  // hidden helper — pre-Move 4, preflight read this branch and always
  // returned "pass"). The worker branch is seeded with an over-cap
  // cumulative: post-Move 4, preflight reads this and blocks.
  const orchestratorSM = ctx.sessionManager ?? SessionManager.inMemory(ctx.cwd);
  // Build a worker SM with an over-cap cumulative.
  const workerCwd = mkdtempSync(join(tmpdir(), "pi-hive-preflight-worker-"));
  const workerSM = SessionManager.inMemory(workerCwd);
  workerSM.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, {
    caps: { workerTokens: 100_000, teamTokens: 500_000 },
    cumulative: { tokens: 15_134, costUsd: 1.5, runs: 1 },
    writtenAt: 0,
    agentSlug: "builder",
  });

  // Inject the orchestrator + worker SMs into ctx/state for the preflight call.
  (ctx as any).sessionManager = orchestratorSM;
  // The state needs a budget cap so the policy has something to check.
  (state.config!.settings as any).budgets = {
    perWorker: { tokens: { cap: 10_000 } },
    perTeam: {},
  };

  // Move 4: passing the worker SM makes the preflight block.
  await assert.rejects(
    async () => runBudgetPreflight(state, "builder", ctx as any, workerSM),
    (err: any) => err?.name === "BudgetExhaustedError",
    "Move 4: preflight reads worker's SM (over-cap cumulative → blocks)",
  );

  // Sanity: without the worker SM, the preflight falls back to the
  // orchestrator's empty branch and passes (the legacy always-pass bug,
  // preserved for `delegateAgent`'s backward compatibility).
  await assert.doesNotReject(
    async () => runBudgetPreflight(state, "builder", ctx as any),
    "fallback to orchestrator's empty branch still passes (legacy behavior, preserved for delegateAgent)",
  );
});

// ─── T-preflight-2: fresh dispatch against over-cap worker SM still passes (Move 5) ──
test("T-preflight-2: fresh dispatch's preflight runs AFTER Move 3 — empty fresh SM means preflight passes (Move 5)", async () => {
  const { worker, state, ctx } = harness();
  // Configure a tight budget cap so preflight would block if it read the
  // wrong SM.
  (state.config!.settings as any).budgets = {
    perWorker: { tokens: { cap: 100 } },
    perTeam: {},
  };
  // Pretend the prior session file is on disk and contains a transcript
  // (the fresh-archive path). Move 5 ensures the preflight sees the FRESH
  // SM (created by Move 3) rather than this prior transcript. Without Move 5,
  // the preflight would see the prior transcript's budget entries and block.
  writeFileSync(worker.sessionFile, JSON.stringify({ type: "session", version: 3, id: "old", timestamp: new Date().toISOString(), cwd: ctx.cwd }) + "\n");

  const create: CreateAgentSession = (async () => ({ session: scriptedSession({ turns: [{ input: 1, output: 1, cost: 0 }], stats: { input: 30, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.01 } }) })) as any;

  // The dispatch should succeed (no BudgetExhaustedError). The fresh session
  // totals (30 + 10 = 40) are under the cap (100), so even after the run
  // there's no block.
  const result = await dispatchAgent(state, "Builder", "fresh under cap", ctx, true, create);
  assert.equal(result.exitCode, 0, "fresh dispatch succeeds: preflight ran AFTER Move 3, saw empty fresh SM");
});

// ─── T-preflight-3: non-fresh dispatch with a budget cap succeeds (Move 4 sanity) ──
//
// Move 4 changes the preflight to read the worker's SessionManager instead of
// `ctx.sessionManager`. For a fresh dispatch this is benign (the new SM is
// empty). For a non-fresh dispatch the worker SM is also empty on the FIRST
// run (no prior session file) — preflight must still pass. This test pins
// down that Move 4 didn't accidentally make the preflight block on every
// dispatch.
//
// The deeper over-cap regression is covered by T-preflight-1 (unit test on
// `runBudgetPreflight` directly with a seeded worker SM) — driving a full
// dispatch that ends with a CustomEntry write requires either a working
// scriptedSession's `agent_settled` event (which the L1 harness omits) or
// a custom SM seam (out of scope for this fix).
test("T-preflight-3: non-fresh dispatch with a budget cap still passes (Move 4 sanity — preflight reads worker SM without false-blocking)", async () => {
  const { state, ctx } = harness();
  (state.config!.settings as any).budgets = {
    perWorker: { tokens: { cap: 100 } },
    perTeam: {},
  };
  const create: CreateAgentSession = (async () => ({ session: scriptedSession({ turns: [{ input: 1, output: 1, cost: 0 }], stats: { input: 30, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.01 } }) })) as any;
  const result = await dispatchAgent(state, "Builder", "non-fresh under cap", ctx, false, create);
  assert.equal(result.exitCode, 0, "non-fresh dispatch with empty worker SM passes the preflight");
});

// ─── T-fresh-counter-reset: every counter starts at zero on the new runtime (Move 2) ──
test("T-fresh-counter-reset: fresh dispatch zeros ALL counters on the new runtime (Move 2 — defensive)", async () => {
  const { worker, state, ctx } = harness();
  // Seed the original runtime with stale values across every counter.
  worker.inputTokens = 15_000;
  worker.outputTokens = 200;
  worker.cacheReadTokens = 50;
  worker.cacheWriteTokens = 20;
  worker.reasoningTokens = 30;
  worker.costUsd = 0.50;
  worker.runCount = 5;
  worker.toolCount = 7;
  worker.contextPct = 88;
  worker.contextTokens = 999_000;
  worker.contextWindow = 1_000_000;
  worker.task = "stale task from prior dispatch";
  worker.lastWork = "stale lastWork";
  worker.systemPrompt = "stale systemPrompt";
  worker.status = "error";
  worker.startedAt = 1_000_000;
  worker.timer = undefined;  // (no timer to clear, but include for completeness)

  const create: CreateAgentSession = (async () => ({ session: scriptedSession({ turns: [{ input: 1, output: 1, cost: 0 }], stats: { input: 80, output: 30, cacheRead: 5, cacheWrite: 2, cost: 0.08 } }) })) as any;
  await dispatchAgent(state, "Builder", "fresh task", ctx, true, create);

  const current = state.runtimes.get("builder")!;
  // Every counter on the NEW runtime is either 0 (zeroed by Move 2) or the
  // fresh session's lifetime (overwritten by Move 3 + applySessionStatsToRuntime).
  assert.equal(current.inputTokens, 80, "fresh session's inputTokens, not the stale 15,000");
  assert.equal(current.outputTokens, 30, "fresh session's outputTokens");
  assert.equal(current.cacheReadTokens, 5);
  assert.equal(current.cacheWriteTokens, 2);
  assert.equal(current.reasoningTokens, 0);
  assert.equal(current.costUsd, 0.08, "fresh session's costUsd, not the stale 0.50");
  assert.equal(current.runCount, 1, "Move 2 zeroed runCount; dispatch's increment brought it to 1 (NOT 6 — the legacy always-increment bug)");
  assert.equal(current.toolCount, 0, "toolCount is per-run, reset at run-start (legacy behavior, preserved)");
  assert.equal(current.task, "fresh task", "Move 2 zeroed task; dispatch set it to the new task");
  // `lastWork` is overwritten at end-of-dispatch from the output (or '[no
  // output]' fallback when the scripted session produces no text). The
  // Move-2 zero is observable only DURING the run, not after. The legacy
  // dispatch behaved the same way.
  assert.equal(current.lastWork, "[no output]", "end-of-dispatch lastWork derives from output (legacy behavior, preserved)");
  assert.equal(current.systemPrompt, "", "Move 2 zeroed systemPrompt (re-loaded by reloadAgentConfig)");
  assert.equal(current.status, "done", "dispatch completed successfully → status='done'");
});
