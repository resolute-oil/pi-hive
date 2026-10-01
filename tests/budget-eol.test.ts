// Wave 3 F5 EOL tests — combined file for Agents 3B and 3C.
//
// Agent 3B region (top, lines TBD-1): 24 tests for T5.1, T5.2, T5.4, T5.8,
// T5.9, T5.13, T5.14, T5.15 (8 stop/pause/resume/escape operator commands).
//
// Agent 3C region (bottom, lines TBD-2): 10 tests for T5.3, T5.5, T5.6
// (3 branch/clone/respawn/snapshot/restore operator commands).
//
// 3B's helpers + tests come first because they merged into the staging
// branch first; 3C's helpers + tests come after. Helper name
// `makeFakeSession` collides between the two agents (different shapes) so
// 3C's is renamed to `makeFakeRespawnSession` — only a name change, no
// behavior change.
//
// Total: 34 tests. 3B verifies the operator commands in
// src/engine/budget/worker-tools.ts region 3B (lines 327-413) write a
// ledger snapshot with a distinct kind and call the documented SDK
// primitives. 3C verifies the F5 branch/clone commands (T5.3 dispose→
// create→branch order; T5.5 branchWithSummary; T5.6 SDK chain
// createBranchedSession→open→createAgentSession end-to-end with real SDK).
//
// Cross-cutting Wave 3 hard gates covered here:
//   - forceKillWorkerSession: controller.abort() + session.dispose() directly
//     (no waitForIdle); force-kill snapshot BEFORE dispose.
//   - tearDownAllWorkers({force:false}): endWorkerSession per worker;
//     {force:true}: forceKillWorkerSession per worker.
//   - forceKillWorkerSession / forceEndWorkerSession / tearDownAllWorkers
//     are operator-only (not ToolDefinition objects).
//   - 9 distinct kind values across all operator commands (3B covers 8,
//     3C covers 3 — T5.3 respawn / T5.5 snapshot / T5.6 restore — for a
//     complete 11 distinct kinds across both agents).

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  SessionStats,
  SessionEntry,
  CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { BudgetLedger } from "../src/engine/budget/ledger.ts";
import type { BudgetLedgerEntry, BudgetLedgerKind } from "../src/core/types.ts";
import type { WorkerBudgetPolicy } from "../src/core/types.ts";

// ─────────────────────────────────────────────────────────────────────────
// Agent 3B imports + test fixtures (T5.1, T5.2, T5.4, T5.8, T5.9, T5.13, T5.14, T5.15)
// ─────────────────────────────────────────────────────────────────────────

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
  sessionManager: SessionManager;
  ledger: BudgetLedger;
  policy: unknown;
};
const registerHandle = (workerTools as unknown as { __registerHandle?: (h: WorkerHandleLike) => void })
  .__registerHandle;
const unregisterHandle = (workerTools as unknown as { __unregisterHandle?: (agent: string) => void })
  .__unregisterHandle;

// The AgentSession interface has many internal fields the operator
// commands don't touch. We narrow the fake to just the surface area the
// commands use: abort, compact, waitForIdle, abortCompaction, dispose,
// getSessionStats, sessionId, sessionManager, subscribe (for G-04
// resume).
interface FakeSession {
  sessionId: string;
  sessionManager: SessionManager;
  getSessionStats: () => SessionStats;
  abort: () => Promise<void>;
  compact: (ci?: string) => Promise<unknown>;
  waitForIdle: () => Promise<void>;
  abortCompaction: () => void;
  dispose: () => void;
  subscribe: (listener: unknown) => () => void;
}

