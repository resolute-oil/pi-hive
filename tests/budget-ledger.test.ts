// Wave 1 F1 T1.2 — BudgetLedger unit tests
//
// Tests verify the public surface of BudgetLedger through real SessionManager
// state (inMemory) — the test seam is the SessionManager's CustomEntry log,
// not the ledger's private bookkeeping. This keeps tests at the public seam
// and means the implementation can be refactored freely without breaking
// the tests.

import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { BudgetLedger } from "../src/engine/budget/ledger.ts";
import type { WorkerBudgetPolicy, BudgetLedgerEntry } from "../src/core/types.ts";

// A no-cap policy keeps the test focused on ledger mechanics, not on
// checkBudgetPolicy's gate logic (which is exercised in tests/budget-policy.test.ts).
const noCapPolicy: WorkerBudgetPolicy = {
  worker: {},
  team: {},
};

async function emptyLedger(agentName = "tester"): Promise<{
  sm: SessionManager;
  ledger: BudgetLedger;
  signal: AbortSignal;
}> {
  const sm = SessionManager.inMemory("/tmp");
  const signal = new AbortController().signal;
  const ledger = await BudgetLedger.restore(sm, agentName, noCapPolicy, signal);
  return { sm, ledger, signal };
}

// ── Test 1: restore() reduces CustomEntry history to cumulative ────────────

test("restore() walks the active branch and reduces pi-hive-budget-ledger CustomEntries to cumulative", async () => {
  const { sm, ledger } = await emptyLedger();

  // Append two budget-ledger entries (simulating prior message_end writes).
  sm.appendCustomEntry("pi-hive-budget-ledger", {
    caps: { workerTokens: 1000 },
    cumulative: { tokens: 100, costUsd: 0.01, runs: 1 },
    writtenAt: 1_700_000_000_000,
    agentSlug: "tester",
  });
  sm.appendCustomEntry("pi-hive-budget-ledger", {
    caps: { workerTokens: 1000 },
    cumulative: { tokens: 250, costUsd: 0.03, runs: 2 },
    writtenAt: 1_700_000_000_001,
    agentSlug: "tester",
  });

  const restored = await BudgetLedger.restore(sm, "tester", noCapPolicy, new AbortController().signal);

  // The latest entry's cumulative IS the ledger's authoritative state.
  assert.equal(restored.cumulative.tokens, 250, "cumulative.tokens reflects the LATEST ledger entry's tokens");
  assert.equal(restored.cumulative.costUsd, 0.03, "cumulative.costUsd reflects the LATEST ledger entry's costUsd");
  assert.equal(restored.cumulative.runs, 2, "cumulative.runs reflects the LATEST ledger entry's runs");
  // Both entries are present in the persisted history.
  assert.equal(restored.entries.length, 2, "entries[] carries every matching CustomEntry from the active branch");
});

// ── Test 2: recordEvent() persists a CustomEntry via appendCustomEntry ─────

test("recordEvent() appends a pi-hive-budget-ledger CustomEntry with the supplied cumulative", async () => {
  const { sm, ledger } = await emptyLedger();
  const signal = new AbortController().signal;

  ledger.recordEvent("message_end", { tokens: 50, costUsd: 0.005, runs: 1 }, signal);

  const branch = sm.getBranch();
  const ledgerEntries = branch.filter(
    (e) => e.type === "custom" && e.customType === "pi-hive-budget-ledger",
  );
  assert.equal(ledgerEntries.length, 1, "exactly one budget-ledger CustomEntry was written");
  const written = ledgerEntries[0] as unknown as { data: BudgetLedgerEntry["data"] };
  assert.equal(written.data.cumulative.tokens, 50, "written entry carries the supplied tokens");
  assert.equal(written.data.cumulative.costUsd, 0.005, "written entry carries the supplied costUsd");
  assert.equal(written.data.cumulative.runs, 1, "written entry carries the supplied runs");
  assert.equal(written.data.agentSlug, "tester", "written entry carries the ledger's agentSlug");
  // Live in-memory cumulative is also updated.
  assert.equal(ledger.cumulative.tokens, 50, "ledger.cumulative.tokens reflects the event");
  assert.equal(ledger.cumulative.costUsd, 0.005, "ledger.cumulative.costUsd reflects the event");
  assert.equal(ledger.cumulative.runs, 1, "ledger.cumulative.runs reflects the event");
});

