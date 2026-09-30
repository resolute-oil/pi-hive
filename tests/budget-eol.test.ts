// Wave 3 F5 EOL tests — Agent 3B (T5.1, T5.2, T5.4, T5.8, T5.9, T5.13, T5.14, T5.15)
//
// 24 tests total: 3 per command × 8 commands. Verifies the operator
// commands in src/engine/budget/worker-tools.ts region 3B (lines 327-413)
// write a ledger snapshot with a distinct kind and call the documented SDK
// primitives. The cross-cutting Wave 3 hard gates (per the F5 brief):
//   - forceKillWorkerSession: controller.abort() + session.dispose() directly
//     (no waitForIdle); force-kill snapshot BEFORE dispose.
//   - tearDownAllWorkers({force:false}): endWorkerSession per worker;
//     {force:true}: forceKillWorkerSession per worker.
//   - forceKillWorkerSession / forceEndWorkerSession / tearDownAllWorkers
//     are operator-only (not ToolDefinition objects).
//   - 9 distinct kind values across all operator commands (3B covers 8).
//
// Tests use a module-level WorkerHandle factory: each test seeds the
// workerHandles map via the same seam the production wiring (F13 dashboard
// + dispatcher) uses, then invokes the operator command, then asserts the
// SDK calls + CustomEntry writes that the command produced. The
// SessionManager.inMemory() fake carries the appendCustomEntry log so
// the ledger-snapshot kind assertion is observable end-to-end.

import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  SessionManager as SessionManagerT,
  SessionStats,
} from "@earendil-works/pi-coding-agent";
import { BudgetLedger } from "../src/engine/budget/ledger.ts";
import type { BudgetLedgerEntry } from "../src/core/types.ts";

// Access the module-level registry + register/unregister seam from
// worker-tools.ts. The 3B region exports these symbols internally; we
// import them via the module re-export pattern (the names appear in the
// contract test that asserts "worker-tools exports all 11 operator
// commands" — same names surface here).
import * as workerTools from "../src/engine/budget/worker-tools.ts";

// The 3B region exports a narrow test seam (__registerHandle /
// __unregisterHandle) so the budget-eol.test.ts suite can seed and
// clean up the module-level workerHandles registry without going
// through the public operator-command surface. Production wiring (F13
// dashboard + dispatcher) calls the same functions directly to keep
// the registry in sync with active worker sessions.
type WorkerHandleLike = {
  agent: string;
  session: FakeSession;
  controller: AbortController;
  sessionManager: SessionManagerT;
  ledger: BudgetLedger;
  policy: unknown;
};
const registerHandle = (workerTools as unknown as { __registerHandle?: (h: WorkerHandleLike) => void })
  .__registerHandle;
const unregisterHandle = (workerTools as unknown as { __unregisterHandle?: (agent: string) => void })
  .__unregisterHandle;

// ── Test fixtures ─────────────────────────────────────

// The AgentSession interface has many internal fields the operator
// commands don't touch. We narrow the fake to just the surface area the
// commands use: abort, compact, waitForIdle, abortCompaction, dispose,
// getSessionStats, sessionId, sessionManager, subscribe (for G-04
// resume).
interface FakeSession {
  sessionId: string;
  sessionManager: SessionManagerT;
  getSessionStats: () => SessionStats;
  abort: () => Promise<void>;
  compact: (ci?: string) => Promise<unknown>;
  waitForIdle: () => Promise<void>;
  abortCompaction: () => void;
  dispose: () => void;
  subscribe: (listener: unknown) => () => void;
}

function makeFakeSession(sm: SessionManagerT, id: string): FakeSession {
  return {
    sessionId: id,
    sessionManager: sm,
    getSessionStats: () => ({
      sessionFile: undefined,
      sessionId: id,
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 0,
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
      cost: 0.015,
    }),
    abort: async () => {},
    compact: async (_ci?: string) => ({ summary: "", firstKeptEntryId: "x", tokensBefore: 150, estimatedTokensAfter: 80 }),
    waitForIdle: async () => {},
    abortCompaction: () => {},
    dispose: () => {},
    subscribe: (_listener: unknown) => () => {},
  };
}

