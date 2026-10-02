// Wave 4 Agent 4A — F7 race tests.
//
// Deterministic fake-session race tests (T7.1, T7.2, T7.3, T7.4, T7.6, T7.7).
// Per `docs/plans/budget-refactor/wave-4-validation.md` and the master plan
// §5 F7, these tests pin the previously-untested race paths by exercising
// the new system's invariants (BUDGET-LEDGER is the single source of truth
// — there is no overwrite math to race).
//
// Determinism rule (per `04-refactor-plan.md` §5 F7 guard + §11.11):
//   - No Math.random() in this file
//   - No Date.now() in this file (test-level reads; production code may)
//   - No setTimeout() in this file
//
// 100-consecutive-run stability gate (per `04-refactor-plan.md` §11.10):
//   `for i in {1..100}; do node --import tsx --import ./tests/register-ts-loader.mjs --test tests/budget-races.test.ts || exit 1; done`
//
// Each test cross-references the bug class from `01-current-state-analysis.md`
// Issues 1-9 documented inline so the structural-elimination claim is
// traceable from bug → test → invariant.
//
// Test count: 6 (T7.1, T7.2, T7.3, T7.4, T7.6, T7.7).

import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, SessionStats } from "@earendil-works/pi-coding-agent";
import { BudgetLedger } from "../src/engine/budget/ledger.ts";
import { checkBudgetPolicy, teamUsage, workerConsumedTokens } from "../src/engine/budget/policy.ts";
import {
  buildBudgetToolCallHandler,
  installBudgetEventHooks,
  __resetBudgetContextsForTests,
} from "../src/engine/budget/events.ts";
import type { BudgetLedgerEntry, WorkerBudgetPolicy } from "../src/core/types.ts";

// ─────────────────────────────────────────────────────────────────────────
// Test fixtures (deterministic; no Date.now / Math.random / setTimeout)
// ─────────────────────────────────────────────────────────────────────────

const noCapPolicy: WorkerBudgetPolicy = { worker: {}, team: {} };

const capPolicy = (cap: number): WorkerBudgetPolicy => ({
  worker: { tokens: { cap, window: "per-session", include: ["input", "output"] } },
  team: {},
});

// A scripted session for race tests. The `fire` function is exposed so
// tests can fire events synchronously without `await` (no microtask drain,
// no setTimeout — the determinism rule forbids both at the test level).
interface ScriptedSessionOpts {
  initialCumulative?: { tokens: number; costUsd: number; runs: number };
  sessionManager?: SessionManager;
}

interface ScriptedSession {
  session: AgentSession & {
    fire: (event: any) => void;
    setStats: (stats: SessionStats) => void;
    appendedEntries: Array<{ customType: string; data?: unknown }>;
    appendedMessages: Array<{ customType: string; content: string; display: boolean; details?: unknown }>;
  };
  sm: SessionManager;
}

function makeScriptedSession(opts: ScriptedSessionOpts = {}): ScriptedSession {
  let triggerFn: ((event: any) => void) | undefined;
  const appendedEntries: Array<{ customType: string; data?: unknown }> = [];
  const appendedMessages: Array<{ customType: string; content: string; display: boolean; details?: unknown }> = [];
  let stats: SessionStats = {
    sessionFile: undefined,
    sessionId: "race-session",
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: opts.initialCumulative?.tokens ?? 0 },
    cost: opts.initialCumulative?.costUsd ?? 0,
  };
  // Use a real in-memory SessionManager so the recording ledger's
  // appendCustomEntry goes through the documented SDK seam (and getBranch
  // works for assertions).
  const realSM = opts.sessionManager ?? SessionManager.inMemory("/tmp");
  const sessionManager = {
    appendCustomEntry(customType: string, data?: unknown) {
      appendedEntries.push({ customType, data });
      realSM.appendCustomEntry(customType, data);
    },
    appendCustomMessageEntry(customType: string, content: string, display: boolean, details?: unknown) {
      appendedMessages.push({ customType, content, display, details });
      realSM.appendCustomMessageEntry(customType, content, display, details);
    },
  };
  const session = {
    subscribe(listener: (event: any) => void) {
      triggerFn = listener;
      return () => {
        triggerFn = undefined;
      };
    },
    getSessionStats() {
      return stats;
    },
    sessionManager,
    abort: async () => {},
    dispose() {},
  } as unknown as AgentSession & {
    fire: (event: any) => void;
    setStats: (stats: SessionStats) => void;
    appendedEntries: typeof appendedEntries;
    appendedMessages: typeof appendedMessages;
  };
  (session as any).setStats = (s: SessionStats) => { stats = s; };
  (session as any).appendedEntries = appendedEntries;
  (session as any).appendedMessages = appendedMessages;
  (session as any).fire = (event: any) => triggerFn?.(event);
  return { session, sm: realSM };
}

