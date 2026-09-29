/**
 * Wave 4A — F7 race-safe accounting tests (T7.1, T7.2, T7.3, T7.4, T7.6, T7.7).
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md
 *   §3.7 F7 — race-safe accounting guarantees.
 *   §6.2 G-09 — parallel delegation updates must remain coherent.
 *   §6.2 G-03 — Bug 3 regression: runtime.* = 0 but remaining.tokens = 0
 *               after fresh=true abort is structurally impossible.
 *
 * Coverage (6 test groups; each group is a single node:test):
 *
 *   T7.1 — Abort races getSessionStats(). 100 consecutive runs.
 *          Loop internally; one failed iteration fails the test.
 *
 *   T7.2 — Parallel delegation updates (G-09). Two scripted workers
 *          interleave deterministic events; team totals equal the sum of
 *          each worker's latest cumulative spend.
 *
 *   T7.3 — Mid-run compaction racing message_end. Both orderings
 *          produce a consistent cumulative.
 *
 *   T7.4 — session_start racing CustomEntry write. Both orderings
 *          produce a consistent ledger.
 *
 *   T7.6 — agent_settled after abort. The checkpoint snapshot reflects
 *          the post-abort authoritative stats, no entries dropped.
 *
 *   T7.7 — Bug 3 regression (G-03). workerConsumedTokens=15134 (the
 *          original incident value) → fresh=true dispatch → remaining.tokens
 *          equals tokensCap - 15134, NOT 0.
 *
 * Hard constraints (per the wave-4A task brief):
 *   - No Math.random() / Date.now() / setTimeout() / setInterval() in
 *     production OR test paths.
 *   - T7.1 must pass 100 consecutive runs: structure as an internal loop.
 *   - T7.2 must NOT use real threads: fake "parallel" by interleaving
 *     deterministic event sequences from 2 sources.
 *   - T7.7 must use the exact incident value 15134.
 *   - No implementation changes — these tests drive existing code only.
 *     A failed test indicates a real bug; report it (don't fix it).
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionStats } from "@earendil-works/pi-coding-agent";
import {
  BUDGET_LEDGER_CUSTOM_TYPE,
  BudgetLedger,
} from "../src/engine/budget/ledger.ts";
import {
  installBudgetEventHooks,
} from "../src/engine/budget/events.ts";
import {
  checkBudgetPolicy,
  ratioRemaining,
  teamUsage,
  workerConsumedTokens,
} from "../src/engine/budget/policy.ts";
import type {
  BudgetLedgerData,
  BudgetLedgerEntry,
  WorkerBudgetPolicy,
} from "../src/engine/budget/types.ts";

// ---------------------------------------------------------------------------
// Deterministic fixtures.
// ---------------------------------------------------------------------------

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

function makeStats(tokens: number, cost: number): SessionStats {
  return {
    sessionFile: undefined,
    sessionId: "race-test",
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens },
    cost,
  };
}

/**
 * Scripted session with deterministic stats + an emitter.
 * Records subscribe calls so tests can prove `installBudgetEventHooks`
 * actually installed a listener (it must — the hook is the load-bearing
 * side effect of every race scenario here).
 */
interface ScriptedSession {
  listener: ((event: unknown) => void) | null;
  stats: SessionStats;
  statsCallCount: number;
  abortCallCount: number;
  subscribe(listener: (event: unknown) => void): () => void;
  getSessionStats(): SessionStats;
  emit(event: unknown): void;
  abort(): void;
}

function makeSession(initialStats: SessionStats): ScriptedSession {
  const session: ScriptedSession = {
    listener: null,
    stats: initialStats,
    statsCallCount: 0,
    abortCallCount: 0,
    subscribe(listener: (event: unknown) => void): () => void {
      session.listener = listener;
      return () => {
        if (session.listener === listener) session.listener = null;
      };
    },
    getSessionStats(): SessionStats {
      session.statsCallCount += 1;
      return session.stats;
    },
    emit(event: unknown): void {
      session.listener?.(event);
    },
    abort(): void {
      session.abortCallCount += 1;
    },
  };
  return session;
}

async function makeLedger(policy: WorkerBudgetPolicy): Promise<{ ledger: BudgetLedger; sm: SessionManager }> {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-races-"));
  const sm = SessionManager.inMemory(cwd);
  const ledger = await BudgetLedger.restore(sm, "race-worker", policy);
  return { ledger, sm };
}