async function makeHandle(agent: string) {
  const sm = SessionManager.inMemory("/tmp");
  const ledger = await BudgetLedger.restore(sm, agent, { worker: {}, team: {} }, new AbortController().signal);
  const controller = new AbortController();
  const session = makeFakeSession(sm, `session-${agent}`);
  const handle = {
    agent,
    session,
    controller,
    sessionManager: sm,
    ledger,
    policy: { worker: {}, team: {} },
  };
  return { handle, sm, ledger, controller, session };
}

// ── Test 1 (T5.1): endWorkerSession calls session.abort() + writes kind:"end" ──

test("T5.1: endWorkerSession calls session.abort() and writes ledger snapshot with kind:'end'", async () => {
  const { handle, sm } = await makeHandle("coder-1");
  registerHandle?.(handle);
  try {
    let abortCalled = 0;
    handle.session.abort = async () => { abortCalled += 1; };
    const result = await workerTools.endWorkerSession("coder-1", "shutdown", new AbortController().signal);
    assert.equal(abortCalled, 1, "session.abort() called exactly once");
    assert.equal(result.sessionId, "session-coder-1", "result.sessionId matches AgentSession.sessionId");
    // Ledger snapshot is the LAST pi-hive-budget-ledger CustomEntry.
    const entries = sm.getBranch().filter((e) => e.type === "custom" && e.customType === "pi-hive-budget-ledger");
    const written = entries[entries.length - 1] as unknown as { data: BudgetLedgerEntry["data"] };
    assert.equal(written.data.kind, "end", "ledger snapshot kind = 'end'");
    assert.equal(written.data.marker, "checkpoint", "ledger snapshot marker = 'checkpoint'");
    assert.equal(written.data.agentSlug, "coder-1", "ledger snapshot agentSlug = agent name");
  } finally {
    unregisterHandle?.("coder-1");
  }
});

// ── Test 2 (T5.1): endWorkerSession result.ledgerSnapshot matches the branch entry ──

test("T5.1: endWorkerSession returns ledgerSnapshot that matches the persisted CustomEntry", async () => {
  const { handle, sm } = await makeHandle("coder-2");
  registerHandle?.(handle);
  try {
    const result = await workerTools.endWorkerSession("coder-2", "shutdown", new AbortController().signal);
    assert.equal(result.ledgerSnapshot.type, "custom");
    assert.equal(result.ledgerSnapshot.customType, "pi-hive-budget-ledger");
    assert.equal(result.ledgerSnapshot.data.kind, "end");
    assert.equal(result.ledgerSnapshot.data.cumulative.tokens, 150, "cumulative.tokens reflects getSessionStats()");
    assert.equal(result.ledgerSnapshot.data.cumulative.costUsd, 0.015, "cumulative.costUsd reflects getSessionStats()");
    // Verify the entry actually persisted to the branch.
    const branchEntries = sm.getBranch().filter((e) => e.type === "custom" && e.customType === "pi-hive-budget-ledger");
    assert.equal(branchEntries.length, 1, "exactly one ledger entry was written to the branch");
  } finally {
    unregisterHandle?.("coder-2");
  }
});

// ── Test 3 (T5.1): endWorkerSession throws 'not implemented' for unregistered agent ──

test("T5.1: endWorkerSession throws an error matching /not implemented/ when no handle is registered", async () => {
  await assert.rejects(
    () => workerTools.endWorkerSession("unknown-agent", "reason", new AbortController().signal),
    /not implemented/,
  );
});

// ── Test 4 (T5.2): compactWorkerSession calls session.compact(ci?) + writes kind:"compact" ──

test("T5.2: compactWorkerSession calls session.compact(ci) with the supplied customInstructions and writes kind:'compact'", async () => {
  const { handle, sm } = await makeHandle("coder-3");
  registerHandle?.(handle);
  try {
    let receivedCi: string | undefined;
    handle.session.compact = async (ci?: string) => {
      receivedCi = ci;
      return { summary: "", firstKeptEntryId: "x", tokensBefore: 150, estimatedTokensAfter: 80 } as never;
    };
    const result = await workerTools.compactWorkerSession("coder-3", "compaction", "preserve todos", new AbortController().signal);
    assert.equal(receivedCi, "preserve todos", "session.compact() received the customInstructions argument");
    assert.equal(result.sessionId, "session-coder-3");
    const entries = sm.getBranch().filter((e) => e.type === "custom" && e.customType === "pi-hive-budget-ledger");
    const written = entries[entries.length - 1] as unknown as { data: BudgetLedgerEntry["data"] };
    assert.equal(written.data.kind, "compact", "ledger snapshot kind = 'compact'");
  } finally {
    unregisterHandle?.("coder-3");
  }
});

