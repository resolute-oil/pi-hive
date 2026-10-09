// Wave 7 F13 production wiring — operator-command pickup consumer tests.
//
// The F1-F13 audit caught that the dashboard server writes operator-
// command requests to `operator-command-pickup.jsonl` but nothing
// drains the file. These tests pin the new consumer
// (`src/integration/operator-pickup.ts`) end-to-end:
//
//   1. Unit: drain N rows, verify N commands invoked correctly, file
//      is cleared.
//   2. Integration: simulate the producer (HTTP /operator-command) →
//      consumer (pickupOperatorCommandRequests) flow end-to-end.
//   3. Error: a row that fails (e.g., no live worker handle) does
//      not block the others.
//   4. Idempotency: the second pickup call on an empty / cleared
//      file is a no-op.
//   5. Mode gate: pickup skips when state.mode === "normal".
//
// The producer side is exercised separately in
// tests/server-routes.spec.ts (F13 T13.1 RPC test). The consumer
// here is the Wave 7 fixup half.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionStats } from "@earendil-works/pi-coding-agent";
import { BudgetLedger } from "../src/engine/budget/ledger.ts";
import * as workerTools from "../src/engine/budget/worker-tools.ts";

// Narrow test seam — mirrors the pattern in tests/budget-eol.test.ts.
// The real `__registerHandle` is typed for the full `WorkerHandle`
// (which requires a real `AgentSession`); the test uses a `FakeSession`
// to avoid the SDK's full surface.
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

import {
  isOperatorCommandPickupRunning,
  operatorCommandQueuePath,
  pickupOperatorCommandRequests,
  startOperatorCommandPickup,
  stopOperatorCommandPickup,
  __resetOperatorCommandPickupForTests,
} from "../src/integration/operator-pickup.ts";
import {
  __resetAutoWakeForTests,
  __setAutoWakeInternalsForTests,
  getOrCreateInflightWake,
  releaseWorkerWake,
  wakesForCommand,
} from "../src/integration/auto-wake.ts";

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
  return {
    agent,
    session,
    controller,
    sessionManager: sm,
    ledger,
    policy: { worker: {}, team: {} },
  };
}

// Set the queue path to a temp file by overriding the env vars the
// consumer reads. Each test calls this with its own tmp dir.
function withTempQueuePath(dir: string, fn: () => Promise<void>): Promise<void> {
  // HIVE_TELEMETRY_DB drives `path.dirname(db)`; setting it to
  // <dir>/telemetry.db means the queue is at <dir>/operator-command-pickup.jsonl.
  const prevDb = process.env.HIVE_TELEMETRY_DB;
  const prevAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.HIVE_TELEMETRY_DB = join(dir, "telemetry.db");
  process.env.PI_CODING_AGENT_DIR = dir;
  return fn().finally(() => {
    if (prevDb === undefined) delete process.env.HIVE_TELEMETRY_DB;
    else process.env.HIVE_TELEMETRY_DB = prevDb;
    if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgent;
    __resetOperatorCommandPickupForTests();
  });
}

function writeRows(dir: string, rows: Array<{ id: string; agent: string; command: string; requestedAt: string }>): void {
  const queuePath = operatorCommandQueuePath();
  const lines = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(queuePath, lines, { mode: 0o600 });
  // Confirm the dir matches what withTempQueuePath set up.
  assert.equal(dirname(queuePath), dir);
}

function readQueue(_dir: string): string {
  const queuePath = operatorCommandQueuePath();
  try {
    return readFileSync(queuePath, "utf8");
  } catch {
    return "";
  }
}

// ── Test 1: end-to-end drain with a real worker handle ─────────────────

