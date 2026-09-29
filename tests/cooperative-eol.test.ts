/**
 * T5.10 / T5.11 / T5.12 — cooperative end-of-life tools.
 *
 * Coverage (3 tests; 1 per cooperative tool):
 *   1. `requestCompaction` writes a `cooperative-compact` ledger entry and
 *      invokes `session.compact(notes)` on the caller's runtime.
 *   2. `requestEndSession` writes a `cooperative-end` ledger entry and
 *      invokes `session.abort()` on the caller's runtime.
 *   3. `requestSnapshot` writes a `cooperative-snapshot` ledger entry and
 *      invokes `sessionManager.branchWithSummary(...)` on the caller's
 *      runtime.
 *
 * Each test substitutes a fake runtime for the real `AgentRuntime`. The
 * fake session captures method calls and returns a scripted
 * `CompactionResult` (for `requestCompaction`) so the cooperative tool can
 * be exercised without booting the SDK's extension runner.
 *
 * The "underlying operator command" in the wave 3D spec maps to the SDK
 * primitive (`session.compact`, `session.abort`, `branchWithSummary`).
 * Once Wave 3B/3C land, the cooperative tools' SDK calls remain — the
 * operator commands will wrap them.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  requestCompaction,
  requestEndSession,
  requestSnapshot,
} from "../src/engine/budget/worker-tools.ts";
import { BUDGET_LEDGER_CUSTOM_TYPE } from "../src/engine/budget/ledger.ts";
import type { AgentConfig, AgentRuntime, HiveState } from "../src/core/types.ts";

// ---------------------------------------------------------------------------
// Fakes.
// ---------------------------------------------------------------------------

interface FakeAppendCall {
  customType: string;
  data: Record<string, unknown>;
}

interface FakeSessionManager {
  appendCustomEntry: (customType: string, data?: unknown) => string;
  getLeafId: () => string | null;
  branchWithSummary: (branchFromId: string | null, summary: string) => string;
  appendCalls: FakeAppendCall[];
  branchCalls: Array<{ branchFromId: string | null; summary: string }>;
}

function makeFakeSessionManager(opts: { leafId?: string | null; snapshotId?: string } = {}): FakeSessionManager {
  const appendCalls: FakeAppendCall[] = [];
  const branchCalls: Array<{ branchFromId: string | null; summary: string }> = [];
  const fake: FakeSessionManager = {
    appendCalls,
    branchCalls,
    appendCustomEntry(customType: string, data?: unknown) {
      appendCalls.push({ customType, data: (data ?? {}) as Record<string, unknown> });
      return `entry-${appendCalls.length}`;
    },
    getLeafId() {
      return opts.leafId ?? "leaf-1";
    },
    branchWithSummary(branchFromId, summary) {
      branchCalls.push({ branchFromId, summary });
      return opts.snapshotId ?? "snap-1";
    },
  };
  return fake;
}

interface FakeSession {
  sessionManager: FakeSessionManager;
  compactCalls: Array<{ customInstructions?: string }>;
  compactResult: { tokensBefore: number; estimatedTokensAfter?: number };
  abortCalls: number;
  compact: (customInstructions?: string) => Promise<{ tokensBefore: number; estimatedTokensAfter?: number }>;
  abort: () => Promise<void>;
}

function makeFakeSession(opts: {
  leafId?: string | null;
  snapshotId?: string;
  compactResult?: { tokensBefore: number; estimatedTokensAfter?: number };
} = {}): FakeSession {
  const sessionManager = makeFakeSessionManager(opts);
  const compactCalls: Array<{ customInstructions?: string }> = [];
  const compactResult = opts.compactResult ?? { tokensBefore: 1234, estimatedTokensAfter: 800 };
  const fake: FakeSession = {
    sessionManager,
    compactCalls,
    compactResult,
    abortCalls: 0,
    async compact(customInstructions?: string) {
      compactCalls.push({ customInstructions });
      return compactResult;
    },
    async abort() {
      fake.abortCalls += 1;
    },
  };
  return fake;
}

function makeRuntime(opts: {
  session?: FakeSession;
  contextWindow?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  runCount?: number;
} = {}): AgentRuntime {
  const config: AgentConfig = {
    name: "Builder",
    path: "/tmp/builder",
    slug: "builder",
  };
  const session = opts.session ?? makeFakeSession();
  return {
    config,
    systemPrompt: "",
    status: "running",
    task: "",
    lastWork: "",
    toolCount: 0,
    elapsedMs: 0,
    inputTokens: opts.inputTokens ?? 100,
    outputTokens: opts.outputTokens ?? 200,
    cacheReadTokens: opts.cacheReadTokens ?? 0,
    cacheWriteTokens: opts.cacheWriteTokens ?? 0,
    reasoningTokens: 0,
    costUsd: opts.costUsd ?? 0.42,
    contextPct: 0,
    contextTokens: 300,
    contextWindow: opts.contextWindow ?? 8000,
    runCount: opts.runCount ?? 1,
    sessionFile: "/tmp/builder.jsonl",
    session,
  };
}

function makeState(runtime?: AgentRuntime): HiveState {
  return {
    pi: {} as HiveState["pi"],
    config: null,
    session: null,
    runtimes: runtime ? new Map([[runtime.config.slug, runtime]]) : new Map(),
    widgetCtx: null,
    activeRuns: 0,
    mode: "hive",
    normalToolNames: [],
    sddStatus: null,
    obsSeq: 0,
  };
}

// ---------------------------------------------------------------------------
// 1. requestCompaction writes cooperative-compact + invokes session.compact.
// ---------------------------------------------------------------------------

test("requestCompaction writes a cooperative-compact ledger entry and invokes session.compact", async () => {
  const session = makeFakeSession({
    compactResult: { tokensBefore: 1500, estimatedTokensAfter: 750 },
  });
  const runtime = makeRuntime({
    session,
    contextWindow: 8000,
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.42,
    runCount: 2,
  });
  const state = makeState(runtime);

  const result = await requestCompaction(state, "builder", { notes: "compact requested" });

  // Result shape mirrors the operator's `compactWorkerSession` result contract
  // (ok + the compaction deltas the worker needs to decide whether to
  // continue).
  assert.equal(result.ok, true);
  assert.equal(result.compacted, true);
  assert.equal(result.estimatedTokens, 750, "estimatedTokens mirrors compact's estimatedTokensAfter");
  assert.equal(result.limit, 8000, "limit mirrors the runtime's contextWindow");
  assert.equal(result.reason, undefined);
  assert.equal(result.error, undefined);

  // session.compact was invoked once with the notes as customInstructions.
  assert.equal(session.compactCalls.length, 1);
  assert.deepEqual(session.compactCalls[0], { customInstructions: "compact requested" });

  // Ledger write: exactly one CustomEntry with the cooperative-compact kind
  // and the runtime's accumulated counters.
  const sm = session.sessionManager;
  assert.equal(sm.appendCalls.length, 1, "exactly one cooperative ledger write");
  const call = sm.appendCalls[0];
  assert.equal(call.customType, BUDGET_LEDGER_CUSTOM_TYPE);
  assert.equal(call.data.kind, "cooperative-compact", "kind matches §2.3 cooperative-compact");
  assert.equal(call.data.agentSlug, "builder");
  assert.equal(call.data.marker, "checkpoint");
  assert.deepEqual(call.data.cumulative, { tokens: 300, costUsd: 0.42, runs: 2 });
  assert.equal(call.data.reason, "compact requested", "cooperative reason recorded on the entry");
});

// ---------------------------------------------------------------------------
// 2. requestEndSession writes cooperative-end + invokes session.abort.
// ---------------------------------------------------------------------------

test("requestEndSession writes a cooperative-end ledger entry and invokes session.abort", async () => {
  const session = makeFakeSession();
  const runtime = makeRuntime({ session, runCount: 3, costUsd: 1.5 });
  const state = makeState(runtime);

  const result = await requestEndSession(state, "builder", { reason: "task complete" });

  // Result shape mirrors the operator's `endWorkerSession` contract.
  assert.equal(result.ok, true);
  assert.equal(result.reason, undefined);

  // session.abort was invoked once.
  assert.equal(session.abortCalls, 1);

  // Ledger write: exactly one CustomEntry with the cooperative-end kind.
  const sm = session.sessionManager;
  assert.equal(sm.appendCalls.length, 1);
  const call = sm.appendCalls[0];
  assert.equal(call.customType, BUDGET_LEDGER_CUSTOM_TYPE);
  assert.equal(call.data.kind, "cooperative-end", "kind matches §2.3 cooperative-end");
  assert.equal(call.data.agentSlug, "builder");
  assert.equal(call.data.marker, "checkpoint");
  assert.deepEqual(call.data.cumulative, { tokens: 300, costUsd: 1.5, runs: 3 });
  assert.equal(call.data.reason, "task complete", "cooperative reason recorded on the entry");
});

// ---------------------------------------------------------------------------
// 3. requestSnapshot writes cooperative-snapshot + invokes branchWithSummary.
// ---------------------------------------------------------------------------

test("requestSnapshot writes a cooperative-snapshot ledger entry and invokes branchWithSummary", async () => {
  const session = makeFakeSession({ leafId: "leaf-42", snapshotId: "snap-42" });
  const runtime = makeRuntime({ session, runCount: 5, costUsd: 2.5 });
  const state = makeState(runtime);

  const result = await requestSnapshot(state, "builder", { label: "pre-cleanup" });

  // Result shape mirrors the operator's `snapshotWorkerSession` contract.
  assert.equal(result.ok, true);
  assert.equal(result.snapshotId, "snap-42", "snapshotId mirrors branchWithSummary's return");
  assert.equal(result.reason, undefined);

  // branchWithSummary was invoked with the leaf id + label.
  const sm = session.sessionManager;
  assert.equal(sm.branchCalls.length, 1);
  assert.deepEqual(sm.branchCalls[0], { branchFromId: "leaf-42", summary: "pre-cleanup" });

  // Ledger write: exactly one CustomEntry with the cooperative-snapshot kind
  // and the produced snapshot id linked on the entry.
  assert.equal(sm.appendCalls.length, 1);
  const call = sm.appendCalls[0];
  assert.equal(call.customType, BUDGET_LEDGER_CUSTOM_TYPE);
  assert.equal(call.data.kind, "cooperative-snapshot", "kind matches §2.3 cooperative-snapshot");
  assert.equal(call.data.agentSlug, "builder");
  assert.equal(call.data.marker, "checkpoint");
  assert.deepEqual(call.data.cumulative, { tokens: 300, costUsd: 2.5, runs: 5 });
  assert.equal(call.data.label, "pre-cleanup", "label recorded on the entry");
  assert.equal(call.data.snapshotId, "snap-42", "snapshotId recorded on the entry");
});

// ---------------------------------------------------------------------------
// B3: requestEndSession / requestSnapshot distinguish "no_runtime" from
// "session_unavailable" so the dashboard can tell whether the worker has
// not been dispatched yet vs. the worker's session is in an unexpected
// state. requestCompaction already returns the distinct "compact_failed"
// reason + error string — bring the other two into the same envelope.
// ---------------------------------------------------------------------------

test("requestEndSession: no runtime returns {ok: false, reason: 'no_runtime'} (existing)", async () => {
  const state = makeState();  // empty runtimes map
  const result = await requestEndSession(state, "builder", { reason: "task complete" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_runtime");
});

test("requestEndSession: runtime exists but session lacks abort method returns distinct reason (B3)", async () => {
  const runtime = makeRuntime();  // default fake session IS abortable, so unset it
  (runtime as { session: unknown }).session = undefined;
  const state = makeState(runtime);
  const result = await requestEndSession(state, "builder", { reason: "task complete" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "session_unavailable", "session-unavailable must not be classified as no_runtime");
  assert.ok(result.error && /abortable/i.test(result.error), "error string describes the missing capability");
});

test("requestSnapshot: no runtime returns {ok: false, reason: 'no_runtime'} (existing)", async () => {
  const state = makeState();  // empty runtimes map
  const result = await requestSnapshot(state, "builder", { label: "pre-cleanup" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_runtime");
});

test("requestSnapshot: runtime exists but sessionManager lacks branchWithSummary returns distinct reason (B3)", async () => {
  const runtime = makeRuntime();
  (runtime as { session: unknown }).session = undefined;
  const state = makeState(runtime);
  const result = await requestSnapshot(state, "builder", { label: "pre-cleanup" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "session_unavailable", "session-unavailable must not be classified as no_runtime");
  assert.ok(result.error && /snapshotable/i.test(result.error), "error string describes the missing capability");
});

// ── B11: cooperative tools refuse when the worker's runtime has settled.
// The audit (HTML §5 B11) flagged that requestCompaction and requestEndSession
// invoked the SDK without checking the worker's lifecycle state. The SDK's
// compact()/abort() do serialize concurrent calls (verified by reading
// agent-session.js: `compact` disconnects + aborts the current agent first;
// `abort` is idempotent via waitForIdle), but the cooperative tools should
// still refuse when the runtime is already in a terminal state — there's
// nothing left to compact or end, and the cooperative ledger entry would
// just confuse the dashboard timeline.
// ---------------------------------------------------------------------------

test("B11: requestCompaction returns session_settled when runtime.status === 'done'", async () => {
  const session = makeFakeSession();
  const runtime = makeRuntime({ session, runCount: 1 });
  runtime.status = "done";
  const state = makeState(runtime);

  const result = await requestCompaction(state, "builder", { notes: "compact requested" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "session_settled", "compaction refuses on settled runtime");
  assert.ok(result.error && /already settled/i.test(result.error));
  assert.equal(session.compactCalls.length, 0, "session.compact() must NOT be called on settled runtime");
});

test("B11: requestEndSession returns session_settled when runtime.status === 'error'", async () => {
  const session = makeFakeSession();
  const runtime = makeRuntime({ session, runCount: 1 });
  runtime.status = "error";
  const state = makeState(runtime);

  const result = await requestEndSession(state, "builder", { reason: "task complete" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "session_settled");
  assert.equal(session.abortCalls, 0, "session.abort() must NOT be called on error-state runtime");
});