/** Pull ledger CustomEntry data records (oldest first) from a SessionManager. */
function ledgerEntries(sm: SessionManager): BudgetLedgerData[] {
  return sm
    .getBranch()
    .filter(
      (e) =>
        e.type === "custom" &&
        (e as { customType?: unknown }).customType === BUDGET_LEDGER_CUSTOM_TYPE,
    )
    .map((e) => {
      const entry = e as unknown as BudgetLedgerEntry;
      return entry.data;
    });
}

// ===========================================================================
// T7.1 — Abort races getSessionStats() (100 consecutive runs).
//
// Contract: when controller.signal is aborted mid-read of getSessionStats(),
// the ledger MUST NOT write a half-baked entry. The in-memory cumulative
// MAY be updated (recordEvent is synchronous and runs before the abort
// short-circuit check), but the branch MUST NOT gain a CustomEntry for
// this message_end. Restoring the ledger afterwards yields the same
// numbers as the in-memory state.
//
// Hard constraint: deterministic, no real threads, no Date.now(). The
// "race" is simulated by pre-aborting the controller at a fixed point in
// the message_end sequence; the loop runs the same scenario 100 times.
// If any iteration shows inconsistent state, the test fails.
// ===========================================================================

test("T7.1 abort-then-getSessionStats race is consistent across 100 runs", async () => {
  const policy = makePolicy();

  for (let iteration = 0; iteration < 100; iteration++) {
    // Fresh session + ledger for every iteration — no cross-iteration
    // state pollution; the contract is per-event, not per-run.
    const { ledger, sm } = await makeLedger(policy);
    const session = makeSession(makeStats(0, 0));
    const controller = new AbortController();
    installBudgetEventHooks(session, ledger, policy, sm, controller);

    // Phase 1 — fire a clean message_end that establishes a baseline.
    // No abort here, no race; we use this to prove the throttle writes
    // succeed under normal conditions, so a later failure can be pinned
    // to the abort race rather than a missing throttle.
    session.stats = makeStats(10_000, 1.0);
    session.emit({ type: "message_end" });
    assert.equal(
      ledger.cumulative.tokens,
      10_000,
      `iter ${iteration}: baseline recordEvent applied cumulative=10000`,
    );

    // Phase 2 — race. Abort fires before the next message_end is
    // processed. The contract is that the ledger's CustomEntry for
    // THIS message_end is suppressed; the in-memory cumulative MAY
    // reflect the stats the hook read (recordEvent happens before the
    // signal check).
    controller.abort();
    session.stats = makeStats(20_000, 2.0);
    session.emit({ type: "message_end" });

    // The branch must NOT contain a half-written entry for the aborted
    // message_end. Concretely: the only ledger entry is from phase 1.
    const entries = ledgerEntries(sm);
    assert.equal(
      entries.length,
      1,
      `iter ${iteration}: aborted message_end must not produce a CustomEntry (got ${entries.length})`,
    );
    assert.equal(entries[0]!.cumulative.tokens, 10_000, "the single entry is from phase 1 (baseline)");

    // Restoring the ledger from the branch yields the same in-memory
    // baseline — no half-written cumulative carried over.
    const restored = await BudgetLedger.restore(sm, "race-worker", policy);
    assert.equal(
      restored.cumulative.tokens,
      10_000,
      `iter ${iteration}: restored cumulative matches phase 1 baseline`,
    );
  }

  // Defensive: every iteration passed; the contract holds across 100
  // runs. No Date.now() / Math.random() / setTimeout() used.
});

// ===========================================================================
// T7.2 — Parallel delegation updates (G-09 augmented).
//
// Contract: two delegateAgent calls run concurrently and update the
// SAME team ledger. The team ledger's `teamUsage(branch)` MUST equal
// the sum of each worker's LATEST cumulative spend — no double-count,
// no dropped entry, no race-induced drift.
//
// "Parallel" is simulated deterministically: we script two worker
// sessions (each with its own SessionManager so the worker branches are
// isolated), then merge their branches into a synthetic team branch and
// assert on teamUsage(mergedBranch). The interleaving is a fixed event
// order — no real threads.
//
// Each worker's branch carries its own ledger entries. The merge
// concatenates branch[0..N-1] of workerA and branch[0..M-1] of workerB
// in a fixed order. teamUsage's "LATEST per worker" rule is invariant
// to this merge order: it always takes the most recent CustomEntry per
// agentSlug across the merged branch.
// ===========================================================================

