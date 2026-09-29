/**
 * Wave 2 — T2.2 + T2.3 `delegateAgent` + `resolveWorkerBudgetPolicy` tests.
 *
 * Coverage (16 tests; 14 for `delegateAgent` + 1 for `resolveWorkerBudgetPolicy`
 * + 1 for T2.3 depth-cap pre-flight):
 *
 *   delegateAgent:
 *   1.  unknown agent throws a regular Error (NOT BudgetExhaustedError) per Pi docs §2.
 *   2.  fresh=false calls SessionManager.continueRecent (via injected factory).
 *   3.  fresh=true calls SessionManager.create (via injected factory).
 *   4.  throw `BudgetExhaustedError` (name + scope + resource) when over budget.
 *   5.  pre-flight does NOT throw when under caps.
 *   6.  installBudgetEventHooks is called BEFORE returning (hooks observe events).
 *   7.  controller.signal is fresh (not pre-aborted) per call.
 *   8.  returned sessionId matches the session's sessionId.
 *   9.  ledger in the result is the WORKER's SessionManager (writes go there).
 *  10.  injected createSession receives the SessionManager from sessionManagerFactory.
 *  11.  injected createSession receives cwd from ctx.cwd.
 *  12.  throws are caught by the throw-to-refuse contract (no object-return shape).
 *  13.  ledger cap snapshot fields are captured from the policy at restore time.
 *  14.  re-calling delegateAgent with fresh=true creates a new (independent) session.
 *
 *   resolveWorkerBudgetPolicy (bonus / F6 schema reconciliation):
 *  15.  settings.budgets.perWorker + agent.budgets override merge correctly
 *       (per-agent override beats global default).
 *
 *   T2.3 depth-cap pre-flight:
 *  16.  depth-cap violation throws BudgetExhaustedError with scope=worker, resource=depth.
 *
 * The tests inject `sessionManagerFactory` + `createSession` factories so the
 * SDK's heavy `createAgentSession` is never invoked. The AgentSession is a
 * real `ScriptedSession` whose `subscribe` records calls and whose
 * `getSessionStats` returns a scripted aggregate.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, SessionStats } from "@earendil-works/pi-coding-agent";
import { runAtDelegationDepth } from "../src/engine/session.ts";
import {
  BUDGET_EXHAUSTED_ERROR_NAME,
  delegateAgent,
  resolveWorkerBudgetPolicy,
} from "../src/engine/budget/worker-tools.ts";
import {
  BUDGET_LEDGER_CUSTOM_TYPE,
} from "../src/engine/budget/ledger.ts";
import type {
  AgentConfig,
  AgentRuntime,
  HiveConfig,
  HiveState,
} from "../src/core/types.ts";
import type { WorkerBudgetPolicy } from "../src/engine/budget/types.ts";
import { resolveWindow } from "../src/engine/budget/window-resolver.ts";

// ---------------------------------------------------------------------------
// Stubs / fixtures.
// ---------------------------------------------------------------------------

interface ScriptedSession {
  sessionId: string;
  subscribeCalls: Array<(event: unknown) => void>;
  listeners: Array<(event: unknown) => void>;
  stats: SessionStats;
  emit(event: unknown): void;
  subscribe(listener: (event: unknown) => void): () => void;
  getSessionStats(): SessionStats;
}

function makeSession(sessionId = "sess-test"): ScriptedSession {
  const listeners: Array<(event: unknown) => void> = [];
  const subscribeCalls: Array<(event: unknown) => void> = [];
  const s: ScriptedSession = {
    sessionId,
    subscribeCalls,
    listeners,
    stats: {
      sessionFile: undefined,
      sessionId,
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    },
    emit(event: unknown): void {
      for (const listener of listeners) listener(event);
    },
    subscribe(listener: (event: unknown) => void): () => void {
      subscribeCalls.push(listener);
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    getSessionStats(): SessionStats {
      return s.stats;
    },
  };
  return s;
}

interface ScriptedCreateSession {
  calls: Array<{ cwd: string; sessionManager: SessionManager }>;
  sessionForManager: WeakMap<SessionManager, ScriptedSession>;
  invoke(opts: { cwd?: string; sessionManager?: SessionManager }): Promise<{ session: ScriptedSession; extensionsResult: unknown }>;
}

function makeCreateSession(): ScriptedCreateSession {
  const calls: ScriptedCreateSession["calls"] = [];
  const sessionForManager = new WeakMap<SessionManager, ScriptedSession>();
  return {
    calls,
    sessionForManager,
    async invoke(opts) {
      calls.push({ cwd: opts.cwd ?? "", sessionManager: opts.sessionManager! });
      // Per-manager session so the test can observe which SM the session is bound to.
      let s = sessionForManager.get(opts.sessionManager!);
      if (!s) {
        s = makeSession(`sess-${calls.length}`);
        sessionForManager.set(opts.sessionManager!, s);
      }
      return { session: s, extensionsResult: {} };
    },
  };
}

function makePolicy(overrides: Partial<WorkerBudgetPolicy["worker"]> = {}): WorkerBudgetPolicy {
  return {
    worker: {
      tokens: { resource: "tokens", cap: 100_000 },
      costUsd: { resource: "costUsd", cap: 5 },
      runs: { resource: "runs", cap: 3 },
      depth: { resource: "depth", cap: 2 },
      ...overrides,
    },
    team: {
      tokens: { resource: "tokens", cap: 500_000 },
      costUsd: { resource: "costUsd", cap: 50 },
      runs: { resource: "runs", cap: 20 },
    },
  };
}

interface HiveStateOpts {
  agentName?: string;
  agentConfig?: Partial<AgentConfig>;
  budgetsConfig?: HiveConfig["settings"] extends infer S ? (S extends { budgets?: infer B } ? B : never) : never;
  policy?: WorkerBudgetPolicy;
  seedLedger?: Array<{ tokens: number; costUsd: number; runs: number }>;
}

function makeHiveState(opts: HiveStateOpts = {}): HiveState {
  const agentName = opts.agentName ?? "Builder";
  const slug = agentName.toLowerCase();
  const agentConfig: AgentConfig = {
    name: agentName,
    path: `${slug}.md`,
    slug,
    agentType: "lead",
    ...(opts.agentConfig ?? {}),
  };
  const config: HiveConfig = {
    orchestrator: { name: "Orchestrator", path: "o.md", slug: "orchestrator" },
    agents: [agentConfig],
    sharedContext: [],
    settings: {
      subagentOutputLimit: 100,
      defaultTools: "read",
      distiller: { enabled: false, model: "", conversationLines: 10 },
      ...(opts.budgetsConfig !== undefined ? { budgets: opts.budgetsConfig as never } : {}),
    },
  };

  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-worker-tools-"));
  const ctxSessionManager = SessionManager.inMemory(cwd);
  if (opts.seedLedger) {
    for (const entry of opts.seedLedger) {
      ctxSessionManager.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, {
        caps: {},
        cumulative: entry,
        writtenAt: 0,
        agentSlug: slug,
      });
    }
  }

  const runtime: AgentRuntime = {
    config: agentConfig,
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
    sessionFile: join(cwd, `${slug}.jsonl`),
  };
  return {
    pi: {} as HiveState["pi"],
    config,
    session: {
      sessionId: "s1",
      sessionDir: cwd,
      conversationLog: join(cwd, "c.jsonl"),
      observabilityLog: join(cwd, "e.jsonl"),
    },
    runtimes: new Map([[slug, runtime]]),
    widgetCtx: null,
    activeRuns: 0,
    mode: "hive",
    normalToolNames: [],
    sddStatus: null,
    obsSeq: 0,
  };
}

function makeCtx(cwd: string, ctxSessionManager: SessionManager): ExtensionContext {
  return {
    cwd,
    sessionManager: ctxSessionManager as unknown as ExtensionContext["sessionManager"],
    ui: {} as ExtensionContext["ui"],
    mode: "tui",
    hasUI: true,
    modelRegistry: {} as ExtensionContext["modelRegistry"],
    model: undefined,
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => "",
  };
}

/** Build a state + its ctxSessionManager together so seedLedger entries land where ctx reads them. */
function makeStateAndCtx(opts: HiveStateOpts = {}): { state: HiveState; ctx: ExtensionContext; cwd: string } {
  const state = makeHiveState(opts);
  const cwd = state.session!.sessionDir;
  // The state's internal ctxSessionManager (where seedLedger entries were written)
  // is the SAME one we hand to ctx so the pre-flight can see the seeded branch.
  // We rebuild a matching SM by replaying the seed entries — simpler: pass the
  // fresh SM and accept that the pre-flight sees an empty branch in this builder.
  // Tests that need a non-empty branch use seedBranch() directly.
  const ctx = makeCtx(cwd, SessionManager.inMemory(cwd));
  return { state, ctx, cwd };
}

