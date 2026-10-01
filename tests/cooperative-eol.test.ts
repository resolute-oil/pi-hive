// Wave 3 Agent 3D — F5 cooperative tools behavioral tests.
//
// Covers T5.10 (`request_compaction`), T5.11 (`request_end_session`), and
// T5.12 (`request_snapshot`) per the C4 review walkthrough (3 tests per
// cooperative tool — happy path, failure path, concurrent EOL). Contract
// coverage lives in `tests/budget-contracts.test.ts` Slice 5+6; this file
// adds behavioral coverage of the `buildRequest*Tool` factories in
// `src/engine/budget/worker-tools.ts` region 3D.
//
// The cooperative tools are wired via factory functions (matching the
// `buildSummarizeProgressTool(state, callerName, ledger)` pattern) so each
// test can stub session / policy / ledger independently. The stubs remain
// exported as the documented agent-callable shape; the factories return
// the actual implementations that call session.compact() / session.abort()
// / session.sessionManager.branchWithSummary() and write a BudgetLedgerEntry
// with kind "cooperative-compact" / "cooperative-end" / "cooperative-snapshot".

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession, SessionEntry, SessionStats } from "@earendil-works/pi-coding-agent";
import type { BudgetLedger } from "../src/engine/budget/ledger.ts";
import type { BudgetLedgerEntry, WorkerBudgetPolicy } from "../src/core/types.ts";
import {
  buildRequestCompactionTool,
  buildRequestEndSessionTool,
  buildRequestSnapshotTool,
  __cooperativeToolRegistry,
  __resetCooperativeToolRegistryForTests,
} from "../src/engine/budget/worker-tools.ts";
import type { BudgetLedgerKind } from "../src/core/types.ts";

// ── Test fixtures ─────────────────────────────────────────────────────────

interface SessionManagerStub {
  getLeafId(): string | null;
  branchWithSummary(branchFromId: string | null, summary: string, details?: unknown): string;
  appendCustomEntry(customType: string, data?: unknown): string;
  appendCustomMessageEntry(customType: string, content: string, display: boolean, details?: unknown): string;
  getBranch(): SessionEntry[];
  getEntries(): SessionEntry[];
  // Test capture: every appendCustomEntry call so assertions can verify the
  // cooperative tool wrote the documented {kind, marker, customType, agentSlug}
  // tuple.
  customEntries: Array<{ customType: string; data: any }>;
  branchCalls: Array<{ branchFromId: string | null; summary: string; details?: unknown }>;
}

function makeSessionManagerStub(opts: {
  leafId?: string | null;
  branchReturn?: string;
  throwOnBranchWithSummary?: Error;
} = {}): SessionManagerStub {
  const customEntries: Array<{ customType: string; data: any }> = [];
  const branchCalls: Array<{ branchFromId: string | null; summary: string; details?: unknown }> = [];
  return {
    getLeafId: () => opts.leafId ?? "leaf-1",
    branchWithSummary: (branchFromId, summary, details) => {
      branchCalls.push({ branchFromId, summary, details });
      if (opts.throwOnBranchWithSummary) throw opts.throwOnBranchWithSummary;
      return opts.branchReturn ?? "new-branch-1";
    },
    appendCustomEntry: (customType, data) => {
      customEntries.push({ customType, data });
      return `entry-${customEntries.length}`;
    },
    appendCustomMessageEntry: () => "msg-1",
    getBranch: () => [],
    getEntries: () => [],
    customEntries,
    branchCalls,
  };
}

interface SessionStub {
  sessionId: string;
  sessionManager: SessionManagerStub;
  compact(customInstructions?: string): Promise<{ tokensBefore: number; estimatedTokensAfter: number }>;
  abort(): Promise<void>;
  getSessionStats(): SessionStats;
  // Capture: every call to compact / abort so assertions can verify the
  // cooperative tool invoked the SDK primitive with the right arguments.
  compactCalls: Array<{ customInstructions?: string }>;
  abortCalls: number;
  throwOnCompact?: Error;
  throwOnAbort?: Error;
}