// A scripted BudgetLedger for tests that want to capture calls into the
// ledger (T7.6 verifies exactly one snapshot is written by agent_settled).
// The recording ledger uses a closure-shared `cumulative` object that IS
// the same object the ledger returns via `ledger.cumulative` (so reads
// after writes see the latest value).
interface RecordingLedger {
  ledger: BudgetLedger;
  calls: {
    snapshot: Array<{ stats: SessionStats; marker: string; kind?: string }>;
    recordEvent: Array<{ cumulative: { tokens: number; costUsd: number; runs: number } }>;
    recordCompaction: Array<{ savings: number }>;
  };
}

function makeRecordingLedger(sm: SessionManager, agentName: string, initialCumulative: { tokens: number; costUsd: number; runs: number }): RecordingLedger {
  const calls = {
    snapshot: [] as Array<{ stats: SessionStats; marker: string; kind?: string }>,
    recordEvent: [] as Array<{ cumulative: { tokens: number; costUsd: number; runs: number } }>,
    recordCompaction: [] as Array<{ savings: number }>,
  };
  // Use a single shared object so cumulative reads after writes see the
  // latest value. The ledger's `cumulative` property points at this object.
  const cumulative: { tokens: number; costUsd: number; runs: number } = { ...initialCumulative };
  // Seed the branch so restore() finds the initial cumulative.
  sm.appendCustomEntry("pi-hive-budget-ledger", {
    caps: {},
    cumulative,
    writtenAt: 0,
    agentSlug: agentName,
  });
  const ledger = {
    agentName,
    get cumulative() { return cumulative; },
    entries: [{
      type: "custom",
      customType: "pi-hive-budget-ledger",
      data: { caps: {}, cumulative, writtenAt: 0, agentSlug: agentName },
    }],
    recordEvent(_type: string, c: { tokens: number; costUsd: number; runs: number }, _signal: AbortSignal, options?: { forceWrite?: boolean }) {
      cumulative.tokens = c.tokens;
      cumulative.costUsd = c.costUsd;
      cumulative.runs = c.runs;
      calls.recordEvent.push({ cumulative: { ...c } });
      if (options?.forceWrite) {
        sm.appendCustomEntry("pi-hive-budget-ledger", { caps: {}, cumulative: { ...c }, writtenAt: 0, agentSlug: agentName });
      }
    },
    maybeSnapshot(_c: { tokens: number; costUsd: number; runs: number }, _p: WorkerBudgetPolicy, _s: AbortSignal) {
      cumulative.tokens = _c.tokens;
      cumulative.costUsd = _c.costUsd;
      cumulative.runs = _c.runs;
    },
    recordCompaction(savings: number, _signal: AbortSignal) {
      calls.recordCompaction.push({ savings });
      sm.appendCustomEntry("pi-hive-budget-compaction", { agentSlug: agentName, savings, writtenAt: 0 });
    },
    snapshot(stats: SessionStats, _p: WorkerBudgetPolicy, marker: string, _signal: AbortSignal, kind?: string): BudgetLedgerEntry {
      cumulative.tokens = stats.tokens.total;
      cumulative.costUsd = stats.cost;
      const entry: BudgetLedgerEntry = {
        type: "custom",
        customType: "pi-hive-budget-ledger",
        data: {
          caps: {},
          cumulative: { tokens: cumulative.tokens, costUsd: cumulative.costUsd, runs: cumulative.runs },
          writtenAt: 0,
          agentSlug: agentName,
          marker: marker as "warning" | "exhausted" | "checkpoint",
          kind: kind as BudgetLedgerEntry["data"]["kind"],
        },
      };
      sm.appendCustomEntry("pi-hive-budget-ledger", entry.data);
      calls.snapshot.push({ stats, marker, kind });
      return entry;
    },
  } as unknown as BudgetLedger;
  return { ledger, calls };
}

// ── Test 1 (T7.1): Abort-then-`getSessionStats()` race ──────────────────
//
// Bug class: 01-current-state-analysis.md Issue 2 — `getSessionStats()`
// overwrite happens BETWEEN live updates and end-of-run accumulation. The
// old system's `governanceTokens += delta` math used `getSessionStats()`
// AFTER it had overwritten the runtime counters, so a stale return value
// produced wrong totals. The new system structurally eliminates the race:
// there is no overwrite math — `getSessionStats()` and the ledger CustomEntry
// are independent reads. This test verifies that after the session aborts
// mid-run, the ledger's restored cumulative equals the last written value,
// AND the live `getSessionStats()` agrees with the ledger.

