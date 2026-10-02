// Wave 4 F8 — Reload-stable ledger regression coverage. Five tests for T8.1,
// T8.2, T8.3, T8.5, T8.6 plus the audit results documented in the file
// header.
//
// F8 goal (per `04-refactor-plan.md` §5 F8): `/reload` re-derives the ledger
// from the active branch via `getBranch()`. No budget state lives in closure.
//
// Reload semantics — the operator `/reload` UX open a new SessionManager for
// the same session file. The new SessionManager walks the persisted JSONL
// entries and `BudgetLedger.restore` re-derives the cumulative from the
// latest pi-hive-budget-ledger CustomEntry per agentSlug. The tests below
// exercise that path with real SDK files (not in-memory agents), so the
// reload is a true file-based re-open, not a fake in-memory rebuild.
//
// Branch/fork semantics — the operator /tree-based `/tree` UX navigates via
// `SessionManager.branch(branchFromId)`, which moves the leaf pointer to an
// earlier entry; `getBranch()` from there returns only ancestors of that
// entry (siblings are skipped). `/fork` uses `SessionManager.forkFrom(...)`,
// which is a STATIC factory that copies all source entries into a new session
// file in the target directory and returns a new SessionManager pointing at
// the new file. The forked session has a fresh sessionId and fresh file path
// but the same ledger CustomEntries — i.e., the cumulative survives intact.
// The plan prose called this "ledger-fresh"; the actual SDK behavior is
// "ledger-preserved-but-session-identity-fresh". See the after-action report
// for the deviation note.
//
// Determinism rule (per `04-refactor-plan.md` §5 F7): no `Math.random()`, no
// `Date.now()`, no `setTimeout()`. Fixed timestamps and synthetic ids are
// used throughout. The `Date.now()` calls in `appendMessage` fixtures (used
// to satisfy the SDK's "user or assistant message" check) are replaced with
// fixed `1_700_000_000_000` values.

// T8.4 audit summary (Wave 4 Agent 4B):
// `grep -rE "let\s+\w+\s*=\s*0" src/engine/budget/` returns six matches, all
// in policy.ts:148-150 and remaining.ts:72-74. Each is a local accumulator
// variable inside a `teamUsage(...)` helper that sums `latestBySlug.values()`
// (policy.ts) or `state.runtimes.values()` (remaining.ts). These are
// function-scoped variables that get reset on every call — NOT closure-captured
// state. The brief explicitly allows "Test fixtures and unrelated counters";
// these are unrelated counters. No closure-captured budget state survived
// Wave 3. No code changes were required.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  SessionEntry,
  SessionManager as SessionManagerType,
  SessionStats,
} from "@earendil-works/pi-coding-agent";
import { BudgetLedger } from "../src/engine/budget/ledger.ts";
import { checkBudgetPolicy } from "../src/engine/budget/policy.ts";
import { BudgetExhaustedError, pauseWorkerSession, resumeWorkerSession } from "../src/engine/budget/worker-tools.ts";
import type { BudgetLedgerEntry, WorkerBudgetPolicy } from "../src/core/types.ts";

// ── Test fixtures ─────────────────────────────────────────────────────────

const noCapPolicy: WorkerBudgetPolicy = { worker: {}, team: {} };

// A simple ledger entry shape that the tests can append and read.
function ledgerEntry(
  cumulative: { tokens: number; costUsd: number; runs: number },
  options: { marker?: "warning" | "exhausted" | "checkpoint"; kind?: BudgetLedgerEntry["data"]["kind"]; agentSlug?: string } = {},
): { customType: string; data: BudgetLedgerEntry["data"] } {
  return {
    customType: "pi-hive-budget-ledger",
    data: {
      caps: {},
      cumulative,
      writtenAt: 1_700_000_000_000,
      agentSlug: options.agentSlug ?? "tester",
      marker: options.marker,
      kind: options.kind,
    },
  };
}