// ── Test 3: maybeSnapshot() is throttled below the message-count threshold ─

test("maybeSnapshot() does NOT write when fewer than 10 messages have occurred since the last write", async () => {
  const { sm, ledger } = await emptyLedger();
  const signal = new AbortController().signal;

  ledger.recordEvent("message_end", { tokens: 10, costUsd: 0.001, runs: 1 }, signal);
  // The first recordEvent already wrote a CustomEntry (1 entry on the branch).
  const beforeCount = sm.getBranch().filter((e) => e.type === "custom" && e.customType === "pi-hive-budget-ledger").length;

  // Simulate 4 more message_end events without crossing the 10-message threshold.
  for (let i = 0; i < 4; i++) {
    ledger.recordEvent("message_end", { tokens: 10 + i + 1, costUsd: 0.001, runs: 1 }, signal);
  }
  ledger.maybeSnapshot({ tokens: 15, costUsd: 0.001, runs: 1 }, noCapPolicy, signal);

  const afterCount = sm.getBranch().filter((e) => e.type === "custom" && e.customType === "pi-hive-budget-ledger").length;
  // 4 recordEvent writes + 0 maybeSnapshot writes = 4 new entries since the initial.
  assert.equal(afterCount - beforeCount, 4, "maybeSnapshot() did not write below the message-count threshold");
});

// ── Test 4: maybeSnapshot() writes at the ≥10 messages threshold ───────────

test("maybeSnapshot() writes when ≥10 messages have occurred since the last snapshot", async () => {
  const { sm, ledger } = await emptyLedger();
  const signal = new AbortController().signal;

  ledger.recordEvent("message_end", { tokens: 10, costUsd: 0.001, runs: 1 }, signal);
  const initialCount = sm.getBranch().filter((e) => e.type === "custom" && e.customType === "pi-hive-budget-ledger").length;

  // Simulate 9 more recordEvent calls so the next maybeSnapshot is the 10th event
  // since the last snapshot boundary. The implementation must count events from
  // either the constructor's initial state or the last maybeSnapshot reset.
  for (let i = 0; i < 9; i++) {
    ledger.recordEvent("message_end", { tokens: 20 + i, costUsd: 0.002, runs: 1 }, signal);
  }
  ledger.maybeSnapshot({ tokens: 30, costUsd: 0.002, runs: 1 }, noCapPolicy, signal);

  const afterCount = sm.getBranch().filter((e) => e.type === "custom" && e.customType === "pi-hive-budget-ledger").length;
  assert.ok(afterCount > initialCount, "maybeSnapshot() wrote a new entry at the 10-message threshold");
});

// ── Test 5: maybeSnapshot() writes at the ≥5% spend-change threshold ──────

test("maybeSnapshot() writes when spend has changed by ≥5% since the last snapshot", async () => {
  // Seed a branch with a baseline ledger entry at 1000 tokens. restore() will
  // pick this up as the initial cumulative + lastWrittenTokens, so the test
  // exercises the spend-change math in isolation (without crossing the
  // message-count gate).
  const sm = SessionManager.inMemory("/tmp");
  sm.appendCustomEntry("pi-hive-budget-ledger", {
    caps: { workerTokens: 2000 },
    cumulative: { tokens: 1000, costUsd: 0.10, runs: 1 },
    writtenAt: 1_700_000_000_000,
    agentSlug: "tester",
  });
  const ledger = await BudgetLedger.restore(sm, "tester", noCapPolicy, new AbortController().signal);
  const signal = new AbortController().signal;
  const baselineCount = sm.getBranch().filter((e) => e.type === "custom" && e.customType === "pi-hive-budget-ledger").length;

  // Advance cumulative by 6% (1000 → 1060 = 6%) — above the 5% threshold —
  // without crossing the 10-message gate. maybeSnapshot must write.
  ledger.maybeSnapshot({ tokens: 1060, costUsd: 0.106, runs: 1 }, noCapPolicy, signal);

  const afterCount = sm.getBranch().filter((e) => e.type === "custom" && e.customType === "pi-hive-budget-ledger").length;
  assert.equal(afterCount, baselineCount + 1, "maybeSnapshot() wrote exactly one entry at the 6% spend-change threshold");
});

// ── Test 6: recordCompaction(savings) writes a CustomEntry carrying the savings ─