// ── Test 5 (T5.2): compactWorkerSession works without customInstructions or signal ──

test("T5.2: compactWorkerSession works when customInstructions and signal are both undefined", async () => {
  const { handle, sm } = await makeHandle("coder-4");
  registerHandle?.(handle);
  try {
    let compactCalled = 0;
    let receivedCi: unknown = "sentinel";
    handle.session.compact = async (ci?: string) => {
      compactCalled += 1;
      receivedCi = ci;
      return { summary: "", firstKeptEntryId: "x", tokensBefore: 150, estimatedTokensAfter: 80 } as never;
    };
    await workerTools.compactWorkerSession("coder-4", "compaction");
    assert.equal(compactCalled, 1, "session.compact() called exactly once");
    assert.equal(receivedCi, undefined, "session.compact() received undefined customInstructions");
    const entries = sm.getBranch().filter((e) => e.type === "custom" && e.customType === "pi-hive-budget-ledger");
    const written = entries[entries.length - 1] as unknown as { data: BudgetLedgerEntry["data"] };
    assert.equal(written.data.kind, "compact");
  } finally {
    unregisterHandle?.("coder-4");
  }
});

// ── Test 6 (T5.2): compactWorkerSession throws 'not implemented' for unregistered agent ──

test("T5.2: compactWorkerSession throws an error matching /not implemented/ when no handle is registered", async () => {
  await assert.rejects(
    () => workerTools.compactWorkerSession("unknown-agent", "reason"),
    /not implemented/,
  );
});

// ── Test 7 (T5.4): pauseWorkerSession calls session.waitForIdle() + writes kind:"pause" ──

test("T5.4: pauseWorkerSession calls session.waitForIdle() and writes ledger snapshot with kind:'pause'", async () => {
  const { handle, sm } = await makeHandle("coder-5");
  registerHandle?.(handle);
  try {
    let waitForIdleCalled = 0;
    handle.session.waitForIdle = async () => { waitForIdleCalled += 1; };
    const result = await workerTools.pauseWorkerSession("coder-5", "pause", new AbortController().signal);
    assert.equal(waitForIdleCalled, 1, "session.waitForIdle() called exactly once");
    assert.equal(result.sessionId, "session-coder-5");
    const entries = sm.getBranch().filter((e) => e.type === "custom" && e.customType === "pi-hive-budget-ledger");
    const written = entries[entries.length - 1] as unknown as { data: BudgetLedgerEntry["data"] };
    assert.equal(written.data.kind, "pause", "ledger snapshot kind = 'pause'");
    assert.equal(written.data.marker, "checkpoint");
  } finally {
    unregisterHandle?.("coder-5");
  }
});

// ── Test 8 (T5.4): pauseWorkerSession does NOT call session.dispose() ──

test("T5.4: pauseWorkerSession does NOT call session.dispose() (listeners stay attached for resume)", async () => {
  const { handle } = await makeHandle("coder-6");
  registerHandle?.(handle);
  try {
    let disposeCalled = 0;
    handle.session.dispose = () => { disposeCalled += 1; };
    await workerTools.pauseWorkerSession("coder-6", "pause", new AbortController().signal);
    assert.equal(disposeCalled, 0, "session.dispose() NOT called from pause (operators can still resume)");
  } finally {
    unregisterHandle?.("coder-6");
  }
});

// ── Test 9 (T5.4): pauseWorkerSession throws 'not implemented' for unregistered agent ──

test("T5.4: pauseWorkerSession throws an error matching /not implemented/ when no handle is registered", async () => {
  await assert.rejects(
    () => workerTools.pauseWorkerSession("unknown-agent", "reason", new AbortController().signal),
    /not implemented/,
  );
});

// ── Test 10 (T5.8): resumeWorkerSession writes kind:"resume" ──

test("T5.8: resumeWorkerSession writes ledger snapshot with kind:'resume'", async () => {
  const { handle, sm } = await makeHandle("coder-7");
  registerHandle?.(handle);
  try {
    const result = await workerTools.resumeWorkerSession("coder-7", new AbortController().signal);
    assert.equal(result.sessionId, "session-coder-7");
    const entries = sm.getBranch().filter((e) => e.type === "custom" && e.customType === "pi-hive-budget-ledger");
    const written = entries[entries.length - 1] as unknown as { data: BudgetLedgerEntry["data"] };
    assert.equal(written.data.kind, "resume", "ledger snapshot kind = 'resume'");
    assert.equal(written.data.marker, "checkpoint");
  } finally {
    unregisterHandle?.("coder-7");
  }
});