/** Helper for tests that need to seed ledger entries BEFORE building the ctx SM. */
function makeStateAndCtxWithSeededBranch(
  seed: Array<{ tokens: number; costUsd: number; runs: number }>,
  agentSlug: string,
): { state: HiveState; ctx: ExtensionContext; cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-worker-tools-"));
  const ctxSessionManager = SessionManager.inMemory(cwd);
  for (const entry of seed) {
    ctxSessionManager.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, {
      caps: {},
      cumulative: entry,
      writtenAt: 0,
      agentSlug,
    });
  }
  const ctx = makeCtx(cwd, ctxSessionManager);
  const state = makeHiveState({}); // No seedLedger (we'll seed via ctxSessionManager directly).
  // Use the same cwd so the SM branch is the same one ctx reads.
  state.session!.sessionDir = cwd;
  return { state, ctx, cwd };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

// ── Case 1: unknown agent → plain Error, NOT BudgetExhaustedError ───────

test("delegateAgent: unknown agent throws a plain Error (NOT BudgetExhaustedError)", async () => {
  const state = makeHiveState({ agentName: "Builder" });
  const cwd = state.session!.sessionDir;
  const ctx = makeCtx(cwd, SessionManager.inMemory(cwd));
  await assert.rejects(
    () => delegateAgent(state, "Nonexistent", "task", {}, ctx, {
      sessionManagerFactory: (c, _fresh) => SessionManager.inMemory(c),
      createSession: makeCreateSession().invoke as never,
    }),
    (err: Error) => {
      assert.notEqual(err.name, BUDGET_EXHAUSTED_ERROR_NAME);
      assert.match(err.message, /unknown agent/i);
      return true;
    },
  );
});