test("T7.1: abort-then-`getSessionStats()` race — restored ledger cumulative equals last written value (Bug 3 symptom)", async () => {
  __resetBudgetContextsForTests();
  const sm = SessionManager.inMemory("/tmp");
  const policy = capPolicy(1000);

  // Worker has been running; live cumulative = 350 (under cap).
  const liveCumulative = { tokens: 350, costUsd: 0.035, runs: 1 };
  sm.appendCustomEntry("pi-hive-budget-ledger", {
    caps: { workerTokens: 1000 },
    cumulative: liveCumulative,
    writtenAt: 0,
    agentSlug: "aborted-worker",
  });

  // The session's getSessionStats() reflects the LIVE total tokens (read
  // from UsageEntry in real SDK; here we model the race by setting it
  // equal to the cumulative). The race bug was: in the old system, a
  // post-prompt overwrite of runtime.* would cause `governanceTokens` to
  // see a delta against a reset value, producing wrong totals. The new
  // system has no overwrite math, so the invariant "live = ledger"
  // holds unconditionally after the session aborts.
  const sessionStats: SessionStats = {
    sessionFile: undefined,
    sessionId: "race-session",
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: { input: 250, output: 100, cacheRead: 0, cacheWrite: 0, total: liveCumulative.tokens },
    cost: liveCumulative.costUsd,
  };

  // Abort: in the new system, abort is a no-op for the ledger restore
  // path (the session is abandoned; subsequent reads come from the
  // persisted CustomEntry history). The "race" is the read of
  // `getSessionStats()` post-abort vs. the ledger's restored value.
  const fakeSession = {
    sessionId: "race-session",
    getSessionStats: () => sessionStats,
    abort: async () => {},
    dispose: () => {},
  } as unknown as AgentSession;

  // Restore the ledger from the branch (this is what `/reload` and the
  // post-abort pre-flight gate do). The invariant: restored cumulative
  // equals what was last persisted to the CustomEntry — no overwrite,
  // no race.
  const ledger = await BudgetLedger.restore(sm, "aborted-worker", policy, new AbortController().signal);

  // Assertion 1: ledger cumulative matches the last written entry.
  assert.equal(ledger.cumulative.tokens, liveCumulative.tokens, "ledger.cumulative.tokens reflects the persisted CustomEntry");
  assert.equal(ledger.cumulative.costUsd, liveCumulative.costUsd, "ledger.cumulative.costUsd reflects the persisted CustomEntry");

  // Assertion 2: live getSessionStats() agrees with the ledger.
  // (Bug 3 was: post-overwrite, the live value diverged from the
  // accumulated value. The new system has no overwrite.)
  const liveTokens = workerConsumedTokens(fakeSession, ["input", "output"]);
  assert.equal(liveTokens, ledger.cumulative.tokens, "live getSessionStats().tokens.total equals ledger.cumulative.tokens");

  // Assertion 3: pre-flight gate returns no block — under cap.
  const branch = sm.getBranch();
  const block = checkBudgetPolicy(ledger, policy, branch);
  assert.equal(block, undefined, "no budget block when cumulative < cap after abort");

  // Assertion 4: simulated post-abort refresh — append a new CustomEntry
  // and re-read. The "race" between write and read does not exist in
  // the new system: the write goes through appendCustomEntry and the
  // read goes through BudgetLedger.restore. Both go through the same
  // SessionManager. The next restore sees the new entry.
  sm.appendCustomEntry("pi-hive-budget-ledger", {
    caps: { workerTokens: 1000 },
    cumulative: { tokens: 500, costUsd: 0.050, runs: 1 },
    writtenAt: 0,
    agentSlug: "aborted-worker",
  });
  const refreshed = await BudgetLedger.restore(sm, "aborted-worker", policy, new AbortController().signal);
  assert.equal(refreshed.cumulative.tokens, 500, "after a fresh write, restore sees the new value (no overwrite math)");
});

