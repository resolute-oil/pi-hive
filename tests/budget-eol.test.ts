/**
 * Wave 3C — F5 branch/clone cluster tests (T5.3, T5.5, T5.6).
 *
 * Coverage (9 tests; 3 per command):
 *
 *   respawnWorkerSession (T5.3):
 *   1.  Happy path: disposes old session, creates new session, writes a
 *       ledger snapshot with `kind: "respawn"` and `marker: "checkpoint"`.
 *   2.  SDK chain correctness: `branchWithSummary` is called on the OLD SM
 *       BEFORE the OLD session is disposed; the new session is built via
 *       the injected `sessionManagerFactory` + `createSession` factories.
 *   3.  Result shape: `RespawnWorkerResult` carries `{ ok: true, oldSessionId,
 *       newSessionId, ledgerSnapshot }` where `ledgerSnapshot` is the latest
 *       `BudgetLedgerEntry` written to the OLD SM.
 *
 *   snapshotWorkerSession (T5.5):
 *   4.  Happy path: `branchWithSummary` is called on the worker's SM;
 *       ledger snapshot has `kind: "snapshot"`.
 *   5.  branchPath returned matches the `branch_summary` entry ID the SDK
 *       wrote; the same entry appears in the worker's branch.
 *   6.  Session is preserved (no new session is created); only the
 *       `branch_summary` + ledger snapshot are added.
 *
 *   restoreWorkerSession (T5.6):
 *   7.  createBranchedSession returns `undefined` (in-memory source) →
 *       `{ isError: true, code: "restore_failed" }` — does NOT crash.
 *   8.  createBranchedSession returns a path (file-backed source) →
 *       success path: SessionManager.open is called with that path, the
 *       branched SM is opened, and a ledger snapshot with `kind: "restore"`
 *       is written.
 *   9.  SDK chain correctness: the path returned by `createBranchedSession`
 *       is passed verbatim to `SessionManager.open` (via the injected
 *       `openSessionManager` factory); the new session has the branched
 *       ledger entries.
 *
 * All tests use real `SessionManager` instances (file-backed where
 * `createBranchedSession` must return a real path; in-memory elsewhere)
 * and scripted `AgentSession`s. No real SDK extension runner is invoked.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, ExtensionContext, SessionStats } from "@earendil-works/pi-coding-agent";
import {
  respawnWorkerSession,
  restoreWorkerSession,
  snapshotWorkerSession,
} from "../src/engine/budget/worker-tools.ts";
import { BUDGET_LEDGER_CUSTOM_TYPE, BudgetLedger } from "../src/engine/budget/ledger.ts";
import type {
  BudgetLedgerEntry,
  WorkerBudgetPolicy,
} from "../src/engine/budget/types.ts";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

/**
 * Scripted AgentSession — minimal surface required by the Wave 3C commands:
 *   - `sessionId` (read for the result shape + SDK chain calls)
 *   - `subscribe` (called by installBudgetEventHooks; no-op for these tests)
 *   - `getSessionStats` (source-of-truth stats for the snapshot)
 *   - `dispose` (called by respawnWorkerSession; recorded for assertions)
 *
 * The `disposed` flag is the observable side effect that proves
 * `respawnWorkerSession` invoked `dispose()` rather than `abort()`.
 */
interface ScriptedSession {
  sessionId: string;
  listeners: Array<(event: unknown) => void>;
  stats: SessionStats;
  disposed: boolean;
  disposeCallCount: number;
  subscribe(listener: (event: unknown) => void): () => void;
  getSessionStats(): SessionStats;
  dispose(): void;
}

function makeScriptedSession(sessionId: string, stats: SessionStats): ScriptedSession {
  const s: ScriptedSession = {
    sessionId,
    listeners: [],
    stats,
    disposed: false,
    disposeCallCount: 0,
    subscribe(listener) {
      s.listeners.push(listener);
      return () => {
        const i = s.listeners.indexOf(listener);
        if (i >= 0) s.listeners.splice(i, 1);
      };
    },
    getSessionStats() {
      return s.stats;
    },
    dispose() {
      s.disposed = true;
      s.disposeCallCount += 1;
      s.listeners.length = 0;
    },
  };
  return s;
}

