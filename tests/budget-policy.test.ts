/**
 * Wave 1 — T1.3 BudgetPolicy pure function tests.
 *
 * Eleven tests covering:
 *   1. checkBudgetPolicy returns undefined when under all caps
 *   2. checkBudgetPolicy blocks on worker tokens
 *   3. checkBudgetPolicy blocks on worker costUsd
 *   4. checkBudgetPolicy blocks on worker runs
 *   5. checkBudgetPolicy blocks on team tokens
 *   6. checkBudgetPolicy blocks on team costUsd
 *   7. workerConsumedTokens sums the LATEST per-worker cumulative
 *   8. workerConsumedCost sums the LATEST per-worker cumulative
 *   9. teamUsage sums the LATEST per-worker cumulative across the team
 *  10. ratioRemaining clamps to [0,1] and treats no-cap as fully exhausted
 *  11. crossedThreshold returns true at-or-below threshold, false above
 *  12. G-29 type-mismatch test: passing a ResolvedTeamBudgets raises TypeError
 *
 * Plus indexLedgerByAgent (exported for reuse) gets a coverage test in
 * `tests/budget-policy-index.test.ts` — kept in this file so the 11-test
 * gate from the plan is met without splitting policy tests across files.
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
  checkBudgetPolicy,
  crossedThreshold,
  indexLedgerByAgent,
  ratioRemaining,
  teamUsage,
  workerConsumedCost,
  workerConsumedTokens,
} from "../src/engine/budget/policy.ts";
import type {
  BudgetLedgerData,
  BudgetLedgerEntry,
  WorkerBudgetPolicy,
} from "../src/engine/budget/types.ts";

function makePolicy(overrides: Partial<WorkerBudgetPolicy> = {}): WorkerBudgetPolicy {
  return {
    worker: {
      tokens: { resource: "tokens", cap: 100_000 },
      costUsd: { resource: "costUsd", cap: 5 },
      runs: { resource: "runs", cap: 3 },
      depth: { resource: "depth", cap: 2 },
    },
    team: {
      tokens: { resource: "tokens", cap: 500_000 },
      costUsd: { resource: "costUsd", cap: 50 },
      runs: { resource: "runs", cap: 20 },
    },
    ...overrides,
  };
}

function makeStats(tokens: number, cost: number): SessionStats {
  return {
    sessionFile: undefined,
    sessionId: "policy-test",
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

/**
 * Build a ledger whose cumulative matches `cumulative` by recording a final
 * `snapshot` after restore — matches what the event-hook handler will do at
 * `agent_settled` time. `runs` is NOT carried through `snapshot` (snapshot
 * reads `stats.cost` / `stats.tokens.total` but preserves the in-memory
 * `runs` counter); we set it via `recordEvent` so the ledger reflects the
 * supplied value.
 */
async function ledgerWith(cumulative: { tokens: number; costUsd: number; runs: number }, policy: WorkerBudgetPolicy): Promise<BudgetLedger> {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-budget-policy-"));
  const sm = SessionManager.inMemory(cwd);
  const ledger = await BudgetLedger.restore(sm, "worker", policy);
  ledger.recordEvent("message_end", cumulative);
  ledger.snapshot(makeStats(cumulative.tokens, cumulative.costUsd), policy, "checkpoint");
  return ledger;
}

/** Seed a branch with explicit ledger entries (raw, no ledger class). */
function seedBranch(entries: BudgetLedgerData[]): { sm: SessionManager; branch: import("@earendil-works/pi-coding-agent").SessionEntry[] } {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-budget-policy-"));
  const sm = SessionManager.inMemory(cwd);
  for (const data of entries) {
    sm.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, data);
  }
  return { sm, branch: sm.getBranch() };
}

// ── Case 1: under all caps → undefined ─────────────────────────────────