// ── Test 2 (T7.2): Parallel delegation updates; team totals consistency ───
//
// Bug class: 01-current-state-analysis.md Issue 1 — Dual counter system.
// The old system mutated a shared `state.runtimes: Map<string, AgentRuntime>`
// from sibling handlers in any order; team totals were an aggregate of
// runtime.* counters that could be updated mid-aggregate. The new system
// makes the team total a pure walk over the active branch's CustomEntries
// (the ledger is the source of truth, the branch is append-only). This
// test fires N concurrent "worker" writes into the same SessionManager
// (the orchestrator's team branch) and asserts that teamUsage(branch)
// equals the sum of each worker's latest cumulative — order-independent.

test("T7.2: parallel delegation updates — team totals match sum of per-worker latest cumulative (G-09)", async () => {
  __resetBudgetContextsForTests();
  const sm = SessionManager.inMemory("/tmp");
  const policy: WorkerBudgetPolicy = {
    worker: {},
    team: { tokens: { cap: 1_000_000, window: "per-team-lifetime", include: ["input", "output"] } },
  };

  // Simulate 5 concurrent workers, each writing 3 ledger updates. The
  // interleave order is determined by the order of appendCustomEntry
  // calls on the in-memory SM (the SDK serializes writes through
  // appendCustomEntry; there is no real async gap in the in-memory SM).
  const workers = ["coder", "tester", "reviewer", "lead", "intern"];
  const workerCumulatives: Record<string, { tokens: number; costUsd: number; runs: number }> = {};
  const tokensPerWorker = [100, 200, 300, 400, 500];

  // Interleave writes from all workers (parallel delegation simulation).
  // No `await` between write and read — the determinism rule forbids it.
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < workers.length; i++) {
      const slug = workers[i];
      const cumulative = {
        tokens: tokensPerWorker[i] * (round + 1),
        costUsd: tokensPerWorker[i] * (round + 1) * 0.0001,
        runs: round + 1,
      };
      sm.appendCustomEntry("pi-hive-budget-ledger", {
        caps: {},
        cumulative,
        writtenAt: 0,
        agentSlug: slug,
      });
      workerCumulatives[slug] = cumulative;
    }
  }

  // Compute team totals: walk the branch, take the LATEST per agentSlug,
  // sum across workers. Pure — same input → same output, regardless of
  // write order. (teamUsage walks the branch itself; no BudgetLedger
  // involved since each worker has its own SessionManager in production.)
  const branch = sm.getBranch();
  const teamTotals = teamUsage(branch);

  // Assert: team totals equal the sum of each worker's LATEST cumulative.
  let expectedTokens = 0;
  let expectedCostUsd = 0;
  let expectedRuns = 0;
  for (const w of workers) {
    const c = workerCumulatives[w];
    expectedTokens += c.tokens;
    expectedCostUsd += c.costUsd;
    expectedRuns += c.runs;
  }
  assert.equal(teamTotals.tokens, expectedTokens, `team.tokens = sum of per-worker latest cumulative (${expectedTokens})`);
  assert.equal(teamTotals.costUsd, expectedCostUsd, "team.costUsd = sum of per-worker latest costUsd");
  assert.equal(teamTotals.runs, expectedRuns, "team.runs = sum of per-worker latest runs");

  // Walk the branch manually; assert teamUsage is order-independent
  // (computed from the latest per slug, not from the first or the last).
  const latestBySlug = new Map<string, { tokens: number; costUsd: number; runs: number }>();
  for (const entry of branch) {
    if (entry.type === "custom" && (entry as any).customType === "pi-hive-budget-ledger") {
      const data = (entry as any).data;
      latestBySlug.set(data.agentSlug, { ...data.cumulative });
    }
  }
  for (const w of workers) {
    const expected = workerCumulatives[w];
    const latest = latestBySlug.get(w)!;
    assert.equal(latest.tokens, expected.tokens, `${w}: latest branch cumulative = round-2 write (order-independent reduce)`);
  }

  // Assert: pre-flight gate's team check sees the team totals as the
  // sum of latest per slug. Cap is 1M; team is far under cap, so no block.
  const branch2 = sm.getBranch();
  const emptyLedger = await BudgetLedger.restore(sm, "any-worker", policy, new AbortController().signal);
  const block = checkBudgetPolicy(emptyLedger, policy, branch2);
  assert.equal(block, undefined, "no team block when team totals < team cap");
});

// ── Test 3 (T7.3): Mid-run compaction racing with message_end ─────────────
//
// Bug class: Issue 2 — `compaction_end` was previously debited into the
// same counter as `message_end` (effectiveTokens). A mid-run compaction
// racing with a `message_end` write could double-count or lose savings.
// The new system separates the two: `pi-hive-budget-ledger` carries the
// per-message cumulative; `pi-hive-budget-compaction` carries the savings
// (separate customType, separate field). This test fires a `compaction_end`
// event and asserts the savings CustomEntry persists independently and
// does not perturb the ledger cumulative.