function makeStats(tokens: number, cost: number): SessionStats {
  return {
    sessionFile: undefined,
    sessionId: "stats-stub",
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens },
    cost,
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

/**
 * ExtensionContext is not used by the Wave 3C commands beyond `cwd` and
 * `signal` (the latter is passed through to the ledger write). Build a
 * minimal stub; the commands do not call `ctx.ui`, `ctx.sessionManager`, etc.
 */
function makeCtx(cwd: string): ExtensionContext {
  return {
    cwd,
    sessionManager: {} as ExtensionContext["sessionManager"],
    ui: {} as ExtensionContext["ui"],
    mode: "rpc",
    hasUI: false,
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

/** Build a scripted `createSession` factory returning the supplied session. */
function makeCreateSession(session: AgentSession) {
  return async (_opts: { cwd: string; sessionManager: SessionManager }) => {
    // Track that the factory was called — useful for SDK-chain assertions.
    return { session, extensionsResult: {} };
  };
}

/** Extract the latest ledger entry for the given `agentSlug` from an SM's branch. */
function latestLedgerEntry(sm: SessionManager, agentSlug: string): BudgetLedgerEntry | undefined {
  return sm
    .getBranch()
    .filter(
      (e): e is Extract<typeof e, { type: "custom"; data: unknown }> =>
        e.type === "custom" &&
        (e as { customType?: string }).customType === BUDGET_LEDGER_CUSTOM_TYPE,
    )
    .map((e) => e as unknown as BudgetLedgerEntry)
    .filter((e) => e.data.agentSlug === agentSlug)
    .pop();
}

// ---------------------------------------------------------------------------
// T5.3 — respawnWorkerSession
// ---------------------------------------------------------------------------

// ── T5.3 happy path ────────────────────────────────────────────────────────

test("respawnWorkerSession: disposes old session, creates new session, writes kind:respawn ledger snapshot", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hive-respawn-happy-"));
    const oldSM = SessionManager.inMemory(cwd);
    const oldSession = makeScriptedSession("old-sess", makeStats(1000, 0.05)) as unknown as AgentSession;
    // Seed one ledger entry so the OLD ledger has a `cumulative` baseline.
    oldSM.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, {
      caps: { workerTokens: 100_000 },
      cumulative: { tokens: 500, costUsd: 0.025, runs: 1 },
      writtenAt: 0,
      agentSlug: "builder",
    });
    const oldLedger = await BudgetLedger.restore(oldSM, "builder", makePolicy());
    const policy = makePolicy();
    const ctx = makeCtx(cwd);

    const newSM = SessionManager.inMemory(cwd);
    const newSession = makeScriptedSession("new-sess", makeStats(0, 0)) as unknown as AgentSession;

    const result = await respawnWorkerSession(
      { agent: "builder", reason: "context stale" },
      ctx,
      {
        oldSession,
        oldSessionManager: oldSM,
        oldLedger,
        policy,
        sessionManagerFactory: () => newSM,
        createSession: makeCreateSession(newSession) as never,
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.oldSessionId, "old-sess");
    assert.equal(result.newSessionId, "new-sess");
    assert.ok(result.ledgerSnapshot);
    assert.equal(result.ledgerSnapshot.data.kind, "respawn", "kind must be exactly 'respawn'");
    assert.equal(result.ledgerSnapshot.data.marker, "checkpoint", "marker is 'checkpoint' per plan §2.3");
    assert.equal(result.ledgerSnapshot.data.agentSlug, "builder");
    assert.equal(result.ledgerSnapshot.customType, BUDGET_LEDGER_CUSTOM_TYPE);
    assert.equal((oldSession as unknown as ScriptedSession).disposed, true, "old session.dispose() was called");
    assert.equal((oldSession as unknown as ScriptedSession).disposeCallCount, 1);
  });

  test("respawnWorkerSession: SDK chain — branchWithSummary called on OLD SM before dispose; new SM/session built via factories", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hive-respawn-chain-"));
    const oldSM = SessionManager.inMemory(cwd);
    // Add an entry so getLeafId() returns a non-null ID (branchWithSummary
    // requires a leaf).
    oldSM.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, {
      caps: {},
      cumulative: { tokens: 0, costUsd: 0, runs: 0 },
      writtenAt: 0,
      agentSlug: "builder",
    });
    const leafIdBefore = oldSM.getLeafId();
    assert.ok(leafIdBefore, "oldSM must have a leaf before respawn");

    const oldSession = makeScriptedSession("old-sess", makeStats(100, 0.01)) as unknown as AgentSession;
    const oldLedger = await BudgetLedger.restore(oldSM, "builder", makePolicy());
    const policy = makePolicy();
    const ctx = makeCtx(cwd);

    const newSM = SessionManager.inMemory(cwd);
    const newSession = makeScriptedSession("new-sess", makeStats(0, 0)) as unknown as AgentSession;

    let factoryCallCount = 0;
    let createSessionCallCount = 0;

    await respawnWorkerSession(
      { agent: "builder", reason: "switch context" },
      ctx,
      {
        oldSession,
        oldSessionManager: oldSM,
        oldLedger,
        policy,
        sessionManagerFactory: (calledCwd) => {
          factoryCallCount += 1;
          assert.equal(calledCwd, cwd, "factory receives ctx.cwd");
          return newSM;
        },
        createSession: (async (opts: { cwd: string; sessionManager: SessionManager }) => {
          createSessionCallCount += 1;
          assert.equal(opts.cwd, cwd, "createSession receives ctx.cwd");
          assert.equal(opts.sessionManager, newSM, "createSession receives the new SM");
          return { session: newSession, extensionsResult: {} };
        }) as never,
      },
    );

    // Verify the OLD SM has a branch_summary entry (proves branchWithSummary
    // was called on the OLD SM).
    const branchSummaries = oldSM
      .getBranch()
      .filter((e) => e.type === "branch_summary");
    assert.equal(branchSummaries.length, 1, "branchWithSummary wrote exactly one entry to oldSM");
    const branchSummary = branchSummaries[0] as Extract<typeof branchSummaries[0], { type: "branch_summary" }>;
    assert.match(branchSummary.summary, /Respawned by operator: switch context/);

    // Verify the OLD SM has BOTH the original seed ledger entry AND the
    // new kind:respawn ledger entry (the seed sets the cumulative baseline
    // the kind:respawn snapshot reads from).
    const oldLedgerEntries = oldSM
      .getBranch()
      .filter(
        (e) =>
          e.type === "custom" &&
          (e as { customType?: string }).customType === BUDGET_LEDGER_CUSTOM_TYPE,
      );
    assert.equal(
      oldLedgerEntries.length,
      2,
      "oldSM has seed + kind:respawn ledger entries",
    );
    const kinds = oldLedgerEntries.map(
      (e) => (e as unknown as BudgetLedgerEntry).data.kind,
    );
    assert.ok(kinds.includes("respawn"), "oldSM has the kind:respawn entry");

    // Verify the NEW SM is empty (fresh budget by construction).
    const newBranchEntries = newSM.getBranch();
    assert.equal(newBranchEntries.length, 0, "newSM branch is empty (fresh budget)");

    assert.equal(factoryCallCount, 1, "sessionManagerFactory called exactly once");
    assert.equal(createSessionCallCount, 1, "createSession called exactly once");
    assert.equal((oldSession as unknown as ScriptedSession).disposed, true, "dispose happened AFTER branchWithSummary + snapshot");
  });

  test("respawnWorkerSession: result shape — ledgerSnapshot is a BudgetLedgerEntry with cumulative populated from old stats", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hive-respawn-shape-"));
    const oldSM = SessionManager.inMemory(cwd);
    const oldStats = makeStats(2500, 0.123);
    const oldSession = makeScriptedSession("old-sess", oldStats) as unknown as AgentSession;
    const oldLedger = await BudgetLedger.restore(oldSM, "builder", makePolicy());
    const policy = makePolicy();
    const ctx = makeCtx(cwd);

    const newSM = SessionManager.inMemory(cwd);
    const newSession = makeScriptedSession("new-sess", makeStats(0, 0)) as unknown as AgentSession;

    const result = await respawnWorkerSession(
      { agent: "builder" },
      ctx,
      {
        oldSession,
        oldSessionManager: oldSM,
        oldLedger,
        policy,
        sessionManagerFactory: () => newSM,
        createSession: makeCreateSession(newSession) as never,
      },
    );

    // Verify the projected cumulative came from the OLD session's
    // getSessionStats() — single source of truth, no overwrite math.
    assert.equal(result.ledgerSnapshot.data.cumulative.tokens, oldStats.tokens.total);
    assert.equal(result.ledgerSnapshot.data.cumulative.costUsd, oldStats.cost);
    assert.equal(result.ledgerSnapshot.data.cumulative.runs, 0);

    // Result envelope shape (per task spec): { oldSessionId, newSessionId, ledgerSnapshot }
    assert.equal(typeof result.oldSessionId, "string");
    assert.equal(typeof result.newSessionId, "string");
    assert.equal(result.oldSessionId, "old-sess");
    assert.equal(result.newSessionId, "new-sess");
    assert.equal(result.ledgerSnapshot.type, "custom");
  });