// ── Test 11 (T5.8): resumeWorkerSession re-attaches budget event hooks (G-04) ──

test("T5.8: resumeWorkerSession re-attaches budget event hooks on the existing session (G-04)", async () => {
  const { handle } = await makeHandle("coder-8");
  registerHandle?.(handle);
  try {
    // The re-attach call delegates to installBudgetEventHooks; we assert
    // it does NOT throw (the SDK call succeeds against the fake
    // session.subscribe / getSessionStats surface). If the install
    // path raises, the operator command's await rejects.
    let observerCount = 0;
    handle.session.subscribe = ((_listener: unknown) => {
      observerCount += 1;
      return () => {};
    }) as never;
    await workerTools.resumeWorkerSession("coder-8", new AbortController().signal);
    assert.ok(observerCount >= 1, "session.subscribe was called by resumeWorkerSession's re-attach");
  } finally {
    unregisterHandle?.("coder-8");
  }
});

// ── Test 12 (T5.8): resumeWorkerSession throws 'not implemented' for unregistered agent ──

test("T5.8: resumeWorkerSession throws an error matching /not implemented/ when no handle is registered", async () => {
  await assert.rejects(
    () => workerTools.resumeWorkerSession("unknown-agent", new AbortController().signal),
    /not implemented/,
  );
});

// ── Test 13 (T5.9): abortWorkerCompaction calls session.abortCompaction() + writes kind:"compact-aborted" ──

test("T5.9: abortWorkerCompaction calls session.abortCompaction() and writes ledger snapshot with kind:'compact-aborted'", async () => {
  const { handle, sm } = await makeHandle("coder-9");
  registerHandle?.(handle);
  try {
    let abortCompactionCalled = 0;
    handle.session.abortCompaction = () => { abortCompactionCalled += 1; };
    const result = await workerTools.abortWorkerCompaction("coder-9", new AbortController().signal);
    assert.equal(abortCompactionCalled, 1, "session.abortCompaction() called exactly once");
    assert.equal(result.sessionId, "session-coder-9");
    const entries = sm.getBranch().filter((e) => e.type === "custom" && e.customType === "pi-hive-budget-ledger");
    const written = entries[entries.length - 1] as unknown as { data: BudgetLedgerEntry["data"] };
    assert.equal(written.data.kind, "compact-aborted", "ledger snapshot kind = 'compact-aborted'");
  } finally {
    unregisterHandle?.("coder-9");
  }
});

// ── Test 14 (T5.9): abortWorkerCompaction does NOT call session.dispose() or session.abort() ──

test("T5.9: abortWorkerCompaction does NOT call session.abort() or session.dispose() (in-flight turn continues)", async () => {
  const { handle } = await makeHandle("coder-10");
  registerHandle?.(handle);
  try {
    let abortCalled = 0;
    let disposeCalled = 0;
    handle.session.abort = async () => { abortCalled += 1; };
    handle.session.dispose = () => { disposeCalled += 1; };
    await workerTools.abortWorkerCompaction("coder-10", new AbortController().signal);
    assert.equal(abortCalled, 0, "session.abort() NOT called from abortCompaction");
    assert.equal(disposeCalled, 0, "session.dispose() NOT called from abortCompaction");
  } finally {
    unregisterHandle?.("coder-10");
  }
});

// ── Test 15 (T5.9): abortWorkerCompaction throws 'not implemented' for unregistered agent ──

test("T5.9: abortWorkerCompaction throws an error matching /not implemented/ when no handle is registered", async () => {
  await assert.rejects(
    () => workerTools.abortWorkerCompaction("unknown-agent", new AbortController().signal),
    /not implemented/,
  );
});

// ── Test 16 (T5.13): forceKillWorkerSession calls controller.abort + session.dispose + writes kind:"force-kill" ──