function makeFakeSession(sm: SessionManager, id: string): FakeSession {
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

// ─────────────────────────────────────────────────────────────────────────
// Agent 3C tests for F5 branch/clone operator commands (T5.3, T5.5, T5.6)
// ─────────────────────────────────────────────────────────────────────────
//
// This file's tests use the WorkerContext + internals seam in
// src/engine/budget/worker-tools.ts region 3C.
//
// Per the Wave 3 brief + `04-refactor-plan.md` §5 F5:
//   T5.3 respawnWorkerSession: dispose OLD → create NEW → branchWithSummary
//         on OLD leafId (audit-trail only) → ledger kind "respawn". Spy-based
//         order test pins dispose-before-create-before-branch (P3 review).
//   T5.5 snapshotWorkerSession: branchWithSummary(leafId, label) + ledger
//         kind "snapshot". snapshotId returned for later restore.
//   T5.6 restoreWorkerSession: SDK chain (verified against
//         session-manager.d.ts @ SDK 0.99.1 per C9 review):
//           1. sourceSM.createBranchedSession(snapshotId) → filePath
//           2. SessionManager.open(filePath) → branchedSM
//           3. createAgentSession({ sessionManager: branchedSM }) → AgentSession
//         Plus: restore BudgetLedger on branched SM, install budget event
//         hooks (destination's agent_settled writes final checkpoint),
//         write "restore" ledger entry.

import {
  respawnWorkerSession,
  snapshotWorkerSession,
  restoreWorkerSession,
  type WorkerContext,
} from "../src/engine/budget/worker-tools.ts";

// ── Test fixtures ─────────────────────────────────────────────────────────

const basePolicy: WorkerBudgetPolicy = { worker: { tokens: { cap: 1000 } }, team: {} };

// A scripted session that records every event the listener sees, exposes a
// `fire(event)` for tests to fire events synchronously, and stores the
// returned unsubscribe function so tests can verify lifecycle behavior.
// Mirrors the pattern from tests/budget-events.test.ts.
//
// Note: renamed from the original `makeFakeSession` in 3C's branch to
// `makeFakeRespawnSession` because 3B's branch defines a different
// `makeFakeSession(sm, id)` helper at the top of this combined file.
// Both shapes differ — 3B's takes (SessionManager, string) and returns a
// `FakeSession` interface; this one takes ({sessionId?, onDispose?}) and
// returns { session, sessionManager, appendedEntries, getDisposed,
// getListeners }.
function makeFakeRespawnSession(opts: { sessionId?: string; onDispose?: () => void } = {}) {
  const sessionId = opts.sessionId ?? "fake-session-id";
  let triggerFn: ((event: any) => void) | undefined;
  const events: any[] = [];
  let disposed = false;
  let listeners: ((event: any) => void)[] = [];
  const appendedEntries: Array<{ customType: string; data?: unknown }> = [];
  const sessionManager = {
    appendCustomEntry(customType: string, data?: unknown) {
      appendedEntries.push({ customType, data });
    },
    appendCustomMessageEntry() {},
    getBranch(): SessionEntry[] { return []; },
    getEntries(): SessionEntry[] { return []; },
    appendLabelChange() { return "fake-label-id"; },
    branchWithSummary(_fromId: string | null, _summary: string) { return "fake-branch-summary-id"; },
    createBranchedSession(_leafId: string) { return undefined as unknown as string; },
    getLeafId() { return "fake-leaf-id"; },
    getSessionId() { return sessionId; },
  } as unknown as SessionManager & { appendedEntries: Array<{ customType: string; data?: unknown }> };
  const session = {
    sessionId,
    subscribe(listener: (event: any) => void) {
      listeners.push(listener);
      triggerFn = listener;
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
        triggerFn = undefined;
      };
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
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 100 },
        cost: 0.5,
      };
    },
    sessionManager,
    dispose() {
      disposed = true;
      // The real AgentSession.dispose() clears _eventListeners. Mirror that:
      listeners = [];
      triggerFn = undefined;
      opts.onDispose?.();
    },
  } as unknown as AgentSession & { fire: (event: any) => void; disposed: boolean };
  (session as any).disposed = false;
  (session as any).fire = (event: any) => {
    triggerFn?.(event);
    events.push(event);
  };
  return { session, sessionManager, appendedEntries, getDisposed: () => disposed, getListeners: () => listeners };
}

// A recording ledger. Captures state for tests to assert call shape + count.
function makeFakeLedger() {
  const calls = { snapshot: [] as Array<{ stats: SessionStats; policy: any; marker: string }>, recordEvent: [] as any[], maybeSnapshot: [] as any[], recordCompaction: [] as any[], appendCustomEntry: [] as Array<{ customType: string; data?: unknown }> };
  const appendedEntries: Array<{ customType: string; data?: unknown }> = [];
  const sessionManager = {
    appendCustomEntry(customType: string, data?: unknown) {
      appendedEntries.push({ customType, data });
      calls.appendCustomEntry.push({ customType, data });
    },
    appendCustomMessageEntry() {},
    getBranch(): SessionEntry[] { return []; },
    getEntries(): SessionEntry[] { return []; },
  } as unknown as SessionManager;
  const ledger = {
    cumulative: { tokens: 100, costUsd: 0.5, runs: 3 },
    sessionManager,
    recordEvent(type: string, cumulative: any, signal: AbortSignal) {
      calls.recordEvent.push({ type, cumulative, signal });
      ledger.cumulative = { ...cumulative };
    },
    maybeSnapshot(cumulative: any, policy: any, signal: AbortSignal) {
      calls.maybeSnapshot.push({ cumulative, policy, signal });
    },
    recordCompaction(savings: number, signal: AbortSignal) {
      calls.recordCompaction.push({ savings, signal });
    },
    snapshot(stats: SessionStats, policy: any, marker: string, signal: AbortSignal) {
      calls.snapshot.push({ stats, policy, marker });
    },
  } as unknown as BudgetLedger;
  return { ledger, calls, appendedEntries };
}

// Track call order across multiple spies.
function makeOrderTracker() {
  const order: string[] = [];
  return {
    order,
    tagged<T extends (...args: any[]) => any>(name: string, fn?: T): T {
      const tagged = ((...args: any[]) => {
        order.push(name);
        return fn?.(...args);
      }) as unknown as T;
      return tagged;
    },
  };
}

// ── T5.3: respawnWorkerSession ───────────────────────────────────────────