test("checkBudgetPolicy: returns undefined when under every worker and team cap", async () => {
  const policy = makePolicy();
  const ledger = await ledgerWith({ tokens: 50_000, costUsd: 2.5, runs: 2 }, policy);
  // The ledger.snapshot above wrote the worker's own entry; team = that
  // single worker = under all caps too.
  assert.equal(
    checkBudgetPolicy(ledger, policy, (ledger as unknown as { sessionManager: SessionManager }).sessionManager.getBranch()),
    undefined,
  );
});

// ── Case 2: blocks on worker tokens ────────────────────────────────────

test("checkBudgetPolicy: blocks on worker token cap and returns a worker/tokens BudgetBlock", async () => {
  const policy = makePolicy({
    worker: { tokens: { resource: "tokens", cap: 100 } },
  });
  const ledger = await ledgerWith({ tokens: 100, costUsd: 0, runs: 0 }, policy);
  const block = checkBudgetPolicy(ledger, policy, (ledger as unknown as { sessionManager: SessionManager }).sessionManager.getBranch());
  assert.ok(block, "must block");
  assert.equal(block.scope, "worker");
  assert.equal(block.resource, "tokens");
  assert.equal(block.remaining.tokens, 0);
  assert.equal(block.limit.tokens, 100);
  assert.match(block.reason, /token budget exhausted/);
});

// ── Case 3: blocks on worker costUsd ───────────────────────────────────

test("checkBudgetPolicy: blocks on worker costUsd cap", async () => {
  const policy = makePolicy({
    worker: { costUsd: { resource: "costUsd", cap: 0.5 } },
  });
  const ledger = await ledgerWith({ tokens: 0, costUsd: 0.5, runs: 0 }, policy);
  const block = checkBudgetPolicy(ledger, policy, (ledger as unknown as { sessionManager: SessionManager }).sessionManager.getBranch());
  assert.ok(block);
  assert.equal(block.scope, "worker");
  assert.equal(block.resource, "costUsd");
  assert.equal(block.remaining.costUsd, 0);
  assert.equal(block.limit.costUsd, 0.5);
});

// ── Case 4: blocks on worker runs ──────────────────────────────────────

test("checkBudgetPolicy: blocks on worker runs cap", async () => {
  const policy = makePolicy({
    worker: { runs: { resource: "runs", cap: 2 } },
  });
  const ledger = await ledgerWith({ tokens: 0, costUsd: 0, runs: 2 }, policy);
  const block = checkBudgetPolicy(ledger, policy, (ledger as unknown as { sessionManager: SessionManager }).sessionManager.getBranch());
  assert.ok(block);
  assert.equal(block.scope, "worker");
  assert.equal(block.resource, "runs");
});

// ── Case 5: blocks on team tokens (worker under cap) ────────────────────

test("checkBudgetPolicy: blocks on team token cap when the worker is under cap", async () => {
  // Worker cap is generous; team cap is tight. Worker holds the team ledger.
  const policy = makePolicy({
    worker: { tokens: { resource: "tokens", cap: 100_000 } },
    team: { tokens: { resource: "tokens", cap: 50_000 } },
  });
  const ledger = await ledgerWith({ tokens: 60_000, costUsd: 0, runs: 0 }, policy);
  const block = checkBudgetPolicy(ledger, policy, (ledger as unknown as { sessionManager: SessionManager }).sessionManager.getBranch());
  assert.ok(block);
  assert.equal(block.scope, "team");
  assert.equal(block.resource, "tokens");
});

// ── Case 6: blocks on team costUsd ─────────────────────────────────────

test("checkBudgetPolicy: blocks on team costUsd cap", async () => {
  const policy = makePolicy({
    worker: { costUsd: { resource: "costUsd", cap: 100 } },
    team: { costUsd: { resource: "costUsd", cap: 1 } },
  });
  // Spend $1.20 — well over the team cap of $1, but well under the worker cap.
  const ledger = await ledgerWith({ tokens: 0, costUsd: 1.2, runs: 0 }, policy);
  const block = checkBudgetPolicy(ledger, policy, (ledger as unknown as { sessionManager: SessionManager }).sessionManager.getBranch());
  assert.ok(block);
  assert.equal(block.scope, "team");
  assert.equal(block.resource, "costUsd");
});