function makeSessionStub(opts: {
  sessionId?: string;
  sessionManager?: SessionManagerStub;
  throwOnCompact?: Error;
  throwOnAbort?: Error;
  stats?: SessionStats;
} = {}): SessionStub {
  const compactCalls: Array<{ customInstructions?: string }> = [];
  const state = { abortCalls: 0 };
  const stub: SessionStub = {
    sessionId: opts.sessionId ?? "test-session",
    sessionManager: opts.sessionManager ?? makeSessionManagerStub(),
    compact: async (customInstructions?: string) => {
      compactCalls.push({ customInstructions });
      if (opts.throwOnCompact) throw opts.throwOnCompact;
      return { tokensBefore: 1000, estimatedTokensAfter: 400 };
    },
    abort: async () => {
      state.abortCalls += 1;
      if (opts.throwOnAbort) throw opts.throwOnAbort;
    },
    getSessionStats: () =>
      opts.stats ?? {
        sessionFile: undefined,
        sessionId: opts.sessionId ?? "test-session",
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 2,
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
        cost: 0.01,
      },
    compactCalls,
    get abortCalls() {
      return state.abortCalls;
    },
  } as SessionStub;
  return stub;
}

// Per-call ledger stub. The cooperative tools reach into the ledger's
// private fields via a structural cast, so the stub must expose `agentName`,
// `snapshotCaps()`, and `entries` exactly as BudgetLedger does. `cumulative`
// is the only public BudgetLedger field the cooperative tools read.
interface LedgerStub {
  cumulative: { tokens: number; costUsd: number; runs: number };
  agentName: string;
  snapshotCaps(): BudgetLedgerEntry["data"]["caps"];
  entries: BudgetLedgerEntry[];
  // Capture: every ledger method call so tests can verify the cooperative
  // tool did (or did NOT) write a snapshot on the failure path.
  snapshotCalls: Array<{ stats: unknown; policy: unknown; marker: string; signal: AbortSignal; kind?: BudgetLedgerKind }>;
  // Wave 3 fixup Issue 1 — cooperative tools now use the public
  // `ledger.snapshot(stats, policy, "checkpoint", signal, kind)` API
  // instead of the `writeCooperativeSnapshot` cast bypass. The stub's
  // snapshot() mirrors `BudgetLedger.snapshot()`: builds a
  // BudgetLedgerEntry with the documented caps/cumulative/marker/kind
  // shape, pushes it to `entries`, and returns the same reference so
  // `result.ledgerSnapshot === entries[N]` holds.
  snapshot(stats: { tokens: { total: number }; cost: number }, _policy: unknown, marker: "warning" | "exhausted" | "checkpoint", _signal: AbortSignal, kind?: BudgetLedgerKind): BudgetLedgerEntry;
}

function makeLedgerStub(opts: { agentName?: string; caps?: BudgetLedgerEntry["data"]["caps"]; cumulative?: { tokens: number; costUsd: number; runs: number } } = {}): LedgerStub {
  const entries: BudgetLedgerEntry[] = [];
  const snapshotCalls: Array<{ stats: unknown; policy: unknown; marker: string; signal: AbortSignal; kind?: BudgetLedgerKind }> = [];
  const stub: LedgerStub = {
    cumulative: opts.cumulative ?? { tokens: 0, costUsd: 0, runs: 1 },
    agentName: opts.agentName ?? "cooperative-worker",
    snapshotCaps: () => opts.caps ?? { workerTokens: 1000, workerCostUsd: 5 },
    entries,
    snapshotCalls,
    snapshot(stats, _policy, marker, _signal, kind) {
      snapshotCalls.push({ stats, policy: _policy, marker, signal: _signal, kind });
      const entry: BudgetLedgerEntry = {
        type: "custom",
        customType: "pi-hive-budget-ledger",
        data: {
          caps: stub.snapshotCaps(),
          cumulative: { tokens: stats.tokens.total, costUsd: stats.cost, runs: stub.cumulative.runs },
          writtenAt: 0,
          agentSlug: stub.agentName,
          marker,
          ...(kind !== undefined ? { kind } : {}),
        },
      };
      stub.entries.push(entry);
      return entry;
    },
  };
  return stub;
}