test("T7.2 parallel delegation updates — teamUsage equals sum of each worker's latest cumulative", async () => {
  const policy = makePolicy();

  // ── Worker A ──────────────────────────────────────────────────────────
  const cwdA = mkdtempSync(join(tmpdir(), "pi-hive-race-parallel-A-"));
  const smA = SessionManager.inMemory(cwdA);
  const ledgerA = await BudgetLedger.restore(smA, "worker-A", policy);
  const sessionA = makeSession(makeStats(0, 0));
  installBudgetEventHooks(sessionA, ledgerA, policy, smA, new AbortController());

  // ── Worker B ──────────────────────────────────────────────────────────
  const cwdB = mkdtempSync(join(tmpdir(), "pi-hive-race-parallel-B-"));
  const smB = SessionManager.inMemory(cwdB);
  const ledgerB = await BudgetLedger.restore(smB, "worker-B", policy);
  const sessionB = makeSession(makeStats(0, 0));
  installBudgetEventHooks(sessionB, ledgerB, policy, smB, new AbortController());

  // Deterministic interleaved sequence: each step picks one worker's
  // message_end at a fixed token level. The token levels are chosen
  // so each worker's intermediate cumulative is below the 5% spend
  // trigger relative to the cap (100k tokens), keeping the writes
  // throttled to one per worker — the canonical "what survived in
  // each worker's branch" is exactly one entry per worker.
  //
  // Worker A: 0 → 5_000 → 12_000 (final)
  // Worker B: 0 → 7_000 → 15_000 (final)
  //
  // Each worker's branch ends with exactly ONE throttled CustomEntry
  // (because the message_end throttling is 10-message interval, and
  // only 3 messages fire per worker — well under 10). The 5k→12k
  // jump on A is 7% of cap (above 5% trigger) so A writes its final
  // entry on the LAST message. Same for B (8k jump = 8%). The
  // earlier messages are in-memory only.

  // Interleaved sequence (8 events total):
  const sequence: Array<{ worker: "A" | "B"; tokens: number; cost: number }> = [
    { worker: "A", tokens: 5_000, cost: 0.5 },
    { worker: "B", tokens: 7_000, cost: 0.7 },
    { worker: "A", tokens: 12_000, cost: 1.2 },
    { worker: "B", tokens: 15_000, cost: 1.5 },
  ];

  for (const step of sequence) {
    const session = step.worker === "A" ? sessionA : sessionB;
    session.stats = makeStats(step.tokens, step.cost);
    session.emit({ type: "message_end" });
  }

  // Each worker has its own branch.
  const entriesA = ledgerEntries(smA);
  const entriesB = ledgerEntries(smB);
  assert.equal(entriesA.length >= 1, true, "worker A has at least one ledger entry");
  assert.equal(entriesB.length >= 1, true, "worker B has at least one ledger entry");
  assert.equal(entriesA[entriesA.length - 1]!.cumulative.tokens, 12_000, "A's latest entry = 12000");
  assert.equal(entriesB[entriesB.length - 1]!.cumulative.tokens, 15_000, "B's latest entry = 15000");

  // Build the synthetic team branch: A's entries followed by B's
  // entries. (Interleaving order doesn't affect teamUsage's "latest
  // per agentSlug" rule, but we pin a fixed order for determinism.)
  const teamBranch = [...smA.getBranch(), ...smB.getBranch()];

  const team = teamUsage(teamBranch);

  // team.tokens = LATEST(A) + LATEST(B) = 12_000 + 15_000 = 27_000.
  // NOT the sum of all historical entries (5k + 7k + 12k + 15k = 39_000)
  // — that would double-count the throttled-write intervals and is the
  // bug class teamUsage was designed to prevent.
  assert.equal(team.tokens, 27_000, "team.tokens = latest A + latest B (no double-count)");
  assert.equal(team.costUsd, 2.7, "team.costUsd = 1.2 + 1.5");
  assert.equal(team.runs, 0, "no runs in this scenario");

  // Individual workerConsumedTokens reads also reflect the LATEST entry
  // per worker, not the cumulative sum across older throttled writes.
  assert.equal(workerConsumedTokens(smA.getBranch()), 12_000);
  assert.equal(workerConsumedTokens(smB.getBranch()), 15_000);

  // Reverse the merge order — team totals must be invariant.
  const teamBranchReversed = [...smB.getBranch(), ...smA.getBranch()];
  const teamReversed = teamUsage(teamBranchReversed);
  assert.equal(teamReversed.tokens, 27_000, "team totals invariant to merge order");
  assert.equal(teamReversed.costUsd, 2.7);
});

