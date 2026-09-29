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
  THROTTLE_SPEND_RATIO,
} from "../src/engine/budget/ledger.ts";
import {
  BUDGET_WARNING_CUSTOM_TYPE,
  createBudgetToolCallGuard,
  installBudgetEventHooks,
} from "../src/engine/budget/events.ts";
import type {
  BudgetBlock,
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
  abortCallCount: number;
  subscribe(listener: (event: unknown) => void): () => void;
  getSessionStats(): SessionStats;
  emit(event: unknown): void;
  abort(): Promise<void> | void;
}

function makeSession(initialStats: SessionStats): ScriptedSession {
  const session: ScriptedSession = {
    listener: null,
    stats: initialStats,
    statsCallCount: 0,
    lastEmitted: [],
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
      session.lastEmitted.push(event);
      session.listener?.(event);
    },
    abort(): Promise<void> | void {
      session.abortCallCount += 1;
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

// ──────────────────────────────────────────────────────────────────────────
// Wave 3A — F3 live tracking (T3.1 spend-ratio trigger, T3.2 warning,
// T3.3 exhaustion, T3.4 tool_call blocking).
// ──────────────────────────────────────────────────────────────────────────

function allLedgerEntries(sm: SessionManager): BudgetLedgerData[] {
  return ledgerEntries(sm);
}

function messagesOfType(sm: SessionManager, customType: string): unknown[] {
  // `appendCustomMessageEntry` writes `type: "custom_message"` with a
  // `customType` discriminator; `appendCustomEntry` writes `type: "custom"`.
  // Both are filtered here so a single helper finds either flavor.
  return sm.getBranch().filter((e) => {
    if (e.type !== "custom" && e.type !== "custom_message") return false;
    return (e as { customType?: unknown }).customType === customType;
  });
}

// ── Case 13 (T3.1 spend-ratio trigger): message_end writes a snapshot when ─
// ── the spend change since the last snapshot crosses THROTTLE_SPEND_RATIO ──

test("message_end: T3.1 spend-ratio trigger writes a snapshot before the message interval", async () => {
  // Cap = 1_000 so that 5% = 50 tokens and 6% = 60 tokens — a clean ratio
  // scenario without waiting for the message-interval trigger.
  const cap = 1_000;
  const policy = makePolicy({
    tokens: { resource: "tokens", cap },
  });
  const { ledger, sm } = await makeLedger(policy);
  const session = makeSession(makeStats(0, 0));
  installBudgetEventHooks(session, ledger, policy, sm, new AbortController());

  // First message: 200 tokens = 20% of cap → write.
  session.stats = makeStats(200, 0.02);
  session.emit({ type: "message_end" });
  assert.equal(allLedgerEntries(sm).length, 1, "first message writes the snapshot (20% ≥ 5%)");

  // Second message: bump by 10 tokens (1% of cap) — below threshold, no write.
  // We need THROTTLE_MESSAGE_INTERVAL - 1 more messages to fire on interval;
  // send them all with the same tiny bump so the spend ratio stays < 5%.
  for (let i = 0; i < THROTTLE_MESSAGE_INTERVAL - 1; i++) {
    session.stats = makeStats(210, 0.021);
    session.emit({ type: "message_end" });
  }
  assert.equal(
    allLedgerEntries(sm).length,
    1,
    `inter-message bumps of 1% stay below ${THROTTLE_SPEND_RATIO * 100}% — no new write until the interval fires`,
  );

  // Third message: bump by 60 tokens (6% of cap from last snapshot at 200)
  // → above threshold → write.
  session.stats = makeStats(270, 0.027);
  session.emit({ type: "message_end" });
  assert.equal(
    allLedgerEntries(sm).length,
    2,
    "60/1000 = 6% ≥ 5% triggers a second snapshot via the spend-ratio path",
  );
});

// ── Case 14 (T3.2 warning at 20%): emits a budget_warning CustomMessageEntry ─
// ── + writes a marker:"warning" CustomEntry, dedup by key. ─────────────────

test("message_end: T3.2 emits budget_warning at 20% remaining (dedup by scope:resource:agent)", async () => {
  const cap = 1_000;
  const policy = makePolicy({
    tokens: { resource: "tokens", cap },
  });
  const { ledger, sm } = await makeLedger(policy);
  const session = makeSession(makeStats(0, 0));
  installBudgetEventHooks(session, ledger, policy, sm, new AbortController());

  // 800 tokens = 20% remaining → at the warning threshold.
  session.stats = makeStats(800, 0);
  session.emit({ type: "message_end" });

  // One CustomMessageEntry of type "budget_warning" + one ledger CustomEntry
  // with marker "warning".
  const warnings = messagesOfType(sm, BUDGET_WARNING_CUSTOM_TYPE);
  assert.equal(warnings.length, 1, "exactly one budget_warning CustomMessageEntry");
  const warningEntry = warnings[0] as { details?: { scope?: string; resource?: string; remaining?: number; cap?: number; interventionAvailable?: boolean } };
  assert.equal(warningEntry.details?.scope, "worker");
  assert.equal(warningEntry.details?.resource, "tokens");
  assert.equal(warningEntry.details?.interventionAvailable, true, "default strategy → intervention available");
  assert.equal(warningEntry.details?.remaining, 200);
  assert.equal(warningEntry.details?.cap, cap);

  // Ledger entry with marker "warning" present.
  const ledgerWithWarningMarker = allLedgerEntries(sm).filter((d) => d.marker === "warning");
  assert.equal(ledgerWithWarningMarker.length, 1, "one ledger CustomEntry with marker:'warning'");
  assert.equal(ledgerWithWarningMarker[0]!.cumulative.tokens, 800, "ledger entry records the cumulative at message M");

  // Dedup: emit another message_end at the same cumulative (no spend trigger).
  // Already at messagesSinceLastSnapshot > 0 and spend ratio < threshold, so
  // maybeSnapshot is throttled. The warning MUST NOT fire a second time.
  // Bump stats by 10 tokens (1% — below spend threshold) so the ledger
  // moves forward but the maybeSnapshot does not write.
  session.stats = makeStats(810, 0);
  session.emit({ type: "message_end" });
  assert.equal(
    messagesOfType(sm, BUDGET_WARNING_CUSTOM_TYPE).length,
    1,
    "second message_end at the same scope/resource must NOT re-emit the warning (dedup)",
  );
  assert.equal(
    allLedgerEntries(sm).filter((d) => d.marker === "warning").length,
    1,
    "no second warning ledger entry either",
  );

  // Verify the dedup key exactly matches `${scope}:${resource}:${agent|team}`.
  assert.equal(ledger.warnedKeys.has("worker:tokens:worker"), true, "dedup key uses worker scope + tokens resource + agentSlug");
  assert.equal(ledger.warnedKeys.has("team:tokens:team"), false, "team scope has its own (empty) dedup key");
});

// ── Case 15 (T3.2 dedup by team): team scope warning has its own key ─────

test("message_end: T3.2 team warning fires independently from worker warning (separate dedup key)", async () => {
  const workerCap = 1_000;
  const teamCap = 4_000;
  const policy: WorkerBudgetPolicy = {
    worker: { tokens: { resource: "tokens", cap: workerCap } },
    team: { tokens: { resource: "tokens", cap: teamCap } },
  };
  // Seed the branch with another worker's ledger entry totaling 3000 tokens
  // so the TEAM aggregate is at 3000 / 4000 = 75% used (25% remaining).
  const { ledger, sm } = await makeLedger(policy);
  sm.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, {
    caps: { teamTokens: teamCap, workerTokens: workerCap },
    cumulative: { tokens: 3000, costUsd: 0, runs: 1 },
    writtenAt: 1,
    agentSlug: "other-worker",
  });
  const session = makeSession(makeStats(0, 0));
  installBudgetEventHooks(session, ledger, policy, sm, new AbortController());

  // Worker bumps to 850 → 15% remaining (≤20% fires for worker).
  // Team aggregate = 3000 + 850 = 3850 / 4000 = 3.75% remaining (≤20% fires
  // for team). Both fire in this single message_end.
  session.stats = makeStats(850, 0);
  session.emit({ type: "message_end" });

  const warningEntries = messagesOfType(sm, BUDGET_WARNING_CUSTOM_TYPE);
  assert.equal(warningEntries.length, 2, "worker + team both fire (distinct scope/resource pairs)");

  const scopeResourcePairs = warningEntries.map((entry) => {
    const e = entry as { details?: { scope?: string; resource?: string } };
    return `${e.details?.scope}:${e.details?.resource}`;
  });
  assert.ok(scopeResourcePairs.includes("worker:tokens"), "worker:tokens warning fired");
  assert.ok(scopeResourcePairs.includes("team:tokens"), "team:tokens warning fired");

  // Dedup keys recorded for both pairs.
  assert.ok(ledger.warnedKeys.has("worker:tokens:worker"), "worker key recorded");
  assert.ok(ledger.warnedKeys.has("team:tokens:team"), "team key uses literal 'team' (NOT the agentSlug)");
});

// ── Case 16 (T3.3 exhaustion at 0%): emits + marks + aborts ─────────────

test("message_end: T3.3 emits budget_exhausted + writes marker:'exhausted' + calls session.abort()", async () => {
  const cap = 1_000;
  const policy = makePolicy({
    tokens: { resource: "tokens", cap },
  });
  const { ledger, sm } = await makeLedger(policy);
  const session = makeSession(makeStats(0, 0));
  installBudgetEventHooks(session, ledger, policy, sm, new AbortController());

  // Cumulative hits the cap exactly → exhausted.
  session.stats = makeStats(cap, 0);
  const abortBefore = session.abortCallCount;
  session.emit({ type: "message_end" });

  // One ledger entry with marker "exhausted".
  const exhaustedEntries = allLedgerEntries(sm).filter((d) => d.marker === "exhausted");
  assert.equal(exhaustedEntries.length, 1, "one ledger CustomEntry with marker:'exhausted'");
  assert.equal(exhaustedEntries[0]!.cumulative.tokens, cap);

  // One CustomMessageEntry of type "budget_exhausted".
  const exhaustedMessages = messagesOfType(sm, "budget_exhausted");
  assert.equal(exhaustedMessages.length, 1, "one budget_exhausted CustomMessageEntry");
  const exhaustedEntry = exhaustedMessages[0] as { details?: { scope?: string; resource?: string; remaining?: number; interventionAvailable?: boolean } };
  assert.equal(exhaustedEntry.details?.scope, "worker");
  assert.equal(exhaustedEntry.details?.resource, "tokens");
  assert.equal(exhaustedEntry.details?.remaining, 0);
  assert.equal(exhaustedEntry.details?.interventionAvailable, false, "exhaustion has no intervention");

  // session.abort() was called exactly once.
  assert.equal(session.abortCallCount, abortBefore + 1, "session.abort() called for exhaustion");

  // Subsequent message_end does NOT re-emit (controller is aborted + dedup
  // key recorded). Tests determinism under repeated firings.
  session.stats = makeStats(cap, 0);
  session.emit({ type: "message_end" });
  assert.equal(
    allLedgerEntries(sm).filter((d) => d.marker === "exhausted").length,
    1,
    "second message_end at the cap must NOT re-emit exhausted (dedup key recorded)",
  );
  assert.equal(
    session.abortCallCount,
    abortBefore + 1,
    "session.abort() not called a second time",
  );
});

// ── Case 17 (T3.4 tool_call blocking — bash): returns BudgetBlock as reason ─

test("createBudgetToolCallGuard: T3.4 blocks 'bash' when budget is exhausted (BudgetBlock JSON as reason)", async () => {
  const cap = 1_000;
  const policy = makePolicy({
    tokens: { resource: "tokens", cap },
  });
  const { ledger, sm } = await makeLedger(policy);
  const controller = new AbortController();
  const guard = createBudgetToolCallGuard(
    ledger,
    policy,
    sm,
    controller,
    () => 1, // current delegation depth
  );

  // Seed cumulative so checkBudgetPolicy returns a block.
  ledger.recordEvent("message_end", { tokens: cap, costUsd: 0, runs: 1 }, controller.signal);

  const result = await guard({ toolName: "bash", input: { command: "echo hi" } });
  assert.ok(result, "guard returned a non-undefined result");
  assert.equal(result!.block, true);
  assert.equal(result!.terminate, false);
  // The reason is the JSON-serialized BudgetBlock discriminated union.
  const block = JSON.parse(result!.reason) as BudgetBlock;
  assert.equal(block.scope, "worker");
  assert.equal(block.resource, "tokens");
  assert.equal(block.remaining.tokens, 0);
  assert.equal(block.limit.tokens, cap);
  assert.match(block.reason, /exhausted/i);
});

// ── Case 18 (T3.4 tool_call blocking — edit/write/read): all four targets ─

test("createBudgetToolCallGuard: T3.4 blocks edit, write, read; passes through grep/ls/custom tools", async () => {
  const cap = 1_000;
  const policy = makePolicy({
    tokens: { resource: "tokens", cap },
  });
  const { ledger, sm } = await makeLedger(policy);
  const controller = new AbortController();
  ledger.recordEvent("message_end", { tokens: cap, costUsd: 0, runs: 1 }, controller.signal);
  const guard = createBudgetToolCallGuard(ledger, policy, sm, controller, () => 1);

  // The four blocking targets — each must return a block.
  for (const tool of ["bash", "edit", "write", "read"] as const) {
    const r = await guard({ toolName: tool, input: {} });
    assert.ok(r, `${tool}: guard returned a block result`);
    assert.equal(r!.block, true);
    const parsed = JSON.parse(r!.reason) as BudgetBlock;
    assert.equal(parsed.scope, "worker");
    assert.equal(parsed.resource, "tokens");
  }

  // Non-target tools — pass through (return undefined).
  for (const tool of ["grep", "ls", "delegate_agent"]) {
    const r = await guard({ toolName: tool, input: {} });
    assert.equal(r, undefined, `${tool}: non-blocking tool returns undefined`);
  }
});

// ── Case 19 (T3.4 tool_call no-block): guard is a no-op when budget is fine ─

test("createBudgetToolCallGuard: T3.4 returns undefined (allow) when budget is within caps", async () => {
  const policy = makePolicy();
  const { ledger, sm } = await makeLedger(policy);
  const controller = new AbortController();
  // Cumulative below cap (100 < 100_000) → no block.
  ledger.recordEvent("message_end", { tokens: 100, costUsd: 0.01, runs: 1 }, controller.signal);
  const guard = createBudgetToolCallGuard(ledger, policy, sm, controller, () => 1);

  const r = await guard({ toolName: "bash", input: {} });
  assert.equal(r, undefined, "under-budget tool calls pass through");
});

// ── Case 20 (T3.4 aborted controller short-circuit): guard is a no-op ────

test("createBudgetToolCallGuard: T3.4 short-circuits when the controller is already aborted", async () => {
  const policy = makePolicy();
  const { ledger, sm } = await makeLedger(policy);
  const controller = new AbortController();
  controller.abort();
  // Cumulative at the cap — would normally block, but the abort short-circuit
  // lets the in-flight call resolve so the agent can finish settling.
  ledger.recordEvent("message_end", { tokens: 1_000_000, costUsd: 0, runs: 1 }, controller.signal);
  const guard = createBudgetToolCallGuard(ledger, policy, sm, controller, () => 1);

  const r = await guard({ toolName: "bash", input: {} });
  assert.equal(r, undefined, "aborted controller skips the gate");
});

// ── Case 21 (T4.1 agent_settled — final snapshot): exact ledger shape ───

test("agent_settled: T4.1 writes a single checkpoint CustomEntry (F4 sole finalization path)", async () => {
  const policy = makePolicy();
  const { ledger, sm } = await makeLedger(policy);
  const session = makeSession(makeStats(7500, 0.75));
  installBudgetEventHooks(session, ledger, policy, sm, new AbortController());

  // Fire several message_end events first to seed the ledger with throttled snapshots.
  for (let i = 0; i < THROTTLE_MESSAGE_INTERVAL; i++) {
    session.stats = makeStats(i * 10, i * 0.001);
    session.emit({ type: "message_end" });
  }
  const beforeAgentSettled = allLedgerEntries(sm).length;

  // agent_settled fires the canonical checkpoint.
  session.stats = makeStats(1234, 0.25);
  session.emit({ type: "agent_settled" });

  const after = allLedgerEntries(sm);
  assert.equal(after.length, beforeAgentSettled + 1, "exactly one new entry (the checkpoint)");
  const last = after[after.length - 1]!;
  assert.equal(last.marker, "checkpoint");
  assert.equal(last.cumulative.tokens, 1234);
  assert.equal(last.cumulative.costUsd, 0.25);
  assert.equal(last.kind, undefined, "no specific kind — sentinel means 'canonical end-of-run'");
});