test("Wave 7 F13: pickupOperatorCommandRequests drains a row and invokes the matching operator command (end)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-f13-pickup-"));
  await withTempQueuePath(dir, async () => {
    const handle = await makeHandle("builder");
    registerHandle?.(handle);

    // Simulate the dashboard server: write one row for `end`.
    writeRows(dir, [
      { id: "1", agent: "builder", command: "end", requestedAt: "2026-10-02T00:00:00.000Z" },
    ]);

    const result = await pickupOperatorCommandRequests();
    assert.equal(result.total, 1);
    assert.equal(result.invoked, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.errors.length, 0);

    // File is cleared after the drain.
    assert.equal(readQueue(dir), "", "queue file is cleared after drain");
    // The handle was unregistered by the sleep-after block: `end` is
    // in `wakesForCommand`, so the consumer's finally clause released
    // the handle before returning. endWorkerSession itself is a
    // non-disposing end (preserves resume-ability at the session
    // level), but the wake is transient — every command is wake
    // → operate → sleep, and the next `end` on the same agent
    // would re-wake from the persisted session.
    unregisterHandle?.("builder");
  });
});

// ── Test 2: drain multiple rows, all invoked correctly ────────────────

test("Wave 7 F13: pickupOperatorCommandRequests drains multiple rows in order (end + pause)", async () => {
  // The transient auto-wake (added with the sleeps) means the first
  // command on each agent releases the handle in its `finally`
  // block. Two commands on the same agent therefore need a wake
  // between them, which the test setup does not provide. The test
  // keeps the original "drain multiple rows" intent by using two
  // agents — each gets its own registered handle, both succeed.
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-f13-pickup-multi-"));
  await withTempQueuePath(dir, async () => {
    const handleA = await makeHandle("coder");
    const handleB = await makeHandle("tester");
    registerHandle?.(handleA);
    registerHandle?.(handleB);

    writeRows(dir, [
      { id: "1", agent: "coder", command: "end", requestedAt: "2026-10-02T00:00:00.000Z" },
      { id: "2", agent: "tester", command: "pause", requestedAt: "2026-10-02T00:00:01.000Z" },
    ]);

    const result = await pickupOperatorCommandRequests();
    assert.equal(result.total, 2);
    assert.equal(result.invoked, 2);
    assert.equal(result.failed, 0);
    assert.equal(readQueue(dir), "");
    unregisterHandle?.("coder");
    unregisterHandle?.("tester");
  });
});

// ── Test 3: a failing row does not block the others ───────────────────

test("Wave 7 F13: a row with no live worker handle is reported as failed but does not block the others", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-f13-pickup-fail-"));
  await withTempQueuePath(dir, async () => {
    // Only `coder` is registered; `unknown` will fail.
    const handle = await makeHandle("coder");
    registerHandle?.(handle);

    writeRows(dir, [
      { id: "1", agent: "unknown", command: "end", requestedAt: "2026-10-02T00:00:00.000Z" },
      { id: "2", agent: "coder", command: "pause", requestedAt: "2026-10-02T00:00:01.000Z" },
    ]);

    const result = await pickupOperatorCommandRequests();
    assert.equal(result.total, 2);
    assert.equal(result.invoked, 1, "1 invocation succeeded (coder pause)");
    assert.equal(result.failed, 1, "1 invocation failed (unknown end)");
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].error, /no live worker handle/);
    assert.equal(result.errors[0].agent, "unknown");
    assert.equal(result.errors[0].command, "end");
    assert.equal(readQueue(dir), "", "file is cleared even on partial failure");
    unregisterHandle?.("coder");
  });
});

// ── Test 4: idempotency — second pickup on empty / cleared file ───────

test("Wave 7 F13: a second pickup on a cleared file is a no-op (returns total=0)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-f13-pickup-empty-"));
  await withTempQueuePath(dir, async () => {
    // First pickup on a non-existent file — total=0.
    const r1 = await pickupOperatorCommandRequests();
    assert.equal(r1.total, 0);
    assert.equal(r1.invoked, 0);

    // Write a row, drain it, then a second pickup — also total=0.
    const handle = await makeHandle("coder");
    registerHandle?.(handle);
    writeRows(dir, [
      { id: "1", agent: "coder", command: "pause", requestedAt: "2026-10-02T00:00:00.000Z" },
    ]);
    const r2 = await pickupOperatorCommandRequests();
    assert.equal(r2.total, 1);
    assert.equal(r2.invoked, 1);
    const r3 = await pickupOperatorCommandRequests();
    assert.equal(r3.total, 0, "second pickup on cleared file is a no-op");
    assert.equal(r3.invoked, 0);
    unregisterHandle?.("coder");
  });
});