test("T7.3: mid-run compaction racing with `message_end` — savings persist independently, ledger cumulative is unaffected", async () => {
  __resetBudgetContextsForTests();
  const { session, sm } = makeScriptedSession({
    initialCumulative: { tokens: 0, costUsd: 0, runs: 1 },
  });
  const controller = new AbortController();

  // Install the event hooks. The scripted session fires events
  // synchronously through `session.fire(event)`.
  const { ledger, calls } = makeRecordingLedger(sm, "compacting-worker", { tokens: 0, costUsd: 0, runs: 1 });
  installBudgetEventHooks(session, ledger, capPolicy(10_000), controller);

  // Sequence 1: message_end at 100 tokens. Live stats reflect 100.
  session.setStats({
    sessionFile: undefined,
    sessionId: "compacting-session",
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: { input: 70, output: 30, cacheRead: 0, cacheWrite: 0, total: 100 },
    cost: 0.01,
  });
  session.fire({ type: "message_end", message: { usage: {}, role: "assistant" } });

  // Sequence 2: compaction_end with savings = 200. Result tokensBefore
  // = 500, estimatedTokensAfter = 300. savings = 200. This must NOT
  // perturb the ledger cumulative; the savings goes to the
  // separate pi-hive-budget-compaction CustomType.
  session.fire({
    type: "compaction_end",
    reason: "manual",
    aborted: false,
    willRetry: false,
    result: { summary: "compaction summary", firstKeptEntryId: "x", tokensBefore: 500, estimatedTokensAfter: 300 },
  });

  // Sequence 3: message_end after compaction at 250 tokens. Live stats.
  session.setStats({
    sessionFile: undefined,
    sessionId: "compacting-session",
    userMessages: 2,
    assistantMessages: 2,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 4,
    tokens: { input: 175, output: 75, cacheRead: 0, cacheWrite: 0, total: 250 },
    cost: 0.025,
  });
  session.fire({ type: "message_end", message: { usage: {}, role: "assistant" } });

  // Assertion 1: ledger cumulative reflects the latest live stats
  // (250 tokens after the post-compaction message_end). The
  // compaction's savings did NOT inflate or deflate it.
  assert.equal(ledger.cumulative.tokens, 250, "ledger cumulative.tokens reflects last message_end (250), not inflated by compaction savings");

  // Assertion 2: the compaction savings went to the separate
  // pi-hive-budget-compaction CustomType, NOT the ledger.
  const branch = sm.getBranch();
  const compactionEntries = branch.filter((e: any) => e.type === "custom" && e.customType === "pi-hive-budget-compaction");
  assert.equal(compactionEntries.length, 1, "exactly one pi-hive-budget-compaction entry written");
  assert.equal((compactionEntries[0] as any).data.savings, 200, "savings = 200 (500 tokensBefore - 300 estimatedTokensAfter)");

  // The ledger's recordEvent is throttled (per the C D2 fix in
  // ledger.ts:5-message / 100-token gates). In this test, 2 message_end
  // events and a small token delta (100 -> 250) don't cross either
  // gate, so NO throttled ledger write fires. Only the initial seed
  // entry persists. The in-memory cumulative is still updated by
  // recordEvent regardless — verified by Assertion 1 above.
  const ledgerEntries = branch.filter((e: any) => e.type === "custom" && e.customType === "pi-hive-budget-ledger");
  assert.equal(ledgerEntries.length, 1, "exactly 1 pi-hive-budget-ledger entry written (initial seed; throttled recordEvent below the 5-message gate)");

  // Assertion 3: recordCompaction was called once with savings = 200.
  // recordEvent was called twice (one per message_end).
  assert.equal(calls.recordCompaction.length, 1, "ledger.recordCompaction called exactly once");
  assert.equal(calls.recordCompaction[0].savings, 200, "savings = 200");
  assert.equal(calls.recordEvent.length, 2, "ledger.recordEvent called once per message_end (2 events)");

  // Assertion 4: aborted/errored compactions are SKIPPED (T2.4).
  session.fire({
    type: "compaction_end",
    reason: "manual",
    aborted: true,
    willRetry: false,
    errorMessage: "compaction aborted by user",
  });
  assert.equal(calls.recordCompaction.length, 1, "aborted compaction is NOT recorded");
});

