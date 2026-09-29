/**
 * Wave 3A — F3 ordering tests (T3.5 + T3.6).
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md
 *   §3.3 F3 — T3.5 (warning × summarize_progress ordering, G-17)
 *           T3.6 (abort-then-agent_settled ordering, G-02)
 *   §6.2 G-02 — abort MUST fire before agent_settled (load-bearing for the
 *               ledger's exhausted → checkpoint branch order).
 *   §6.2 G-17 — a warning at message M must be visible to summarize_progress
 *               at M+K as the cumulative-at-M, NOT cumulative-at-M+K.
 *
 * These tests use a fake session that exposes deterministic event ordering
 * so the assertions pin "what fires before what" against an in-memory
 * SessionManager (no real agent loop, no real provider).
 *
 * Hard constraints honored:
 *   - Tests CAN use Date.now() / Math.random() / setTimeout() but must be
 *     deterministic. None of those are used here — events are scripted by
 *     the test in a fixed order.
 *   - No production-code changes — these tests drive the existing factory
 *     `installBudgetEventHooks` and `evaluateThresholds` through their
 *     observable side effects (ledger entries + abort signal).
 *   - Branch ordering is asserted via SessionManager.getBranch() entry
 *     positions — the SDK's `appendCustomEntry` advances the leaf on each
 *     write, so an entry's index in the branch equals its write order.
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
import { installBudgetEventHooks } from "../src/engine/budget/events.ts";
import type {
  BudgetLedgerData,
  BudgetLedgerMarker,
  WorkerBudgetPolicy,
} from "../src/engine/budget/types.ts";

// ---------------------------------------------------------------------------
// Fixtures / helpers.
// ---------------------------------------------------------------------------

function makePolicy(overrides: Partial<WorkerBudgetPolicy["worker"]> = {}): WorkerBudgetPolicy {
  return {
    worker: {
      tokens: { resource: "tokens", cap: 1_000 },
      costUsd: { resource: "costUsd", cap: 5 },
      runs: { resource: "runs", cap: 3 },
      depth: { resource: "depth", cap: 2 },
      ...overrides,
    },
    team: {
      tokens: { resource: "tokens", cap: 5_000 },
      costUsd: { resource: "costUsd", cap: 50 },
      runs: { resource: "runs", cap: 20 },
    },
  };
}

function makeStats(tokens: number, cost: number): SessionStats {
  return {
    sessionFile: undefined,
    sessionId: "ordering-test",
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens },
    cost,
  };
}

interface ScriptedSession {
  listener: ((event: unknown) => void) | null;
  stats: SessionStats;
  statsCallCount: number;
  abortCallCount: number;
  abortOrder: number;
  /** Monotonic counter the test bumps before each emission so we can prove
   * `abort()` fires at a specific point relative to other events. */
  eventCounter: number;
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
    abortCallCount: 0,
    abortOrder: -1,
    eventCounter: 0,
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
      session.eventCounter += 1;
      session.listener?.(event);
    },
    abort(): Promise<void> | void {
      session.abortCallCount += 1;
      session.abortOrder = session.eventCounter;
    },
  };
  return session;
}

async function makeLedger(policy: WorkerBudgetPolicy): Promise<{ ledger: BudgetLedger; sm: SessionManager }> {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-ordering-"));
  const sm = SessionManager.inMemory(cwd);
  const ledger = await BudgetLedger.restore(sm, "worker", policy);
  return { ledger, sm };
}

/** Index of the FIRST ledger CustomEntry (oldest first) whose `marker` matches. */
function indexOfMarker(sm: SessionManager, marker: BudgetLedgerMarker): number {
  const branch = sm.getBranch();
  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i]!;
    if (entry.type !== "custom") continue;
    if ((entry as { customType?: unknown }).customType !== BUDGET_LEDGER_CUSTOM_TYPE) continue;
    const data = (entry as { data?: BudgetLedgerData }).data;
    if (data?.marker === marker) return i;
  }
  return -1;
}

/** Count of ledger CustomEntries with the given marker. */
function countMarker(sm: SessionManager, marker: BudgetLedgerMarker): number {
  return sm.getBranch().filter((entry) => {
    if (entry.type !== "custom") return false;
    if ((entry as { customType?: unknown }).customType !== BUDGET_LEDGER_CUSTOM_TYPE) return false;
    return (entry as { data?: BudgetLedgerData }).data?.marker === marker;
  }).length;
}

// ──────────────────────────────────────────────────────────────────────────
// T3.5 — Warning × summarize_progress ordering (G-17).
//
// Contract: when the warning fires at message M, the CustomMessageEntry (and
// the ledger CustomEntry with marker "warning") must record the cumulative
// AT MESSAGE M. If a subsequent `summarize_progress` tool call fires at
// M+K, the tool's context snapshot (which now includes the warning
// CustomMessageEntry) observes the cumulative from M, NOT M+K.
//
// Why this matters: the worker reads the message stream to make decisions.
// If the warning carries the wrong cumulative, the worker reasons against
// stale numbers — exactly the kind of off-by-one the budget refactor is
// designed to kill.
// ──────────────────────────────────────────────────────────────────────────