test("T5.13: forceKillWorkerSession calls controller.abort() AND session.dispose() and writes kind:'force-kill'", async () => {
  const { handle, sm, controller } = await makeHandle("coder-11");
  registerHandle?.(handle);
  try {
    let disposeCalled = 0;
    handle.session.dispose = () => { disposeCalled += 1; };
    const result = await workerTools.forceKillWorkerSession("coder-11", "stuck", new AbortController().signal);
    assert.equal(controller.signal.aborted, true, "controller.abort() fired (signal is aborted)");
    assert.equal(disposeCalled, 1, "session.dispose() called exactly once");
    assert.equal(result.sessionId, "session-coder-11");
    const entries = sm.getBranch().filter((e) => e.type === "custom" && e.customType === "pi-hive-budget-ledger");
    const written = entries[entries.length - 1] as unknown as { data: BudgetLedgerEntry["data"] };
    assert.equal(written.data.kind, "force-kill", "ledger snapshot kind = 'force-kill'");
  } finally {
    unregisterHandle?.("coder-11");
  }
});

// ── Test 17 (T5.13): forceKillWorkerSession writes force-kill snapshot BEFORE dispose (order test) ──

test("T5.13: forceKillWorkerSession writes force-kill snapshot BEFORE session.dispose() (audit trail intact)", async () => {
  const { handle, sm } = await makeHandle("coder-12");
  registerHandle?.(handle);
  try {
    const callOrder: string[] = [];
    handle.session.dispose = () => { callOrder.push("dispose"); };
    handle.ledger.snapshot = ((...args: unknown[]) => {
      callOrder.push("snapshot");
      return (BudgetLedger.prototype.snapshot as (...a: unknown[]) => BudgetLedgerEntry).call(handle.ledger, ...args);
    }) as never;
    await workerTools.forceKillWorkerSession("coder-12", "stuck", new AbortController().signal);
    // snapshot() is called BEFORE dispose() in the production code;
    // if a future refactor reverses the order, the dispose() may race
    // with the branch write and lose the audit-trail entry.
    assert.deepEqual(callOrder, ["snapshot", "dispose"], "snapshot() called BEFORE dispose()");
    const entries = sm.getBranch().filter((e) => e.type === "custom" && e.customType === "pi-hive-budget-ledger");
    assert.ok(entries.length >= 1, "force-kill snapshot landed in the branch (not lost to dispose)");
  } finally {
    unregisterHandle?.("coder-12");
  }
});

// ── Test 18 (T5.13): forceKillWorkerSession does NOT call session.waitForIdle() (operator escape hatch) ──

test("T5.13: forceKillWorkerSession does NOT call session.waitForIdle() (operator does not wait for the worker)", async () => {
  const { handle } = await makeHandle("coder-13");
  registerHandle?.(handle);
  try {
    let waitForIdleCalled = 0;
    handle.session.waitForIdle = async () => { waitForIdleCalled += 1; };
    await workerTools.forceKillWorkerSession("coder-13", "stuck", new AbortController().signal);
    assert.equal(waitForIdleCalled, 0, "session.waitForIdle() NOT called from forceKillWorkerSession (no waiting)");
  } finally {
    unregisterHandle?.("coder-13");
  }
});

// ── Test 19 (T5.14): tearDownAllWorkers({force:false}) iterates and calls endWorkerSession per worker ──

test("T5.14: tearDownAllWorkers({force:false}) iterates and calls endWorkerSession per worker", async () => {
  const { handle: h1 } = await makeHandle("coder-14a");
  const { handle: h2 } = await makeHandle("coder-14b");
  registerHandle?.(h1);
  registerHandle?.(h2);
  try {
    let abortCount = 0;
    h1.session.abort = async () => { abortCount += 1; };
    h2.session.abort = async () => { abortCount += 1; };
    const result = await workerTools.tearDownAllWorkers("shutdown", { force: false }, new AbortController().signal);
    assert.equal(abortCount, 2, "endWorkerSession (via session.abort) called per registered worker");
    assert.deepEqual(result.stopped.sort(), ["coder-14a", "coder-14b"], "stopped list contains both workers");
    assert.equal(result.skipped.length, 0, "no workers skipped on the graceful path");
  } finally {
    unregisterHandle?.("coder-14a");
    unregisterHandle?.("coder-14b");
  }
});

// ── Test 20 (T5.14): tearDownAllWorkers({force:true}) falls back to forceKillWorkerSession per worker ──