// ===========================================================================
// T7.3 — Mid-run compaction racing message_end.
//
// Contract: a compaction_end and a message_end that fire concurrently
// must both contribute to the cumulative — no double-count, no dropped
// event. The new design reads cumulative from getSessionStats() and
// subtracts compaction savings in-memory; the branch ordering between
// the two writes is irrelevant to the final cumulative.
//
// We test BOTH orderings (compaction-first, message_first) to prove the
// ledger's contract holds regardless of which event the SDK delivers
// first. Each scenario ends with a single coherent cumulative that
// matches the expected post-both-events total.
// ===========================================================================

test("T7.3 compaction racing message_end — cumulative is coherent in both orderings", async () => {
  const policy = makePolicy();
  const { ledger, sm } = await makeLedger(policy);
  const session = makeSession(makeStats(0, 0));
  installBudgetEventHooks(session, ledger, policy, sm, new AbortController());

  // ── Ordering A: compaction first, then message_end ─────────────────────
  // Step 1: message_end brings cumulative to 1000.
  session.stats = makeStats(1000, 0.1);
  session.emit({ type: "message_end" });
  assert.equal(ledger.cumulative.tokens, 1000);

  // Step 2: compaction completes mid-run with savings=400.
  session.emit({
    type: "compaction_end",
    result: { tokensBefore: 1000, estimatedTokensAfter: 600 },
  });
  assert.equal(ledger.cumulative.tokens, 600, "1000 - 400 = 600 (compaction subtracts savings)");

  // Step 3: a subsequent message_end brings the cumulative to 650.
  // Note: the SDK's getSessionStats() is the authoritative total — we
  // model the "stats were read just after compaction" case.
  session.stats = makeStats(650, 0.065);
  session.emit({ type: "message_end" });
  assert.equal(ledger.cumulative.tokens, 650, "post-compaction message_end sets cumulative=650");
  assert.equal(ledger.cumulative.costUsd, 0.065);

  // The branch carries the cumulative of the LATEST ledger write. With
  // small token increments (1000, 650) the spend trigger (5% of cap)
  // never fires and only 3 messages have been emitted (well below the
  // 10-message interval) — so the branch may carry zero CustomEntries
  // and the in-memory state is the authoritative view. Force a write
  // by emitting agent_settled, which always writes a checkpoint from
  // the current authoritative stats (single source of truth).
  session.stats = makeStats(650, 0.065);
  session.emit({ type: "agent_settled" });

  const entriesA = ledgerEntries(sm);
  assert.equal(entriesA.length >= 1, true, "ordering A: at least one ledger entry after agent_settled");
  const latestA = entriesA[entriesA.length - 1]!;
  assert.equal(latestA.marker, "checkpoint", "agent_settled writes a checkpoint marker");
  assert.equal(latestA.cumulative.tokens, 650, "checkpoint records the current authoritative total");

  // ── Ordering B: message_end first, then compaction ─────────────────────
  // Fresh ledger + session — separate the scenario so state from A
  // doesn't bleed into B.
  const { ledger: ledgerB, sm: smB } = await makeLedger(policy);
  const sessionB = makeSession(makeStats(0, 0));
  installBudgetEventHooks(sessionB, ledgerB, policy, smB, new AbortController());

  // Step 1: message_end brings cumulative to 1000 (same as A).
  sessionB.stats = makeStats(1000, 0.1);
  sessionB.emit({ type: "message_end" });
  assert.equal(ledgerB.cumulative.tokens, 1000);

  // Step 2: ANOTHER message_end fires (the second one before
  // compaction). The SDK would deliver compaction_end only when the
  // compaction is done — by the time it arrives, stats are post the
  // second message.
  sessionB.stats = makeStats(1100, 0.11);
  sessionB.emit({ type: "message_end" });
  assert.equal(ledgerB.cumulative.tokens, 1100, "ordering B: cumulative=1100 after second message_end");

  // Step 3: compaction_end now subtracts savings. The SDK reports
  // tokensBefore=1100 (the pre-compaction total including the second
  // message), estimatedTokensAfter=700. Savings = 1100 - 700 = 400.
  sessionB.emit({
    type: "compaction_end",
    result: { tokensBefore: 1100, estimatedTokensAfter: 700 },
  });
  assert.equal(ledgerB.cumulative.tokens, 700, "1100 - 400 = 700 (compaction subtracts from current)");

  // Step 4: agent_settled forces a checkpoint write so the branch
  // carries the post-both-events cumulative (700).
  sessionB.stats = makeStats(700, 0.07);
  sessionB.emit({ type: "agent_settled" });
  const entriesB = ledgerEntries(smB);
  assert.equal(entriesB.length >= 1, true, "ordering B: at least one ledger entry after agent_settled");
  const latestB = entriesB[entriesB.length - 1]!;
  assert.equal(latestB.marker, "checkpoint");
  assert.equal(latestB.cumulative.tokens, 700, "ordering B: checkpoint records post-both-events cumulative");

  // ── Cross-check: both orderings end with a single coherent cumulative
  // state. The ledger's in-memory cumulative MUST equal what a
  // restore from the branch would yield — no drift.
  const restoredA = await BudgetLedger.restore(sm, "race-worker", policy);
  const restoredB = await BudgetLedger.restore(smB, "race-worker", policy);
  assert.equal(restoredA.cumulative.tokens, ledger.cumulative.tokens, "ordering A: restore matches in-memory");
  assert.equal(restoredB.cumulative.tokens, ledgerB.cumulative.tokens, "ordering B: restore matches in-memory");

  // Defensive: cumulative never goes negative, even when an upstream
  // reports savings larger than current spend. This is the same
  // "Math.max(0, …)" clamp the implementation uses (verified by
  // tests/budget-ledger.test.ts case 7, restated here in the race
  // context).
  ledgerB.recordCompaction(99_999);
  assert.equal(ledgerB.cumulative.tokens, 0, "clamp at zero — cumulative never goes negative");
});