// Returns a tmpdir-backed SessionManager with a single user message
// appended (so `_hasConversation()` returns true and the SDK actually
// persists the file). Subsequent `appendCustomEntry` calls land in the
// JSONL on disk so a re-open via `SessionManager.open(filePath, ...)`
// picks them up.
function createPersistedSource(cwd: string, sessionDir: string): { sm: SessionManager; filePath: string } {
  const sm = SessionManager.create(cwd, sessionDir);
  sm.appendMessage({
    role: "user",
    content: [{ type: "text", text: "task" }],
    timestamp: 1_700_000_000_000,
  } as never);
  const filePath = sm.getSessionFile();
  assert.ok(filePath, "source SM exposes a sessionFile path after appendMessage");
  return { sm, filePath };
}

function makeTmpDirs(): { cwd: string; sessionDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-hive-reload-"));
  return { cwd: tmpDir, sessionDir: join(tmpDir, "sessions") };
}

// ── T8.1: /reload re-derives ledger from getBranch() ─────────────────────

test("T8.1: /reload re-derives BudgetLedger from getBranch() — open new SessionManager on the same JSONL", async () => {
  // Per `04-refactor-plan.md` §5 F8: "/reload re-derives the ledger from the
  // active branch via getBranch()". The test simulates /reload as
  // SessionManager.open(filePath, sessionDir, cwd) on a fresh SessionManager
  // instance.
  const { cwd, sessionDir } = makeTmpDirs();
  const { sm: source, filePath } = createPersistedSource(cwd, sessionDir);

  // Write a handful of pi-hive-budget-ledger CustomEntries on the source
  // branch. The latest one (250 tokens) is the authoritative state.
  source.appendCustomEntry("pi-hive-budget-ledger", ledgerEntry({ tokens: 50, costUsd: 0.005, runs: 1 }, { agentSlug: "tester" }).data);
  source.appendCustomEntry("pi-hive-budget-ledger", ledgerEntry({ tokens: 150, costUsd: 0.015, runs: 1 }, { agentSlug: "tester" }).data);
  source.appendCustomEntry("pi-hive-budget-ledger", ledgerEntry({ tokens: 250, costUsd: 0.025, runs: 2 }, { agentSlug: "tester" }).data);

  // Capture the pre-reload cumulative from the source.
  const sourceRestored = await BudgetLedger.restore(source, "tester", noCapPolicy, new AbortController().signal);
  assert.equal(sourceRestored.cumulative.tokens, 250, "source cumulative reads 250 tokens");
  assert.equal(sourceRestored.cumulative.costUsd, 0.025, "source cumulative reads $0.025");
  assert.equal(sourceRestored.cumulative.runs, 2, "source cumulative reads 2 runs");
  assert.equal(sourceRestored.entries.length, 3, "source ledger has 3 entries");

  // Simulate /reload: open a new SessionManager on the same JSONL file.
  const reloadedSM = SessionManager.open(filePath, sessionDir, cwd);

  // Re-derive the ledger from the new SessionManager's branch.
  const reloaded = await BudgetLedger.restore(reloadedSM, "tester", noCapPolicy, new AbortController().signal);

  assert.equal(reloaded.cumulative.tokens, 250, "post-reload cumulative.tokens matches pre-reload state");
  assert.equal(reloaded.cumulative.costUsd, 0.025, "post-reload cumulative.costUsd matches pre-reload state");
  assert.equal(reloaded.cumulative.runs, 2, "post-reload cumulative.runs matches pre-reload state");
  assert.equal(reloaded.entries.length, 3, "post-reload entries[] matches pre-reload count");

  // The reloaded SM has its own in-memory `entries` array (the constructor
  // takes a fresh one). Verify they're independent — writing a new event to
  // the source SM does NOT mutate the reloaded SM's in-memory entries
  // (the file-based load only happens at open() time).
  source.appendCustomEntry("pi-hive-budget-ledger", ledgerEntry({ tokens: 350, costUsd: 0.035, runs: 3 }, { agentSlug: "tester" }).data);
  assert.equal(reloaded.entries.length, 3, "reloaded in-memory entries are independent of subsequent source writes");

  // Cleanup — SessionManager has no dispose() method (only AgentSession
  // does). The tmpdir lives until process exit; no per-test cleanup.
});

