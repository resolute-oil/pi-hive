/**
 * Wave 2 — T2.1 `installBudgetEventHooks` factory tests.
 *
 * Twelve tests covering:
 *   1.  message_end records cumulative from session.getSessionStats() (not from the event payload).
 *   2.  message_end then calls maybeSnapshot (throttled).
 *   3.  message_end updates cumulative in monotonic order (recordEvent first, then snapshot).
 *   4.  message_end threads controller.signal into recordEvent (aborted signal short-circuits).
 *   5.  compaction_end with positive savings calls recordCompaction(savings).
 *   6.  compaction_end with zero savings calls recordCompaction(0) (idempotent no-op).
 *   7.  compaction_end with missing result fields is a no-op (no throw, no write).
 *   8.  compaction_end with non-finite (NaN) savings is a no-op (defensive).
 *   9.  agent_settled writes a checkpoint snapshot from session.getSessionStats().
 *  10.  unknown event types are silently ignored.
 *  11.  the returned unsubscribe function removes the listener (subsequent events do nothing).
 *  12.  the hook consults session.getSessionStats() exactly once per message_end — not zero, not twice.
 *
 * All tests drive the factory through a fake `SubscribableSession` whose
 * `getSessionStats()` returns scripted authoritative aggregates. The
 * ledger is a real `BudgetLedger` backed by `SessionManager.inMemory` so
 * the write-side contract (entry ids, persisted branch state) is
 * exercised end-to-end.
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
  THROTTLE_MESSAGE_INTERVAL,
} from "../src/engine/budget/ledger.ts";
import { installBudgetEventHooks } from "../src/engine/budget/events.ts";
import type {
  BudgetLedgerData,
  WorkerBudgetPolicy,
} from "../src/engine/budget/types.ts";

// ---------------------------------------------------------------------------
// Stubs / fixtures.
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
    sessionId: "events-test",
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens },
    cost,
  };
}

/** A scripted session that records subscribe calls and replays scripted getSessionStats(). */
interface ScriptedSession {
  listener: ((event: unknown) => void) | null;
  stats: SessionStats;
  statsCallCount: number;
  lastEmitted: unknown[];
  subscribe(listener: (event: unknown) => void): () => void;
  getSessionStats(): SessionStats;
  emit(event: unknown): void;
}

function makeSession(initialStats: SessionStats): ScriptedSession {
  const session: ScriptedSession = {
    listener: null,
    stats: initialStats,
    statsCallCount: 0,
    lastEmitted: [],
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
      session.lastEmitted.push(event);
      session.listener?.(event);
    },
  };
  return session;
}

async function makeLedger(policy: WorkerBudgetPolicy): Promise<{ ledger: BudgetLedger; sm: SessionManager }> {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-events-"));
  const sm = SessionManager.inMemory(cwd);
  const ledger = await BudgetLedger.restore(sm, "worker", policy);
  return { ledger, sm };
}

function ledgerEntries(sm: SessionManager): BudgetLedgerData[] {
  return sm.getBranch()
    .filter((e) => e.type === "custom" && (e as { customType?: unknown }).customType === BUDGET_LEDGER_CUSTOM_TYPE)
    .map((e) => (e as { data: BudgetLedgerData }).data);
}

// ── Case 1: message_end reads totals from getSessionStats, not from event.usage ──

test("message_end: cumulative tokens/cost come from session.getSessionStats() (single source of truth)", async () => {
  const { ledger, sm } = await makeLedger(makePolicy());
  const session = makeSession(makeStats(1234, 0.42));
  installBudgetEventHooks(session, ledger, makePolicy(), sm, new AbortController());

  // Event payload carries DIFFERENT numbers — the hook must ignore them.
  session.emit({
    type: "message_end",
    message: {
      usage: { input: 99_999, output: 99_999, cacheRead: 0, cacheWrite: 0, cost: { total: 999 } },
    },
  });

  // Throttle: 1 message < THROTTLE_MESSAGE_INTERVAL AND 1234/100_000 ≈ 1.2%
  // < THROTTLE_SPEND_RATIO (5%) — no entry written yet. The in-memory
  // cumulative IS updated, however — that's the recordEvent step.
  assert.equal(ledger.cumulative.tokens, 1234, "recordEvent set in-memory tokens to 1234 (from getSessionStats, NOT from event.usage)");
  assert.equal(ledger.cumulative.costUsd, 0.42, "recordEvent set in-memory cost to 0.42");
  assert.equal(ledgerEntries(sm).length, 0, "no entry written under throttle");
});

// ── Case 2: message_end then maybeSnapshot (throttled write) ────────────