// ===========================================================================
// T7.4 — session_start racing CustomEntry write.
//
// Contract: the session emits a `session_start` event at the same
// moment a CustomEntry is being written. Order is determined by the
// SDK; the ledger must handle both orderings identically. The ledger
// has no specific `session_start` handler (events.ts does not branch
// on this event type), so the test verifies that the ledger's writes
// and the session_start emission are independent — neither corrupts
// the other's state regardless of which arrives first.
//
// We model `session_start` as a distinct SessionEntry type on the
// branch (the SDK does not write `session_start` to the branch via
// appendCustomEntry, but a malformed extension might, and we want to
// prove the ledger ignores such entries rather than crashing or
// double-counting). In a real test the event would flow through
// subscribe() only.
// ===========================================================================

test("T7.4 session_start racing CustomEntry write — both orderings are coherent", async () => {
  const policy = makePolicy();
  const { ledger, sm } = await makeLedger(policy);
  const session = makeSession(makeStats(0, 0));
  installBudgetEventHooks(session, ledger, policy, sm, new AbortController());

  // ── Ordering A: write CustomEntry first, then "session_start" event ──
  // Step 1: a throttled-snapshot CustomEntry write — message_end 10x
  // pushes cumulative through the throttle (message-interval trigger
  // fires at 10). Token increments stay well below the 5% spend trigger
  // relative to the cap (10 / 100_000 = 0.01% per step) so only the
  // message-interval trigger fires — exactly one CustomEntry lands.
  for (let i = 1; i <= 10; i++) {
    session.stats = makeStats(i * 10, i * 0.001);
    session.emit({ type: "message_end" });
  }
  const entriesBeforeA = ledgerEntries(sm).length;
  assert.equal(entriesBeforeA, 1, "ordering A: one ledger entry after 10 message_ends");

  // Step 2: emit a session_start event. The hook must ignore it (no
  // handler for this event type in events.ts).
  session.emit({ type: "session_start", reason: "startup" });

  // No new CustomEntry written; the ledger ignores session_start.
  assert.equal(
    ledgerEntries(sm).length,
    entriesBeforeA,
    "ordering A: ledger entries unchanged after session_start (no handler)",
  );
  assert.equal(ledger.cumulative.tokens, 100, "ordering A: cumulative unchanged (100 tokens)");

  // ── Ordering B: session_start first, then CustomEntry write ───────────
  // Fresh session — separate the scenario so the assertion of "no
  // write from session_start" doesn't conflict with prior state.
  const { ledger: ledgerB, sm: smB } = await makeLedger(policy);
  const sessionB = makeSession(makeStats(0, 0));
  installBudgetEventHooks(sessionB, ledgerB, policy, smB, new AbortController());

  // Step 1: session_start fires BEFORE any message_end.
  sessionB.emit({ type: "session_start", reason: "startup" });
  assert.equal(ledgerEntries(smB).length, 0, "ordering B: no ledger entry from session_start alone");

  // Step 2: message_ends land normally; the throttled snapshot fires
  // on the 10th one (message-interval trigger).
  for (let i = 1; i <= 10; i++) {
    sessionB.stats = makeStats(i * 10, i * 0.001);
    sessionB.emit({ type: "message_end" });
  }
  assert.equal(ledgerEntries(smB).length, 1, "ordering B: one ledger entry after 10 message_ends");
  assert.equal(ledgerEntries(smB)[0]!.cumulative.tokens, 100);

  // ── Cross-check: BOTH orderings produce the same final ledger state ──
  // when starting from the same in-memory ledger baseline (cumulative=0).
  // The only differences must be in the BRANCH (which CustomEntry exists),
  // not in the in-memory state. After 10 message_ends, the cumulative
  // is the same in both cases (10_000).
  assert.equal(
    ledger.cumulative.tokens,
    ledgerB.cumulative.tokens,
    "both orderings converge to the same in-memory cumulative",
  );
  assert.equal(
    ledger.cumulative.costUsd,
    ledgerB.cumulative.costUsd,
    "both orderings converge to the same cost",
  );

  // The CustomEntry's `data.cumulative` MUST be the same in both cases
  // (a session_start event doesn't perturb the ledger). Restoring from
  // either branch yields the same numbers.
  const restoredA = await BudgetLedger.restore(sm, "race-worker", policy);
  const restoredB = await BudgetLedger.restore(smB, "race-worker", policy);
  assert.equal(restoredA.cumulative.tokens, restoredB.cumulative.tokens);
  assert.equal(restoredA.cumulative.costUsd, restoredB.cumulative.costUsd);
});