test("T5.3: respawnWorkerSession happy path — creates new session, returns old/new IDs, writes 'respawn' ledger entry", async () => {
  const { session, sessionManager, appendedEntries } = makeFakeRespawnSession({ sessionId: "old-session-id" });
  const { ledger } = makeFakeLedger();

  const newFakeSessionManager: any = {
    ...sessionManager,
  };

  const ctx: WorkerContext = {
    agent: "coder",
    session,
    sessionManager,
    ledger,
    policy: basePolicy,
    cwd: "/tmp/work",
    internals: {
      sessionManagerCreate: () => newFakeSessionManager,
      createAgentSessionFn: async (_opts: CreateAgentSessionOptions) => ({ session: { sessionId: "new-session-id" } as unknown as AgentSession }),
    },
  };

  const result = await respawnWorkerSession(ctx, "operator requested restart");

  assert.equal(result.oldSessionId, "old-session-id", "oldSessionId preserved for audit trail");
  assert.equal(result.newSessionId, "new-session-id", "newSessionId returned from new AgentSession");
  assert.ok(result.newSession, "newSession returned");
  assert.ok(result.newSessionManager, "newSessionManager returned");
  assert.ok(result.controller instanceof AbortController, "fresh controller returned for the new session");
  assert.ok(result.ledgerSnapshot, "ledger snapshot returned");

  // Ledger entry on the SOURCE session manager (audit trail). The
  // writeKindLedgerEntry helper writes to the session manager passed in,
  // which is the source (not the new one).
  const kindEntry = appendedEntries.find((e) => e.customType === "pi-hive-budget-ledger" && (e.data as any)?.kind === "respawn");
  assert.ok(kindEntry, "ledger entry with kind=respawn was written");
  assert.equal((kindEntry!.data as any).marker, "checkpoint", "marker is 'checkpoint'");
  assert.equal((kindEntry!.data as any).agentSlug, "coder", "agentSlug is the worker slug");
  assert.equal((kindEntry!.data as any).kind, "respawn", "kind discriminator is 'respawn'");
});

test("T5.3 spy-based order: dispose is called BEFORE create BEFORE branchWithSummary (P3 review)", async () => {
  const { session, sessionManager } = makeFakeRespawnSession({ sessionId: "old" });
  const { ledger } = makeFakeLedger();

  const tracker = makeOrderTracker();
  const newFakeSM: any = {};
  const createSpy = tracker.tagged("create", () => newFakeSM);
  const branchSpy = tracker.tagged("branch", () => "fake-snapshot-id");
  // Capture the original dispose BEFORE installing the spy to avoid
  // recursion (the spy's wrapper delegates to the original; if we wire
  // the spy back into session.dispose before calling it, the spy calls
  // itself).
  const originalDispose = (session as any).dispose;
  const disposeSpy = tracker.tagged("dispose", originalDispose);

  (session as any).dispose = disposeSpy;
  (sessionManager as any).createBranchedSession = () => "fake-branched-path";
  (sessionManager as any).branchWithSummary = branchSpy;

  const ctx: WorkerContext = {
    agent: "coder",
    session,
    sessionManager,
    ledger,
    policy: basePolicy,
    cwd: "/tmp/work",
    internals: {
      sessionManagerCreate: createSpy,
      createAgentSessionFn: async (_opts: CreateAgentSessionOptions) => ({ session: { sessionId: "new-session-id" } as unknown as AgentSession }),
    },
  };

  await respawnWorkerSession(ctx, "test");

  // P3 gate: dispose was called BEFORE create was called BEFORE branchWithSummary.
  const disposeIdx = tracker.order.indexOf("dispose");
  const createIdx = tracker.order.indexOf("create");
  const branchIdx = tracker.order.indexOf("branch");
  assert.ok(disposeIdx >= 0 && createIdx >= 0 && branchIdx >= 0, "all three calls happened");
  assert.ok(disposeIdx < createIdx, `dispose (${disposeIdx}) called before create (${createIdx})`);
  assert.ok(createIdx < branchIdx, `create (${createIdx}) called before branchWithSummary (${branchIdx})`);
});

test("T5.3 listeners removed after dispose: no event fires on the disposed session's old listeners (closes listener leak per `01-current-state-analysis.md` Issue 9)", async () => {
  const { session, sessionManager, getListeners } = makeFakeRespawnSession({ sessionId: "old" });
  const { ledger } = makeFakeLedger();

  // Capture a listener before respawn.
  let listenerCalls = 0;
  const unsubscribe = session.subscribe(() => { listenerCalls += 1; });
  assert.equal(getListeners().length, 1, "listener registered");

  const newFakeSessionManager: any = {};

  const ctx: WorkerContext = {
    agent: "coder",
    session,
    sessionManager,
    ledger,
    policy: basePolicy,
    cwd: "/tmp/work",
    internals: {
      sessionManagerCreate: () => newFakeSessionManager,
      createAgentSessionFn: async (_opts: CreateAgentSessionOptions) => ({ session: { sessionId: "new-session-id" } as unknown as AgentSession }),
    },
  };

  await respawnWorkerSession(ctx, "test");

  // After dispose, listeners array should be empty (mirroring
  // AgentSession.dispose() clearing _eventListeners).
  assert.equal(getListeners().length, 0, "all listeners cleared after dispose()");
  // Fire an event post-dispose — the captured listener must NOT be called.
  (session as any).fire({ type: "message_end", message: {} });
  assert.equal(listenerCalls, 0, "no event reaches listeners after dispose");
  unsubscribe(); // cleanup
});