test("T5.14: tearDownAllWorkers({force:true}) falls back to forceKillWorkerSession per worker", async () => {
  const { handle: h1, controller: c1 } = await makeHandle("coder-15a");
  const { handle: h2, controller: c2 } = await makeHandle("coder-15b");
  registerHandle?.(h1);
  registerHandle?.(h2);
  try {
    let disposeCount = 0;
    h1.session.dispose = () => { disposeCount += 1; };
    h2.session.dispose = () => { disposeCount += 1; };
    const result = await workerTools.tearDownAllWorkers("shutdown", { force: true }, new AbortController().signal);
    assert.equal(c1.signal.aborted, true, "h1 controller.abort() fired via forceKillWorkerSession");
    assert.equal(c2.signal.aborted, true, "h2 controller.abort() fired via forceKillWorkerSession");
    assert.equal(disposeCount, 2, "session.dispose() called for each worker via forceKillWorkerSession");
    assert.deepEqual(result.stopped.sort(), ["coder-15a", "coder-15b"], "stopped list contains both workers");
  } finally {
    unregisterHandle?.("coder-15a");
    unregisterHandle?.("coder-15b");
  }
});

// ── Test 21 (T5.14): tearDownAllWorkers writes team-level snapshot kind:"tear-down-all" with agentSlug:"__team__" ──

test("T5.14: tearDownAllWorkers writes a team-level ledger snapshot with kind:'tear-down-all' and agentSlug:'__team__'", async () => {
  const { handle } = await makeHandle("coder-16");
  registerHandle?.(handle);
  try {
    const result = await workerTools.tearDownAllWorkers("shutdown", { force: false }, new AbortController().signal);
    assert.equal(result.ledgerSnapshot.data.kind, "tear-down-all", "ledger snapshot kind = 'tear-down-all'");
    assert.equal(result.ledgerSnapshot.data.agentSlug, "__team__", "ledger snapshot agentSlug = '__team__'");
    assert.equal(result.ledgerSnapshot.data.marker, "checkpoint");
  } finally {
    unregisterHandle?.("coder-16");
  }
});

// ── Test 22 (T5.15): forceEndWorkerSession calls session.abort() + session.dispose() + writes kind:"force-end" ──

test("T5.15: forceEndWorkerSession calls session.abort() AND session.dispose() and writes kind:'force-end'", async () => {
  const { handle, sm } = await makeHandle("coder-17");
  registerHandle?.(handle);
  try {
    let abortCalled = 0;
    let disposeCalled = 0;
    handle.session.abort = async () => { abortCalled += 1; };
    handle.session.dispose = () => { disposeCalled += 1; };
    const result = await workerTools.forceEndWorkerSession("coder-17", "shutdown", new AbortController().signal);
    assert.equal(abortCalled, 1, "session.abort() called exactly once (lets in-flight turn settle)");
    assert.equal(disposeCalled, 1, "session.dispose() called exactly once (closes listener leak)");
    assert.equal(result.sessionId, "session-coder-17");
    const entries = sm.getBranch().filter((e) => e.type === "custom" && e.customType === "pi-hive-budget-ledger");
    const written = entries[entries.length - 1] as unknown as { data: BudgetLedgerEntry["data"] };
    assert.equal(written.data.kind, "force-end", "ledger snapshot kind = 'force-end'");
  } finally {
    unregisterHandle?.("coder-17");
  }
});

// ── Test 23 (T5.15): forceEndWorkerSession calls session.abort() BEFORE session.dispose() ──

test("T5.15: forceEndWorkerSession calls session.abort() BEFORE session.dispose() (in-flight turn allowed to settle)", async () => {
  const { handle } = await makeHandle("coder-18");
  registerHandle?.(handle);
  try {
    const callOrder: string[] = [];
    handle.session.abort = async () => { callOrder.push("abort"); };
    handle.session.dispose = () => { callOrder.push("dispose"); };
    await workerTools.forceEndWorkerSession("coder-18", "shutdown", new AbortController().signal);
    assert.deepEqual(callOrder, ["abort", "dispose"], "abort() called BEFORE dispose() (settle-before-cleanup)");
  } finally {
    unregisterHandle?.("coder-18");
  }
});

// ── Test 24 (T5.15): forceEndWorkerSession throws 'not implemented' for unregistered agent ──

test("T5.15: forceEndWorkerSession throws an error matching /not implemented/ when no handle is registered", async () => {
  await assert.rejects(
    () => workerTools.forceEndWorkerSession("unknown-agent", "reason", new AbortController().signal),
    /not implemented/,
  );
});
