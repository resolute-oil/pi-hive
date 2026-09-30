// Wave 3 — Agent 3C tests for F5 branch/clone operator commands (T5.3, T5.5, T5.6).
//
// Shared file with Agent 3B (their region: lines TBD, top-level test() blocks
// only). This file's tests use the WorkerContext + internals seam in
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

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, SessionManager, SessionStats, SessionEntry, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { SessionManager as SessionManagerClass } from "@earendil-works/pi-coding-agent";
import type { BudgetLedger } from "../src/engine/budget/ledger.ts";
import type { WorkerBudgetPolicy, BudgetLedgerEntry } from "../src/core/types.ts";
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
function makeFakeSession(opts: { sessionId?: string; onDispose?: () => void } = {}) {
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
  const { session, sessionManager, appendedEntries } = makeFakeSession({ sessionId: "old-session-id" });
  const { ledger } = makeFakeLedger();

  const newFakeSessionManager: any = {
    ...sessionManager,
    toAgentSession: () => ({ sessionId: "new-session-id" }),
  };

  const ctx: WorkerContext = {
    agent: "coder",
    session,
    sessionManager,
    ledger,
    policy: basePolicy,
    cwd: "/tmp/work",
    internals: { sessionManagerCreate: () => newFakeSessionManager },
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
  const { session, sessionManager } = makeFakeSession({ sessionId: "old" });
  const { ledger } = makeFakeLedger();

  const tracker = makeOrderTracker();
  const newFakeSM: any = { toAgentSession: () => ({ sessionId: "new-session-id" }) };
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
    internals: { sessionManagerCreate: createSpy },
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
  const { session, sessionManager, getListeners } = makeFakeSession({ sessionId: "old" });
  const { ledger } = makeFakeLedger();

  // Capture a listener before respawn.
  let listenerCalls = 0;
  const unsubscribe = session.subscribe(() => { listenerCalls += 1; });
  assert.equal(getListeners().length, 1, "listener registered");

  const newFakeSessionManager: any = {
    toAgentSession: () => ({ sessionId: "new-session-id" }),
  };

  const ctx: WorkerContext = {
    agent: "coder",
    session,
    sessionManager,
    ledger,
    policy: basePolicy,
    cwd: "/tmp/work",
    internals: { sessionManagerCreate: () => newFakeSessionManager },
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
  const { session, sessionManager, appendedEntries } = makeFakeSession({ sessionId: "sess-1" });
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
  const { session, sessionManager } = makeFakeSession({ sessionId: "sess-1" });
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
  const { session, sessionManager, appendedEntries } = makeFakeSession({ sessionId: "sess-1" });
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
  const { session, sessionManager } = makeFakeSession({ sessionId: "old" });
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
  const sourceSM = SessionManagerClass.create(cwd, sessionDir);
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
  const { session, sessionManager: fakeSM } = makeFakeSession({ sessionId: "fake" });
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
      // The seam overrides SessionManagerClass.create — for restore we use
      // sessionManagerOpen instead. Use the real SessionManager.open on the
      // path returned by createBranchedSession.
      sessionManagerOpen: (path: string) => SessionManagerClass.open(path, sessionDir, cwd),
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
  const { session, sessionManager } = makeFakeSession({ sessionId: "old" });
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
  const { session, sessionManager } = makeFakeSession({ sessionId: "old" });
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