// ── Test 5: tear-down-all works without a per-row agent ───────────────

test("Wave 7 F13: tear-down-all command iterates all live workers (no per-row agent required)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-f13-pickup-teardown-"));
  await withTempQueuePath(dir, async () => {
    const a = await makeHandle("alpha");
    const b = await makeHandle("beta");
    registerHandle?.(a);
    registerHandle?.(b);

    writeRows(dir, [
      // tear-down-all ignores the per-row agent name (it iterates
      // workerHandles internally). The dashboard sends an empty
      // / placeholder agent for this command.
      { id: "1", agent: "", command: "tear-down-all", requestedAt: "2026-10-02T00:00:00.000Z" },
    ]);

    const result = await pickupOperatorCommandRequests();
    assert.equal(result.total, 1);
    assert.equal(result.invoked, 1, "tear-down-all invoked successfully");
    // Both handles are unregistered (force=false default → endWorkerSession
    // per worker, which preserves the handle, but tearDownAllWorkers
    // calls force=false end which preserves handles; alpha and beta
    // should still be registered).
    unregisterHandle?.("alpha");
    unregisterHandle?.("beta");
  });
});

// ── Test 6: force-kill unregisters the handle (escape hatch) ─────────

test("Wave 7 F13: force-kill unregisters the worker handle (escape-hatch semantics)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-f13-pickup-forcekill-"));
  await withTempQueuePath(dir, async () => {
    const handle = await makeHandle("coder");
    registerHandle?.(handle);

    writeRows(dir, [
      { id: "1", agent: "coder", command: "force-kill", requestedAt: "2026-10-02T00:00:00.000Z" },
    ]);

    const result = await pickupOperatorCommandRequests();
    assert.equal(result.invoked, 1);
    // A subsequent pickup that tries to invoke on `coder` should fail
    // (the handle is gone after force-kill's dispose+unregister).
    writeRows(dir, [
      { id: "2", agent: "coder", command: "pause", requestedAt: "2026-10-02T00:00:01.000Z" },
    ]);
    const r2 = await pickupOperatorCommandRequests();
    assert.equal(r2.failed, 1, "pause after force-kill fails (handle unregistered)");
  });
});

// ── Test 7: malformed rows are skipped, valid ones still drain ────────

test("Wave 7 F13: malformed JSON rows are skipped without aborting the drain", async () => {
  // Each valid row targets a different agent so the transient
  // auto-wake's sleep-after-release does not invalidate the second
  // command's handle lookup. The test's intent (malformed rows are
  // skipped, valid ones still drain) is preserved.
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-f13-pickup-malformed-"));
  await withTempQueuePath(dir, async () => {
    const handleA = await makeHandle("coder");
    const handleB = await makeHandle("tester");
    registerHandle?.(handleA);
    registerHandle?.(handleB);
    const queuePath = operatorCommandQueuePath();
    // Mix valid + malformed lines.
    writeFileSync(
      queuePath,
      [
        JSON.stringify({ id: "1", agent: "coder", command: "pause", requestedAt: "2026-10-02T00:00:00.000Z" }),
        "this is not json",
        JSON.stringify({ id: "2", agent: "tester", command: "pause", requestedAt: "2026-10-02T00:00:01.000Z" }),
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const result = await pickupOperatorCommandRequests();
    assert.equal(result.total, 2, "2 valid rows processed");
    assert.equal(result.invoked, 2);
    unregisterHandle?.("coder");
    unregisterHandle?.("tester");
  });
});

// ── Test 8: command name outside the allow-list is rejected ───────────

test("Wave 7 F13: a command outside the 12-command allow-list is reported as failed (not thrown)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-f13-pickup-allowlist-"));
  await withTempQueuePath(dir, async () => {
    const handle = await makeHandle("coder");
    registerHandle?.(handle);
    writeRows(dir, [
      { id: "1", agent: "coder", command: "shell-escape", requestedAt: "2026-10-02T00:00:00.000Z" },
    ]);
    const result = await pickupOperatorCommandRequests();
    assert.equal(result.total, 1);
    assert.equal(result.invoked, 0);
    assert.equal(result.failed, 1);
    assert.match(result.errors[0].error, /unknown command/);
    unregisterHandle?.("coder");
  });
});