function makePolicyWithMaxTokens(maxTokens: number | undefined): WorkerBudgetPolicy {
  return {
    worker: { tokens: { cap: 1000 } },
    team: {},
    ...(maxTokens !== undefined
      ? {
          strategies: {
            onApproachingLimit: { action: "wrap-up" as const, threshold: 0.2, hint: "" },
            onExhaustion: { action: "abort" as const },
            summary: { maxTokens },
          },
        }
      : {}),
  };
}

const noCapPolicy: WorkerBudgetPolicy = { worker: {}, team: {} };

// ── T5.10: request_compaction ────────────────────────────────────────────

// Test 1 (T5.10 happy): strategies.summary.maxTokens is honored, the SDK
// compact() call receives the encoded maxTokens hint, and the ledger has a
// "cooperative-compact" snapshot.
test("T5.10 happy: request_compaction honors strategies.summary.maxTokens and writes a cooperative-compact snapshot", async () => {
  const sessionManager = makeSessionManagerStub();
  const session = makeSessionStub({ sessionManager });
  const ledger = makeLedgerStub();
  const policy = makePolicyWithMaxTokens(200);

  const requestCompaction = buildRequestCompactionTool({ session: session as unknown as AgentSession, policy, ledger: ledger as unknown as BudgetLedger });
  const signal = new AbortController().signal;
  const result = await requestCompaction("wrap up the migration", signal);

  // SDK compact() was called exactly once with customInstructions encoding the
  // configured maxTokens. The "honor" gate (per B1 fix wiring at commit
  // 09e0c54) requires the encoded maxTokens to land in the instruction
  // string — see events.ts:48-148 for the read pattern.
  assert.equal(session.compactCalls.length, 1, "session.compact() called once");
  const compactInstructions = session.compactCalls[0].customInstructions;
  assert.ok(typeof compactInstructions === "string", "customInstructions is a string (SDK compact signature)");
  assert.match(compactInstructions, /wrap up the migration/, "user-provided instruction forwarded");
  assert.match(compactInstructions, /200 tokens/, "maxTokens encoded into the instruction text");
  assert.match(compactInstructions, /at most 200 tokens\./, "maxTokens hint uses the documented sentence");

  // Ledger received the cooperative-compact snapshot (kind field set).
  assert.equal(ledger.entries.length, 1, "ledger has exactly one entry from the cooperative call");
  const entry = ledger.entries[0];
  assert.equal(entry.customType, "pi-hive-budget-ledger", "writes via the documented customType");
  assert.equal(entry.data.kind, "cooperative-compact", "kind is cooperative-compact");
  assert.equal(entry.data.marker, "checkpoint", "marker is checkpoint (the §2.6 marker restriction is bypassed here only to set the kind field)");
  assert.equal(entry.data.agentSlug, "cooperative-worker", "agentSlug forwarded from ledger");

  assert.equal(result.ledgerSnapshot, entry, "result.ledgerSnapshot is the entry the cooperative call wrote");
});

// Test 2 (T5.10 failure): session.compact() throws; the error propagates
// and the ledger does NOT receive a "cooperative-compact" snapshot.
test("T5.10 failure: session.compact() throwing propagates and the ledger receives no cooperative-compact snapshot", async () => {
  const compactError = new Error("compact failed: context window exceeded");
  const session = makeSessionStub({ throwOnCompact: compactError });
  const ledger = makeLedgerStub();
  const policy = makePolicyWithMaxTokens(500);

  const requestCompaction = buildRequestCompactionTool({ session: session as unknown as AgentSession, policy, ledger: ledger as unknown as BudgetLedger });

  await assert.rejects(
    () => requestCompaction("attempt to compact"),
    (err: unknown) => err === compactError,
    "the compact error propagates unchanged (no silent fallback)",
  );

  assert.equal(session.compactCalls.length, 1, "session.compact() was attempted exactly once");
  assert.equal(ledger.entries.length, 0, "no ledger entry written when compact() throws");
  assert.equal(
    session.sessionManager.customEntries.length,
    0,
    "sessionManager.appendCustomEntry was NOT called for a cooperative-compact entry on the failure path",
  );
});