test("message_end: maybeSnapshot writes a CustomEntry once THROTTLE_MESSAGE_INTERVAL is reached", async () => {
  const policy = makePolicy();
  const { ledger, sm } = await makeLedger(policy);
  const session = makeSession(makeStats(0, 0));
  installBudgetEventHooks(session, ledger, policy, sm, new AbortController());

  for (let i = 0; i < THROTTLE_MESSAGE_INTERVAL; i++) {
    session.emit({ type: "message_end" });
  }
  // After exactly THROTTLE_MESSAGE_INTERVAL messages, maybeSnapshot fires.
  assert.equal(ledgerEntries(sm).length, 1);
  const entry = ledgerEntries(sm)[0]!;
  assert.equal(entry.marker, undefined, "throttled snapshot has no marker (markers are for threshold crossings)");
  assert.equal(entry.kind, undefined);
});

// ── Case 3: recordEvent BEFORE maybeSnapshot — cumulative is updated first ─

test("message_end: recordEvent updates cumulative before maybeSnapshot reads it (ordering pin)", async () => {
  const policy = makePolicy();
  const { ledger, sm } = await makeLedger(policy);
  let observedCumulativeInMaybeSnapshot = -1;
  // Spy on maybeSnapshot by reading ledger.cumulative right before the write.
  const realMaybe = ledger.maybeSnapshot.bind(ledger);
  ledger.maybeSnapshot = ((cumulative, pol, sig) => {
    observedCumulativeInMaybeSnapshot = ledger.cumulative.tokens;
    return realMaybe(cumulative, pol, sig);
  }) as typeof ledger.maybeSnapshot;

  // Pre-load the throttle counter to exactly one less than the threshold so the
  // NEXT message_end fires maybeSnapshot for the first time.
  ledger.recordEvent("message_end", { tokens: 0, costUsd: 0, runs: 0 });
  for (let i = 1; i < THROTTLE_MESSAGE_INTERVAL; i++) {
    ledger.recordEvent("message_end", { tokens: 0, costUsd: 0, runs: 0 });
  }
  // Reset the session (already 0 events fired through the listener). Stats grow.
  const session = makeSession(makeStats(1234, 0.5));
  installBudgetEventHooks(session, ledger, policy, sm, new AbortController());

  session.emit({ type: "message_end" });

  // maybeSnapshot saw the post-recordEvent cumulative (1234), not the pre-update one (0).
  assert.equal(observedCumulativeInMaybeSnapshot, 1234);
});

// ── Case 4: controller.signal aborted — short-circuits writes ───────────

test("message_end: aborted controller.signal prevents ledger writes", async () => {
  const policy = makePolicy();
  const { ledger, sm } = await makeLedger(policy);
  const controller = new AbortController();
  controller.abort();
  const session = makeSession(makeStats(100, 0.01));
  installBudgetEventHooks(session, ledger, policy, sm, controller);

  for (let i = 0; i < THROTTLE_MESSAGE_INTERVAL + 5; i++) {
    session.emit({ type: "message_end" });
  }
  // Aborted signal — no entry written even past the throttle threshold.
  assert.equal(ledgerEntries(sm).length, 0);
  // In-memory cumulative is updated regardless (recordEvent honors signal but
  // doesn't short-circuit on it; the in-memory mutation is the rollback-safe step).
  assert.equal(ledger.cumulative.tokens, 100);
});

// ── Case 5: compaction_end with positive savings calls recordCompaction ──

test("compaction_end: positive savings subtract from cumulative tokens", async () => {
  const policy = makePolicy();
  const { ledger, sm } = await makeLedger(policy);
  // Seed the cumulative at 1000 so the subtraction is observable.
  ledger.recordEvent("message_end", { tokens: 1000, costUsd: 0, runs: 0 });
  const session = makeSession(makeStats(1000, 0));
  installBudgetEventHooks(session, ledger, policy, sm, new AbortController());

  session.emit({
    type: "compaction_end",
    result: { tokensBefore: 1000, estimatedTokensAfter: 400 },
  });

  assert.equal(ledger.cumulative.tokens, 400, "1000 - (1000 - 400) = 400");
});

// ── Case 6: compaction_end with zero savings — idempotent ────────────────

test("compaction_end: zero savings is recorded as 0 (idempotent no-op write)", async () => {
  const policy = makePolicy();
  const { ledger, sm } = await makeLedger(policy);
  ledger.recordEvent("message_end", { tokens: 500, costUsd: 0, runs: 0 });
  const session = makeSession(makeStats(500, 0));
  installBudgetEventHooks(session, ledger, policy, sm, new AbortController());

  session.emit({
    type: "compaction_end",
    result: { tokensBefore: 500, estimatedTokensAfter: 500 },
  });

  // 500 - 0 = 500; cumulative unchanged.
  assert.equal(ledger.cumulative.tokens, 500);
});