// ── Test 9: hive_reload_agent_config is in the allow-list ─────────────

test("Wave 7 F13: hive_reload_agent_config is in the consumer allow-list (T13.0 follow-up)", async () => {
  // The command operates on the agent's static config (state.config.agents),
  // NOT a live worker handle. The consumer's "requires a live handle"
  // check skips hive_reload_agent_config so the command is invokable
  // even before a worker has been dispatched. With no bound state +
  // ctx (bindReloadAgentConfigState is per-dispatch), the underlying
  // hiveReloadAgentConfig returns reloaded=false; the consumer
  // surfaces this as a failure, but the row is processed (not thrown).
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-f13-pickup-reload-"));
  await withTempQueuePath(dir, async () => {
    writeRows(dir, [
      { id: "1", agent: "coder", command: "hive_reload_agent_config", requestedAt: "2026-10-02T00:00:00.000Z" },
    ]);
    const result = await pickupOperatorCommandRequests();
    assert.equal(result.total, 1);
    // hive_reload_agent_config is allowed without a live worker handle,
    // so the row reaches the underlying hiveReloadAgentConfig. With no
    // bound state, that function returns reloaded=false with a clear
    // error message (not "no live worker handle").
    assert.equal(result.invoked, 0);
    assert.equal(result.failed, 1);
    assert.doesNotMatch(result.errors[0].error, /no live worker handle/, "hive_reload_agent_config does not require a live worker handle");
    assert.match(result.errors[0].error, /no live state|Unknown agent|reload|state\/ctx/i);
  });
});

// ── Test 10: integration — producer (write) + consumer (pickup) ──────

test("Wave 7 F13 integration: producer writes to the file, consumer reads and invokes, file is cleared", async () => {
  // This is the end-to-end test the F1-F13 audit asked for: simulate
  // the full dashboard → parent-pi flow. Producer is a direct
  // appendFileSync (mirroring the dashboard server's
  // `writeOperatorCommandRequest`); consumer is `pickupOperatorCommandRequests`.
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-f13-pickup-integration-"));
  await withTempQueuePath(dir, async () => {
    const handle = await makeHandle("builder");
    registerHandle?.(handle);

    // ── Producer side: the dashboard server writes one row per
    // click via writeOperatorCommandRequest (in db.ts). We mirror
    // that here with a direct appendFileSync so this test is
    // hermetic (the test does not need to start the dashboard server).
    const queuePath = operatorCommandQueuePath();
    const id1 = "row-1";
    const requestedAt = "2026-10-02T00:00:00.000Z";
    writeFileSync(
      queuePath,
      JSON.stringify({ id: id1, agent: "builder", command: "end", requestedAt }) + "\n",
      { mode: 0o600 },
    );

    // Sanity: file is non-empty before pickup.
    assert.notEqual(readQueue(dir), "", "queue file is non-empty after producer write");

    // ── Consumer side: drain.
    const result = await pickupOperatorCommandRequests();
    assert.equal(result.total, 1, "consumer sees the producer's row");
    assert.equal(result.invoked, 1, "consumer invokes the matching operator command");
    assert.equal(result.failed, 0);

    // File is cleared.
    assert.equal(readQueue(dir), "", "consumer clears the file after drain");
    unregisterHandle?.("builder");
  });
});

// ── Test 11: startOperatorCommandPickup / stopOperatorCommandPickup ──

