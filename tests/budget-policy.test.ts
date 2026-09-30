// Wave 1 F1 T1.3 — BudgetPolicy pure functions
//
// 11 tests total: 6 main behaviors + 4 edge cases + 1 G-29 type-mismatch.
// Tests verify the public surface through real SessionManager / AgentSession
// state (where applicable). The functions are pure (no I/O of their own; they
// only read session state), so the seam is "given a session, what does the
// function compute?"

import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  checkBudgetPolicy,
  workerConsumedTokens,
  workerConsumedCost,
  teamUsage,
  ratioRemaining,
  crossedThreshold,
} from "../src/engine/budget/policy.ts";
import { BudgetLedger } from "../src/engine/budget/ledger.ts";
import type { BudgetLedgerEntry, WorkerBudgetPolicy } from "../src/core/types.ts";

const noCapPolicy: WorkerBudgetPolicy = { worker: {}, team: {} };

async function ledgerWith(
  entries: Array<Partial<BudgetLedgerEntry["data"]> & { cumulative: { tokens: number; costUsd: number; runs: number } }>,
): Promise<{ sm: SessionManager; ledger: BudgetLedger; signal: AbortSignal }> {
  const sm = SessionManager.inMemory("/tmp");
  for (const entry of entries) {
    sm.appendCustomEntry("pi-hive-budget-ledger", {
      caps: entry.caps ?? {},
      cumulative: entry.cumulative,
      writtenAt: entry.writtenAt ?? Date.now(),
      agentSlug: entry.agentSlug ?? "agent",
      marker: entry.marker,
      kind: entry.kind,
    });
  }
  const signal = new AbortController().signal;
  const ledger = await BudgetLedger.restore(sm, "agent", noCapPolicy, signal);
  return { sm, ledger, signal };
}

function fakeSession(stats: {
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost?: number;
}): AgentSession {
  const tokens = stats.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const cost = stats.cost ?? 0;
  return {
    getSessionStats: () => ({
      sessionFile: undefined,
      sessionId: "test",
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 0,
      tokens,
      cost,
    }),
  } as unknown as AgentSession;
}

// ── Test 1: checkBudgetPolicy (worker + team scopes, both exhausted + under-cap) ─

test("checkBudgetPolicy returns the first violated cap (worker tokens, team costUsd, or undefined when under cap)", async () => {
  // Worker tokens exceeded.
  {
    const { sm, ledger } = await ledgerWith([{ cumulative: { tokens: 1500, costUsd: 0.15, runs: 1 } }]);
    const policy: WorkerBudgetPolicy = {
      worker: { tokens: { cap: 1000, window: "per-session", include: ["input", "output"] } },
      team: {},
    };
    const block = checkBudgetPolicy(ledger, policy, sm.getBranch());
    assert.ok(block !== undefined, "expected a BudgetBlock");
    assert.equal(block!.scope, "worker", "block scope must be 'worker'");
    assert.equal(block!.resource, "tokens", "block resource must be 'tokens'");
    assert.equal(block!.limit.tokens, 1000, "block carries the violated cap");
    assert.equal(block!.remaining.tokens, 0, "remaining.tokens is zero when cumulative >= cap");
  }

  // Team cost exceeded.
  {
    const { sm, ledger } = await ledgerWith([{ cumulative: { tokens: 100, costUsd: 6.0, runs: 1 } }]);
    const policy: WorkerBudgetPolicy = {
      worker: {},
      team: { costUsd: { cap: 5, window: "per-team-lifetime" } },
    };
    const block = checkBudgetPolicy(ledger, policy, sm.getBranch());
    assert.ok(block !== undefined, "expected a BudgetBlock for team cost");
    assert.equal(block!.scope, "team", "block scope must be 'team'");
    assert.equal(block!.resource, "costUsd", "block resource must be 'costUsd'");
    assert.equal(block!.limit.costUsd, 5, "block carries the violated team cap");
  }

  // Under every cap.
  {
    const { sm, ledger } = await ledgerWith([{ cumulative: { tokens: 500, costUsd: 0.5, runs: 1 } }]);
    const policy: WorkerBudgetPolicy = {
      worker: {
        tokens: { cap: 1000, window: "per-session", include: ["input", "output"] },
        costUsd: { cap: 1, window: "per-session" },
        runs: { cap: 5 },
      },
      team: {
        tokens: { cap: 10000, window: "per-team-lifetime" },
        costUsd: { cap: 10, window: "per-team-lifetime" },
        runs: { cap: 50 },
      },
    };
    assert.equal(checkBudgetPolicy(ledger, policy, sm.getBranch()), undefined, "under every cap → no BudgetBlock");
  }
});