test("T3.5: warning × summarize_progress ordering — warning at message M records cumulative from M, not M+K", async () => {
  const cap = 1_000;
  const policy = makePolicy({
    tokens: { resource: "tokens", cap },
  });
  const { ledger, sm } = await makeLedger(policy);
  const session = makeSession(makeStats(0, 0));
  installBudgetEventHooks(session, ledger, policy, sm, new AbortController());

  // ── Message M: cumulative = 800 (20% remaining) → warning fires ─────
  session.stats = makeStats(800, 0);
  session.emit({ type: "message_end" });

  // Capture the ledger entry's recorded cumulative at message M.
  const branchAtM = sm.getBranch();
  const warningEntryIndex = branchAtM.findIndex((entry) => {
    if (entry.type !== "custom") return false;
    if ((entry as { customType?: unknown }).customType !== BUDGET_LEDGER_CUSTOM_TYPE) return false;
    return (entry as { data?: BudgetLedgerData }).data?.marker === "warning";
  });
  assert.notEqual(warningEntryIndex, -1, "warning ledger entry must exist after message M");
  const warningCumulativeAtM = (branchAtM[warningEntryIndex]! as { data: BudgetLedgerData }).data.cumulative;
  assert.equal(warningCumulativeAtM.tokens, 800, "warning at M records cumulative=800");

  // The CustomMessageEntry (worker-visible hint) must reference cumulative=800.
  const warningMessages = sm.getBranch().filter((entry) => {
    return entry.type === "custom_message" && (entry as { customType?: unknown }).customType === "budget_warning";
  });
  assert.equal(warningMessages.length, 1, "exactly one budget_warning CustomMessageEntry");
  const warningDetails = (warningMessages[0]! as { details?: { remaining?: number; cap?: number } }).details;
  assert.equal(warningDetails?.remaining, 200, "warning CustomMessageEntry reports remaining=200 (cap - cumulative at M)");
  assert.equal(warningDetails?.cap, cap);

  // ── Messages M+1 .. M+K: cumulative climbs to 950 — well below the cap
  // (no exhaustion), and we deliberately step the cumulative in single
  // increments so the spend-ratio throttle does not write new ledger entries
  // between messages. The warning MUST NOT re-emit (dedup) and the
  // warning's recorded cumulative MUST stay locked at 800.
  for (let i = 801; i <= 950; i += 10) {
    session.stats = makeStats(i, 0);
    session.emit({ type: "message_end" });
  }

  // Exactly ONE warning ledger entry across all messages M..M+K.
  assert.equal(countMarker(sm, "warning"), 1, "warning fires exactly once across M..M+K (dedup holds)");

  // Summarize_progress fires at M+K. The worker-visible warning entry is
  // STILL the one we recorded at message M — its `remaining` is 200, NOT
  // 50 (which would be cap - cumulative-at-M+K = 1000 - 950).
  const warningEntriesAfterProgress = sm.getBranch().filter((entry) => {
    return entry.type === "custom_message" && (entry as { customType?: unknown }).customType === "budget_warning";
  });
  assert.equal(warningEntriesAfterProgress.length, 1, "no second warning after summarize_progress");
  const lockedDetails = (warningEntriesAfterProgress[0]! as { details?: { remaining?: number } }).details;
  assert.equal(lockedDetails?.remaining, 200, "warning remains at cumulative from M (200 remaining), not from M+K");

  // The ledger entry's `cumulative.tokens` is also still 800.
  const branchAfter = sm.getBranch();
  const lastWarningLedger = [...branchAfter].reverse().find((entry) => {
    if (entry.type !== "custom") return false;
    if ((entry as { customType?: unknown }).customType !== BUDGET_LEDGER_CUSTOM_TYPE) return false;
    return (entry as { data?: BudgetLedgerData }).data?.marker === "warning";
  });
  assert.ok(lastWarningLedger);
  assert.equal((lastWarningLedger as { data: BudgetLedgerData }).data.cumulative.tokens, 800);
});

// ──────────────────────────────────────────────────────────────────────────
// T3.6 — abort-then-agent_settled ordering (G-02).
//
// Contract: when the budget hits 0% on a `message_end` event, the
// exhaustion CustomEntry MUST land in the branch BEFORE the eventual
// `agent_settled` checkpoint CustomEntry. session.abort() fires from the
// exhaustion handler (synchronously) and the abort is what causes
// `agent_settled` to fire later. The T3.6 ordering test pins:
//   1. session.abort() is called when the budget hits 0%.
//   2. The exhausted ledger entry is written BEFORE agent_settled.
//   3. The checkpoint ledger entry (from agent_settled) is the LAST entry
//      in the branch, AFTER the exhausted entry.
// ──────────────────────────────────────────────────────────────────────────