// ── Case 2: fresh=false calls SessionManager.continueRecent ──────────────

test("delegateAgent({fresh:false}): sessionManagerFactory is called with fresh=false (continueRecent)", async () => {
  const state = makeHiveState({ agentName: "Builder" });
  const cwd = state.session!.sessionDir;
  const ctx = makeCtx(cwd, SessionManager.inMemory(cwd));
  let lastFresh: boolean | undefined;
  const create = makeCreateSession();

  await delegateAgent(state, "Builder", "task", { fresh: false }, ctx, {
    sessionManagerFactory: (c, fresh) => {
      lastFresh = fresh;
      return SessionManager.inMemory(c);
    },
    createSession: create.invoke as never,
  });

  assert.equal(lastFresh, false, "fresh flag passed as false");
});

// ── Case 3: fresh=true calls SessionManager.create ───────────────────────

test("delegateAgent({fresh:true}): sessionManagerFactory is called with fresh=true (create)", async () => {
  const state = makeHiveState({ agentName: "Builder" });
  const cwd = state.session!.sessionDir;
  const ctx = makeCtx(cwd, SessionManager.inMemory(cwd));
  let lastFresh: boolean | undefined;
  const create = makeCreateSession();

  await delegateAgent(state, "Builder", "task", { fresh: true }, ctx, {
    sessionManagerFactory: (c, fresh) => {
      lastFresh = fresh;
      return SessionManager.inMemory(c);
    },
    createSession: create.invoke as never,
  });

  assert.equal(lastFresh, true);
});

// ── Case 4: over budget → BudgetExhaustedError with scope+resource ──────

test("delegateAgent: throws BudgetExhaustedError when over worker tokens (scope=worker, resource=tokens)", async () => {
  const { state, ctx } = makeStateAndCtxWithSeededBranch(
    [{ tokens: 100, costUsd: 0, runs: 0 }],
    "builder",
  );
  // Cap = 100 (matches the seeded cumulative so 100 >= 100 blocks).
  (state.config!.settings as unknown as { budgets?: unknown }).budgets = {
    perWorker: { tokens: { cap: 100 } },
  };
  const create = makeCreateSession();

  await assert.rejects(
    () =>
      delegateAgent(state, "Builder", "task", {}, ctx, {
        sessionManagerFactory: (c) => SessionManager.inMemory(c),
        createSession: create.invoke as never,
      }),
    (err: Error & { scope?: string; resource?: string }) => {
      assert.equal(err.name, BUDGET_EXHAUSTED_ERROR_NAME);
      assert.equal(err.scope, "worker");
      assert.equal(err.resource, "tokens");
      assert.match(err.message, /token budget exhausted/i);
      return true;
    },
  );
});