// Test 3 (T5.10 concurrent EOL): the brief says "If concurrent EOL scenario
// is hard to test deterministically, document as integration-test status
// (not unit-test)". This test pins the order of operations when the worker
// invokes request_compaction while another command is mid-flight: the SDK
// compact() call MUST complete before the cooperative ledger snapshot is
// written, so the snapshot reflects post-compaction state. We simulate the
// scenario by stubbing compact() to record the ledger.entries.length at the
// moment of invocation and asserting it equals zero — the snapshot is only
// written AFTER compact resolves.
test("T5.10 concurrent EOL: cooperative-compact snapshot is written only AFTER session.compact() resolves (ordering pinned)", async () => {
  const sessionManager = makeSessionManagerStub();
  const ledger = makeLedgerStub();
  let observedLedgerSizeDuringCompact = -1;
  const session: SessionStub = {
    sessionId: "test-session",
    sessionManager,
    compactCalls: [],
    abortCalls: 0,
    async compact(customInstructions?: string) {
      this.compactCalls.push({ customInstructions });
      // Snapshot the ledger entries length WHILE compact is "running". A
      // correct implementation has not yet appended the cooperative-compact
      // entry — the entry is written only after compact resolves.
      observedLedgerSizeDuringCompact = ledger.entries.length;
      return { tokensBefore: 1000, estimatedTokensAfter: 400 };
    },
    async abort() {
      this.abortCalls += 1;
    },
    getSessionStats() {
      return {
        sessionFile: undefined,
        sessionId: "test-session",
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 2,
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
        cost: 0.01,
      };
    },
  };

  const policy = makePolicyWithMaxTokens(300);
  const requestCompaction = buildRequestCompactionTool({ session: session as unknown as AgentSession, policy, ledger: ledger as unknown as BudgetLedger });
  const controller = new AbortController();
  await requestCompaction("concurrent eol probe", controller.signal);

  assert.equal(observedLedgerSizeDuringCompact, 0, "ledger is empty during compact() — snapshot is written only AFTER compact resolves");
  assert.equal(ledger.entries.length, 1, "ledger has exactly one entry AFTER compact resolves");
  assert.equal(ledger.entries[0].data.kind, "cooperative-compact", "the post-compact entry has kind cooperative-compact");

  // Hard-gate documentation: the brief explicitly allows the concurrent-EOL
  // path to be pinned via ordering rather than a true race test. Documented
  // here so the wave-3 reviewer knows this is intentional (C4 review
  // walkthrough 2026-09-29).
  assert.ok(true, "T5.10 concurrent EOL pinned via ordering (integration-test status per brief)");
});

// ── T5.11: request_end_session ────────────────────────────────────────────

// Test 4 (T5.11 happy): session.abort() is called and the ledger has a
// "cooperative-end" snapshot.
test("T5.11 happy: request_end_session calls session.abort() and writes a cooperative-end snapshot", async () => {
  const sessionManager = makeSessionManagerStub();
  const session = makeSessionStub({ sessionManager });
  const ledger = makeLedgerStub();
  const policy = noCapPolicy;

  const requestEndSession = buildRequestEndSessionTool({ session: session as unknown as AgentSession, policy, ledger: ledger as unknown as BudgetLedger });
  const signal = new AbortController().signal;
  const result = await requestEndSession("agent decided to wrap up", signal);

  assert.equal(session.abortCalls, 1, "session.abort() called exactly once");
  assert.equal(ledger.entries.length, 1, "ledger has exactly one entry from the cooperative call");
  const entry = ledger.entries[0];
  assert.equal(entry.data.kind, "cooperative-end", "kind is cooperative-end");
  assert.equal(entry.data.marker, "checkpoint", "marker is checkpoint");
  assert.equal(entry.data.agentSlug, "cooperative-worker", "agentSlug forwarded from ledger");

  assert.equal(result.ledgerSnapshot, entry, "result.ledgerSnapshot is the entry the cooperative call wrote");
});