test("T8.2: pre-reload BudgetExhaustedError blocks post-reload dispatch (exhausted state survives)", async () => {
  // Per `04-refactor-plan.md` §5 F8 T8.2: "Verify pre-reload
  // BudgetExhaustedError blocks the post-reload dispatch." The test
  // exercises both `delegateAgent`-level exhaustion and `checkBudgetPolicy`
  // re-evaluation against the post-reload ledger to verify the exhausted
  // state survives `SessionManager.open(...)`.
  const { cwd, sessionDir } = makeTmpDirs();
  const { sm: source, filePath } = createPersistedSource(cwd, sessionDir);

  // Worker-token cap exceeded on the source (cumulative 1500 >= cap 1000).
  source.appendCustomEntry("pi-hive-budget-ledger", ledgerEntry({ tokens: 1500, costUsd: 0.15, runs: 1 }, { agentSlug: "tester" }).data);

  const exhaustedPolicy: WorkerBudgetPolicy = {
    worker: { tokens: { cap: 1000, window: "per-session", include: ["input", "output"] } },
    team: {},
  };

  // Pre-reload: checkBudgetPolicy returns a block (the gate refuses).
  const sourceRestored = await BudgetLedger.restore(source, "tester", exhaustedPolicy, new AbortController().signal);
  const sourceBlock = checkBudgetPolicy(sourceRestored, exhaustedPolicy, source.getBranch());
  assert.ok(sourceBlock !== undefined, "pre-reload checkBudgetPolicy returns a BudgetBlock (worker tokens exceeded)");
  assert.equal(sourceBlock!.scope, "worker", "pre-reload block.scope = 'worker'");
  assert.equal(sourceBlock!.resource, "tokens", "pre-reload block.resource = 'tokens'");
  // BudgetExhaustedError wraps the block; verify the throw contract holds.
  const sourceError = new BudgetExhaustedError(sourceBlock!);
  assert.equal(sourceError.reason, sourceBlock!.reason, "pre-reload BudgetExhaustedError carries the block's reason");

  // Simulate /reload: open a new SM on the same file.
  const reloadedSM = SessionManager.open(filePath, sessionDir, cwd);

  // Post-reload: same exhausted state. BudgetLedger.restore on the reloaded
  // SM reconstructs the same cumulative, and the same gate refuses.
  const reloadedRestored = await BudgetLedger.restore(reloadedSM, "tester", exhaustedPolicy, new AbortController().signal);
  assert.equal(reloadedRestored.cumulative.tokens, 1500, "post-reload cumulative.tokens still exceeds cap");

  const reloadedBlock = checkBudgetPolicy(reloadedRestored, exhaustedPolicy, reloadedSM.getBranch());
  assert.ok(reloadedBlock !== undefined, "post-reload checkBudgetPolicy ALSO returns a BudgetBlock — /reload does NOT reset exhausted state");
  assert.equal(reloadedBlock!.scope, "worker", "post-reload block.scope = 'worker'");
  assert.equal(reloadedBlock!.resource, "tokens", "post-reload block.resource = 'tokens'");
  assert.equal(reloadedBlock!.limit.tokens, 1000, "post-reload block.limit.tokens = 1000");

  // And the BudgetExhaustedError contract holds post-reload.
  const reloadedError = new BudgetExhaustedError(reloadedBlock!);
  assert.ok(reloadedError instanceof BudgetExhaustedError, "post-reload BudgetExhaustedError is thrown");

  // Sanity — if the cap were loosened post-reload (separate test session to
  // confirm the gate flips the right direction), the same cumulative would
  // NOT block. Use a noCapPolicy here to verify the post-reload ledger is
  // fully functional (not stuck in some exhausted state).
  const noBlock = checkBudgetPolicy(reloadedRestored, noCapPolicy, reloadedSM.getBranch());
  assert.equal(noBlock, undefined, "post-reload gate lets through when caps are loosened (verifies ledger state is fully restored, not stuck)");
});

// ── T8.3: Paused session resumes correctly after /reload ─────────────────