// ── Case 5: under caps → succeeds, returns DelegateAgentResult ──────────

test("delegateAgent: returns DelegateAgentResult when under caps", async () => {
  const state = makeHiveState({ agentName: "Builder" });
  // Default policy (worker tokens cap = 100_000) — fresh session is empty, so under cap.
  const cwd = state.session!.sessionDir;
  const ctx = makeCtx(cwd, SessionManager.inMemory(cwd));
  const create = makeCreateSession();

  const result = await delegateAgent(state, "Builder", "task", {}, ctx, {
    sessionManagerFactory: (c) => SessionManager.inMemory(c),
    createSession: create.invoke as never,
  });

  assert.equal(typeof result.sessionId, "string");
  assert.ok(result.session);
  assert.ok(result.ledger);
  assert.ok(result.controller);
});

// ── Case 6: installBudgetEventHooks called BEFORE returning ─────────────

test("delegateAgent: installBudgetEventHooks installs BEFORE delegateAgent returns (hooks observe session events)", async () => {
  const state = makeHiveState({ agentName: "Builder" });
  const cwd = state.session!.sessionDir;
  const ctx = makeCtx(cwd, SessionManager.inMemory(cwd));
  const create = makeCreateSession();

  const result = await delegateAgent(state, "Builder", "task", {}, ctx, {
    sessionManagerFactory: (c) => SessionManager.inMemory(c),
    createSession: create.invoke as never,
  });

  // The result.session is the scripted session — emit an event and verify the
  // hook fired (subscribed listeners list contains exactly one entry).
  const scriptedSession = result.session as unknown as ScriptedSession;
  assert.equal(scriptedSession.listeners.length, 1, "subscribe was called exactly once");
  // Emit a message_end; the hook runs (we don't assert ledger state here —
  // that's covered by tests/budget-events.test.ts).
  assert.doesNotThrow(() => scriptedSession.emit({ type: "message_end" }));
});

// ── Case 7: controller is fresh (not pre-aborted) ───────────────────────

test("delegateAgent: returned controller.signal is fresh (not pre-aborted)", async () => {
  const state = makeHiveState({ agentName: "Builder" });
  const cwd = state.session!.sessionDir;
  const ctx = makeCtx(cwd, SessionManager.inMemory(cwd));
  const create = makeCreateSession();

  const result = await delegateAgent(state, "Builder", "task", {}, ctx, {
    sessionManagerFactory: (c) => SessionManager.inMemory(c),
    createSession: create.invoke as never,
  });

  assert.equal(result.controller.signal.aborted, false);
});

// ── Case 8: sessionId matches session.sessionId ─────────────────────────

test("delegateAgent: returned sessionId matches session.sessionId", async () => {
  const state = makeHiveState({ agentName: "Builder" });
  const cwd = state.session!.sessionDir;
  const ctx = makeCtx(cwd, SessionManager.inMemory(cwd));
  const create = makeCreateSession();

  const result = await delegateAgent(state, "Builder", "task", {}, ctx, {
    sessionManagerFactory: (c) => SessionManager.inMemory(c),
    createSession: create.invoke as never,
  });

  assert.equal(result.sessionId, result.session.sessionId);
});

// ── Case 9: ledger points at the WORKER's SessionManager ────────────────