// ── Test 2: workerConsumedTokens returns session.getSessionStats().tokens.total ─

test("workerConsumedTokens reads session.getSessionStats().tokens.total", () => {
  const session = fakeSession({ tokens: { input: 100, output: 50, cacheRead: 25, cacheWrite: 10, total: 185 } });
  // The include list is captured at the policy-resolution boundary, so the
  // pure function reads tokens.total from getSessionStats() regardless of the
  // passed scope (the §1.3 contract: single call to getSessionStats()).
  const consumed = workerConsumedTokens(session, ["input", "output", "cacheRead", "cacheWrite"]);
  assert.equal(consumed, 185, "returns the session's tokens.total");
});

// ── Test 3: workerConsumedCost returns session.getSessionStats().cost ──────

test("workerConsumedCost reads session.getSessionStats().cost", () => {
  const session = fakeSession({ cost: 1.23 });
  assert.equal(workerConsumedCost(session), 1.23, "returns the session's lifetime cost");
});

// ── Test 4: teamUsage walks the branch and sums latest per agentSlug ───────

test("teamUsage walks the active branch and sums the LATEST CustomEntry per agentSlug", () => {
  const branch: SessionEntry[] = [
    { type: "custom", customType: "pi-hive-budget-ledger", id: "1", parentId: null, timestamp: "t1",
      data: { cumulative: { tokens: 100, costUsd: 0.01, runs: 1 }, caps: {}, writtenAt: 1, agentSlug: "coder" } },
    { type: "custom", customType: "pi-hive-budget-ledger", id: "2", parentId: "1", timestamp: "t2",
      data: { cumulative: { tokens: 200, costUsd: 0.02, runs: 2 }, caps: {}, writtenAt: 2, agentSlug: "coder" } },
    { type: "custom", customType: "pi-hive-budget-ledger", id: "3", parentId: "2", timestamp: "t3",
      data: { cumulative: { tokens: 300, costUsd: 0.03, runs: 3 }, caps: {}, writtenAt: 3, agentSlug: "tester" } },
    // Non-ledger entry must be ignored.
    { type: "custom", customType: "unrelated", id: "4", parentId: "3", timestamp: "t4", data: { cumulative: { tokens: 999, costUsd: 99, runs: 99 } } } as unknown as SessionEntry,
  ];

  const usage = teamUsage(branch);
  // Latest per agentSlug:
  //   coder:  200 tokens, 0.02 cost, 2 runs
  //   tester: 300 tokens, 0.03 cost, 3 runs
  // Total: 500 tokens, 0.05 cost, 5 runs
  assert.equal(usage.tokens, 500, "teamUsage sums latest tokens across all worker slugs");
  assert.equal(usage.costUsd, 0.05, "teamUsage sums latest costUsd across all worker slugs");
  assert.equal(usage.runs, 5, "teamUsage sums latest runs across all worker slugs");
});

// ── Test 5: ratioRemaining returns used/cap (and 0 when cap is 0) ──────────

test("ratioRemaining returns used/cap (and 0 when cap is 0 to avoid divide-by-zero)", () => {
  assert.equal(ratioRemaining(50, 100), 0.5, "50/100 = 0.5");
  assert.equal(ratioRemaining(150, 100), 1.5, "150/100 = 1.5 (over-budget)");
  assert.equal(ratioRemaining(0, 100), 0, "0/100 = 0");
  assert.equal(ratioRemaining(100, 0), 0, "any used over cap=0 yields ratio 0 (avoids Infinity)");
});

// ── Test 6: crossedThreshold returns true when remaining <= threshold * cap ─

test("crossedThreshold returns true when the remaining-ratio has crossed below the threshold-ratio", () => {
  // The 2-arg signature takes a pre-computed remaining ratio (returned by
  // ratioRemaining(used, cap)) and a threshold ratio (e.g., 0.20 for "20%
  // remaining" warning). The function is `remainingRatio <= thresholdRatio`.
  assert.equal(crossedThreshold(0.10, 0.20), true, "remaining 10% with 20% threshold has crossed");
  assert.equal(crossedThreshold(0.25, 0.20), false, "remaining 25% with 20% threshold has NOT crossed");
  // Edge: remaining equals threshold exactly → crossed (per "<=").
  assert.equal(crossedThreshold(0.20, 0.20), true, "remaining exactly at the threshold counts as crossed");
  // Edge: remaining zero → always crossed.
  assert.equal(crossedThreshold(0, 0.20), true, "remaining 0 with any threshold has crossed");
});