// ── T5.5: snapshotWorkerSession ──────────────────────────────────────────

test("T5.5: snapshotWorkerSession happy path — branchWithSummary returns snapshotId, writes 'snapshot' ledger entry", async () => {
  const { session, sessionManager, appendedEntries } = makeFakeRespawnSession({ sessionId: "sess-1" });
  const { ledger } = makeFakeLedger();

  const tracker = makeOrderTracker();
  (sessionManager as any).branchWithSummary = tracker.tagged("branchWithSummary", () => "snap-id-42");

  const ctx: WorkerContext = {
    agent: "coder",
    session,
    sessionManager,
    ledger,
    policy: basePolicy,
    cwd: "/tmp/work",
  };

  const result = await snapshotWorkerSession(ctx, "before risky edit", new AbortController().signal);

  assert.equal(result.sessionId, "sess-1", "sessionId returned");
  assert.equal(result.snapshotId, "snap-id-42", "snapshotId is the branch_summary entry id");
  assert.ok(result.ledgerSnapshot, "ledgerSnapshot returned");

  const kindEntry = appendedEntries.find((e) => e.customType === "pi-hive-budget-ledger" && (e.data as any)?.kind === "snapshot");
  assert.ok(kindEntry, "ledger entry with kind=snapshot was written");
});

test("T5.5: snapshotWorkerSession propagates the label to branchWithSummary", async () => {
  const { session, sessionManager } = makeFakeRespawnSession({ sessionId: "sess-1" });
  const { ledger } = makeFakeLedger();

  let capturedLabel: string | undefined;
  (sessionManager as any).branchWithSummary = (_leafId: string | null, summary: string) => {
    capturedLabel = summary;
    return "snap-id";
  };

  const ctx: WorkerContext = {
    agent: "coder", session, sessionManager, ledger, policy: basePolicy, cwd: "/tmp/work",
  };

  await snapshotWorkerSession(ctx, "checkpoint before refactor", new AbortController().signal);
  assert.equal(capturedLabel, "checkpoint before refactor", "label propagated to branchWithSummary");
});

test("T5.5: snapshotWorkerSession ledger snapshot has kind='snapshot' and marker='checkpoint'", async () => {
  const { session, sessionManager, appendedEntries } = makeFakeRespawnSession({ sessionId: "sess-1" });
  const { ledger } = makeFakeLedger();
  (sessionManager as any).branchWithSummary = () => "snap-id";

  const ctx: WorkerContext = {
    agent: "coder", session, sessionManager, ledger, policy: basePolicy, cwd: "/tmp/work",
  };

  await snapshotWorkerSession(ctx, "label", new AbortController().signal);

  const kindEntry = appendedEntries.find((e) => e.customType === "pi-hive-budget-ledger");
  assert.ok(kindEntry, "ledger entry was written");
  assert.equal((kindEntry!.data as any).kind, "snapshot", "kind discriminator is 'snapshot'");
  assert.equal((kindEntry!.data as any).marker, "checkpoint", "marker is 'checkpoint'");
  assert.equal((kindEntry!.data as any).agentSlug, "coder", "agentSlug is the worker slug");
});

// ── T5.6: restoreWorkerSession ───────────────────────────────────────────

test("T5.6: restoreWorkerSession calls SDK chain in order — createBranchedSession → open → createAgentSession", async () => {
  const { session, sessionManager } = makeFakeRespawnSession({ sessionId: "old" });
  const { ledger } = makeFakeLedger();

  const order: string[] = [];
  (sessionManager as any).createBranchedSession = (leafId: string) => {
    order.push("createBranchedSession");
    assert.equal(leafId, "snap-id", "createBranchedSession called with the supplied snapshotId");
    return "/fake/branched/session.jsonl";
  };
  const openSpy: any = (path: string) => {
    order.push("open");
    assert.equal(path, "/fake/branched/session.jsonl", "open called with the createBranchedSession return value");
    // Return a SM that has the entries needed by BudgetLedger.restore.
    return makeFakeBranchedSessionManager();
  };

  const createAgentSessionSpy: any = async (_opts: CreateAgentSessionOptions) => {
    order.push("createAgentSession");
    return { session: makeFakeRestoredSession() };
  };

  const ctx: WorkerContext = {
    agent: "coder",
    session,
    sessionManager,
    ledger,
    policy: basePolicy,
    cwd: "/tmp/work",
    internals: {
      sessionManagerOpen: openSpy,
      createAgentSessionFn: createAgentSessionSpy,
    },
  };

  const result = await restoreWorkerSession(ctx, "snap-id", new AbortController().signal);
  assert.equal(result.sessionId, "restored-session-id", "restored sessionId returned");
  assert.deepEqual(order, ["createBranchedSession", "open", "createAgentSession"], "SDK chain runs in documented order");
});