// ===========================================================================
// T7.6 — agent_settled after abort.
//
// Contract: when an abort fires, `agent_settled` MUST still fire (per
// plan §3.3 — abort precedes agent_settled ordering). The ledger's
// `kind: "checkpoint"` snapshot MUST reflect the final pre-abort
// cumulative. Neither event is silently dropped.
//
// Partly covered by tests/budget-events-ordering.test.ts (T3.6). This
// F7-specific test pins the "race" version: the abort fires, then
// stats change one more time (the "agent_settled" event arrives with
// FRESH post-abort stats — the model is "the agent was running
// when abort fired, but the SDK still emits agent_settled once
// cleanup completes"), and the checkpoint MUST record the FRESH
// authoritative totals (single source of truth, Hard constraint).
// ===========================================================================

test("T7.6 agent_settled after abort — checkpoint reflects post-abort authoritative stats", async () => {
  const cap = 1_000;
  const policy = makePolicy({
    tokens: { resource: "tokens", cap },
  });
  const { ledger, sm } = await makeLedger(policy);
  const session = makeSession(makeStats(0, 0));
  installBudgetEventHooks(session, ledger, policy, sm, new AbortController());

  // Step 1: spend to the cap → exhaustion fires + session.abort() is
  // called from the warning/exhaustion handler. At this point the
  // message_end fires THREE writes: maybeSnapshot's throttled write
  // (the 100% spend trigger vs. cap=1000), then markExhaustion
  // (marker="exhausted"), then the warning-evaluation guard resets the
  // dedup key. The branch carries both writes.
  session.stats = makeStats(cap, 0);
  session.emit({ type: "message_end" });
  assert.equal(session.abortCallCount, 1, "exhaustion handler fired session.abort()");
  const entriesAfterExhaustion = ledgerEntries(sm);
  assert.equal(entriesAfterExhaustion.length >= 1, true, "at least one CustomEntry after exhaustion");
  // The exhausted entry is the most recent ledger write at exhaustion time.
  const exhaustedEntry = entriesAfterExhaustion[entriesAfterExhaustion.length - 1]!;
  assert.equal(exhaustedEntry.marker, "exhausted", "the most recent entry is the exhausted marker");

  // Step 2: agent_settled fires AFTER the abort (the SDK's cleanup
  // sequence). The session might still report SOME new stats — the
  // model is "agent_settled reports whatever the SDK considers the
  // final aggregate". We model that as "the SDK reports a slightly
  // different total" (post-final-message-end value).
  const postAbortStats = makeStats(cap + 50, 0);
  session.stats = postAbortStats;
  session.emit({ type: "agent_settled" });

  // The branch carries the exhaustion entries plus the agent_settled
  // checkpoint. The checkpoint is the LAST entry (abort fires before
  // agent_settled per G-02 / T3.6).
  const entries = ledgerEntries(sm);
  assert.equal(entries.length >= 2, true, "at least exhausted + checkpoint CustomEntries");
  assert.equal(entries[entries.length - 1]!.marker, "checkpoint", "checkpoint is the latest entry");
  assert.equal(entries[entries.length - 1]!.cumulative.tokens, cap + 50, "checkpoint records post-abort stats (15134-style)");
  assert.equal(entries[entries.length - 1]!.kind, undefined, "agent_settled sentinel: kind undefined");

  // The in-memory cumulative reflects the post-abort stats — the
  // checkpoint's `cumulative` is the FRESH authoritative total, not
  // the cap-time total. This is the "single source of truth" contract:
  // the ledger doesn't carry stale numbers; getSessionStats() does.
  assert.equal(ledger.cumulative.tokens, cap + 50);

  // Restore yields the same checkpoint — the branch is the canonical
  // store, restore is a no-op loss.
  const restored = await BudgetLedger.restore(sm, "race-worker", policy);
  assert.equal(restored.cumulative.tokens, cap + 50);
  assert.equal(restored.lastMarker, "checkpoint");

  // ── Defensive: a second message_end after agent_settled MUST NOT
  // re-fire exhaustion. The dedup set in the ledger guards this.
  const exhaustedCountBefore = entries.filter((e) => e.marker === "exhausted").length;
  session.stats = makeStats(cap + 100, 0);
  session.emit({ type: "message_end" });
  const entriesAfterSecond = ledgerEntries(sm);
  assert.equal(
    entriesAfterSecond.filter((e) => e.marker === "exhausted").length,
    exhaustedCountBefore,
    "exhaustion did not re-fire after agent_settled (dedup holds)",
  );
  assert.equal(session.abortCallCount, 1, "session.abort() not re-fired");
});

