/**
 * Wave 1 — T1.2 BudgetLedger class tests.
 *
 * Eight tests covering:
 *   1. restore with prior entries reconstructs cumulative from the LATEST entry
 *   2. restore with no prior entries returns zeroed cumulative
 *   3. restore ignores entries with a different customType / agentSlug
 *   4. recordEvent updates in-memory cumulative without writing to the branch
 *   5. maybeSnapshot is throttled by message interval
 *   6. maybeSnapshot writes when spend ratio threshold exceeded
 *   7. recordCompaction subtracts savings from cumulative tokens
 *   8. snapshot writes a checkpoint entry and respects AbortSignal
 *   9. entries() returns the ledger entries in branch order
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
import type {
  BudgetLedgerData,
  WorkerBudgetPolicy,
} from "../src/engine/budget/types.ts";

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
    sessionId: "test-session",
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: {
      input: tokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: tokens,
    },
    cost,
  };
}

function makeFixture(opts: { agentSlug?: string; policy?: WorkerBudgetPolicy; seed?: BudgetLedgerData[] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-budget-ledger-"));
  const sm = SessionManager.inMemory(cwd);
  const agentSlug = opts.agentSlug ?? "worker";
  const policy = opts.policy ?? makePolicy();
  if (opts.seed) {
    for (const data of opts.seed) {
      sm.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, data);
    }
  }
  return { cwd, sm, agentSlug, policy };
}

// ── Case 1: restore reconstructs cumulative from the LATEST entry ───────

test("restore: reconstructs cumulative from the latest pi-hive-budget-ledger entry", async () => {
  const { sm, agentSlug, policy } = makeFixture({
    seed: [
      {
        caps: { workerTokens: 100_000 },
        cumulative: { tokens: 100, costUsd: 0.01, runs: 1 },
        writtenAt: 1_000,
        agentSlug: "worker",
      },
      {
        caps: { workerTokens: 100_000 },
        cumulative: { tokens: 250, costUsd: 0.025, runs: 1 },
        writtenAt: 2_000,
        agentSlug: "worker",
        marker: "checkpoint",
        kind: "snapshot",
      },
    ],
  });

  const ledger = await BudgetLedger.restore(sm, agentSlug, policy);
  assert.equal(ledger.cumulative.tokens, 250);
  assert.equal(ledger.cumulative.costUsd, 0.025);
  assert.equal(ledger.cumulative.runs, 1);
  assert.equal(ledger.lastKind, "snapshot");
  assert.equal(ledger.lastMarker, "checkpoint");
  assert.equal(ledger.writtenAt, 2_000);
  // Caps captured from the policy at restore time.
  assert.equal(ledger.caps.workerTokens, 100_000);
  assert.equal(ledger.caps.teamRuns, 20);
});

// ── Case 2: restore with no prior entries returns zeroed cumulative ─────

test("restore: returns zeroed cumulative and undefined kind/marker when the branch has no entries", async () => {
  const { sm, agentSlug, policy } = makeFixture();
  const ledger = await BudgetLedger.restore(sm, agentSlug, policy);
  assert.deepEqual(ledger.cumulative, { tokens: 0, costUsd: 0, runs: 0 });
  assert.equal(ledger.lastKind, undefined);
  assert.equal(ledger.lastMarker, undefined);
  assert.equal(ledger.writtenAt, 0);
  assert.equal(ledger.caps.workerDepth, 2);
});

// ── Case 3: restore ignores unrelated customTypes + other agents ─────────

test("restore: ignores entries with a different customType or different agentSlug", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-budget-ledger-"));
  const sm = SessionManager.inMemory(cwd);
  const agentSlug = "worker";
  const policy = makePolicy();
  // Right customType, wrong agent — must be ignored.
  sm.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, {
    caps: {},
    cumulative: { tokens: 888_888, costUsd: 88, runs: 88 },
    writtenAt: 1_000,
    agentSlug: "someone-else",
  });
  // Different customType (not ours) — must be ignored even when agentSlug
  // matches. Bypasses the seed helper because that helper only writes our
  // customType; we want to exercise the "raw SDK write of another type" path.
  sm.appendCustomEntry("unrelated-extension", {
    caps: {},
    cumulative: { tokens: 999_999, costUsd: 999, runs: 999 },
    writtenAt: 2_000,
    agentSlug: "worker",
  });

  const ledger = await BudgetLedger.restore(sm, agentSlug, policy);
  assert.equal(ledger.cumulative.tokens, 0);
  assert.equal(ledger.cumulative.costUsd, 0);
  assert.equal(ledger.cumulative.runs, 0);
  assert.equal(ledger.entries().length, 0, "no matching ledger entries");
});

// ── Case 4: recordEvent updates cumulative without writing ──────────────

test("recordEvent: updates in-memory cumulative and message counter without writing to the branch", async () => {
  const { sm, agentSlug, policy } = makeFixture();
  const ledger = await BudgetLedger.restore(sm, agentSlug, policy);
  const before = ledger.entries().length;

  ledger.recordEvent("message_end", { tokens: 500, costUsd: 0.05, runs: 1 });
  ledger.recordEvent("message_end", { tokens: 750, costUsd: 0.08, runs: 1 });

  assert.equal(ledger.cumulative.tokens, 750);
  assert.equal(ledger.cumulative.costUsd, 0.08);
  assert.equal(ledger.entries().length, before, "no write happened");
});

// ── Case 5: maybeSnapshot is throttled by message interval ──────────────

test("maybeSnapshot: does not write before the message interval is reached", async () => {
  const { sm, agentSlug, policy } = makeFixture();
  const ledger = await BudgetLedger.restore(sm, agentSlug, policy);

  // Cap is 100_000 tokens. Increments of 100 tokens are 0.1% of cap, well
  // under the 5% spend trigger; the only way to write during this loop is
  // the message-interval trigger (which must NOT fire for messages 1..9).
  for (let i = 1; i < THROTTLE_MESSAGE_INTERVAL; i++) {
    const tokens = i * 100;
    const cost = i * 0.001;
    ledger.recordEvent("message_end", { tokens, costUsd: cost, runs: 1 });
    const wrote = ledger.maybeSnapshot({ tokens, costUsd: cost, runs: 1 }, policy);
    assert.equal(wrote, false, `message ${i} should not trigger a write`);
  }
  assert.equal(ledger.entries().length, 0);

  // The THROTTLE_MESSAGE_INTERVAL-th message end triggers the write.
  const tokens = THROTTLE_MESSAGE_INTERVAL * 100;
  const cost = THROTTLE_MESSAGE_INTERVAL * 0.001;
  ledger.recordEvent("message_end", { tokens, costUsd: cost, runs: 1 });
  const wrote = ledger.maybeSnapshot({ tokens, costUsd: cost, runs: 1 }, policy);
  assert.equal(wrote, true);
  assert.equal(ledger.entries().length, 1);
});

// ── Case 6: maybeSnapshot writes when spend ratio threshold exceeded ────

test("maybeSnapshot: writes when spend change since last snapshot is at least THROTTLE_SPEND_RATIO of cap", async () => {
  // Cap = 1_000 so that 5% = 50 tokens and 6% = 60 tokens — a clean ratio
  // scenario without waiting for the message-interval trigger.
  const cap = 1_000;
  const policy: WorkerBudgetPolicy = makePolicy({
    tokens: { resource: "tokens", cap },
  });
  const { sm, agentSlug } = makeFixture({ policy });
  const ledger = await BudgetLedger.restore(sm, agentSlug, policy);

  // First write: 200 tokens is 20% of cap (well above 5%). Bootstrap.
  ledger.recordEvent("message_end", { tokens: 200, costUsd: 0.02, runs: 1 });
  assert.equal(ledger.maybeSnapshot({ tokens: 200, costUsd: 0.02, runs: 1 }, policy), true);
  assert.equal(ledger.entries().length, 1);

  // 10-token bump is 1% of cap — below threshold, must NOT write.
  ledger.recordEvent("message_end", { tokens: 210, costUsd: 0.021, runs: 1 });
  assert.equal(
    ledger.maybeSnapshot({ tokens: 210, costUsd: 0.021, runs: 1 }, policy),
    false,
    `10/${cap} = ${(10 / cap) * 100}% is below ${THROTTLE_SPEND_RATIO * 100}%`,
  );

  // 60-token bump is 6% of cap — above threshold, must write.
  ledger.recordEvent("message_end", { tokens: 270, costUsd: 0.027, runs: 1 });
  assert.equal(
    ledger.maybeSnapshot({ tokens: 270, costUsd: 0.027, runs: 1 }, policy),
    true,
    `60/${cap} = ${(60 / cap) * 100}% is above ${THROTTLE_SPEND_RATIO * 100}%`,
  );
  assert.equal(ledger.entries().length, 2);
});

// ── Case 7: recordCompaction subtracts savings ──────────────────────────

test("recordCompaction: subtracts savings from cumulative tokens, in-memory only", async () => {
  const { sm, agentSlug, policy } = makeFixture();
  const ledger = await BudgetLedger.restore(sm, agentSlug, policy);
  ledger.recordEvent("message_end", { tokens: 10_000, costUsd: 1, runs: 1 });
  assert.equal(ledger.cumulative.tokens, 10_000);

  ledger.recordCompaction(3_500);
  assert.equal(ledger.cumulative.tokens, 6_500);
  // Defensive clamp: cumulative must never go negative, even if a buggy
  // upstream reports savings larger than the current spend.
  ledger.recordCompaction(99_999);
  assert.equal(ledger.cumulative.tokens, 0);
});

// ── Case 8: snapshot writes a checkpoint + respects AbortSignal ─────────

test("snapshot: writes a checkpoint entry with stats-derived cumulative and respects AbortSignal", async () => {
  const { sm, agentSlug, policy } = makeFixture();
  const ledger = await BudgetLedger.restore(sm, agentSlug, policy);

  const stats = makeStats(42_000, 4.2);
  ledger.snapshot(stats, policy, "checkpoint");
  assert.equal(ledger.entries().length, 1);
  assert.equal(ledger.cumulative.tokens, 42_000);
  assert.equal(ledger.cumulative.costUsd, 4.2);
  assert.equal(ledger.lastMarker, "checkpoint");
  assert.equal(ledger.lastKind, undefined, "the `checkpoint` sentinel means no specific kind");

  // Operator kind: a `compact` snapshot tags data.kind distinctly so the
  // dashboard can colorize operator vs. agent_settled checkpoints.
  ledger.snapshot(makeStats(43_000, 4.3), policy, "compact");
  assert.equal(ledger.entries().length, 2);
  assert.equal(ledger.lastKind, "compact");

  // Aborted signal short-circuits the write entirely.
  const before = ledger.entries().length;
  const controller = new AbortController();
  controller.abort();
  ledger.snapshot(makeStats(99_999, 9.99), policy, "checkpoint", controller.signal);
  assert.equal(ledger.entries().length, before, "aborted signal must skip the write");
  assert.equal(ledger.cumulative.tokens, 43_000, "in-memory state must not update when aborted");
});

// ── Case 9: entries() returns the branch entries in order ───────────────

test("entries: returns ledger entries oldest-first, filtered to this agent's slug", async () => {
  const { sm, agentSlug, policy } = makeFixture({
    seed: [
      {
        caps: {},
        cumulative: { tokens: 10, costUsd: 0.001, runs: 1 },
        writtenAt: 1,
        agentSlug: "worker",
      },
      {
        caps: {},
        cumulative: { tokens: 20, costUsd: 0.002, runs: 1 },
        writtenAt: 2,
        agentSlug: "other-agent",
      },
      {
        caps: {},
        cumulative: { tokens: 30, costUsd: 0.003, runs: 1 },
        writtenAt: 3,
        agentSlug: "worker",
        marker: "warning",
      },
    ],
  });
  const ledger = await BudgetLedger.restore(sm, agentSlug, policy);
  const entries = ledger.entries();
  assert.equal(entries.length, 2, "other-agent entry must be filtered out");
  assert.equal(entries[0]!.data.cumulative.tokens, 10);
  assert.equal(entries[1]!.data.cumulative.tokens, 30);
  assert.equal(entries[1]!.data.marker, "warning");
  assert.equal(entries[0]!.customType, BUDGET_LEDGER_CUSTOM_TYPE);
});