// ── Case 7: workerConsumedTokens reads the latest cumulative ────────────

test("workerConsumedTokens: returns the latest cumulative tokens, ignoring older entries", () => {
  const { branch } = seedBranch([
    { caps: {}, cumulative: { tokens: 100, costUsd: 0.01, runs: 1 }, writtenAt: 1, agentSlug: "worker" },
    { caps: {}, cumulative: { tokens: 250, costUsd: 0.025, runs: 1 }, writtenAt: 2, agentSlug: "worker" },
    { caps: {}, cumulative: { tokens: 500, costUsd: 0.05, runs: 2 }, writtenAt: 3, agentSlug: "worker" },
  ]);
  // Single-worker branch: the LATEST entry's tokens are the worker total.
  // Older entries are NOT summed (they'd double-count).
  assert.equal(workerConsumedTokens(branch), 500);
});

// ── Case 8: workerConsumedCost reads the latest cumulative ─────────────

test("workerConsumedCost: returns the latest cumulative costUsd", () => {
  const { branch } = seedBranch([
    { caps: {}, cumulative: { tokens: 100, costUsd: 0.01, runs: 1 }, writtenAt: 1, agentSlug: "worker" },
    { caps: {}, cumulative: { tokens: 250, costUsd: 0.05, runs: 1 }, writtenAt: 2, agentSlug: "worker" },
  ]);
  assert.equal(workerConsumedCost(branch), 0.05);
});

// ── Case 9: teamUsage sums the LATEST per worker ───────────────────────

test("teamUsage: sums the LATEST cumulative per distinct agentSlug (no double-count across older checkpoints)", () => {
  // Two workers in the same branch. Each has multiple ledger entries; teamUsage
  // takes only the latest from each worker to avoid double-counting.
  const { branch } = seedBranch([
    { caps: {}, cumulative: { tokens: 100, costUsd: 0.01, runs: 1 }, writtenAt: 1, agentSlug: "alpha" },
    { caps: {}, cumulative: { tokens: 50, costUsd: 0.005, runs: 1 }, writtenAt: 2, agentSlug: "beta" },
    { caps: {}, cumulative: { tokens: 400, costUsd: 0.04, runs: 2 }, writtenAt: 3, agentSlug: "alpha" },
    { caps: {}, cumulative: { tokens: 75, costUsd: 0.0075, runs: 2 }, writtenAt: 4, agentSlug: "beta" },
  ]);
  const team = teamUsage(branch);
  // alpha latest = 400, beta latest = 75; team total = 475 tokens.
  // If older entries (100 + 50) had been summed in, we'd get 625.
  assert.equal(team.tokens, 475);
  assert.equal(team.costUsd, 0.0475);
  assert.equal(team.runs, 4);
});

// ── Case 10: ratioRemaining ────────────────────────────────────────────

test("ratioRemaining: returns 0 when no cap is set, 0 at exhaustion, 1 when nothing spent, intermediate otherwise", () => {
  // No cap → 0 (treat unbounded as fully exhausted for warning purposes).
  assert.equal(ratioRemaining(0, undefined), 0);
  assert.equal(ratioRemaining(100, undefined), 0);

  // Cap = 0 is meaningless — treat as exhausted.
  assert.equal(ratioRemaining(0, 0), 0);

  // Nothing spent → ratio = 1 (full headroom remaining).
  assert.equal(ratioRemaining(0, 100), 1);

  // Exactly at cap → ratio = 0.
  assert.equal(ratioRemaining(100, 100), 0);

  // Half spent → ratio = 0.5.
  assert.equal(ratioRemaining(50, 100), 0.5);

  // Over cap (defensive) → clamped to 0.
  assert.equal(ratioRemaining(150, 100), 0);

  // Negative consumed (defensive) → clamped to 1.
  assert.equal(ratioRemaining(-10, 100), 1);
});