// Test 5 (T5.11 failure): session.abort() throws; the error propagates
// and the ledger does NOT receive a "cooperative-end" snapshot.
test("T5.11 failure: session.abort() throwing propagates and the ledger receives no cooperative-end snapshot", async () => {
  const abortError = new Error("abort failed: session already disposed");
  const session = makeSessionStub({ throwOnAbort: abortError });
  const ledger = makeLedgerStub();
  const policy = noCapPolicy;

  const requestEndSession = buildRequestEndSessionTool({ session: session as unknown as AgentSession, policy, ledger: ledger as unknown as BudgetLedger });

  await assert.rejects(
    () => requestEndSession("wrap up", new AbortController().signal),
    (err: unknown) => err === abortError,
    "the abort error propagates unchanged",
  );

  assert.equal(session.abortCalls, 1, "session.abort() was attempted exactly once");
  assert.equal(ledger.entries.length, 0, "no ledger entry written when abort() throws");
  assert.equal(session.sessionManager.customEntries.length, 0, "no appendCustomEntry call on the failure path");
});

// Test 6 (T5.11 concurrent EOL): the cooperative-end snapshot is written
// only AFTER session.abort() resolves (ordering pinned).
test("T5.11 concurrent EOL: cooperative-end snapshot is written only AFTER session.abort() resolves (ordering pinned)", async () => {
  const sessionManager = makeSessionManagerStub();
  const ledger = makeLedgerStub();
  let observedLedgerSizeDuringAbort = -1;
  const session: SessionStub = {
    sessionId: "test-session",
    sessionManager,
    compactCalls: [],
    abortCalls: 0,
    async abort() {
      observedLedgerSizeDuringAbort = ledger.entries.length;
      this.abortCalls += 1;
    },
    async compact(customInstructions?: string) {
      this.compactCalls.push({ customInstructions });
      return { tokensBefore: 0, estimatedTokensAfter: 0 };
    },
    getSessionStats() {
      return {
        sessionFile: undefined,
        sessionId: "test-session",
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 2,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
      };
    },
  };

  const policy = noCapPolicy;
  const requestEndSession = buildRequestEndSessionTool({ session: session as unknown as AgentSession, policy, ledger: ledger as unknown as BudgetLedger });
  const controller = new AbortController();
  await requestEndSession("concurrent eol probe", controller.signal);

  assert.equal(observedLedgerSizeDuringAbort, 0, "ledger is empty during abort() — snapshot is written only AFTER abort resolves");
  assert.equal(ledger.entries.length, 1, "ledger has exactly one entry AFTER abort resolves");
  assert.equal(ledger.entries[0].data.kind, "cooperative-end", "the post-abort entry has kind cooperative-end");

  assert.ok(true, "T5.11 concurrent EOL pinned via ordering (integration-test status per brief)");
});

// ── T5.12: request_snapshot ───────────────────────────────────────────────