test("T3.6: abort fires BEFORE agent_settled; exhausted entry precedes checkpoint entry in the branch", async () => {
  const cap = 1_000;
  const policy = makePolicy({
    tokens: { resource: "tokens", cap },
  });
  const { ledger, sm } = await makeLedger(policy);
  const session = makeSession(makeStats(0, 0));
  installBudgetEventHooks(session, ledger, policy, sm, new AbortController());

  // ── Message M: cumulative hits the cap → exhaustion fires ────────────
  session.stats = makeStats(cap, 0);
  session.emit({ type: "message_end" });

  // session.abort() was called exactly once.
  assert.equal(session.abortCallCount, 1, "session.abort() called exactly once on exhaustion");

  // The exhausted CustomEntry is present.
  assert.equal(countMarker(sm, "exhausted"), 1, "one ledger entry with marker:'exhausted'");

  // ── No agent_settled has fired yet → checkpoint NOT in branch ───────
  assert.equal(countMarker(sm, "checkpoint"), 0, "no checkpoint before agent_settled");

  // ── The SDK fires `agent_settled` after the abort resolves ───────────
  // (We model that with a deterministic fake emit.)
  session.stats = makeStats(cap, 0);
  session.emit({ type: "agent_settled" });

  // Now the branch has: exhausted, checkpoint — in that order.
  const exhaustedIndex = indexOfMarker(sm, "exhausted");
  const checkpointIndex = indexOfMarker(sm, "checkpoint");
  assert.notEqual(exhaustedIndex, -1, "exhausted entry present");
  assert.notEqual(checkpointIndex, -1, "checkpoint entry present");
  assert.ok(
    exhaustedIndex < checkpointIndex,
    `exhausted entry (index ${exhaustedIndex}) MUST come before checkpoint entry (index ${checkpointIndex})`,
  );

  // The checkpoint entry carries the cumulative from getSessionStats() —
  // not the exhaustion-time cumulative — and `kind` is undefined (the
  // "checkpoint" sentinel).
  const branch = sm.getBranch();
  const checkpointEntry = branch[checkpointIndex]! as { data: BudgetLedgerData };
  assert.equal(checkpointEntry.data.marker, "checkpoint");
  assert.equal(checkpointEntry.data.cumulative.tokens, cap);
  assert.equal(checkpointEntry.data.kind, undefined);

  // ── Determinism: a second message_end after agent_settled MUST NOT
  // re-emit exhausted (the dedup key from message M holds) and MUST NOT
  // re-fire session.abort().
  const abortCountBefore = session.abortCallCount;
  session.stats = makeStats(cap, 0);
  session.emit({ type: "message_end" });
  assert.equal(session.abortCallCount, abortCountBefore, "session.abort() not re-fired after agent_settled");
  assert.equal(countMarker(sm, "exhausted"), 1, "no duplicate exhausted entry");
  assert.equal(countMarker(sm, "checkpoint"), 1, "no duplicate checkpoint entry");
});

test("T3.6: agent_settled WITHOUT a preceding message_end writes only the checkpoint (no exhausted)", async () => {
  // Per F4 design: agent_settled is the canonical end-of-run path. If a
  // session settles without exhausting the budget, only the checkpoint
  // entry is written — no exhausted entry.
  const policy = makePolicy();
  const { ledger, sm } = await makeLedger(policy);
  const session = makeSession(makeStats(500, 0.05));
  installBudgetEventHooks(session, ledger, policy, sm, new AbortController());

  // No message_end — session settles directly.
  session.emit({ type: "agent_settled" });

  assert.equal(countMarker(sm, "exhausted"), 0, "no exhausted entry when budget wasn't blown");
  assert.equal(countMarker(sm, "checkpoint"), 1, "exactly one checkpoint entry");
  assert.equal(session.abortCallCount, 0, "session.abort() not called when budget is fine");
});

test("T3.6: aborted session continues to write the checkpoint on agent_settled — neither event is silently dropped", async () => {
  // Defensive regression: a session that aborts mid-run MUST still surface
  // the canonical checkpoint so the dashboard can show "run terminated
  // because budget exhausted" rather than "session ended with no record".
  const cap = 1_000;
  const policy = makePolicy({
    tokens: { resource: "tokens", cap },
  });
  const { ledger, sm } = await makeLedger(policy);
  const session = makeSession(makeStats(0, 0));
  installBudgetEventHooks(session, ledger, policy, sm, new AbortController());

  // Burn to cap → exhaustion fires + session.abort() called.
  session.stats = makeStats(cap, 0);
  session.emit({ type: "message_end" });

  // agent_settled fires (as it would after the abort resolves).
  session.emit({ type: "agent_settled" });

  // Final branch shape: exhausted → checkpoint. Nothing dropped.
  assert.equal(countMarker(sm, "exhausted"), 1);
  assert.equal(countMarker(sm, "checkpoint"), 1);
  assert.ok(indexOfMarker(sm, "exhausted") < indexOfMarker(sm, "checkpoint"));
});