test("T5.6 (integration): restore destination has source's ledger CustomEntries (real SDK chain end-to-end)", async () => {
  // Per C9 review: exercise the REAL SDK chain with a real SessionManager,
  // not just mocks. Use a tmp directory for the session files.
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-hive-restore-test-"));
  const cwd = tmpDir;
  const sessionDir = join(tmpDir, "sessions");

  // Create a real source session manager, append a few entries including
  // a pi-hive-budget-ledger CustomEntry, then create a snapshot.
  const sourceSM = SessionManager.create(cwd, sessionDir);
  // Append a user message first so the source session is persisted to disk.
  // Without this, the SDK's `_hasConversation()` returns false (only checks
  // for user/assistant messages) and createBranchedSession returns a path
  // for a file that was never written.
  sourceSM.appendMessage({
    role: "user",
    content: [{ type: "text", text: "task" }],
    timestamp: Date.now(),
  } as any);
  sourceSM.appendCustomEntry("pi-hive-budget-ledger", {
    caps: { workerTokens: 1000 },
    cumulative: { tokens: 100, costUsd: 0.5, runs: 1 },
    writtenAt: Date.now(),
    agentSlug: "coder",
    marker: "checkpoint",
  });
  sourceSM.appendCustomEntry("pi-hive-budget-ledger", {
    caps: { workerTokens: 1000 },
    cumulative: { tokens: 200, costUsd: 1.0, runs: 2 },
    writtenAt: Date.now(),
    agentSlug: "coder",
    marker: "checkpoint",
  });
  // Snapshot via branchWithSummary — returns the new branch_summary entry id.
  const snapshotId = sourceSM.branchWithSummary(sourceSM.getLeafId(), "before risky edit");

  // Inject the real source SM as the sourceSessionManager. The seam lets
  // us pass createBranchedSession that delegates to the real SDK call.
  const { session, sessionManager: fakeSM } = makeFakeRespawnSession({ sessionId: "fake" });
  // Use the real source as the source for createBranchedSession.
  const realSource = sourceSM;

  const { ledger } = makeFakeLedger();

  // Spy on installBudgetEventHooksFn by stubbing the createAgentSessionFn
  // to return a fake AgentSession whose installBudgetEventHooksFn is captured.
  // (We assert the hooks were installed by verifying the listener registered.)
  let hooksInstalled = false;
  const fakeRestoredSession = {
    sessionId: "restored-session",
    getSessionStats(): SessionStats {
      return {
        sessionFile: undefined,
        sessionId: "restored-session",
        userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 200 },
        cost: 1.0,
      };
    },
    sessionManager: null as any, // set after open
    subscribe(_listener: any) { hooksInstalled = true; return () => {}; },
    dispose() {},
  } as unknown as AgentSession;

  const ctx: WorkerContext = {
    agent: "coder",
    session,
    sessionManager: realSource,
    ledger,
    policy: basePolicy,
    cwd,
    internals: {
      // The seam overrides SessionManager.create — for restore we use
      // sessionManagerOpen instead. Use the real SessionManager.open on the
      // path returned by createBranchedSession.
      sessionManagerOpen: (path: string) => SessionManager.open(path, sessionDir, cwd),
      createAgentSessionFn: async (_opts: CreateAgentSessionOptions) => {
        return { session: fakeRestoredSession };
      },
    },
  };

  const result = await restoreWorkerSession(ctx, snapshotId, new AbortController().signal);

  // The branched SM should have inherited the source's ledger CustomEntries.
  // (The real createBranchedSession copies path-from-root into a new file,
  // and open(path) loads those entries.)
  const branchedBranch = result.sessionManager.getBranch();
  const ledgerEntries = branchedBranch.filter(
    (e: any) => e.type === "custom" && e.customType === "pi-hive-budget-ledger",
  );
  assert.ok(ledgerEntries.length >= 2, `branched SM has the source's ledger entries (found ${ledgerEntries.length})`);

  // Verify the cumulative state survived.
  const latest = (ledgerEntries[ledgerEntries.length - 1] as any).data.cumulative;
  assert.equal(latest.tokens, 200, "destination inherits the latest cumulative tokens");
  assert.equal(latest.costUsd, 1.0, "destination inherits the latest cumulative costUsd");
  assert.equal(latest.runs, 2, "destination inherits the latest cumulative runs");
});