test("delegateAgent: returned ledger's SessionManager is the WORKER's, not ctx.sessionManager", async () => {
  const state = makeHiveState({ agentName: "Builder" });
  const cwd = state.session!.sessionDir;
  const ctx = makeCtx(cwd, SessionManager.inMemory(cwd));
  const create = makeCreateSession();
  let workerSessionManager: SessionManager | undefined;

  const result = await delegateAgent(state, "Builder", "task", {}, ctx, {
    sessionManagerFactory: (c) => {
      workerSessionManager = SessionManager.inMemory(c);
      return workerSessionManager;
    },
    createSession: create.invoke as never,
  });

  // ledger's writes go through its sessionManager — verify by appending an
  // entry via the ledger and checking it landed in the worker SM, NOT the ctx SM.
  // Force a write by directly invoking recordEvent-then-snapshot:
  result.ledger.recordEvent("message_end", { tokens: 1, costUsd: 0, runs: 0 });
  result.ledger.snapshot(
    { sessionFile: undefined, sessionId: "x", userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0, tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 }, cost: 0 },
    makePolicy(),
    "checkpoint",
  );
  const ctxEntries = ctx.sessionManager.getBranch().filter(
    (e) => e.type === "custom" && (e as { customType?: string }).customType === BUDGET_LEDGER_CUSTOM_TYPE,
  );
  const workerEntries = workerSessionManager!.getBranch().filter(
    (e) => e.type === "custom" && (e as { customType?: string }).customType === BUDGET_LEDGER_CUSTOM_TYPE,
  );
  assert.equal(ctxEntries.length, 0, "no entries in ctx.sessionManager");
  assert.equal(workerEntries.length, 1, "entry written to workerSessionManager");
});

// ── Case 10: createSession receives the worker SessionManager ───────────

test("delegateAgent: injected createSession is called with the SessionManager from sessionManagerFactory", async () => {
  const state = makeHiveState({ agentName: "Builder" });
  const cwd = state.session!.sessionDir;
  const ctx = makeCtx(cwd, SessionManager.inMemory(cwd));
  const create = makeCreateSession();
  let workerSM: SessionManager | undefined;

  await delegateAgent(state, "Builder", "task", {}, ctx, {
    sessionManagerFactory: (c) => {
      workerSM = SessionManager.inMemory(c);
      return workerSM;
    },
    createSession: create.invoke as never,
  });

  assert.equal(create.calls.length, 1);
  assert.equal(create.calls[0]!.sessionManager, workerSM);
});

// ── Case 11: createSession receives ctx.cwd ──────────────────────────────

test("delegateAgent: injected createSession receives ctx.cwd verbatim", async () => {
  const state = makeHiveState({ agentName: "Builder" });
  const cwd = state.session!.sessionDir;
  const ctx = makeCtx(cwd, SessionManager.inMemory(cwd));
  const create = makeCreateSession();

  await delegateAgent(state, "Builder", "task", {}, ctx, {
    sessionManagerFactory: (c) => SessionManager.inMemory(c),
    createSession: create.invoke as never,
  });

  assert.equal(create.calls[0]!.cwd, cwd);
});

// ── Case 12: throw-to-refuse — no object-return shape (no exitCode) ──────

test("delegateAgent: budget violation throws (no { output, exitCode: 1 } object-return shape)", async () => {
  const { state, ctx } = makeStateAndCtxWithSeededBranch(
    [{ tokens: 100, costUsd: 0, runs: 0 }],
    "builder",
  );
  (state.config!.settings as unknown as { budgets?: unknown }).budgets = {
    perWorker: { tokens: { cap: 100 } },
  };
  const create = makeCreateSession();

  let caught: unknown;
  try {
    await delegateAgent(state, "Builder", "task", {}, ctx, {
      sessionManagerFactory: (c) => SessionManager.inMemory(c),
      createSession: create.invoke as never,
    });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof Error, "must throw an Error");
  // Belt-and-braces: the object-return shape would carry exitCode, not throw.
  assert.equal((caught as { exitCode?: number }).exitCode, undefined);
});

// ── Case 13: ledger caps captured from policy at restore ────────────────

test("delegateAgent: ledger.caps reflects policy caps at restore time", async () => {
  const { state, ctx } = makeStateAndCtx({ agentName: "Builder" });
  // Inject a budget config with non-default caps so we can assert the values.
  (state.config!.settings as unknown as { budgets?: unknown }).budgets = {
    perWorker: {
      tokens: { cap: 100_000 },
      costUsd: { cap: 5 },
      runs: { cap: 3 },
      depth: { cap: 2 },
    },
  };
  const create = makeCreateSession();

  const result = await delegateAgent(state, "Builder", "task", {}, ctx, {
    sessionManagerFactory: (c) => SessionManager.inMemory(c),
    createSession: create.invoke as never,
  });

  assert.equal(result.ledger.caps.workerTokens, 100_000);
  assert.equal(result.ledger.caps.workerCostUsd, 5);
  assert.equal(result.ledger.caps.workerRuns, 3);
  assert.equal(result.ledger.caps.workerDepth, 2);
});

// ── Case 14: two fresh=true calls produce independent sessions ───────────

