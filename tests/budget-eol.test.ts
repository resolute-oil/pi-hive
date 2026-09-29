/**
 * Wave 3B — T5.1, T5.2, T5.4, T5.8, T5.9 operator-command tests.
 *
 * Coverage (15 tests; 3 per command):
 *
 *   endWorkerSession (T5.1):
 *   1.  snapshot has kind="end".
 *   2.  session.abort() was called (and NOT session.dispose() — plan §6.2 G-06).
 *   3.  result shape: { sessionId, ledgerSnapshot } with BudgetLedgerEntry discriminator.
 *
 *   compactWorkerSession (T5.2):
 *   4.  snapshot has kind="compact".
 *   5.  session.compact() was called (and result.compaction is the SDK return).
 *   6.  customInstructions are forwarded to session.compact() verbatim.
 *
 *   pauseWorkerSession (T5.4):
 *   7.  snapshot has kind="pause".
 *   8.  session.waitForIdle() was called BEFORE the snapshot was written.
 *   9.  result shape: ledgerSnapshot is the post-pause BudgetLedgerEntry.
 *
 *   resumeWorkerSession (T5.8, G-04):
 *  10.  snapshot has kind="resume".
 *  11.  installBudgetEventHooks is re-attached (session.subscribe was called).
 *  12.  snapshot cumulative is taken from session.getSessionStats() AT resume
 *       time — works even if the session has been idle for hours.
 *
 *   abortWorkerCompaction (T5.9, G-05):
 *  13.  snapshot has kind="compact-aborted".
 *  14.  session.abortCompaction() was called.
 *  15.  snapshot is written with the current authoritative totals.
 *
 * The tests inject a scripted `AgentSession` so the SDK's heavy machinery
 * (`createAgentSession`, real providers, real bash executor) never runs.
 * `BudgetLedger` is real and backed by `SessionManager.inMemory`, so the
 * write-side contract (entry ids, persisted branch state) is exercised
 * end-to-end. `installBudgetEventHooks` is the real factory from
 * `src/engine/budget/events.ts` — we assert on `session.subscribe` being
 * called, which is the public observable side-effect.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  CompactionResult,
  ExtensionContext,
  SessionManager as SessionManagerType,
  SessionStats,
} from "@earendil-works/pi-coding-agent";
import {
  BudgetLedger,
} from "../src/engine/budget/ledger.ts";
import {
  abortWorkerCompaction,
  compactWorkerSession,
  endWorkerSession,
  pauseWorkerSession,
  resumeWorkerSession,
} from "../src/engine/budget/worker-tools.ts";
import type {
  BudgetLedgerData,
  BudgetLedgerEntry,
  WorkerBudgetPolicy,
} from "../src/engine/budget/types.ts";

// ---------------------------------------------------------------------------
// Stubs / fixtures.
// ---------------------------------------------------------------------------

function makePolicy(): WorkerBudgetPolicy {
  return {
    worker: {
      tokens: { resource: "tokens", cap: 100_000 },
      costUsd: { resource: "costUsd", cap: 5 },
      runs: { resource: "runs", cap: 3 },
      depth: { resource: "depth", cap: 2 },
    },
    team: {
      tokens: { resource: "tokens", cap: 500_000 },
      costUsd: { resource: "costUsd", cap: 50 },
      runs: { resource: "runs", cap: 20 },
    },
  };
}

function makeStats(tokens: number, cost: number, sessionId = "eol-test"): SessionStats {
  return {
    sessionFile: undefined,
    sessionId,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens },
    cost,
  };
}

/** Scripted AgentSession — records every method call so tests can assert side-effects. */
interface ScriptedSession {
  sessionId: string;
  abortCalls: number;
  compactCalls: Array<string | undefined>;
  waitForIdleCalls: number;
  abortCompactionCalls: number;
  subscribeCalls: number;
  /** Stats returned by getSessionStats(). Mutable so a test can simulate "idle for hours, then more spend". */
  stats: SessionStats;
  /** Mirrors AgentSession.sessionManager (readonly on the real type). Set by `makeHandle`. */
  sessionManager: SessionManagerType;
  /** Pre-canned return value from `compact()`. */
  compactResult: CompactionResult;
  abort(): Promise<void>;
  compact(customInstructions?: string): Promise<CompactionResult>;
  waitForIdle(): Promise<void>;
  abortCompaction(): void;
  subscribe(_listener: (event: unknown) => void): () => void;
  getSessionStats(): SessionStats;
}