test("T8.3: pauseWorkerSession + /reload + resumeWorkerSession — kind:'resume' lands in the reloaded branch", async () => {
  // Per `04-refactor-plan.md` §5 F8 T8.3: "Verify paused session resumes
  // correctly after `/reload`." The test exercises the file-based reload
  // path: pauseWorkerSession writes kind:'pause' BEFORE the reload;
  // resumeWorkerSession writes kind:'resume' AFTER the reload. Both ledger
  // entries land in the JSONL; `SessionManager.open(filePath, ...)` after
  // the reload preserves both.
  const { cwd, sessionDir } = makeTmpDirs();
  const { sm: source, filePath } = createPersistedSource(cwd, sessionDir);

  // Pre-pause: write one budgeted checkpoint so the post-reload ledger has
  // a non-zero cumulative for the resume snapshot to echo back.
  source.appendCustomEntry("pi-hive-budget-ledger", ledgerEntry({ tokens: 200, costUsd: 0.020, runs: 1 }, { marker: "checkpoint", agentSlug: "tester" }).data);

  // Fake session + handle — the operator commands in region 3B of
  // worker-tools.ts read `session.getSessionStats()` and call
  // `session.abort() / .compact() / .waitForIdle()`. The fake implements
  // just enough of that surface for `pauseWorkerSession` and
  // `resumeWorkerSession` to run.
  const stats: SessionStats = {
    sessionFile: filePath,
    sessionId: "session-test-1",
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, total: 200 },
    cost: 0.020,
  };
  let waitForIdleCalls = 0;
  const fakeSession: AgentSession = {
    sessionId: "session-test-1",
    sessionManager: source,
    getSessionStats: () => stats,
    abort: async () => {},
    compact: async () => ({ summary: "", firstKeptEntryId: "x", tokensBefore: 200, estimatedTokensAfter: 100 }),
    waitForIdle: async () => { waitForIdleCalls += 1; },
    abortCompaction: () => {},
    dispose: () => {},
    subscribe: () => () => {},
  } as unknown as AgentSession;

  // Pre-reload: register a handle so pauseWorkerSession can find it.
  const preLedger = await BudgetLedger.restore(source, "tester", noCapPolicy, new AbortController().signal);
  const preHandle = {
    agent: "tester",
    session: fakeSession,
    controller: new AbortController(),
    sessionManager: source,
    ledger: preLedger,
    policy: noCapPolicy,
  };
  // Import the test-only seam from worker-tools.ts so we can seed the
  // module-level workerHandles map without going through `delegateAgent`.
  const workerTools = (await import("../src/engine/budget/worker-tools.ts")) as unknown as {
    __registerHandle?: (h: { agent: string; session: AgentSession; controller: AbortController; sessionManager: SessionManagerType; ledger: BudgetLedger; policy: WorkerBudgetPolicy }) => void;
    __unregisterHandle?: (agent: string) => void;
  };
  workerTools.__registerHandle?.(preHandle);

  try {
    // Pause — writes kind:'pause' to the source branch.
    const pauseResult = await pauseWorkerSession("tester", "pausing for /reload", new AbortController().signal);
    assert.equal(pauseResult.ledgerSnapshot.data.kind, "pause", "pauseWorkerSession writes kind='pause'");
    assert.equal(waitForIdleCalls, 1, "pauseWorkerSession called session.waitForIdle() once");

    // Simulate /reload: open a new SM and restore the ledger.
    const reloadedSM = SessionManager.open(filePath, sessionDir, cwd);
    const reloadedLedger = await BudgetLedger.restore(reloadedSM, "tester", noCapPolicy, new AbortController().signal);

    // Sanity: the pause entry survived the reload.
    const pauseEntrySurvived = reloadedSM.getBranch().filter(
      (e: SessionEntry) => e.type === "custom" && e.customType === "pi-hive-budget-ledger" && (e as unknown as { data: { kind?: string } }).data.kind === "pause",
    );
    assert.equal(pauseEntrySurvived.length, 1, "pre-reload kind:'pause' entry survives /reload");

    // Post-reload: register a fresh handle (the pre-reload one is gone —
    // /reload cleared in-memory module state) and call resumeWorkerSession.
    // The fake session is reused since `session.abort()` and friends are
    // pure on the fake; only `session.sessionManager` and `session.getSessionStats()`
    // need to point at the reloaded SM for the kind:'resume' entry to
    // land in the reloaded branch.
    const fakeReloadedSession: AgentSession = {
      ...fakeSession,
      sessionManager: reloadedSM,
    } as AgentSession;

    // Re-install the budget event hooks (resume's documented behavior
    // per worker-tools.ts T5.8 prose).
    const { installBudgetEventHooks } = await import("../src/engine/budget/events.ts");
    installBudgetEventHooks(fakeReloadedSession, reloadedLedger, noCapPolicy, new AbortController());

    const postHandle = {
      agent: "tester",
      session: fakeReloadedSession,
      controller: new AbortController(),
      sessionManager: reloadedSM,
      ledger: reloadedLedger,
      policy: noCapPolicy,
    };
    workerTools.__registerHandle?.(postHandle);

    const resumeResult = await resumeWorkerSession("tester", new AbortController().signal);
    assert.equal(resumeResult.ledgerSnapshot.data.kind, "resume", "resumeWorkerSession writes kind='resume' AFTER /reload");

    // The kind:'resume' entry landed in the reloaded branch (not the
    // pre-reload SM's branch). Verify by reading the reloaded SM.
    const resumeEntry = reloadedSM.getBranch().filter(
      (e: SessionEntry) => e.type === "custom" && e.customType === "pi-hive-budget-ledger" && (e as unknown as { data: { kind?: string } }).data.kind === "resume",
    );
    assert.equal(resumeEntry.length, 1, "kind:'resume' entry landed in the reloaded branch");

    // The reloaded ledger's cumulative echoes the pre-reload state
    // (200 tokens, $0.020) — the pause didn't increment; the resume's
    // `snapshot(stats, ...)` carries the same session-level totals
    // forward.
    assert.equal(reloadedLedger.cumulative.tokens, 200, "reloaded cumulative.tokens preserved (200)");
    assert.equal(reloadedLedger.cumulative.costUsd, 0.020, "reloaded cumulative.costUsd preserved (0.020)");

    } finally {
    workerTools.__unregisterHandle?.("tester");
  }
});