test("delegateAgent: two fresh=true calls produce independent SessionManagers and sessions", async () => {
  const state = makeHiveState({ agentName: "Builder" });
  const cwd = state.session!.sessionDir;
  const ctx = makeCtx(cwd, SessionManager.inMemory(cwd));
  const create = makeCreateSession();
  const sms: SessionManager[] = [];

  const r1 = await delegateAgent(state, "Builder", "task1", { fresh: true }, ctx, {
    sessionManagerFactory: (c) => {
      const sm = SessionManager.inMemory(c);
      sms.push(sm);
      return sm;
    },
    createSession: create.invoke as never,
  });
  const r2 = await delegateAgent(state, "Builder", "task2", { fresh: true }, ctx, {
    sessionManagerFactory: (c) => {
      const sm = SessionManager.inMemory(c);
      sms.push(sm);
      return sm;
    },
    createSession: create.invoke as never,
  });

  assert.equal(sms.length, 2);
  assert.notEqual(sms[0], sms[1], "fresh=true yields distinct SMs per call");
  assert.notEqual(r1.sessionId, r2.sessionId);
});

// ── Case 15: resolveWorkerBudgetPolicy merges per-agent override over global default ─

test("resolveWorkerBudgetPolicy: per-agent budgets override beats settings.budgets.perWorker default", () => {
  const state = makeHiveState({
    agentName: "Builder",
    agentConfig: {
      budgets: {
        tokens: { resource: "tokens", cap: 500 },
        costUsd: { resource: "costUsd", cap: 0.25 },
      },
    },
  });
  (state.config!.settings as unknown as { budgets?: unknown }).budgets = {
    perWorker: { tokens: { cap: 1000 }, costUsd: { cap: 1 } },
    perTeam: { runs: { cap: 5 } },
  };

  const policy = resolveWorkerBudgetPolicy(state, "Builder");
  // Per-agent override beats global default for tokens + costUsd.
  assert.equal(policy.worker.tokens?.cap, 500);
  assert.equal(policy.worker.costUsd?.cap, 0.25);
  // Team layer came from the global default (no per-team override exists).
  assert.equal(policy.team.runs?.cap, 5);
});

// ── Case 16: T2.3 depth cap blocks dispatch with scope=worker, resource=depth ─

test("T2.3: depth-cap violation throws BudgetExhaustedError with scope=worker, resource=depth", async () => {
  // Depth cap = 1. With runAtDelegationDepth(2, ...) the dispatch would push
  // depth to 3, which exceeds cap=1.
  const state = makeHiveState({ agentName: "Builder" });
  (state.config!.settings as unknown as { budgets?: unknown }).budgets = {
    perWorker: { depth: { cap: 1 } },
  };
  const cwd = state.session!.sessionDir;
  const ctx = makeCtx(cwd, SessionManager.inMemory(cwd));
  const create = makeCreateSession();

  let caught: (Error & { scope?: string; resource?: string }) | undefined;
  await runAtDelegationDepth(2, async () => {
    try {
      await delegateAgent(state, "Builder", "task", {}, ctx, {
        sessionManagerFactory: (c) => SessionManager.inMemory(c),
        createSession: create.invoke as never,
      });
    } catch (e) {
      caught = e as typeof caught;
    }
  });

  assert.ok(caught, "must throw");
  assert.equal(caught!.name, BUDGET_EXHAUSTED_ERROR_NAME);
  assert.equal(caught!.scope, "worker");
  assert.equal(caught!.resource, "depth");
  assert.match(caught!.message, /depth budget exhausted/i);
});

// ── Bonus: window-resolver (referenced from worker-tools.ts) ────────────

test("resolveWindow: object form flattens to BudgetWindow string (F2 reconciliation)", () => {
  assert.equal(resolveWindow({ kind: "all-time" }), "per-team-lifetime");
  assert.equal(resolveWindow({ kind: "per-day" }), "per-day");
  assert.equal(resolveWindow({ kind: "rolling", duration: 30 * 60 * 1000 }), "per-hour");
  assert.equal(resolveWindow({ kind: "rolling", duration: 12 * 60 * 60 * 1000 }), "per-day");
  assert.equal(resolveWindow({ kind: "rolling", duration: 48 * 60 * 60 * 1000 }), "per-session");
  assert.equal(resolveWindow(undefined), undefined);
});