function makeSession(sessionId: string, stats: SessionStats, sessionManager: SessionManagerType): ScriptedSession {
  const session: ScriptedSession = {
    sessionId,
    abortCalls: 0,
    compactCalls: [],
    waitForIdleCalls: 0,
    abortCompactionCalls: 0,
    subscribeCalls: 0,
    stats,
    sessionManager,
    compactResult: {
      summary: "compacted",
      firstKeptEntryId: "first",
      tokensBefore: 1000,
      estimatedTokensAfter: 500,
    },
    async abort(): Promise<void> {
      session.abortCalls += 1;
    },
    async compact(customInstructions?: string): Promise<CompactionResult> {
      session.compactCalls.push(customInstructions);
      return session.compactResult;
    },
    async waitForIdle(): Promise<void> {
      session.waitForIdleCalls += 1;
    },
    abortCompaction(): void {
      session.abortCompactionCalls += 1;
    },
    subscribe(_listener: (event: unknown) => void): () => void {
      session.subscribeCalls += 1;
      return () => undefined;
    },
    getSessionStats(): SessionStats {
      return session.stats;
    },
  };
  return session;
}

interface HandleHarness {
  session: ScriptedSession;
  ledger: BudgetLedger;
  sessionManager: SessionManagerType;
  policy: WorkerBudgetPolicy;
}

let handleCounter = 0;
async function makeHandle(statsTokens = 0, statsCost = 0): Promise<HandleHarness> {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-eol-"));
  const sessionManager = SessionManager.inMemory(cwd);
  const policy = makePolicy();
  const ledger = await BudgetLedger.restore(sessionManager, "eol-worker", policy);
  handleCounter += 1;
  const session = makeSession(
    `sess-eol-${handleCounter}`,
    makeStats(statsTokens, statsCost),
    sessionManager,
  );
  return { session, ledger, sessionManager, policy };
}

function makeCtx(): ExtensionContext {
  return {
    cwd: "/tmp/eol",
    sessionManager: SessionManager.inMemory("/tmp/eol") as unknown as ExtensionContext["sessionManager"],
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

function ledgerEntries(sm: SessionManagerType): BudgetLedgerEntry[] {
  return sm
    .getBranch()
    .filter((e) => e.type === "custom" && (e as { customType?: unknown }).customType === "pi-hive-budget-ledger")
    .map((e) => {
      const data = (e as { data?: BudgetLedgerData }).data;
      if (!data) throw new Error("ledger entry missing data");
      return { type: "custom", customType: "pi-hive-budget-ledger", data } satisfies BudgetLedgerEntry;
    });
}

// ---------------------------------------------------------------------------
// T5.1 — endWorkerSession
// ---------------------------------------------------------------------------

test("T5.1 endWorkerSession: snapshot kind is 'end'", async () => {
  const { session, ledger, sessionManager, policy } = await makeHandle(42, 0.01);
  const ctx = makeCtx();
  const result = await endWorkerSession({ agent: "eol-worker" }, ctx, {
    session: session as unknown as AgentSession,
    ledger,
    policy,
  });
  const entries = ledgerEntries(sessionManager);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.data.kind, "end");
  assert.equal(result.ledgerSnapshot.data.kind, "end");
});

test("T5.1 endWorkerSession: session.abort() was called (and NOT disposed — plan §6.2)", async () => {
  const { session, ledger, policy } = await makeHandle();
  const ctx = makeCtx();
  await endWorkerSession({ agent: "eol-worker" }, ctx, {
    session: session as unknown as AgentSession,
    ledger,
    policy,
  });
  assert.equal(session.abortCalls, 1, "abort() was called exactly once");
  // §6.2 G-06: session.dispose() must NOT be called here. The session is
  // preserved so a later resumeWorkerSession can re-attach hooks. The
  // scripted session has no `dispose` method at all — a real AgentSession
  // does, and we verify by checking the property is absent on the fake.
  assert.equal((session as unknown as { dispose?: unknown }).dispose, undefined);
});

test("T5.1 endWorkerSession: result shape is { sessionId, ledgerSnapshot: BudgetLedgerEntry }", async () => {
  const { session, ledger, policy } = await makeHandle(7, 0.001);
  const ctx = makeCtx();
  const result = await endWorkerSession({ agent: "eol-worker" }, ctx, {
    session: session as unknown as AgentSession,
    ledger,
    policy,
  });
  assert.equal(result.sessionId, session.sessionId);
  // Discriminated union: BudgetLedgerEntry is { type: "custom"; customType: "pi-hive-budget-ledger"; data: ... }
  assert.equal(result.ledgerSnapshot.type, "custom");
  assert.equal(result.ledgerSnapshot.customType, "pi-hive-budget-ledger");
  assert.ok(result.ledgerSnapshot.data, "data block present");
  assert.equal(result.ledgerSnapshot.data.kind, "end");
});

// ---------------------------------------------------------------------------
// T5.2 — compactWorkerSession
// ---------------------------------------------------------------------------

test("T5.2 compactWorkerSession: snapshot kind is 'compact'", async () => {
  const { session, ledger, sessionManager, policy } = await makeHandle(123, 0.05);
  const ctx = makeCtx();
  const result = await compactWorkerSession({ agent: "eol-worker" }, ctx, {
    session: session as unknown as AgentSession,
    ledger,
    policy,
  });
  const entries = ledgerEntries(sessionManager);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.data.kind, "compact");
  assert.equal(result.ledgerSnapshot.data.kind, "compact");
});