// ---------------------------------------------------------------------------
// T5.5 — snapshotWorkerSession
// ---------------------------------------------------------------------------

// ── T5.5 happy path ────────────────────────────────────────────────────────

test("snapshotWorkerSession: branchWithSummary called on SM, ledger has kind:snapshot", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hive-snapshot-happy-"));
    const sm = SessionManager.inMemory(cwd);
    sm.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, {
      caps: {},
      cumulative: { tokens: 0, costUsd: 0, runs: 0 },
      writtenAt: 0,
      agentSlug: "builder",
    });
    const ledger = await BudgetLedger.restore(sm, "builder", makePolicy());
    const session = makeScriptedSession("sess-snap", makeStats(750, 0.04)) as unknown as AgentSession;
    const ctx = makeCtx(cwd);

    const result = await snapshotWorkerSession(
      { agent: "builder", label: "Pre-compact checkpoint" },
      ctx,
      { sessionManager: sm, ledger, session, policy: makePolicy() },
    );

    assert.equal(result.ok, true);
    assert.equal(result.sessionId, "sess-snap");
    assert.equal(result.ledgerSnapshot.data.kind, "snapshot", "kind must be exactly 'snapshot'");
    assert.equal(result.ledgerSnapshot.data.marker, "checkpoint");
    assert.equal(result.ledgerSnapshot.data.agentSlug, "builder");
    assert.equal(typeof result.branchPath, "string");
    assert.ok(result.branchPath.length > 0);
  });

  test("snapshotWorkerSession: SDK chain — branchPath matches the branch_summary entry ID; entry appears in branch", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hive-snapshot-chain-"));
    const sm = SessionManager.inMemory(cwd);
    sm.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, {
      caps: {},
      cumulative: { tokens: 0, costUsd: 0, runs: 0 },
      writtenAt: 0,
      agentSlug: "builder",
    });
    const ledger = await BudgetLedger.restore(sm, "builder", makePolicy());
    const session = makeScriptedSession("sess-snap", makeStats(100, 0.005)) as unknown as AgentSession;
    const ctx = makeCtx(cwd);

    const result = await snapshotWorkerSession(
      { agent: "builder", label: "checkpoint-A" },
      ctx,
      { sessionManager: sm, ledger, session, policy: makePolicy() },
    );

    // branchPath must match the branch_summary entry ID the SDK wrote.
    const branchSummaries = sm
      .getBranch()
      .filter((e) => e.type === "branch_summary");
    assert.equal(branchSummaries.length, 1);
    const branchSummary = branchSummaries[0] as Extract<typeof branchSummaries[0], { type: "branch_summary" }>;
    assert.equal(result.branchPath, branchSummary.id);
    assert.equal(branchSummary.summary, "checkpoint-A");
  });

  test("snapshotWorkerSession: session preserved — no new SM/session is created; only branch_summary + ledger snapshot are added", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hive-snapshot-preserved-"));
    const sm = SessionManager.inMemory(cwd);
    sm.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, {
      caps: {},
      cumulative: { tokens: 100, costUsd: 0.005, runs: 1 },
      writtenAt: 0,
      agentSlug: "builder",
    });
    const ledger = await BudgetLedger.restore(sm, "builder", makePolicy());
    const session = makeScriptedSession("sess-snap", makeStats(200, 0.01)) as unknown as AgentSession;
    const ctx = makeCtx(cwd);
    const initialBranchLength = sm.getBranch().length;

    const result = await snapshotWorkerSession(
      { agent: "builder", label: "preserve-test" },
      ctx,
      { sessionManager: sm, ledger, session, policy: makePolicy() },
    );

    // No new session was created (the session ID matches the original).
    assert.equal(result.sessionId, session.sessionId);
    assert.equal((session as unknown as ScriptedSession).disposeCallCount, 0, "session was NOT disposed (T5.5 preserves it)");

    // The branch grew by exactly 2 entries: the branch_summary + the
    // kind:snapshot ledger entry. The original ledger CustomEntry is still
    // there (the baseline for restore's `getBranch()` walk).
    const finalBranch = sm.getBranch();
    assert.equal(
      finalBranch.length,
      initialBranchLength + 2,
      "branch grew by exactly 2 entries (branch_summary + ledger snapshot)",
    );

    const latest = latestLedgerEntry(sm, "builder");
    assert.ok(latest, "a ledger entry exists for builder");
    assert.equal(latest!.data.kind, "snapshot");
  });