// ── Test 7: edge case — zero-cap divide-by-zero on ratioRemaining ───────────

test("ratioRemaining returns 0 for cap=0 even with non-zero used (configuration-time guard)", () => {
  assert.equal(ratioRemaining(50, 0), 0, "50/0 → 0 (avoids NaN/Infinity at config load)");
  assert.equal(ratioRemaining(0, 0), 0, "0/0 → 0 (avoids NaN)");
});

// ── Test 8: edge case — undefined-cap tier is skipped by checkBudgetPolicy ──

test("checkBudgetPolicy skips worker / team blocks whose cap is undefined (omitted tier = unlimited)", async () => {
  const { ledger } = await ledgerWith([
    { cumulative: { tokens: 99999, costUsd: 99999, runs: 99999 } },
  ]);
  const policy: WorkerBudgetPolicy = {
    worker: {}, // no caps at all — unlimited
    team: {},
  };
  assert.equal(checkBudgetPolicy(ledger, policy, []), undefined, "no caps configured → no block");
});

// ── Test 9: edge case — checkBudgetPolicy returns the FIRST violated cap ───

test("checkBudgetPolicy returns the first violated cap (worker-tokens checked before team-costUsd)", async () => {
  const { ledger } = await ledgerWith([
    { cumulative: { tokens: 1500, costUsd: 99, runs: 99 } },
  ]);
  const policy: WorkerBudgetPolicy = {
    worker: { tokens: { cap: 1000, window: "per-session", include: ["input", "output"] } },
    team: { costUsd: { cap: 50, window: "per-team-lifetime" } },
  };
  const block = checkBudgetPolicy(ledger, policy, []);
  assert.ok(block !== undefined);
  assert.equal(block!.scope, "worker", "worker-tokens is checked first");
  assert.equal(block!.resource, "tokens", "worker-tokens is checked first");
});

// ── Test 10: edge case — mixed worker/team ledger entries handled by teamUsage ─

test("teamUsage handles a mixed worker/team ledger (latest per slug aggregates correctly)", () => {
  // Two workers, each with two consecutive ledger entries. Latest per slug
  // wins (root-to-leaf order), so the second entry's cumulative is the one
  // summed.
  const branch: SessionEntry[] = [
    { type: "custom", customType: "pi-hive-budget-ledger", id: "1", parentId: null, timestamp: "t1",
      data: { cumulative: { tokens: 100, costUsd: 0.01, runs: 1 }, caps: {}, writtenAt: 1, agentSlug: "coder" } },
    { type: "custom", customType: "pi-hive-budget-ledger", id: "2", parentId: "1", timestamp: "t2",
      data: { cumulative: { tokens: 200, costUsd: 0.02, runs: 2 }, caps: {}, writtenAt: 2, agentSlug: "tester" } },
    { type: "custom", customType: "pi-hive-budget-ledger", id: "3", parentId: "2", timestamp: "t3",
      data: { cumulative: { tokens: 250, costUsd: 0.025, runs: 3 }, caps: {}, writtenAt: 3, agentSlug: "coder" } },
  ];
  const usage = teamUsage(branch);
  // Latest coder entry: 250 tokens, 0.025 cost, 3 runs.
  // Latest tester entry: 200 tokens, 0.02 cost, 2 runs.
  assert.equal(usage.tokens, 450, "is: latest coder (250) + latest tester (200)");
  assert.equal(usage.costUsd, 0.045, "is: latest coder (0.025) + latest tester (0.02)");
  assert.equal(usage.runs, 5, "is: latest coder (3) + latest tester (2)");
});

// ── Test 11: G-29 — type-mismatch surfaces as TypeError at the boundary ─────

test("G-29: checkBudgetPolicy raises TypeError on a structurally-malformed policy (missing worker)", async () => {
  // The typebox schema boundary (§2.13 / C4) discriminates BudgetBlock by
  // scope. A misuse (passing a policy that lacks the required `worker`
  // block — e.g., a JSON-decoded config from disk that bypassed TypeScript's
  // structural check) must surface as a TypeError so the dispatcher refuses
  // with a structured error and the dashboard renders a clean refusal.
  const { ledger } = await ledgerWith([
    { cumulative: { tokens: 500, costUsd: 0.5, runs: 1 } },
  ]);
  // Bypass the static type to simulate a malformed runtime payload.
  const malformedPolicy = { team: {} } as unknown as WorkerBudgetPolicy;
  assert.throws(
    () => checkBudgetPolicy(ledger, malformedPolicy, []),
    TypeError,
    "missing-worker policy must raise TypeError at the typebox boundary",
  );
});