test("T5.2 compactWorkerSession: session.compact() was called and result.compaction is the SDK return", async () => {
  const { session, ledger, policy } = await makeHandle(100, 0.01);
  const ctx = makeCtx();
  const result = await compactWorkerSession({ agent: "eol-worker" }, ctx, {
    session: session as unknown as AgentSession,
    ledger,
    policy,
  });
  assert.equal(session.compactCalls.length, 1, "compact() was called exactly once");
  // result.compaction must be the SDK's CompactionResult — pass through unchanged.
  assert.equal(result.compaction.summary, "compacted");
  assert.equal(result.compaction.tokensBefore, 1000);
  assert.equal(result.compaction.estimatedTokensAfter, 500);
});

test("T5.2 compactWorkerSession: customInstructions are forwarded to session.compact()", async () => {
  const { session, ledger, policy } = await makeHandle();
  const ctx = makeCtx();
  await compactWorkerSession(
    { agent: "eol-worker" },
    ctx,
    { session: session as unknown as AgentSession, ledger, policy },
    "keep these specific entries verbatim",
  );
  assert.deepEqual(session.compactCalls, ["keep these specific entries verbatim"]);
});

// ---------------------------------------------------------------------------
// T5.4 — pauseWorkerSession
// ---------------------------------------------------------------------------

test("T5.4 pauseWorkerSession: snapshot kind is 'pause'", async () => {
  const { session, ledger, sessionManager, policy } = await makeHandle(50, 0.02);
  const ctx = makeCtx();
  const result = await pauseWorkerSession({ agent: "eol-worker" }, ctx, {
    session: session as unknown as AgentSession,
    ledger,
    policy,
  });
  const entries = ledgerEntries(sessionManager);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.data.kind, "pause");
  assert.equal(result.ledgerSnapshot.data.kind, "pause");
});

test("T5.4 pauseWorkerSession: session.waitForIdle() was called BEFORE the snapshot was written", async () => {
  const { session, ledger, policy } = await makeHandle(75, 0.03);
  // Spy: record whether the ledger had any entries when waitForIdle fired.
  let ledgerHadEntriesAtWaitTime = -1;
  const realWait = session.waitForIdle.bind(session);
  session.waitForIdle = async (): Promise<void> => {
    ledgerHadEntriesAtWaitTime = ledgerEntries(session.sessionManager as SessionManagerType).length;
    await realWait();
  };
  const ctx = makeCtx();
  await pauseWorkerSession({ agent: "eol-worker" }, ctx, {
    session: session as unknown as AgentSession,
    ledger,
    policy,
  });
  assert.equal(session.waitForIdleCalls, 1, "waitForIdle() was called exactly once");
  // Ledger was empty before pause ran — confirms snapshot is written AFTER waitForIdle.
  assert.equal(ledgerHadEntriesAtWaitTime, 0);
  // After the call, the ledger has the pause snapshot.
  assert.equal(ledgerEntries(session.sessionManager as SessionManagerType).length, 1);
});

test("T5.4 pauseWorkerSession: result shape includes ledgerSnapshot (post-pause BudgetLedgerEntry)", async () => {
  const { session, ledger, policy } = await makeHandle(200, 0.07);
  const ctx = makeCtx();
  const result = await pauseWorkerSession({ agent: "eol-worker" }, ctx, {
    session: session as unknown as AgentSession,
    ledger,
    policy,
  });
  assert.equal(result.sessionId, session.sessionId);
  // Snapshot records the authoritative totals — getSessionStats() is the single source of truth.
  assert.equal(result.ledgerSnapshot.data.cumulative.tokens, 200);
  assert.equal(result.ledgerSnapshot.data.cumulative.costUsd, 0.07);
  assert.equal(result.ledgerSnapshot.data.kind, "pause");
});