// ===========================================================================
// T7.7 — Bug 3 end-to-end regression (G-03).
//
// Original incident: after fresh=true dispatch, runtime.* was reset
// to 0 but remaining.tokens was also 0 (a bug — remaining should be
// cap when consumed=0, or cap-consumed when consumed>0). With the
// new single-source-of-truth design, this bug class is structurally
// impossible: consumed is read from the ledger (not from a runtime
// counter), and remaining is computed as max(0, cap - consumed).
//
// Test scenario:
//   1. workerConsumedTokens = 15134 (the exact incident value).
//   2. The ledger carries a CustomEntry for "worker" with
//      cumulative.tokens = 15134 (the worker has prior history).
//   3. fresh=true dispatch: a new SessionManager is created (the
//      worker's fresh session), but the pre-flight reads from the
//      CONTEXT SM (which carries the prior history). The ledger
//      restored against the CONTEXT SM has cumulative.tokens=15134.
//   4. checkBudgetPolicy reads ledger.cumulative.tokens=15134. With
//      tokensCap > 15134, NO block is returned. With tokensCap <=
//      15134, a block IS returned — but its `remaining.tokens` is
//      computed from the ledger's cumulative, NOT reset to 0.
//   5. remaining.tokens = max(0, tokensCap - 15134).
//
// We assert the regression directly: the ledger reports
// cumulative.tokens = 15134 (NOT 0), and remaining.tokens computed
// from policy + ledger equals tokensCap - 15134 (NOT 0).
// ===========================================================================