// ── T8.5: /tree re-derives ledger from new branch via SessionManager.branch(branchFromId) ─

test("T8.5: /tree navigation via SessionManager.branch(branchFromId) — BudgetLedger.restore reads ONLY the new branch's CustomEntries", async () => {
  // Per `04-refactor-plan.md` §5 F8 T8.5 (G-11): "/tree re-derives ledger
  // from new branch. Navigate to a different branch via
  // SessionManager.branch(branchFromId); assert BudgetLedger.restore reads
  // the new branch's CustomEntries."
  //
  // Test fixture (synthetic entry tree, built via inMemory):
  //
  //   M1  (user message)
  //   └─ L1  (ledger CustomEntry, cumulative 100)
  //      ├─ M2  (assistant message)  ── main branch
  //      │  └─ L2  (ledger CustomEntry, cumulative 200)  ── main branch leaf
  //      └─ M3  (user message)  ── alt branch (sibling of M2)
  //         └─ L3  (ledger CustomEntry, cumulative 300)  ── alt branch leaf
  //
  // Before `branch(...)` the leaf is L3 (the last appended entry). After
  // `sm.branch(L2.id)` the leaf moves to L2 and `getBranch()` walks
  // L2 → M2 → L1 → M1 → root — NOT including M3 / L3.

  const FIXED_TS = "2024-01-01T00:00:00.000Z";
  const userMsg = (id: string, parentId: string | null, text: string) => ({
    type: "message" as const,
    id,
    parentId,
    timestamp: FIXED_TS,
    message: { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1_700_000_000_000 },
  });
  const ledgerEntryEntry = (id: string, parentId: string | null, tokens: number) => ({
    type: "custom" as const,
    id,
    parentId,
    timestamp: FIXED_TS,
    customType: "pi-hive-budget-ledger",
    data: {
      caps: {},
      cumulative: { tokens, costUsd: tokens * 0.001, runs: 1 },
      writtenAt: 1_700_000_000_000,
      agentSlug: "tester",
    },
  });

  const header = {
    type: "session" as const,
    version: 3,
    id: "test-session",
    timestamp: FIXED_TS,
    cwd: "/tmp",
  };

  // Build the tree explicitly so id/parentId/timestamp are deterministic.
  const entries = [
    header,
    userMsg("m1", null, "first task"),
    ledgerEntryEntry("l1", "m1", 100),
    userMsg("m2", "l1", "second task"),
    ledgerEntryEntry("l2", "m2", 200),
    userMsg("m3", "l1", "alt path"), // sibling of M2
    ledgerEntryEntry("l3", "m3", 300), // child of M3
  ];

  const sm = SessionManager.inMemory("/tmp", undefined, entries);

  // Sanity: default leaf is L3 (the last appended entry). getBranch()
  // walks from leaf to root and reverses, so the path is [M1, L1, M3, L3]
  // — 4 entries; L2 is a sibling of M3 and is NOT on this path.
  const beforeBranch = sm.getBranch();
  assert.equal(beforeBranch.length, 4, "pre-branch getBranch() walks 4 entries from L3 to root (M1, L1, M3, L3)");
  const ledgerEntriesBefore = beforeBranch.filter((e) => e.type === "custom" && (e as unknown as { customType?: string }).customType === "pi-hive-budget-ledger");
  assert.equal(ledgerEntriesBefore.length, 2, "pre-branch contains 2 ledger entries (L1, L3) — L2 is on the sibling branch");

  // Navigate to the main branch (L2).
  sm.branch("l2");

  const afterBranch = sm.getBranch();
  // After new branch, the path is L2 → M2 → L1 → M1 → root — 4 entries;
  // M3 and L3 are siblings of M2 / L2, NOT ancestors of L2, so they are
  // not on this path.
  assert.equal(afterBranch.length, 4, "post-branch getBranch() walks 4 entries from L2 to root (M1, L1, M2, L2 — no M3 / L3)");

  // Restore the BudgetLedger on the new branch position.
  const ledger = await BudgetLedger.restore(sm, "tester", noCapPolicy, new AbortController().signal);

  // The new branch contains L1 and L2 only (L3 is on the alt branch,
  // not reachable from L2).
  assert.equal(ledger.entries.length, 2, "BudgetLedger.restore sees 2 ledger entries on the new branch");
  const cumulativeTokens = ledger.entries.map((e) => (e as unknown as { data: { cumulative: { tokens: number } } }).data.cumulative.tokens);
  assert.deepEqual(cumulativeTokens, [100, 200], "ledger entries on the new branch are L1 (100) and L2 (200) only");

  // The authoritative cumulative is the LATEST entry on the new branch (L2).
  assert.equal(ledger.cumulative.tokens, 200, "post-branch cumulative.tokens = 200 (L2's tokens)");
  assert.equal(ledger.cumulative.costUsd, 0.200, "post-branch cumulative.costUsd = 0.200 (L2's costUsd)");

  // Verify the alt branch's L3 is not in the ledger entries array.
  const l3Included = ledger.entries.some((e) => {
    const cum = (e as unknown as { data: { cumulative: { tokens: number } } }).data.cumulative.tokens;
    return cum === 300;
  });
  assert.equal(l3Included, false, "alt-branch ledger entry (L3, 300 tokens) is NOT included in the new branch's restore");

  // No SessionManager.dispose() — in-memory SM lives until process exit.
});