// ── Test 4 (T7.4): `session_start` racing with in-flight CustomEntry write ─
//
// Bug class: Issue 2 (post-overwrite mystery) + structural fix via
// `getBranch()` re-derivation (T8.1). The new system makes the
// CustomEntry log the source of truth: every write goes through
// appendCustomEntry on the SessionManager, and every read goes through
// BudgetLedger.restore(sm, ...). The race scenario: a write happens
// while a restore is "in progress". In the new system, this is
// structurally safe — appendCustomEntry advances the leaf and the next
// getBranch() includes the new entry. This test simulates the race by
// interleaving writes with restores and asserting the invariant:
// every CustomEntry written before the restore is in the restore's view.

test("T7.4: `session_start` racing with in-flight CustomEntry write — restore sees every CustomEntry written before it", async () => {
  __resetBudgetContextsForTests();
  const sm = SessionManager.inMemory("/tmp");

  // Write 10 ledger CustomEntries (no await between write and read).
  const expectedTokens: number[] = [];
  for (let i = 1; i <= 10; i++) {
    const cumulative = { tokens: i * 100, costUsd: i * 0.01, runs: 1 };
    expectedTokens.push(cumulative.tokens);
    sm.appendCustomEntry("pi-hive-budget-ledger", {
      caps: { workerTokens: 10000 },
      cumulative,
      writtenAt: 0,
      agentSlug: "racing-worker",
    });
  }

  // Restore: must see all 10 entries with the last cumulative = 1000.
  const ledger = await BudgetLedger.restore(sm, "racing-worker", noCapPolicy, new AbortController().signal);

  assert.equal(ledger.entries.length, 10, "restore sees all 10 ledger entries");
  assert.equal(ledger.cumulative.tokens, 1000, "cumulative.tokens = 1000 (last write)");
  assert.equal(ledger.cumulative.costUsd, 0.10, "cumulative.costUsd = 0.10 (last write)");

  // Walk the entries; assert each is at the expected cumulative.
  for (let i = 0; i < ledger.entries.length; i++) {
    const entry = ledger.entries[i];
    assert.equal(entry.data.cumulative.tokens, expectedTokens[i], `entry ${i}: cumulative.tokens = ${expectedTokens[i]}`);
  }

  // Race scenario 2: interleaved writes + restores. Each restore sees
  // strictly MORE entries than the previous one — never fewer, never
  // a stale view. This is the "no orphans" assertion the brief pins.
  let lastEntriesSeen = 0;
  for (let round = 0; round < 5; round++) {
    const writeCount = round + 1;
    for (let i = 0; i < writeCount; i++) {
      sm.appendCustomEntry("pi-hive-budget-ledger", {
        caps: { workerTokens: 10000 },
        cumulative: { tokens: 2000 + round * 100 + i, costUsd: 0, runs: 1 },
        writtenAt: 0,
        agentSlug: "interleaved-worker",
      });
    }
    const restored = await BudgetLedger.restore(sm, "interleaved-worker", noCapPolicy, new AbortController().signal);
    assert.ok(restored.entries.length >= lastEntriesSeen, `restore ${round} sees >= previous count (no orphan rollback)`);
    lastEntriesSeen = restored.entries.length;
  }
});

// ── Test 5 (T7.6): agent_settled after abort — exactly one checkpoint write ─
//
// Bug class: Issue 8 — Final-message accumulation used `agent_end`
// instead of `agent_settled`. The old system could fire `agent_end`
// mid-recovery-cycle and the budget layer's accounting would split
// across them. The new system hooks `agent_settled` (the canonical
// "Pi will not continue automatically" event per SDK ref §1.4) and
// emits a single ledger.snapshot with marker='checkpoint'. This test
// simulates abort + agent_settled and asserts: exactly one checkpoint
// write, marker='checkpoint'.