// ── Case 11: crossedThreshold ──────────────────────────────────────────

test("crossedThreshold: returns true at-or-below threshold, false above", () => {
  // 20% remaining is the warning threshold.
  assert.equal(crossedThreshold(0.20, 0.20), true);
  assert.equal(crossedThreshold(0.19, 0.20), true);
  assert.equal(crossedThreshold(0.0, 0.20), true);
  assert.equal(crossedThreshold(0.21, 0.20), false);

  // 0% remaining is the exhaustion threshold.
  assert.equal(crossedThreshold(0.0, 0.0), true);
  assert.equal(crossedThreshold(0.001, 0.0), false);
});

// ── Case 12 (G-29): type-mismatch raises TypeError ─────────────────────

test("G-29 checkBudgetPolicy: raises TypeError when `policy` is not a WorkerBudgetPolicy", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-budget-policy-"));
  const sm = SessionManager.inMemory(cwd);
  const ledger = await BudgetLedger.restore(sm, "worker", makePolicy());

  // `teamPolicy` looks like a ResolvedTeamBudgets — `{ tokens, costUsd, runs }`
  // without the `worker` / `team` wrappers that WorkerBudgetPolicy requires.
  // This is the shape a caller would accidentally pass if they confused the
  // two-tier abstraction. The runtime guard must reject it.
  const teamPolicy = {
    tokens: { resource: "tokens" as const, cap: 1_000 },
    costUsd: { resource: "costUsd" as const, cap: 1 },
    runs: { resource: "runs" as const, cap: 1 },
  };
  assert.throws(
    () => checkBudgetPolicy(ledger, teamPolicy as unknown as WorkerBudgetPolicy, sm.getBranch()),
    /TypeError/,
    "passing a ResolvedTeamBudgets where WorkerBudgetPolicy is expected must raise TypeError (G-29)",
  );
});

// ── Bonus: indexLedgerByAgent groups by agentSlug in branch order ───────

test("indexLedgerByAgent: groups branch entries by agentSlug in chronological order", () => {
  const { branch } = seedBranch([
    { caps: {}, cumulative: { tokens: 1, costUsd: 0, runs: 1 }, writtenAt: 1, agentSlug: "alpha" },
    { caps: {}, cumulative: { tokens: 2, costUsd: 0, runs: 1 }, writtenAt: 2, agentSlug: "beta" },
    { caps: {}, cumulative: { tokens: 3, costUsd: 0, runs: 1 }, writtenAt: 3, agentSlug: "alpha" },
  ]);
  const map = indexLedgerByAgent(branch);
  assert.deepEqual(
    [...map.keys()],
    ["alpha", "beta"],
    "preserve insertion order of first appearance",
  );
  assert.equal(map.get("alpha")!.length, 2);
  assert.equal(map.get("alpha")![0]!.cumulative.tokens, 1);
  assert.equal(map.get("alpha")![1]!.cumulative.tokens, 3);
  assert.equal(map.get("beta")!.length, 1);
});

// ── Bonus: ledger entries() round-trips a write ────────────────────────

test("BudgetLedger.entries: a snapshot write shows up in the branch the next restore reads", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-budget-policy-"));
  const sm = SessionManager.inMemory(cwd);
  const policy = makePolicy();
  const ledger = await BudgetLedger.restore(sm, "worker", policy);
  ledger.snapshot(makeStats(7_777, 0.5), policy, "checkpoint");

  const persisted = ledger.entries();
  assert.equal(persisted.length, 1);
  const entry: BudgetLedgerEntry = persisted[0]!;
  assert.equal(entry.data.cumulative.tokens, 7_777);
  assert.equal(entry.data.cumulative.costUsd, 0.5);
  assert.equal(entry.data.marker, "checkpoint");
  assert.equal(entry.data.kind, undefined);
});