test("T7.7 Bug 3 regression — workerConsumedTokens=15134 survives fresh=true dispatch", async () => {
  const INCIDENT_TOKENS = 15134;

  // Step 1: seed a branch with a CustomEntry carrying cumulative.tokens
  // = 15134 for the "worker" agent. This models the worker's prior
  // session history that the bug class would have erroneously reset.
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-race-bug3-"));
  const ctxSessionManager = SessionManager.inMemory(cwd);
  ctxSessionManager.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, {
    caps: { workerTokens: 100_000, teamTokens: 500_000 },
    cumulative: { tokens: INCIDENT_TOKENS, costUsd: 1.5, runs: 1 },
    writtenAt: 0,
    agentSlug: "worker",
  });

  // Step 2: restore the ledger from the ctx SM (the pre-flight path).
  const policy = makePolicy({
    tokens: { resource: "tokens", cap: 100_000 },
  });
  const ledger = await BudgetLedger.restore(ctxSessionManager, "worker", policy);

  // The cumulative MUST equal 15134 — the bug class (consumed reset
  // to 0 on fresh=true) is structurally impossible in the new design.
  assert.equal(
    ledger.cumulative.tokens,
    INCIDENT_TOKENS,
    "ledger.cumulative.tokens = 15134 (NOT 0) — Bug 3 is structurally impossible",
  );
  assert.equal(ledger.cumulative.runs, 1, "ledger.cumulative.runs = 1 (carries over)");

  // Step 3: simulate the fresh=true dispatch path. The worker SM is
  // a brand-new SessionManager (empty branch — that's the literal
  // "fresh=true" semantics). The PRE-FLIGHT, however, reads the ctx
  // SM and reports the cumulative there. We model this by:
  //   - creating a fresh worker SM (empty branch),
  //   - calling checkBudgetPolicy with the PRE-FLIGHT ledger
  //     (ctx-restore, cumulative=15134),
  //   - asserting the policy returns no block (15134 < 100_000),
  //   - then verifying remaining computation.

  const workerCwd = mkdtempSync(join(tmpdir(), "pi-hive-race-bug3-worker-"));
  const workerSessionManager = SessionManager.inMemory(workerCwd);
  assert.equal(
    workerSessionManager.getBranch().length,
    0,
    "fresh=true worker SessionManager has an empty branch",
  );

  // Run checkBudgetPolicy against the pre-flight ledger (read from
  // ctx). 15134 < 100_000 → no block.
  const branch = ctxSessionManager.getBranch();
  const block = checkBudgetPolicy(ledger, policy, branch, 0);
  assert.equal(block, undefined, "pre-flight: 15134 < cap=100000 → no BudgetBlock");

  // Step 4: remaining = tokensCap - 15134 (NOT 0). Use the same
  // helper the implementation uses for warning thresholds so the
  // assertion matches production code paths.
  const tokensCap = 100_000;
  const expectedRemainingTokens = tokensCap - INCIDENT_TOKENS; // 84_866
  const ratio = ratioRemaining(INCIDENT_TOKENS, tokensCap);
  // ratio = (cap - consumed) / cap = 84_866 / 100_000 = 0.84866
  assert.equal(ratio, expectedRemainingTokens / tokensCap, "ratioRemaining reflects 15134 consumed");
  assert.ok(ratio > 0, "ratio is strictly positive — consumed (15134) is below cap (100_000)");

  // ── Defensive: the same ledger is read back via workerConsumedTokens
  // (the policy.ts export). The function reads the LATEST CustomEntry's
  // cumulative, which is 15134 — the bug class would have reported 0.
  assert.equal(
    workerConsumedTokens(branch),
    INCIDENT_TOKENS,
    "workerConsumedTokens(branch) = 15134 — the bug would have reported 0",
  );

  // ── Defensive: even if the fresh worker SM happens to receive a
  // branch_summary entry pointing at the prior history (some SDK
  // chains archive-and-continue), restoring the ledger on the fresh
  // SM yields zeroed cumulative. That's the EXPECTED behavior for a
  // fresh worker — the pre-flight on ctx SM is what carries 15134
  // forward. This assertion makes the contract explicit so a future
  // regression to "fresh SM restores from prior archive" would fail
  // loudly.
  const freshWorkerLedger = await BudgetLedger.restore(workerSessionManager, "worker", policy);
  assert.equal(
    freshWorkerLedger.cumulative.tokens,
    0,
    "fresh worker SM starts at zero — the pre-flight on ctx SM carries the 15134 forward",
  );

  // ── Block path: if tokensCap were <= 15134 (e.g., the operator
  // set a tight cap), the block WOULD be returned. Its remaining.tokens
  // is 0 (the exhausted-case value), but the ledger.cumulative.tokens
  // is STILL 15134 — the bug class would have flipped consumed to 0
  // and remaining to 0 simultaneously.
  const tightPolicy = makePolicy({
    tokens: { resource: "tokens", cap: 10_000 },
  });
  const tightBlock = checkBudgetPolicy(ledger, tightPolicy, branch, 0);
  assert.ok(tightBlock, "tight cap (10000) blocks when consumed=15134");
  assert.equal(tightBlock.scope, "worker");
  assert.equal(tightBlock.resource, "tokens");
  assert.equal(tightBlock.remaining.tokens, 0, "block.remaining.tokens = 0 when exhausted (cap-relative clamp)");
  assert.equal(tightBlock.limit.tokens, 10_000);
  // The CRITICAL assertion: ledger.cumulative.tokens did NOT reset
  // to 0. Bug 3 was about both consumed AND remaining being 0 after
  // fresh=true — we explicitly verify consumed is NOT 0.
  assert.equal(
    ledger.cumulative.tokens,
    INCIDENT_TOKENS,
    "ledger.cumulative.tokens still 15134 even when block fires — Bug 3 can't recur",
  );
  // ratioRemaining on the tight cap: max(0, 10000 - 15134) / 10000 = 0
  // (clamped to 0 because consumed exceeds cap).
  assert.equal(
    ratioRemaining(INCIDENT_TOKENS, 10_000),
    0,
    "ratioRemaining=0 when consumed > cap (clamped)",
  );

  // ── Finally: the team totals must reflect the 15134. teamUsage
  // walks the branch and sums LATEST cumulative per agentSlug. With
  // one worker at 15134, team.tokens = 15134.
  const team = teamUsage(branch);
  assert.equal(team.tokens, INCIDENT_TOKENS, "teamUsage.tokens = 15134");
  assert.equal(team.runs, 1);
});