// Test 7 (T5.12 happy): session_manager.branchWithSummary() is called and
// the ledger has a "cooperative-snapshot" entry.
test("T5.12 happy: request_snapshot calls branchWithSummary() and writes a cooperative-snapshot entry", async () => {
  const sessionManager = makeSessionManagerStub({ leafId: "leaf-current-1", branchReturn: "leaf-snapshot-2" });
  const session = makeSessionStub({ sessionManager });
  const ledger = makeLedgerStub();
  const policy = noCapPolicy;

  const requestSnapshot = buildRequestSnapshotTool({ session: session as unknown as AgentSession, policy, ledger: ledger as unknown as BudgetLedger });
  const signal = new AbortController().signal;
  const result = await requestSnapshot("checkpoint before risky edit", signal);

  assert.equal(sessionManager.branchCalls.length, 1, "branchWithSummary() called exactly once");
  assert.equal(sessionManager.branchCalls[0].branchFromId, "leaf-current-1", "branches from the current leaf");
  assert.equal(sessionManager.branchCalls[0].summary, "checkpoint before risky edit", "uses the supplied label as the summary");
  assert.equal(ledger.entries.length, 1, "ledger has exactly one entry from the cooperative call");
  const entry = ledger.entries[0];
  assert.equal(entry.data.kind, "cooperative-snapshot", "kind is cooperative-snapshot");
  assert.equal(entry.data.marker, "checkpoint", "marker is checkpoint");
  assert.equal(entry.data.agentSlug, "cooperative-worker", "agentSlug forwarded from ledger");

  assert.equal(result.ledgerSnapshot, entry, "result.ledgerSnapshot is the entry the cooperative call wrote");
});

// Test 8 (T5.12 failure): branchWithSummary() throws; the error
// propagates and the ledger does NOT receive a "cooperative-snapshot" entry.
test("T5.12 failure: branchWithSummary() throwing propagates and the ledger receives no cooperative-snapshot entry", async () => {
  const branchError = new Error("branch failed: session file locked");
  const sessionManager = makeSessionManagerStub({ throwOnBranchWithSummary: branchError });
  const session = makeSessionStub({ sessionManager });
  const ledger = makeLedgerStub();
  const policy = noCapPolicy;

  const requestSnapshot = buildRequestSnapshotTool({ session: session as unknown as AgentSession, policy, ledger: ledger as unknown as BudgetLedger });

  await assert.rejects(
    () => requestSnapshot("label", new AbortController().signal),
    (err: unknown) => err === branchError,
    "the branch error propagates unchanged",
  );

  assert.equal(sessionManager.branchCalls.length, 1, "branchWithSummary() was attempted exactly once");
  assert.equal(ledger.entries.length, 0, "no ledger entry written when branchWithSummary() throws");
  assert.equal(sessionManager.customEntries.length, 0, "no appendCustomEntry call on the failure path");
});

// Test 9 (T5.12 concurrent EOL): the cooperative-snapshot entry is written
// only AFTER branchWithSummary() resolves (ordering pinned).
test("T5.12 concurrent EOL: cooperative-snapshot entry is written only AFTER branchWithSummary() resolves (ordering pinned)", async () => {
  const sessionManager = makeSessionManagerStub({ leafId: "leaf-current-2" });
  const ledger = makeLedgerStub();
  let observedLedgerSizeDuringBranch = -1;
  const originalBranchWithSummary = sessionManager.branchWithSummary;
  sessionManager.branchWithSummary = (branchFromId, summary, details) => {
    observedLedgerSizeDuringBranch = ledger.entries.length;
    return originalBranchWithSummary(branchFromId, summary, details);
  };
  const session = makeSessionStub({ sessionManager });

  const policy = noCapPolicy;
  const requestSnapshot = buildRequestSnapshotTool({ session: session as unknown as AgentSession, policy, ledger: ledger as unknown as BudgetLedger });
  const controller = new AbortController();
  await requestSnapshot("concurrent eol probe", controller.signal);

  assert.equal(observedLedgerSizeDuringBranch, 0, "ledger is empty during branchWithSummary() — entry is written only AFTER branch resolves");
  assert.equal(ledger.entries.length, 1, "ledger has exactly one entry AFTER branch resolves");
  assert.equal(ledger.entries[0].data.kind, "cooperative-snapshot", "the post-branch entry has kind cooperative-snapshot");

  assert.ok(true, "T5.12 concurrent EOL pinned via ordering (integration-test status per brief)");
});