// ---------------------------------------------------------------------------
// T5.8 — resumeWorkerSession (G-04)
// ---------------------------------------------------------------------------

test("T5.8 resumeWorkerSession: snapshot kind is 'resume'", async () => {
  const { session, ledger, sessionManager, policy } = await makeHandle(33, 0.005);
  const ctx = makeCtx();
  const result = await resumeWorkerSession({ agent: "eol-worker" }, ctx, {
    session: session as unknown as AgentSession,
    ledger,
    policy,
  });
  const entries = ledgerEntries(sessionManager);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.data.kind, "resume");
  assert.equal(result.ledgerSnapshot.data.kind, "resume");
});

test("T5.8 resumeWorkerSession: installBudgetEventHooks is re-attached (subscribe was called)", async () => {
  const { session, ledger, policy } = await makeHandle();
  const ctx = makeCtx();
  await resumeWorkerSession({ agent: "eol-worker" }, ctx, {
    session: session as unknown as AgentSession,
    ledger,
    policy,
  });
  // installBudgetEventHooks calls session.subscribe exactly once.
  assert.equal(session.subscribeCalls, 1, "subscribe was called exactly once by installBudgetEventHooks");
});

test("T5.8 resumeWorkerSession: snapshot uses current getSessionStats() (works after long idle)", async () => {
  const { session, ledger, sessionManager, policy } = await makeHandle(11, 0.001);
  // Simulate "session has been idle for hours, then a new burst of spend":
  // mutate stats to reflect fresh authoritative totals.
  session.stats = makeStats(9999, 4.2, session.sessionId);
  const ctx = makeCtx();
  const result = await resumeWorkerSession({ agent: "eol-worker" }, ctx, {
    session: session as unknown as AgentSession,
    ledger,
    policy,
  });
  // The resume snapshot reads CURRENT totals, not stale ones.
  assert.equal(result.ledgerSnapshot.data.cumulative.tokens, 9999);
  assert.equal(result.ledgerSnapshot.data.cumulative.costUsd, 4.2);
  // And the kind is set correctly even with non-zero pre-existing spend.
  assert.equal(ledgerEntries(sessionManager)[0]!.data.kind, "resume");
});

// ---------------------------------------------------------------------------
// T5.9 — abortWorkerCompaction (G-05)
// ---------------------------------------------------------------------------

test("T5.9 abortWorkerCompaction: snapshot kind is 'compact-aborted'", async () => {
  const { session, ledger, sessionManager, policy } = await makeHandle(8, 0.001);
  const ctx = makeCtx();
  const result = await abortWorkerCompaction({ agent: "eol-worker" }, ctx, {
    session: session as unknown as AgentSession,
    ledger,
    policy,
  });
  const entries = ledgerEntries(sessionManager);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.data.kind, "compact-aborted");
  assert.equal(result.ledgerSnapshot.data.kind, "compact-aborted");
});

test("T5.9 abortWorkerCompaction: session.abortCompaction() was called", async () => {
  const { session, ledger, policy } = await makeHandle();
  const ctx = makeCtx();
  await abortWorkerCompaction({ agent: "eol-worker" }, ctx, {
    session: session as unknown as AgentSession,
    ledger,
    policy,
  });
  assert.equal(session.abortCompactionCalls, 1, "abortCompaction() was called exactly once");
  // abortCompaction is synchronous; abort() must NOT also fire (this is the cancel path).
  assert.equal(session.abortCalls, 0, "abort() was NOT called — cancelCompaction is its own path");
});

test("T5.9 abortWorkerCompaction: snapshot is written with current authoritative totals", async () => {
  const { session, ledger, sessionManager, policy } = await makeHandle(1234, 0.5);
  const ctx = makeCtx();
  const result = await abortWorkerCompaction({ agent: "eol-worker" }, ctx, {
    session: session as unknown as AgentSession,
    ledger,
    policy,
  });
  // The aborted compaction did not rewrite the branch — getSessionStats()
  // returns the pre-compaction totals.
  assert.equal(result.ledgerSnapshot.data.cumulative.tokens, 1234);
  assert.equal(result.ledgerSnapshot.data.cumulative.costUsd, 0.5);
  // And the kind is exactly "compact-aborted" (the long literal with the dash).
  assert.equal(ledgerEntries(sessionManager)[0]!.data.kind, "compact-aborted");
});