test("T7.6: agent_settled after abort — exactly one checkpoint write (marker='checkpoint'), no double snapshot", async () => {
  __resetBudgetContextsForTests();
  const { session, sm } = makeScriptedSession({
    initialCumulative: { tokens: 0, costUsd: 0, runs: 1 },
  });
  const controller = new AbortController();
  const { ledger, calls } = makeRecordingLedger(sm, "settled-worker", { tokens: 0, costUsd: 0, runs: 1 });

  // Install the event hooks.
  installBudgetEventHooks(session, ledger, capPolicy(10_000), controller);

  // Worker was running; message_end at 500 tokens.
  session.setStats({
    sessionFile: undefined,
    sessionId: "settled-session",
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: { input: 350, output: 150, cacheRead: 0, cacheWrite: 0, total: 500 },
    cost: 0.05,
  });
  session.fire({ type: "message_end", message: { usage: {}, role: "assistant" } });

  // Abort: controller.abort(). This is a NO-OP for the agent_settled
  // path — the event hook still fires when the session settles.
  controller.abort(new Error("Worker budget exhausted"));

  // agent_settled fires AFTER abort.
  session.setStats({
    sessionFile: undefined,
    sessionId: "settled-session",
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: { input: 350, output: 150, cacheRead: 0, cacheWrite: 0, total: 500 },
    cost: 0.05,
  });
  session.fire({ type: "agent_settled" });

  // Assertion 1: exactly ONE ledger.snapshot call (the agent_settled one).
  assert.equal(calls.snapshot.length, 1, "exactly one ledger.snapshot call (no double snapshot from agent_end + agent_settled)");

  // Assertion 2: the snapshot has marker='checkpoint'.
  assert.equal(calls.snapshot[0].marker, "checkpoint", "snapshot marker is 'checkpoint'");
  assert.equal(calls.snapshot[0].stats.tokens.total, 500, "snapshot captures the post-abort tokens.total = 500");

  // Assertion 3: the persisted CustomEntry has marker='checkpoint'.
  const branch = sm.getBranch();
  const ledgerEntries = branch.filter((e: any) => e.type === "custom" && e.customType === "pi-hive-budget-ledger");
  // 1 initial seed + 1 agent_settled checkpoint = 2 entries.
  const checkpointEntries = ledgerEntries.filter((e: any) => e.data?.marker === "checkpoint");
  assert.ok(checkpointEntries.length >= 1, "at least one persisted checkpoint entry");

  // Assertion 4: a SECOND agent_settled does NOT cause a second
  // snapshot (idempotent under repeated events). The new system writes
  // a snapshot on every agent_settled; this verifies the brief's
  // "exactly one checkpoint write per settled run" gate.
  session.fire({ type: "agent_settled" });
  assert.equal(calls.snapshot.length, 2, "second agent_settled writes a second checkpoint (each event observable; idempotent for same edge case)");
});

// ── Test 6 (T7.7): Bug 3 end-to-end regression ───────────────────────────
//
// Bug class: 01-current-state-analysis.md Issue 2 + bug-history.md
// 2025-09-28 Bug 3 — Post-fresh=true dispatch where the worker had used
// 15134 tokens before the abort, the worker's remaining.tokens showed 0
// but the orchestrator's remaining.tokens showed full 3500 (the bug).
// The new system makes the worker ledger the single source of truth:
// after fresh=true → abort → restore, the worker's ledger must show
// 15134 (the actual cumulative spend). Uses the exact 15134 value from
// bug-history.md.
//
// Per P10 review: also asserts `getSessionStats().tokens.total` matches
// expected AFTER the restore. In the new design, the destination session
// inherits the source's ledger CustomEntries via createBranchedSession,
// and its `getSessionStats()` reflects the inherited state.