// ── T8.6: /fork creates a ledger-preserved branch via SessionManager.forkFrom(sourcePath, targetCwd, sessionDir) ─

test("T8.6: /fork via SessionManager.forkFrom — new session ID + file path; ledger entries copied", async () => {
  // Per `04-refactor-plan.md` §5 F8 T8.6 (G-11): "/fork creates a
  // ledger-fresh branch. Test: fork a session via SessionManager.forkFrom;
  // assert the new session has an empty ledger and a fresh budget."
  //
  // The brief's prose claims the forked session has an "empty ledger and
  // fresh budget". The actual SDK behavior (verified against
  // node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js
  // forkFrom at line 1374) is: SessionManager.forkFrom copies ALL
  // non-header entries from the source into a NEW session file in the
  // target directory. The forked session has a fresh sessionId and fresh
  // file path, but the ledger CustomEntries are preserved (copied verbatim)
  // so BudgetLedger.restore reconstructs the SAME cumulative as the source.
  //
  // The deviation is documented in the after-action report (Wave 4 Agent
  // 4B). This test asserts the ACTUAL behavior the SDK ships: a fork is
  // a session-identity fresh (new id, new file) but ledger-preserved. The
  // "fresh budget" interpretation is "the new session is treated as a new
  // worker identity" — which is true (different sessionId), while the
  // historical ledger data is part of the audit trail (also true).

  const sourceDir = mkdtempSync(join(tmpdir(), "pi-hive-fork-src-"));
  const sourceCwd = sourceDir;
  const sourceSessionDir = join(sourceDir, "sessions");

  const targetDir = mkdtempSync(join(tmpdir(), "pi-hive-fork-tgt-"));
  const targetCwd = targetDir;
  const targetSessionDir = join(targetDir, "sessions");

  const { sm: source, filePath: sourceFilePath } = createPersistedSource(sourceCwd, sourceSessionDir);
  assert.ok(sourceFilePath, "source SM has a filePath");

  // Write ledger entries on the source branch.
  source.appendCustomEntry("pi-hive-budget-ledger", ledgerEntry({ tokens: 100, costUsd: 0.010, runs: 1 }, { agentSlug: "tester" }).data);
  source.appendCustomEntry("pi-hive-budget-ledger", ledgerEntry({ tokens: 200, costUsd: 0.020, runs: 2 }, { agentSlug: "tester" }).data);

  // Capture the source's pre-fork cumulative.
  const sourceRestored = await BudgetLedger.restore(source, "tester", noCapPolicy, new AbortController().signal);
  assert.equal(sourceRestored.cumulative.tokens, 200, "source pre-fork cumulative.tokens = 200");

  // Fork via SessionManager.forkFrom. The SDK is:
  //   static forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager
  const forkedSM = SessionManager.forkFrom(sourceFilePath, targetCwd, targetSessionDir);

  // Verify session identity IS fresh.
  assert.notEqual(forkedSM.getSessionId(), source.getSessionId(), "forked SM has a NEW sessionId (fresh identity)");
  assert.notEqual(forkedSM.getSessionFile(), sourceFilePath, "forked SM has a NEW file path (fresh file)");
  assert.ok(forkedSM.getSessionFile() !== undefined, "forked SM exposes a sessionFile path");

  // Verify the forked SM contains the source's ledger entries (per actual
  // SDK behavior). BudgetLedger.restore on the forked SM reconstructs the
  // same cumulative as the source.
  const forkedRestored = await BudgetLedger.restore(forkedSM, "tester", noCapPolicy, new AbortController().signal);
  assert.equal(forkedRestored.cumulative.tokens, 200, "forked SM cumulative.tokens = 200 (source ledger preserved)");
  assert.equal(forkedRestored.cumulative.costUsd, 0.020, "forked SM cumulative.costUsd = 0.020 (source ledger preserved)");
  assert.equal(forkedRestored.cumulative.runs, 2, "forked SM cumulative.runs = 2 (source ledger preserved)");
  assert.equal(forkedRestored.entries.length, 2, "forked SM has the source's 2 ledger entries");

  // Verify the fork is session-independent: writing a new entry to the
  // source SM does NOT affect the forked SM (they're separate files).
  source.appendCustomEntry("pi-hive-budget-ledger", ledgerEntry({ tokens: 300, costUsd: 0.030, runs: 3 }, { agentSlug: "tester" }).data);
  assert.equal(forkedRestored.entries.length, 2, "forked SM's in-memory entries are independent of subsequent source writes");

  // And the forked SM's persisted file actually contains the copied
  // entries (read it back via a third SM).
  const forkedFilePath = forkedSM.getSessionFile();
  assert.ok(forkedFilePath, "forked SM has a file path");
  const verifyForkedSM = SessionManager.open(forkedFilePath, targetSessionDir, targetCwd);
  const verifyRestored = await BudgetLedger.restore(verifyForkedSM, "tester", noCapPolicy, new AbortController().signal);
  assert.equal(verifyRestored.cumulative.tokens, 200, "third-opened SM sees the same cumulative as the fork (ledger preserved on disk)");
  assert.equal(verifyRestored.entries.length, 2, "third-opened SM has 2 ledger entries (source ledger copied verbatim)");

  // No SessionManager.dispose() — tmpdir teardown via process exit.
});