// ── Case 7: compaction_end with missing result is a no-op ───────────────

test("compaction_end: missing result fields are a no-op (no throw, no write)", async () => {
  const policy = makePolicy();
  const { ledger, sm } = await makeLedger(policy);
  ledger.recordEvent("message_end", { tokens: 800, costUsd: 0, runs: 0 });
  const session = makeSession(makeStats(800, 0));
  installBudgetEventHooks(session, ledger, policy, sm, new AbortController());

  // result: undefined — entire object missing.
  assert.doesNotThrow(() => session.emit({ type: "compaction_end" }));
  assert.equal(ledger.cumulative.tokens, 800, "unchanged");
  assert.equal(ledgerEntries(sm).length, 0);
});

// ── Case 8: compaction_end with NaN savings — defensive no-op ───────────

test("compaction_end: non-finite (NaN) savings is a defensive no-op", async () => {
  const policy = makePolicy();
  const { ledger, sm } = await makeLedger(policy);
  ledger.recordEvent("message_end", { tokens: 600, costUsd: 0, runs: 0 });
  const session = makeSession(makeStats(600, 0));
  installBudgetEventHooks(session, ledger, policy, sm, new AbortController());

  // tokensBefore is NaN (the SDK could send undefined which Number() coerces).
  session.emit({
    type: "compaction_end",
    result: { tokensBefore: undefined as unknown as number, estimatedTokensAfter: 100 },
  });
  // Defensive: NaN math would corrupt the cumulative; bail instead.
  assert.equal(ledger.cumulative.tokens, 600);
});

// ── Case 9: agent_settled writes a checkpoint snapshot ──────────────────

test("agent_settled: writes a checkpoint snapshot from session.getSessionStats()", async () => {
  const policy = makePolicy();
  const { ledger, sm } = await makeLedger(policy);
  const session = makeSession(makeStats(2500, 0.25));
  installBudgetEventHooks(session, ledger, policy, sm, new AbortController());

  session.emit({ type: "agent_settled" });

  const entries = ledgerEntries(sm);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.marker, "checkpoint");
  assert.equal(entries[0]!.cumulative.tokens, 2500);
  assert.equal(entries[0]!.cumulative.costUsd, 0.25);
  assert.equal(entries[0]!.kind, undefined);
});

// ── Case 10: unknown event types are silently ignored ───────────────────

test("unknown event types: ignored without throwing or writing", async () => {
  const policy = makePolicy();
  const { ledger, sm } = await makeLedger(policy);
  const session = makeSession(makeStats(0, 0));
  installBudgetEventHooks(session, ledger, policy, sm, new AbortController());

  // Bogus / future event names must not break the hook.
  assert.doesNotThrow(() => session.emit({ type: "totally_unexpected_event" }));
  assert.doesNotThrow(() => session.emit({ type: "agent_start" }));
  assert.equal(ledgerEntries(sm).length, 0);
});

// ── Case 11: unsubscribe removes the listener (no further events fire) ──

test("unsubscribe: removes the listener — subsequent events are no-ops", async () => {
  const policy = makePolicy();
  const { ledger, sm } = await makeLedger(policy);
  const session = makeSession(makeStats(0, 0));
  const off = installBudgetEventHooks(session, ledger, policy, sm, new AbortController());
  assert.notEqual(session.listener, null, "subscribe installed the listener");

  off();
  assert.equal(session.listener, null, "unsubscribe cleared the listener");

  session.emit({ type: "message_end" });
  session.emit({ type: "agent_settled" });
  // No writes after unsubscribe; ledger cumulative is whatever it was at restore.
  assert.equal(ledgerEntries(sm).length, 0);
  assert.equal(ledger.cumulative.tokens, 0);
});

// ── Case 12: getSessionStats() is consulted exactly once per message_end ─

test("message_end: getSessionStats() is called exactly once (no zero, no double-read)", async () => {
  const policy = makePolicy();
  const { ledger, sm } = await makeLedger(policy);
  const session = makeSession(makeStats(123, 0.01));
  installBudgetEventHooks(session, ledger, policy, sm, new AbortController());

  const before = session.statsCallCount;
  session.emit({ type: "message_end" });
  const after = session.statsCallCount;
  assert.equal(after - before, 1, "exactly one getSessionStats() call per message_end");
});