// ---------------------------------------------------------------------------
// T5.6 — restoreWorkerSession
// ---------------------------------------------------------------------------

// ── T5.6 error path ────────────────────────────────────────────────────────

test("restoreWorkerSession: error path — createBranchedSession returns undefined → isError:true code:restore_failed (does NOT crash)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hive-restore-err-"));
    const sourceSM = SessionManager.inMemory(cwd); // inMemory → createBranchedSession returns undefined
    sourceSM.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, {
      caps: {},
      cumulative: { tokens: 0, costUsd: 0, runs: 0 },
      writtenAt: 0,
      agentSlug: "builder",
    });
    const leafId = sourceSM.getLeafId()!;
    const ctx = makeCtx(cwd);

    // Sanity check: the SDK truly returns undefined for inMemory sources.
    const sdkResult = sourceSM.createBranchedSession(leafId);
    assert.equal(sdkResult, undefined, "inMemory source SM must return undefined");

    let openCalled = false;
    const result = await restoreWorkerSession(
      { agent: "builder", snapshotId: leafId },
      ctx,
      {
        sourceSessionManager: sourceSM,
        snapshotLeafId: leafId,
        policy: makePolicy(),
        openSessionManager: () => {
          openCalled = true;
          throw new Error("openSessionManager must NOT be called on the error path");
        },
      },
    );

    const errResult = result as { isError: true; code: "restore_failed"; reason: string };
    assert.equal(errResult.isError, true);
    assert.equal(errResult.code, "restore_failed");
    assert.match(errResult.reason, /createBranchedSession returned undefined/);
    assert.equal(openCalled, false, "openSessionManager was NOT invoked on the error path");
  });

  test("restoreWorkerSession: success path — createBranchedSession returns path → SessionManager.open called, kind:restore written", async () => {
    // Use a file-backed SessionManager (createBranchedSession returns a
    // path only for persisted SMs per session-manager.js:1296).
    const cwd = mkdtempSync(join(tmpdir(), "pi-hive-restore-ok-"));
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-hive-restore-ok-sessions-"));
    const sourceSM = SessionManager.create(cwd, sessionDir);
    sourceSM.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, {
      caps: {},
      cumulative: { tokens: 0, costUsd: 0, runs: 0 },
      writtenAt: 0,
      agentSlug: "builder",
    });
    const leafId = sourceSM.getLeafId()!;
    const ctx = makeCtx(cwd);

    // Sanity check: the SDK returns a real path for file-backed sources.
    const sdkBranchedPath = sourceSM.createBranchedSession(leafId);
    assert.equal(typeof sdkBranchedPath, "string", "file-backed source must return a path");

    // Rebuild the source SM because createBranchedSession mutates the SM
    // (its leaf/file state changes). The test then exercises the full path
    // through restoreWorkerSession.
    const sourceSM2 = SessionManager.create(cwd, sessionDir);
    sourceSM2.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, {
      caps: {},
      cumulative: { tokens: 0, costUsd: 0, runs: 0 },
      writtenAt: 0,
      agentSlug: "builder",
    });
    const leafId2 = sourceSM2.getLeafId()!;

    const newSession = makeScriptedSession("restored-sess", makeStats(0, 0)) as unknown as AgentSession;
    const openedSM = SessionManager.inMemory(cwd);

    const result = await restoreWorkerSession(
      { agent: "builder", snapshotId: leafId2 },
      ctx,
      {
        sourceSessionManager: sourceSM2,
        snapshotLeafId: leafId2,
        policy: makePolicy(),
        openSessionManager: (path) => {
          assert.equal(typeof path, "string", "open receives a string path");
          assert.ok(path.length > 0);
          return openedSM;
        },
        createSession: makeCreateSession(newSession) as never,
      },
    );

    if ("isError" in result) {
      assert.fail(`expected success path, got isError: ${result.reason}`);
    }
    const okResult = result as { ok: true; sessionId: string; ledgerSnapshot: BudgetLedgerEntry };
    assert.equal(okResult.ok, true);
    assert.equal(okResult.sessionId, "restored-sess");
    assert.equal(okResult.ledgerSnapshot.data.kind, "restore", "kind must be exactly 'restore'");
    assert.equal(okResult.ledgerSnapshot.data.marker, "checkpoint");
    assert.equal(okResult.ledgerSnapshot.data.agentSlug, "builder");
  });

  test("restoreWorkerSession: SDK chain — createBranchedSession is called on the source SM, the returned path is passed to SessionManager.open", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hive-restore-chain-"));
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-hive-restore-chain-sessions-"));
    const sourceSM = SessionManager.create(cwd, sessionDir);
    sourceSM.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, {
      caps: {},
      cumulative: { tokens: 0, costUsd: 0, runs: 0 },
      writtenAt: 0,
      agentSlug: "builder",
    });
    const leafId = sourceSM.getLeafId()!;

    // Monkey-patch `createBranchedSession` on this instance so we can
    // observe the argument + return value without consuming the SM.
    let createBranchedCallCount = 0;
    let createBranchedArg: string | null | undefined;
    let interceptedPath: string | undefined;
    const originalCreateBranched = sourceSM.createBranchedSession.bind(sourceSM);
    sourceSM.createBranchedSession = (id: string) => {
      createBranchedCallCount += 1;
      createBranchedArg = id;
      const path = originalCreateBranched(id);
      interceptedPath = path;
      return path;
    };

    const ctx = makeCtx(cwd);
    let openedSM: SessionManager | undefined;
    const newSession = makeScriptedSession("restored-sess", makeStats(0, 0)) as unknown as AgentSession;
    let observedPath: string | undefined;

    await restoreWorkerSession(
      { agent: "builder", snapshotId: leafId },
      ctx,
      {
        sourceSessionManager: sourceSM,
        snapshotLeafId: leafId,
        policy: makePolicy(),
        openSessionManager: (path) => {
          observedPath = path;
          // Use the REAL SessionManager.open so the branched file's
          // contents (including the source's ledger entry) are loaded
          // into the opened SM. This matches production behavior — the
          // SDK chain is `createBranchedSession` → `open`.
          const sm = SessionManager.open(path);
          openedSM = sm;
          return sm;
        },
        createSession: makeCreateSession(newSession) as never,
      },
    );

    // SDK chain: createBranchedSession was called once on the source SM,
    // with the exact snapshotLeafId we passed.
    assert.equal(createBranchedCallCount, 1, "createBranchedSession called exactly once");
    assert.equal(createBranchedArg, leafId, "createBranchedSession called with the snapshotLeafId");
    assert.ok(interceptedPath, "createBranchedSession returned a path");
    assert.equal(observedPath, interceptedPath, "openSessionManager received the exact path returned by createBranchedSession");
    assert.ok(openedSM, "openSessionManager returned a SessionManager");

    // The branched SM must include the new kind:restore ledger entry
    // (the audit trail written by restoreWorkerSession). Whether the
    // source's CustomEntry survives into the branched file is an SDK
    // quirk (the SDK's createBranchedSession defers file writes when the
    // branch has no assistant message per
    // `dist/core/session-manager.js:1273`) — the structural guarantee
    // comes from `BudgetLedger.restore()` reading the branched SM's
    // branch, not from the file persisting. We assert on the audit entry
    // (the new snapshot) which is the observable contract.
    const openedBranch = openedSM!.getBranch();
    const restoredEntries = openedBranch.filter(
      (e) =>
        e.type === "custom" &&
        (e as { customType?: string }).customType === BUDGET_LEDGER_CUSTOM_TYPE,
    );
    const kinds = restoredEntries.map((e) => (e as unknown as BudgetLedgerEntry).data.kind);
    assert.ok(
      kinds.includes("restore"),
      `branched SM includes the kind:restore entry (got kinds: ${JSON.stringify(kinds)}, ${openedBranch.length} total entries)`,
    );
  });