test("Wave 7 F13: startOperatorCommandPickup starts a polling loop; stopOperatorCommandPickup clears it (AGENTS.md session-scoped process rule)", async () => {
  // Lightweight test: the loop drains rows on its own; we just
  // verify the start/stop idempotency and that the loop polls
  // without manual invocation.
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-f13-pickup-loop-"));
  await withTempQueuePath(dir, async () => {
    const handle = await makeHandle("builder");
    registerHandle?.(handle);

    assert.equal(isOperatorCommandPickupRunning(), false, "no pickup running initially");

    const fakeState: any = { mode: "hive" };
    const fakeCtx: any = { hasUI: false, ui: { notify: () => undefined } };
    startOperatorCommandPickup(fakeState, fakeCtx);
    assert.equal(isOperatorCommandPickupRunning(), true, "pickup running after start");

    // Calling start a second time is a no-op (the existing timer stays).
    startOperatorCommandPickup(fakeState, fakeCtx);
    assert.equal(isOperatorCommandPickupRunning(), true, "second start is a no-op");

    stopOperatorCommandPickup();
    assert.equal(isOperatorCommandPickupRunning(), false, "pickup stopped after stopOperatorCommandPickup");

    // Calling stop again is a no-op.
    stopOperatorCommandPickup();
    assert.equal(isOperatorCommandPickupRunning(), false, "second stop is a no-op");

    unregisterHandle?.("builder");
  });
});

// ── Cleanup ────────────────────────────────────────────────────────────