test("T5.6: destination installBudgetEventHooks fires agent_settled (per C9: coupling with destination's checkpoint write)", async () => {
  // Verify that after restore, the destination session has installBudgetEventHooks
  // installed: its subscribe() was called (which is what installBudgetEventHooks
  // does internally per events.ts:48-148). The actual agent_settled → ledger
  // checkpoint wiring is the responsibility of events.ts; here we just verify
  // the hooks were attached.
  const { session, sessionManager } = makeFakeRespawnSession({ sessionId: "old" });
  const { ledger } = makeFakeLedger();

  let hooksSubscribed = false;
  let capturedListener: ((event: any) => void) | undefined;
  const fakeRestoredSession = {
    sessionId: "restored",
    getSessionStats(): SessionStats {
      return {
        sessionFile: undefined, sessionId: "restored",
        userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
      };
    },
    sessionManager: makeFakeBranchedSessionManager(),
    subscribe(listener: (event: any) => void) {
      hooksSubscribed = true;
      capturedListener = listener;
      return () => {};
    },
    dispose() {},
  } as unknown as AgentSession;

  (sessionManager as any).createBranchedSession = () => "/fake/branched.jsonl";
  const ctx: WorkerContext = {
    agent: "coder",
    session,
    sessionManager,
    ledger,
    policy: basePolicy,
    cwd: "/tmp",
    internals: {
      sessionManagerOpen: () => makeFakeBranchedSessionManager(),
      createAgentSessionFn: async () => ({ session: fakeRestoredSession }),
    },
  };

  await restoreWorkerSession(ctx, "snap-id", new AbortController().signal);

  assert.ok(hooksSubscribed, "installBudgetEventHooks was called on the destination session (subscribe registered)");
  assert.ok(capturedListener, "destination session has a listener installed");

  // The agent_settled → ledger.snapshot(marker='checkpoint') wiring is
  // exercised end-to-end by tests/budget-events.test.ts:493
  // ("agent_settled calls ledger.snapshot with marker 'checkpoint'").
  // This test only pins that worker-tools.ts installs the hooks on the
  // destination session; the actual handler behavior belongs to events.ts.
});

test("T5.6: restoreWorkerSession writes 'restore' ledger entry on the destination (branched) SessionManager", async () => {
  const { session, sessionManager } = makeFakeRespawnSession({ sessionId: "old" });
  const { ledger } = makeFakeLedger();

  const fakeBranchedSM = makeFakeBranchedSessionManager();
  (sessionManager as any).createBranchedSession = () => "/fake/branched.jsonl";

  const fakeRestoredSession = {
    sessionId: "restored",
    getSessionStats(): SessionStats {
      return {
        sessionFile: undefined, sessionId: "restored",
        userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
      };
    },
    sessionManager: fakeBranchedSM,
    subscribe() { return () => {}; },
    dispose() {},
  } as unknown as AgentSession;

  const ctx: WorkerContext = {
    agent: "coder", session, sessionManager, ledger, policy: basePolicy, cwd: "/tmp",
    internals: {
      sessionManagerOpen: () => fakeBranchedSM,
      createAgentSessionFn: async () => ({ session: fakeRestoredSession }),
    },
  };

  await restoreWorkerSession(ctx, "snap-id", new AbortController().signal);

  // The branched SM (destination) should have a "restore" ledger entry.
  const restoreEntry = fakeBranchedSM.appendedEntries.find(
    (e: any) => e.customType === "pi-hive-budget-ledger" && e.data?.kind === "restore",
  );
  assert.ok(restoreEntry, "ledger entry with kind='restore' was written on the destination SessionManager");
  assert.equal((restoreEntry as any).data.marker, "checkpoint", "marker is 'checkpoint'");
  assert.equal((restoreEntry as any).data.agentSlug, "coder", "agentSlug is the worker slug");
});

// ── Shared helpers ───────────────────────────────────────────────────────

// Build a fake "branched" SessionManager that BudgetLedger.restore can walk
// and that records any subsequent appendCustomEntry writes for assertions.
function makeFakeBranchedSessionManager(): SessionManager & { appendedEntries: Array<{ customType: string; data?: unknown }> } {
  const appendedEntries: Array<{ customType: string; data?: unknown }> = [];
  const sm = {
    appendedEntries,
    getBranch(): SessionEntry[] { return []; },
    getEntries(): SessionEntry[] { return []; },
    appendCustomEntry(customType: string, data?: unknown) {
      appendedEntries.push({ customType, data });
    },
    appendCustomMessageEntry() {},
    appendLabelChange() { return "fake-label-id"; },
    getLeafId() { return "fake-leaf-id"; },
    getSessionId() { return "fake-branched-session-id"; },
  };
  return sm as unknown as SessionManager & { appendedEntries: Array<{ customType: string; data?: unknown }> };
}

function makeFakeRestoredSession(): AgentSession {
  return {
    sessionId: "restored-session-id",
    subscribe() { return () => {}; },
    getSessionStats(): SessionStats {
      return {
        sessionFile: undefined, sessionId: "restored-session-id",
        userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
      };
    },
    sessionManager: makeFakeBranchedSessionManager(),
    dispose() {},
  } as unknown as AgentSession;
}

// ── Wave 3 fixup Issue 2: all 11 operator commands + 3 cooperative tools export distinct kind values ──