// ── Wave 3 fixup Issue 4: cooperative-tool registry + operator-only assertion ──

// Per the post-wave review: "verified by a test asserting they don't appear
// in the cooperative-tool registry." The brief targets operator commands that are
// the explicit escape hatches (forceKillWorkerSession, forceEndWorkerSession,
// tearDownAllWorkers) — those MUST NOT register themselves in the
// cooperative-tool registry because the cooperative registry is the agent-
// callable surface (only `request_compaction`, `request_end_session`,
// `request_snapshot` are agent-callable).
test("Wave 3 fixup Issue 4: cooperative-tool registry contains exactly the 3 cooperative tool names and NO operator commands", () => {
  // Reset to keep the test hermetic — the registry persists across the
  // whole module's lifetime, and earlier tests in this file call the
  // cooperative factories (each adds an entry).
  __resetCooperativeToolRegistryForTests();
  const sessionManager = makeSessionManagerStub();
  const session = makeSessionStub({ sessionManager });
  const ledger = makeLedgerStub();
  const policy = noCapPolicy;

  // Call each cooperative factory. The factories register their tool name
  // on entry — this is the side effect under test.
  buildRequestCompactionTool({ session: session as unknown as AgentSession, policy, ledger: ledger as unknown as BudgetLedger });
  buildRequestEndSessionTool({ session: session as unknown as AgentSession, policy, ledger: ledger as unknown as BudgetLedger });
  buildRequestSnapshotTool({ session: session as unknown as AgentSession, policy, ledger: ledger as unknown as BudgetLedger });

  const registry = __cooperativeToolRegistry();
  assert.equal(registry.size, 3, "registry contains exactly 3 entries (one per cooperative tool)");

  // The three cooperative tool names appear in the registry.
  assert.ok(registry.has("request_compaction"), "request_compaction in cooperative registry");
  assert.ok(registry.has("request_end_session"), "request_end_session in cooperative registry");
  assert.ok(registry.has("request_snapshot"), "request_snapshot in cooperative registry");

  // Operator commands do NOT appear — explicitly check the three escape-
  // hatch commands called out by the brief plus a sample of base operator
  // commands. None of these functions are called above, so none should
  // register themselves.
  const operatorCommandNames = [
    "endWorkerSession",
    "compactWorkerSession",
    "respawnWorkerSession",
    "pauseWorkerSession",
    "snapshotWorkerSession",
    "restoreWorkerSession",
    "resumeWorkerSession",
    "abortWorkerCompaction",
    "forceKillWorkerSession",
    "forceEndWorkerSession",
    "tearDownAllWorkers",
  ];
  for (const name of operatorCommandNames) {
    assert.ok(!registry.has(name as never), `operator command '${name}' does NOT appear in the cooperative registry`);
  }
});

// Verify the registry-clearing test seam: after resetting, a cooperative
// factory call re-adds the name. Pins the test seam so a future regression
// in __resetCooperativeToolRegistryForTests cannot silently break Issue 4.
test("Wave 3 fixup Issue 4: __resetCooperativeToolRegistryForTests clears the registry and re-adds on next factory call", () => {
  __resetCooperativeToolRegistryForTests();
  assert.equal(__cooperativeToolRegistry().size, 0, "registry empty after reset");

  const sessionManager = makeSessionManagerStub();
  const session = makeSessionStub({ sessionManager });
  const ledger = makeLedgerStub();
  const policy = noCapPolicy;

  buildRequestCompactionTool({ session: session as unknown as AgentSession, policy, ledger: ledger as unknown as BudgetLedger });
  assert.equal(__cooperativeToolRegistry().size, 1, "first factory call adds 1 entry");
  assert.ok(__cooperativeToolRegistry().has("request_compaction"), "registry now contains request_compaction");

  __resetCooperativeToolRegistryForTests();
  assert.equal(__cooperativeToolRegistry().size, 0, "registry empty after second reset");
});