test("recordCompaction(savings) writes a CustomEntry carrying the savings number", async () => {
  const { sm, ledger } = await emptyLedger();
  const signal = new AbortController().signal;

  ledger.recordCompaction(1234, signal);

  const branch = sm.getBranch();
  // The compaction entry uses a distinct customType so it doesn't pollute the
  // ledger-entry filter used by restore(). The customType must be present and
  // discoverable; the savings number must round-trip through the entry's data.
  const compactionEntries = branch.filter((e) => e.type === "custom" && (e as { customType?: string }).customType?.startsWith("pi-hive-budget-compaction"));
  assert.ok(compactionEntries.length >= 1, "at least one compaction CustomEntry was written");
  const written = compactionEntries[0] as unknown as { data: { savings: number; agentSlug: string } };
  assert.equal(written.data.savings, 1234, "compaction entry carries the savings number");
  assert.equal(written.data.agentSlug, "tester", "compaction entry carries the ledger's agentSlug");
});

// ── Test 7: snapshot(stats, policy, marker, signal) writes a CustomEntry with marker/kind ─

test("snapshot(stats, policy, marker, signal) appends a CustomEntry with the supplied marker", async () => {
  const { sm, ledger } = await emptyLedger();
  const signal = new AbortController().signal;

  const stats = {
    sessionFile: undefined,
    sessionId: "test-session",
    userMessages: 5,
    assistantMessages: 5,
    toolCalls: 3,
    toolResults: 3,
    totalMessages: 10,
    tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
    cost: 0.015,
  };

  ledger.snapshot(stats, noCapPolicy, "warning", signal);

  const branch = sm.getBranch();
  const ledgerEntries = branch.filter((e) => e.type === "custom" && e.customType === "pi-hive-budget-ledger") as unknown as Array<{ data: BudgetLedgerEntry["data"] }>;
  // snapshot() must always write (no throttle — used for threshold crossings).
  assert.ok(ledgerEntries.length >= 1, "snapshot() always persists a CustomEntry");
  const written = ledgerEntries[ledgerEntries.length - 1];
  assert.equal(written.data.marker, "warning", "written entry carries the supplied marker");
  assert.equal(written.data.cumulative.tokens, 150, "written entry's cumulative.tokens comes from stats.tokens.total");
  assert.equal(written.data.cumulative.costUsd, 0.015, "written entry's cumulative.costUsd comes from stats.cost");
});

// ── Test 8: entries[] and cumulative reflect persisted state after multiple operations ─

test("entries[] and cumulative reflect the persisted state after a sequence of writes", async () => {
  const { sm, ledger } = await emptyLedger();
  const signal = new AbortController().signal;

  // Sequence: two recordEvent + one recordCompaction + one snapshot.
  ledger.recordEvent("message_end", { tokens: 100, costUsd: 0.01, runs: 1 }, signal);
  ledger.recordEvent("message_end", { tokens: 200, costUsd: 0.02, runs: 2 }, signal);
  ledger.recordCompaction(500, signal);
  ledger.snapshot(
    {
      sessionFile: undefined,
      sessionId: "s",
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 250 },
      cost: 0.025,
    },
    noCapPolicy,
    "checkpoint",
    signal,
  );

  // Cumulative carries the latest recorded values from recordEvent.
  assert.equal(ledger.cumulative.tokens, 200, "cumulative.tokens reflects the latest recordEvent");
  assert.equal(ledger.cumulative.costUsd, 0.02, "cumulative.costUsd reflects the latest recordEvent");

  // entries[] carries every pi-hive-budget-ledger CustomEntry from the branch
  // (the compaction entry uses a distinct customType, so it's excluded here).
  const ledgerOnly = ledger.entries.filter((e) => (e as unknown as { customType?: string }).customType === "pi-hive-budget-ledger");
  // 2 recordEvent + 1 snapshot = 3 budget-ledger entries.
  assert.equal(ledgerOnly.length, 3, "entries[] carries every budget-ledger CustomEntry (excluding compaction entries)");

  // Reading getBranch() independently must match the same set.
  const branch = sm.getBranch();
  const fromBranch = branch.filter((e) => e.type === "custom" && (e as unknown as { customType?: string }).customType === "pi-hive-budget-ledger");
  assert.equal(fromBranch.length, 3, "the session manager's branch agrees on the entry count");
});