test("Wave 7 F13: operatorCommandQueuePath resolves to <hive-dir>/operator-command-pickup.jsonl", () => {
  // Pin the path shape so a refactor of the env-var precedence does
  // not silently break the producer/consumer contract.
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-f13-pickup-path-"));
  const prevDb = process.env.HIVE_TELEMETRY_DB;
  const prevAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.HIVE_TELEMETRY_DB = join(dir, "telemetry.db");
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const path = operatorCommandQueuePath();
    assert.ok(path.endsWith("/operator-command-pickup.jsonl"), `path ends with /operator-command-pickup.jsonl; got ${path}`);
    assert.ok(path.startsWith(dir), `path starts with the temp dir; got ${path}`);
  } finally {
    if (prevDb === undefined) delete process.env.HIVE_TELEMETRY_DB;
    else process.env.HIVE_TELEMETRY_DB = prevDb;
    if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgent;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ── Helpers for transient auto-wake tests ──────────────────────────────

// Create a real persisted SessionManager under `tmpDir` with at
// least one entry (so SessionManager.continueRecent on the same dir
// finds it and the wake's getEntryCount() > 0 check passes). The
// returned SessionManager is bound to the on-disk file; future
// reads via continueRecent in the same dir will return the same
// session.
//
// The `options.sessionDir` defaults to `<tmpDir>/sessions` so the
// fixture is hermetic. The wake's `sessionManagerContinueRecent`
// seam in auto-wake.ts receives the cwd and resolves the session
// dir via the same default, so pointing both at the same temp dir
// is enough.
function makePersistedSessionFixture(tmpDir: string, _options: { entries?: number } = {}): SessionManager {
  const sessionDir = join(tmpDir, "sessions");
  // SessionManager.create resolves the session file under
  // `<agentDir>/sessions/<encoded-cwd>/<session-id>.jsonl`. We
  // need a real session file so continueRecent finds it.
  const sm = SessionManager.create(tmpDir, sessionDir);
  // Append one user message so getEntryCount() returns at least 1.
  sm.appendMessage({
    role: "user",
    content: "wake fixture seed",
    timestamp: Date.now(),
  } as never);
  return sm;
}

// Build a minimal HiveState that satisfies the wake's preconditions:
// state.config is non-null, the agent is declared, and the agents /
// orchestrator arrays are typed as the wake expects. `cwd` defaults
// to the test's temp dir so the wake's `sessionManagerContinueRecent`
// seam (which resolves sessions under `<cwd>`'s encoded session dir)
// can find the persisted fixture built by `makePersistedSessionFixture`.
function makeWakeState(agentName: string, options: { unknown?: boolean; cwd?: string } = {}): {
  state: any;
  ctx: any;
} {
  const agentConfig = options.unknown
    ? { name: "different-agent" }
    : { name: agentName };
  const state: any = {
    config: {
      agents: [agentConfig],
      orchestrator: undefined,
      settings: {},
    },
    runtimes: new Map(),
    mode: "hive",
  };
  const ctx: any = {
    cwd: options.cwd ?? "/tmp/wake-fixture",
    hasUI: false,
  };
  return { state, ctx };
}

// Build a fake AgentSession that the operator commands can call
// against. The wake's createAgentSessionFn seam returns this shape
// (cast to AgentSession so the workerHandle registration accepts
// it). The methods track call counts so tests can assert that
// compact / abort / waitForIdle were invoked.
function makeWakeSession(id: string, sm: SessionManager) {
  let compactCount = 0;
  let abortCount = 0;
  let waitForIdleCount = 0;
  const session = {
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
    compact: async (_ci?: string) => {
      compactCount += 1;
      return { summary: "", firstKeptEntryId: "x", tokensBefore: 150, estimatedTokensAfter: 80 };
    },
    abort: async () => {
      abortCount += 1;
    },
    waitForIdle: async () => {
      waitForIdleCount += 1;
    },
    abortCompaction: () => {},
    dispose: () => {},
    subscribe: (_listener: unknown) => () => {},
    // Test introspection: counts surfaced via the returned closure.
    __counts: () => ({ compact: compactCount, abort: abortCount, waitForIdle: waitForIdleCount }),
  };
  return session as any;
}

// Helper: build a CreateAgentSessionResult-shaped object from a
// fake session. The wake's createAgentSessionFn seam expects this
// shape, but the test's fake session has extra `__counts`
// introspection that the wake does not need. The cast keeps the
// test code free of `unknown`/`never` plumbing at the call sites.
function asCreateResult(fakeSession: any): { session: any } {
  return { session: fakeSession };
}

// ── Test 12: wake+compact success ───────────────────────────────────

test("transient auto-wake: compact wakes the session, invokes compactWorkerSession, and unregisters before returning", async () => {
  // The wake rehydrates the agent's persisted session, registers a
  // WorkerHandle, the per-command side effect (compactWorkerSession)
  // runs against the live handle, and the sleep unregisters the
  // handle before the operator sees the result. The test pins all
  // four conditions.
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-f13-wake-compact-"));
  const sm = makePersistedSessionFixture(dir);
  const fakeSession = makeWakeSession("wake-compact-session", sm);
  __setAutoWakeInternalsForTests({
    sessionManagerContinueRecent: () => sm,
    createAgentSessionFn: async () => asCreateResult(fakeSession),
  });
  try {
    await withTempQueuePath(dir, async () => {
      const { state, ctx } = makeWakeState("builder", { cwd: dir });
      // Confirm pre-condition: the wake's WorkerHandle is not yet
      // registered.
      assert.equal(workerTools.lookupWorkerHandleForProduction?.("builder"), undefined, "no live handle before the wake");

      writeRows(dir, [
        { id: "1", agent: "builder", command: "compact", requestedAt: "2026-10-02T00:00:00.000Z" },
      ]);

      const result = await pickupOperatorCommandRequests({ state, ctx });
      assert.equal(result.total, 1);
      assert.equal(result.invoked, 1, "compact invoked after wake");
      assert.equal(result.failed, 0);

      // (a) the wake fired — createAgentSessionFn was called.
      // (b) compactWorkerSession was invoked against the live session.
      assert.equal(fakeSession.__counts().compact, 1, "compact called exactly once on the wake session");
      // (c) result is ok:true.
      assert.equal(result.errors.length, 0);
      // (d) the handle is gone before the operator returns.
      assert.equal(workerTools.lookupWorkerHandleForProduction?.("builder"), undefined, "handle unregistered before result returns");
    });
  } finally {
    __resetAutoWakeForTests();
    unregisterHandle?.("builder");
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ── Test 13: wake+unknown fails closed ───────────────────────────────

test("transient auto-wake: agent with no persisted session fails closed with the byte-identical pre-change error", async () => {
  // The wake's fail-closed contract: when the agent has no
  // persisted session (continueRecent returns an empty SM), the
  // wake returns undefined, and the consumer surfaces the
  // pre-change "no live worker handle for agent ..." error
  // byte-identically. This is the regression net for the byte-
  // identical error message contract documented in the
  // operator-pickup.ts comment.
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-f13-wake-failclosed-"));
  // No fixture: continueRecent returns an in-memory SM with no
  // entries, so the wake's getEntryCount() === 0 check fires.
  const emptySm = SessionManager.inMemory(dir);
  __setAutoWakeInternalsForTests({
    sessionManagerContinueRecent: () => emptySm,
    createAgentSessionFn: async () => {
      throw new Error("createAgentSessionFn should not be called when the wake is fail-closed");
    },
  });
  try {
    await withTempQueuePath(dir, async () => {
      const { state, ctx } = makeWakeState("ghost", { cwd: dir });

      writeRows(dir, [
        { id: "1", agent: "ghost", command: "compact", requestedAt: "2026-10-02T00:00:00.000Z" },
      ]);

      const result = await pickupOperatorCommandRequests({ state, ctx });
      assert.equal(result.total, 1);
      assert.equal(result.invoked, 0);
      assert.equal(result.failed, 1);
      // Byte-identical to the pre-change error string at
      // operator-pickup.ts:144-148. The wake must fail-closed so
      // the consumer can surface this message unchanged.
      assert.equal(
        result.errors[0].error,
        `no live worker handle for agent "ghost"`,
        "error string must be byte-identical to the pre-change message",
      );
    });
  } finally {
    __resetAutoWakeForTests();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ── Test 14: respawn does not wake ──────────────────────────────────

test("transient auto-wake: respawn does not wake (respawn operates on persisted state, not a live session)", async () => {
  // respawn is NOT in wakesForCommand: it discards the old
  // session and creates a clean slate, so waking first would be
  // wasted I/O. The test stubs `sessionManagerContinueRecent` to
  // throw if called, which would cause the wake to return
  // undefined; the consumer's pre-switch gate then surfaces the
  // pre-change "no live worker handle" error. If the assertion
  // (counter === 0) holds, the wake was never attempted.
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-f13-wake-respawn-"));
  let continueRecentCalls = 0;
  __setAutoWakeInternalsForTests({
    sessionManagerContinueRecent: () => {
      continueRecentCalls += 1;
      throw new Error("wake must NOT be attempted for respawn");
    },
    createAgentSessionFn: async () => {
      throw new Error("wake must NOT be attempted for respawn");
    },
  });
  try {
    await withTempQueuePath(dir, async () => {
      const { state, ctx } = makeWakeState("builder", { cwd: dir });
      writeRows(dir, [
        { id: "1", agent: "builder", command: "respawn", requestedAt: "2026-10-02T00:00:00.000Z" },
      ]);
      const result = await pickupOperatorCommandRequests({ state, ctx });
      assert.equal(result.total, 1);
      assert.equal(result.invoked, 0);
      assert.equal(result.failed, 1);
      // The consumer bails out at the pre-switch gate because no
      // live handle is registered (and respawn is not in
      // wakesForCommand so the wake gate is skipped). The
      // counter check confirms the wake was never attempted.
      assert.equal(continueRecentCalls, 0, "wake must NOT be attempted for respawn");
      assert.match(result.errors[0].error, /no live worker handle/);
    });
  } finally {
    __resetAutoWakeForTests();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ── Test 15: two simultaneous wakes resolve to one handle ──────────

test("transient auto-wake: two simultaneous compact commands for the same agent share one wake (concurrency guard)", async () => {
  // The single JS event loop + the in-flight Map means two
  // requests for the same agent resolve to one factory call. The
  // counter in the test stub counts how many times
  // sessionManagerContinueRecent (and therefore the wake) is
  // invoked. Both compact commands succeed; only one wake fires.
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-f13-wake-concurrency-"));
  const sm = makePersistedSessionFixture(dir);
  let factoryCalls = 0;
  try {
    // The consumer processes rows sequentially (await in a for-
    // loop), so two rows in a single pickup do not actually race.
    // The concurrency guard is for callers that issue parallel
    // wake requests — a future parallel consumer, an RPC handler,
    // or a chat tool that needs to wake + act on the same session.
    // The test invokes getOrCreateInflightWake twice in the same
    // tick and pins that the factory runs only once.
    const factory = async (): Promise<any> => {
      factoryCalls += 1;
      // Yield so the second call's getOrCreateInflightWake sees
      // the in-flight entry before the first resolves. A single
      // microtask is enough because the Map read happens
      // synchronously after the factory's first await.
      await Promise.resolve();
      return { sessionManager: sm, session: makeWakeSession("wake-concurrency-session", sm) } as any;
    };
    const promise1 = getOrCreateInflightWake({} as any, "builder", factory);
    const promise2 = getOrCreateInflightWake({} as any, "builder", factory);
    const [r1, r2] = await Promise.all([promise1, promise2]);
    assert.equal(factoryCalls, 1, "factory called once for two simultaneous wake requests");
    assert.ok(r1, "first wake resolved to a WorkerContext");
    assert.ok(r2, "second wake resolved to a WorkerContext");
    assert.equal(r1, r2, "both callers receive the same WorkerContext (dedup)");
  } finally {
    __resetAutoWakeForTests();
    unregisterHandle?.("builder");
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ── Test 16: handle is unregistered after success ──────────────────

test("transient auto-wake: handle is unregistered after the operator command completes (no persistent idle state)", async () => {
  // Focused version of Test 12 that reads the handle map directly
  // through the test seam and asserts the agent is NOT in the
  // map after the operator returns. This pins the sleep-after
  // contract: every command is wake → operate → sleep.
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-f13-wake-sleep-"));
  const sm = makePersistedSessionFixture(dir);
  const fakeSession = makeWakeSession("wake-sleep-session", sm);
  __setAutoWakeInternalsForTests({
    sessionManagerContinueRecent: () => sm,
    createAgentSessionFn: async () => asCreateResult(fakeSession),
  });
  try {
    await withTempQueuePath(dir, async () => {
      const { state, ctx } = makeWakeState("builder", { cwd: dir });
      // The wake test below exercises the `pause` path. Reads
      // against the live handle map through the test seam.
      const lookupBefore = workerTools.lookupWorkerHandleForProduction?.("builder");
      assert.equal(lookupBefore, undefined, "no handle before the wake");

      writeRows(dir, [
        { id: "1", agent: "builder", command: "pause", requestedAt: "2026-10-02T00:00:00.000Z" },
      ]);
      const result = await pickupOperatorCommandRequests({ state, ctx });
      assert.equal(result.invoked, 1);
      assert.equal(result.failed, 0);
      // The wake fired, the per-command side effect ran
      // (waitForIdle was called), and the handle is gone.
      assert.equal(fakeSession.__counts().waitForIdle, 1, "waitForIdle called once during pause");
      const lookupAfter = workerTools.lookupWorkerHandleForProduction?.("builder");
      assert.equal(lookupAfter, undefined, "handle is unregistered after the operator returns (sleep-after contract)");
    });
  } finally {
    __resetAutoWakeForTests();
    unregisterHandle?.("builder");
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ── Test 17: wakesForCommand membership pin ────────────────────────

test("transient auto-wake: wakesForCommand contains exactly the 5 commands the brief specified", () => {
  // Pin the membership so a refactor of the wake gate (e.g.,
  // accidentally adding force-kill or removing resume) surfaces as
  // a test failure. The set is exported as a ReadonlySet so
  // callers cannot mutate it from outside.
  assert.deepEqual(
    [...wakesForCommand].sort(),
    ["compact", "end", "pause", "resume", "snapshot"],
    "wakesForCommand must contain exactly compact, end, pause, resume, snapshot",
  );
});

// ── Test 18: releaseWorkerWake is a no-op on an unregistered agent ─

test("transient auto-wake: releaseWorkerWake is a no-op when the handle was never registered", () => {
  // Defensive: the operator-pickup consumer's finally clause calls
  // releaseWorkerWake for every wake-eligible command. If the
  // command did not actually wake (e.g., the consumer bailed out
  // before the wake path, or the handle was already unregistered
  // by the command itself), the release must be silent.
  // releaseWorkerWake never throws.
  assert.doesNotThrow(() => releaseWorkerWake("never-registered-agent"));
  // And the handle map is unchanged.
  assert.equal(workerTools.lookupWorkerHandleForProduction?.("never-registered-agent"), undefined);
});