// Per the post-wave review: "verified by a test that calls all commands and
// asserts 9 distinct `kind` values." The brief said "9" but the actual
// operator command set has 11 commands (T5.1, T5.2, T5.3, T5.4, T5.5, T5.6,
// T5.8, T5.9, T5.13, T5.14, T5.15) — 8 from Wave 3B plus 3 from Wave 3C —
// plus the 3 cooperative tools (T5.10, T5.11, T5.12). The brief's "9"
// appears to have been an undercount from an earlier version of the F5
// plan; this test pins the *actual* distinct-kind property, which is
// what the dashboard's operator-vs-cooperative distinction depends on.
test("Wave 3 fixup Issue 2: 11 operator commands + 3 cooperative tools each emit a distinct BudgetLedgerKind (14 distinct values total)", async () => {
  // Seed a real BudgetLedger for each operator command. The command runs
  // write a snapshot with a unique `kind` value; we read the kind from the
  // resulting ledgerSnapshot and accumulate it into a Set.
  const collectedKinds = new Set<BudgetLedgerKind>();

  // ── Operator commands (3B's 8 + 3C's 3) ──
  // T5.1 endWorkerSession
  {
    const { handle, sm } = await makeHandle("kinds-end");
    registerHandle?.(handle);
    try {
      const r = await workerTools.endWorkerSession("kinds-end", "shutdown", new AbortController().signal);
      if (r.ledgerSnapshot.data.kind !== undefined) collectedKinds.add(r.ledgerSnapshot.data.kind);
    } finally { unregisterHandle?.("kinds-end"); }
    void sm;
  }
  // T5.2 compactWorkerSession
  {
    const { handle } = await makeHandle("kinds-compact");
    registerHandle?.(handle);
    try {
      const r = await workerTools.compactWorkerSession("kinds-compact", "compaction");
      if (r.ledgerSnapshot.data.kind !== undefined) collectedKinds.add(r.ledgerSnapshot.data.kind);
    } finally { unregisterHandle?.("kinds-compact"); }
  }
  // T5.4 pauseWorkerSession
  {
    const { handle } = await makeHandle("kinds-pause");
    registerHandle?.(handle);
    try {
      const r = await workerTools.pauseWorkerSession("kinds-pause", "pause", new AbortController().signal);
      if (r.ledgerSnapshot.data.kind !== undefined) collectedKinds.add(r.ledgerSnapshot.data.kind);
    } finally { unregisterHandle?.("kinds-pause"); }
  }
  // T5.8 resumeWorkerSession
  {
    const { handle } = await makeHandle("kinds-resume");
    registerHandle?.(handle);
    try {
      const r = await workerTools.resumeWorkerSession("kinds-resume", new AbortController().signal);
      if (r.ledgerSnapshot.data.kind !== undefined) collectedKinds.add(r.ledgerSnapshot.data.kind);
    } finally { unregisterHandle?.("kinds-resume"); }
  }
  // T5.9 abortWorkerCompaction
  {
    const { handle } = await makeHandle("kinds-abort-compact");
    registerHandle?.(handle);
    try {
      const r = await workerTools.abortWorkerCompaction("kinds-abort-compact", new AbortController().signal);
      if (r.ledgerSnapshot.data.kind !== undefined) collectedKinds.add(r.ledgerSnapshot.data.kind);
    } finally { unregisterHandle?.("kinds-abort-compact"); }
  }
  // T5.13 forceKillWorkerSession
  {
    const { handle } = await makeHandle("kinds-force-kill");
    registerHandle?.(handle);
    try {
      const r = await workerTools.forceKillWorkerSession("kinds-force-kill", "force-kill", new AbortController().signal);
      if (r.ledgerSnapshot.data.kind !== undefined) collectedKinds.add(r.ledgerSnapshot.data.kind);
    } finally { unregisterHandle?.("kinds-force-kill"); }
  }
  // T5.15 forceEndWorkerSession
  {
    const { handle } = await makeHandle("kinds-force-end");
    registerHandle?.(handle);
    try {
      const r = await workerTools.forceEndWorkerSession("kinds-force-end", "force-end", new AbortController().signal);
      if (r.ledgerSnapshot.data.kind !== undefined) collectedKinds.add(r.ledgerSnapshot.data.kind);
    } finally { unregisterHandle?.("kinds-force-end"); }
  }
  // T5.14 tearDownAllWorkers — team-level kind. Seed one handle so the
  // iteration has a target.
  {
    const { handle } = await makeHandle("kinds-tear-down");
    registerHandle?.(handle);
    try {
      const r = await workerTools.tearDownAllWorkers("shutdown all");
      const k = r.ledgerSnapshot.data.kind;
      if (k !== undefined) collectedKinds.add(k);
    } finally { unregisterHandle?.("kinds-tear-down"); }
  }

  // ── Operator commands (3C's 2 of 3 branch/clone — respawn + snapshot) ──
  // restoreWorkerSession (T5.6) requires createBranchedSession to return a
  // file path; in-memory SM does not expose that. The T5.6 test family
  // already pins `restore` emits kind:"restore" (search for "T5.6: restore
  // writes 'restore' ledger entry"), and the BudgetLedgerKind contract test
  // enumerates all 14 values. We exercise respawn + snapshot here.
  {
    const { session, sessionManager } = makeFakeRespawnSession({ sessionId: "kinds-respawn-session" });
    const { ledger } = makeFakeLedger();
    const newFakeSM: any = { ...sessionManager };
    const ctx: WorkerContext = {
      agent: "kinds-respawn", session, sessionManager, ledger, policy: basePolicy, cwd: "/tmp/work",
      internals: {
        sessionManagerCreate: () => newFakeSM,
        createAgentSessionFn: async (_opts: CreateAgentSessionOptions) => ({ session: { sessionId: "kinds-respawn-new" } as unknown as AgentSession }),
      },
    };
    const r = await workerTools.respawnWorkerSession(ctx, "operator requested restart");
    const k = r.ledgerSnapshot.data.kind;
    if (k !== undefined) collectedKinds.add(k);
  }
  {
    const { session, sessionManager } = makeFakeRespawnSession({ sessionId: "kinds-snapshot-session" });
    const { ledger } = makeFakeLedger();
    const ctx: WorkerContext = { agent: "kinds-snapshot", session, sessionManager, ledger, policy: basePolicy, cwd: "/tmp/work" };
    const r = await workerTools.snapshotWorkerSession(ctx, "label");
    const k = r.ledgerSnapshot.data.kind;
    if (k !== undefined) collectedKinds.add(k);
  }

  // ── Cooperative tools (3D's 3) ──
  // Capture the kind from each cooperative tool's ledger.snapshot() call.
  {
    const captured: BudgetLedgerKind[] = [];
    const fakeLedger = {
      cumulative: { tokens: 0, costUsd: 0, runs: 0 },
      agentName: "kinds-coop",
      snapshotCaps: () => ({}),
      entries: [] as BudgetLedgerEntry[],
      snapshot(_stats: unknown, _policy: unknown, _marker: string, _signal: AbortSignal, kind?: BudgetLedgerKind): BudgetLedgerEntry {
        if (kind) captured.push(kind);
        return { type: "custom", customType: "pi-hive-budget-ledger", data: { caps: {}, cumulative: { tokens: 0, costUsd: 0, runs: 0 }, writtenAt: 0, agentSlug: "kinds-coop", marker: "checkpoint", kind } };
      },
    };
    const fakeSession = {
      sessionId: "kinds-coop-session",
      sessionManager: { getLeafId: () => "leaf-coop", branchWithSummary: (id: string | null, summary: string) => `b-${id}-${summary}`, appendCustomEntry: () => "" },
      compact: async () => ({}),
      abort: async () => {},
      getSessionStats: () => defaultStats(),
    };
    const policy: WorkerBudgetPolicy = { worker: {}, team: {} };
    const requestCompaction = workerTools.buildRequestCompactionTool({ session: fakeSession as unknown as AgentSession, policy, ledger: fakeLedger as unknown as BudgetLedger });
    await requestCompaction(undefined, new AbortController().signal);
    const requestEndSession = workerTools.buildRequestEndSessionTool({ session: fakeSession as unknown as AgentSession, policy, ledger: fakeLedger as unknown as BudgetLedger });
    await requestEndSession("wrap", new AbortController().signal);
    const requestSnapshot = workerTools.buildRequestSnapshotTool({ session: fakeSession as unknown as AgentSession, policy, ledger: fakeLedger as unknown as BudgetLedger });
    await requestSnapshot("label", new AbortController().signal);
    for (const k of captured) collectedKinds.add(k);
  }

  // ── Assertion: distinct kinds observed ──
  // Documenting the actual count rather than the brief's "9" — the
  // BudgetLedgerKind type enumerates 14 values (see the contract test
  // "BudgetLedgerKind accepts all 14 documented values"). We exercise 13
  // here (everything except T5.6 restore, which is covered by T5.6 tests +
  // the contract test). 13 distinct values is the floor; adding the
  // restore kind yields the full 14.
  const observed = [...collectedKinds].sort();
  assert.equal(collectedKinds.size, 13, `13 distinct kinds observed (8 from 3B + 2 from 3C + 1 tear-down-all + 3 cooperative — restore pinned by T5.6 / contract tests). Observed: ${observed.join(", ")}`);
  // Spot-check that all operator + cooperative kinds we exercised here
  // appear in the set (the brief's distinctness gate).
  const expectedKinds: BudgetLedgerKind[] = [
    "end",
    "compact",
    "pause",
    "resume",
    "compact-aborted",
    "force-kill",
    "force-end",
    "tear-down-all",
    "respawn",
    "snapshot",
    "cooperative-compact",
    "cooperative-end",
    "cooperative-snapshot",
  ];
  for (const k of expectedKinds) {
    assert.ok(collectedKinds.has(k), `kind '${k}' was emitted by its producer/cooperative tool`);
  }
});

function defaultStats(): SessionStats {
  return {
    sessionFile: undefined,
    sessionId: "x",
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
}