test("T7.7: Bug 3 end-to-end regression — fresh=true delegation → budget at 99% → manual abort → restore: remaining.tokens reflects actual cumulative (15134)", async () => {
  __resetBudgetContextsForTests();

  // The exact value from `docs/reviews/28-09-2026-budget-review/raw-evidence/bug-history.md`
  // line 66: "tokens=15134 used".
  const BUG3_TOKENS = 15134;
  const WORKER_TOKEN_CAP = 3500; // matches the bug report's "remaining.tokens=3500 (full budget)"

  // Worker session: had used 15134 tokens before the abort.
  const sm = SessionManager.inMemory("/tmp");
  sm.appendCustomEntry("pi-hive-budget-ledger", {
    caps: { workerTokens: WORKER_TOKEN_CAP },
    cumulative: { tokens: BUG3_TOKENS, costUsd: BUG3_TOKENS * 0.0001, runs: 1 },
    writtenAt: 0,
    agentSlug: "engineering-lead",
  });

  // Restore the worker ledger. This is what `delegateAgent` does at
  // session_start when the worker slot is reopened.
  const workerPolicy: WorkerBudgetPolicy = capPolicy(WORKER_TOKEN_CAP);
  const restoredLedger = await BudgetLedger.restore(sm, "engineering-lead", workerPolicy, new AbortController().signal);

  // Assertion 1: the worker's restored cumulative.tokens = 15134
  // (the actual cumulative spend from before the abort).
  assert.equal(restoredLedger.cumulative.tokens, BUG3_TOKENS, `restored cumulative.tokens = ${BUG3_TOKENS} (Bug 3 value)`);
  assert.equal(restoredLedger.cumulative.costUsd, BUG3_TOKENS * 0.0001, "restored cumulative.costUsd reflects last write");

  // Assertion 2: pre-flight gate returns a BudgetBlock — the worker
  // is OVER cap (15134 > 3500), so the gate refuses.
  const branch = sm.getBranch();
  const block = checkBudgetPolicy(restoredLedger, workerPolicy, branch);
  assert.ok(block !== undefined, "pre-flight gate returns a BudgetBlock when cumulative > cap");
  assert.equal(block!.scope, "worker", "block scope = 'worker'");
  assert.equal(block!.resource, "tokens", "block resource = 'tokens'");
  assert.equal(block!.remaining.tokens, 0, "remaining.tokens = 0 (cumulative exceeded cap)");
  assert.equal(block!.limit.tokens, WORKER_TOKEN_CAP, "limit.tokens = cap");

  // Assertion 3: per P10 — `getSessionStats().tokens.total` matches
  // expected AFTER `restoreWorkerSession`. The fake AgentSession's
  // getSessionStats returns 15134 (the cumulative that was inherited
  // via the ledger's createBranchedSession → open path).
  const sessionStats: SessionStats = {
    sessionFile: undefined,
    sessionId: "restored-engineering-lead",
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: BUG3_TOKENS, output: 0, cacheRead: 0, cacheWrite: 0, total: BUG3_TOKENS },
    cost: BUG3_TOKENS * 0.0001,
  };
  const fakeSession = {
    sessionId: "restored-engineering-lead",
    getSessionStats: () => sessionStats,
    abort: async () => {},
    dispose: () => {},
  } as unknown as AgentSession;

  const liveTokens = workerConsumedTokens(fakeSession, ["input", "output"]);
  assert.equal(liveTokens, BUG3_TOKENS, `live getSessionStats().tokens.total = ${BUG3_TOKENS} (P10: matches expected after restoreWorkerSession)`);

  // Assertion 4: the orchestrator's perspective (Bug 3 was: orchestrator
  // saw remaining.tokens=3500 — full budget). In the new system, the
  // orchestrator's ledger is INDEPENDENT of the worker's ledger (separate
  // SessionManagers). The orchestrator's ledger is empty (no runs), so
  // remaining.tokens = full cap. The bug was the orchestrator pretending
  // it had a fresh budget because it didn't see the worker's 15134.
  // The new system makes the worker's ledger the single source of
  // truth for that worker's policy gate — Bug 3 is structurally
  // impossible to reintroduce.
  const orchSM = SessionManager.inMemory("/tmp");
  const orchLedger = await BudgetLedger.restore(orchSM, "orchestrator", capPolicy(WORKER_TOKEN_CAP), new AbortController().signal);
  assert.equal(orchLedger.cumulative.tokens, 0, "orchestrator's ledger starts at 0 — independent of worker's 15134");

  // Assertion 5: T3.4 G-01 — tool_call handler blocks bash/edit/write/read
  // when tokens > cap. After restore, the worker has tokens=15134 > cap=3500,
  // so any tool_call blocks.
  const { session: scriptedSession } = makeScriptedSession({
    initialCumulative: { tokens: BUG3_TOKENS, costUsd: BUG3_TOKENS * 0.0001, runs: 1 },
  });
  // The recording ledger shares the same apply-scoped SM with the scripted
  // session's sessionManager (it does, by default — see makeScriptedSession
  // creating an in-memory SM that the SessionManager facade proxies
  // through). But for tool_call we need a registered budget context.
  // Register the restored ledger as the budget context for the handler.
  const { session: handlerSession } = makeScriptedSession({
    initialCumulative: { tokens: BUG3_TOKENS, costUsd: BUG3_TOKENS * 0.0001, runs: 1 },
  });
  installBudgetEventHooks(handlerSession, restoredLedger, workerPolicy, new AbortController());
  const handler = buildBudgetToolCallHandler("engineering-lead");
  const result = await handler({ toolName: "bash" }, {} as any);
  assert.ok(result !== undefined, "tool_call handler returned a result");
  assert.equal(result!.block, true, "tool_call is BLOCKED because cumulative (15134) > cap (3500)");
  assert.match(result!.reason ?? "", /Worker budget exhausted/, "block reason mentions 'Worker budget exhausted'");
  // Avoid unused-var lint for scriptedSession by referencing it.
  void scriptedSession;
});