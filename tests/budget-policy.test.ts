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
import type { AgentSession, SessionEntry, SessionStats } from "@earendil-works/pi-coding-agent";
import {
  checkBudgetPolicy,
  workerConsumedTokens,
  workerConsumedCost,
  teamUsage,
  ratioRemaining,
  crossedThreshold,
  budgetRemaining,
  tokensForInclude,
} from "../src/engine/budget/policy.ts";
import { BudgetLedger } from "../src/engine/budget/ledger.ts";
import type { AgentRuntime, BudgetLedgerEntry, HiveState, WorkerBudgetPolicy } from "../src/core/types.ts";

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

// ── Test 12: budgetRemaining live-mirror semantics (Fix E) ────────────────
//
// Wave 6's Gap 3 (remaining.ts → policy.ts migration) changed budgetRemaining
// from "cumulative across runs" to "live mirror of the current session's
// lifetime tokens" — the runtime now holds session-lifetime aggregates
// (overwritten from getSessionStats at run end), and budgetRemaining reads
// those fields directly. These three tests pin the new semantics so a future
// regression to per-run accumulation is caught.

function runtimeFor(name: string, slug: string, counters: Partial<AgentRuntime>): AgentRuntime {
  return {
    config: { name, slug, role: "member" },
    systemPrompt: "",
    status: "idle",
    task: "",
    lastWork: "",
    toolCount: 0,
    elapsedMs: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, costUsd: 0, contextPct: 0,
    runCount: 0, sessionFile: `/tmp/${slug}.jsonl`,
    ...counters,
  } as AgentRuntime;
}

function stateFor(runtimes: AgentRuntime[], settings: Record<string, unknown>): HiveState {
  return {
    pi: {} as any,
    config: { settings } as any,
    session: null,
    runtimes: new Map(runtimes.map((r) => [r.config.slug!, r])),
    widgetCtx: null,
    activeRuns: 0,
    mode: "hive",
    normalToolNames: [],
    sddStatus: null,
    obsSeq: 0,
  } as unknown as HiveState;
}

test("budgetRemaining: single running session mirrors the live lifetime counters (scope=all)", () => {
  // After getSessionStats() overwrites the runtime, the lifetime counters
  // hold the session's running totals. budgetRemaining must read those
  // directly — no historical per-run accumulation.
  const worker = runtimeFor("Worker", "worker", {
    inputTokens: 700, outputTokens: 300, cacheReadTokens: 100, cacheWriteTokens: 50, reasoningTokens: 25,
    costUsd: 1.25, runCount: 1, distillerRunCount: 0,
  });
  const state = stateFor([worker], {
    workerBudgets: { tokenBudget: 2000, costBudgetUsd: 5, maxRuns: 10, distillerRuns: 5 },
    teamBudgets: { tokenBudget: 4000, costBudgetUsd: 10, maxRuns: 50 },
  });
  const { worker: rem, team } = budgetRemaining(state, worker);
  // scope=all: tokens = input + output + cacheRead + cacheWrite + reasoning = 1175.
  assert.equal(rem.tokens, 2000 - 1175, "remaining.tokens = cap - (input+output+cache*+reasoning)");
  assert.equal(rem.costUsd, 5 - 1.25, "remaining.costUsd = cap - costUsd");
  assert.equal(rem.runs, 10 - 1, "remaining.runs = cap - runCount");
  assert.equal(rem.distillerRuns, 5 - 0, "remaining.distillerRuns = cap - distillerRunCount");
  // Single-agent team total equals the worker total when team caps are set.
  assert.equal(team.tokens, 4000 - 1175, "single-agent team mirrors the worker total (team cap set)");
});

test("budgetRemaining: multiple completed runs reflect CURRENT session lifetime, not cumulative across runs", () => {
  // The brief's key regression pin: a worker that has run 3 times should NOT
  // show budgetRemaining = cap - 3×single_run_usage. The runtime holds the
  // session-lifetime totals from getSessionStats (per Wave 5A Decision 1),
  // so budgetRemaining reads the SAME values whether the worker ran once
  // or three times — as long as the current session's lifetime is the same.
  // (For a re-run agent, lifetime is session-cumulative via the SDK; the
  // per-run growth lives in delegation_end.delta, not on the runtime.)
  const worker = runtimeFor("Worker", "worker", {
    inputTokens: 900, outputTokens: 400, cacheReadTokens: 200, cacheWriteTokens: 100, reasoningTokens: 50,
    costUsd: 2.10, runCount: 3, // runCount=3 from prior runs, but the lifetime totals reflect the CURRENT session only
  });
  const state = stateFor([worker], {
    workerBudgets: { tokenBudget: 5000, costBudgetUsd: 10, maxRuns: 20, distillerRuns: 5, tokenBudgetScope: "all" },
  });
  const { worker: rem } = budgetRemaining(state, worker);
  // scope=all: tokens used = 900 + 400 + 200 + 100 + 50 = 1650 (the CURRENT session).
  // The pre-Wave-6 bug would have shown remaining = 5000 - 3*1650 = 50 (cumulative
  // across 3 runs). Post-Wave-6 semantics: remaining = 5000 - 1650 = 3350.
  assert.equal(rem.tokens, 5000 - 1650, "remaining is the CURRENT session's lifetime, not cumulative across runs");
  assert.equal(rem.costUsd, 10 - 2.10, "costUsd is the current session's lifetime, not cumulative");
  // runCount IS a counter that tracks total runs, so remaining.runs does subtract runCount.
  assert.equal(rem.runs, 20 - 3, "runCount tracks total runs across the lifetime; remaining reflects that");
});

test("budgetRemaining: agent with no session / no usage returns cap - 0 (the full budget remaining)", () => {
  // A runtime with all-zero counters and no prior history: remaining equals
  // the cap exactly. This is the steady-state "fresh agent, not yet started"
  // view used by the orchestrator prompt.
  const worker = runtimeFor("Worker", "worker", {});
  const state = stateFor([worker], {
    workerBudgets: { tokenBudget: 2000, costBudgetUsd: 5, maxRuns: 10, distillerRuns: 5 },
  });
  const { worker: rem } = budgetRemaining(state, worker);
  assert.equal(rem.tokens, 2000, "no usage → full token budget remaining");
  assert.equal(rem.costUsd, 5, "no usage → full cost budget remaining");
  assert.equal(rem.runs, 10, "no usage → full run budget remaining");
  assert.equal(rem.distillerRuns, 5, "no usage → full distiller-run budget remaining");
});

test("budgetRemaining: input_output scope ignores cache + reasoning tokens", () => {
  // The scope flag restricts which counter dimensions feed into the tokens
  // remaining calculation. input_output excludes cache and reasoning.
  const worker = runtimeFor("Worker", "worker", {
    inputTokens: 600, outputTokens: 200, cacheReadTokens: 999, cacheWriteTokens: 999, reasoningTokens: 999,
    costUsd: 1.0, runCount: 1,
  });
  const state = stateFor([worker], {
    workerBudgets: { tokenBudget: 1000, costBudgetUsd: 5, maxRuns: 10, distillerRuns: 5, tokenBudgetScope: "input_output" },
  });
  const { worker: rem } = budgetRemaining(state, worker);
  // scope=input_output: only input + output = 800 counts toward tokens used.
  assert.equal(rem.tokens, 1000 - 800, "input_output scope ignores cache and reasoning");
});

// =====================================================================
// Wave budget-include-filter — fix(budget): honor include list in pre-flight
// gate and tool-call handler. Tests cover the new `tokensForInclude` helper
// and the include-aware `checkBudgetPolicy` overload that takes a 4th
// `stats?: SessionStats` argument. The legacy 3-arg overload falls back to
// `ledger.cumulative.tokens` (the documented behavior at delegation-time
// pre-flight, where no AgentSession is open yet).
// =====================================================================

// Helper to build a SessionStats-shaped value with explicit per-dimension
// counts. Mirrors the SDK's contract: `total = input + output + cacheRead +
// cacheWrite` (reasoning is on the runtime, not stats).
function statsOf(input: number, output: number, cacheRead = 0, cacheWrite = 0) {
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

// ── T1: tokensForInclude helper sums the requested dimensions ──────────────

test("tokensForInclude: sums only the dimensions named in include", () => {
  const stats = {
    sessionFile: undefined as undefined,
    sessionId: "test",
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: statsOf(100, 50, 200_000, 80_000), // total = 280150
    cost: 1.0,
  };
  assert.equal(tokensForInclude(stats, ["input"]), 100, "include=[input] → 100");
  assert.equal(tokensForInclude(stats, ["output"]), 50, "include=[output] → 50");
  assert.equal(tokensForInclude(stats, ["input", "output"]), 150, "include=[input,output] → 150");
  assert.equal(tokensForInclude(stats, ["cacheRead"]), 200_000, "include=[cacheRead] → 200_000");
  assert.equal(tokensForInclude(stats, ["cacheWrite"]), 80_000, "include=[cacheWrite] → 80_000");
  assert.equal(
    tokensForInclude(stats, ["input", "output", "cacheRead", "cacheWrite"]),
    280150,
    "include=all-four → 280150",
  );
});

test("tokensForInclude: empty / undefined include list falls back to input + output (the policy.ts §2.13 default)", () => {
  const stats = {
    sessionFile: undefined as undefined,
    sessionId: "test",
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: statsOf(100, 50, 999_999, 888_888), // total includes lots of cache
    cost: 1.0,
  };
  // Empty include list → default to input + output (per the helper's
  // documented behavior; matches the policy's include default).
  assert.equal(tokensForInclude(stats, []), 150, "include=[] defaults to [input,output] → 150");
});

// ── T2: checkBudgetPolicy 4-arg overload — include filter on worker tokens ─

test("checkBudgetPolicy 4-arg overload: include=[input,output] ignores cacheRead/write when stats supplied", async () => {
  // The user's 350,000-token scenario: a session that has burned huge cache hits
  // but only ~10K of input+output. With cap=20K and include=[input,output],
  // the gate MUST NOT fire even though stats.tokens.total is 350K.
  const { sm, ledger } = await ledgerWith([
    // The ledger's cumulative.tokens reflects the prior cumulative. We don't
    // pass it to the gate here — the 4-arg overload uses stats instead.
    { cumulative: { tokens: 350_000, costUsd: 5.0, runs: 5 } },
  ]);
  const policy: WorkerBudgetPolicy = {
    worker: { tokens: { cap: 20_000, window: "per-session", include: ["input", "output"] } },
    team: {},
  };
  const branch = sm.getBranch();
  // Session has 10K input + 5K output = 15K; cacheRead=200K; cacheWrite=135K
  // (total = 350K). include=[input,output] → 15K. 15K < 20K → no block.
  const stats = {
    sessionFile: undefined as undefined,
    sessionId: "user-scenario",
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: statsOf(10_000, 5_000, 200_000, 135_000),
    cost: 5.0,
  } as const;
  const block = checkBudgetPolicy(ledger, policy, branch, stats as unknown as SessionStats);
  assert.equal(block, undefined, "include=[input,output] gate lets through when cache is huge but input+output is under cap (the user's bug)");
});

test("checkBudgetPolicy 4-arg overload: include=[input,output] fires when input+output exceeds cap (cache alone doesn't push it over)", async () => {
  const { sm, ledger } = await ledgerWith([
    { cumulative: { tokens: 100, costUsd: 1, runs: 1 } },
  ]);
  const policy: WorkerBudgetPolicy = {
    worker: { tokens: { cap: 20_000, window: "per-session", include: ["input", "output"] } },
    team: {},
  };
  const branch = sm.getBranch();
  // input+output = 25K > cap=20K. The cache dimension contributes 1M but
  // is excluded by include. Gate MUST fire on the include-scoped sum.
  const stats = {
    sessionFile: undefined as undefined,
    sessionId: "x",
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: statsOf(15_000, 10_000, 1_000_000, 500_000), // total = 1.5M
    cost: 1.0,
  } as const;
  const block = checkBudgetPolicy(ledger, policy, branch, stats as unknown as SessionStats);
  assert.ok(block !== undefined, "gate fires when include-scoped sum exceeds cap");
  assert.equal(block!.scope, "worker");
  assert.equal(block!.resource, "tokens");
  assert.equal(block!.limit.tokens, 20_000);
  // The reason string reflects the include-scoped count, not the total.
  assert.match(block!.reason, /Worker token budget exhausted: 25000\/20000/, "reason shows include-scoped usage (25K), not the total (1.5M)");
});

test("checkBudgetPolicy 4-arg overload: include=all-four sums every dimension (matches the pre-fix behavior)", async () => {
  const { sm, ledger } = await ledgerWith([
    { cumulative: { tokens: 100, costUsd: 1, runs: 1 } },
  ]);
  const policy: WorkerBudgetPolicy = {
    worker: { tokens: { cap: 1000, window: "per-session", include: ["input", "output", "cacheRead", "cacheWrite"] } },
    team: {},
  };
  const branch = sm.getBranch();
  const stats = {
    sessionFile: undefined as undefined,
    sessionId: "x",
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: statsOf(200, 300, 400, 500), // total = 1400
    cost: 1.0,
  } as const;
  const block = checkBudgetPolicy(ledger, policy, branch, stats as unknown as SessionStats);
  assert.ok(block !== undefined, "include=all-four fires when total = 1400 > cap = 1000");
  assert.equal(block!.limit.tokens, 1000);
});

test("checkBudgetPolicy 4-arg overload: include=undefined defaults to input+output (per policy.ts §2.13/C2)", async () => {
  // The policy's tokens.include is optional; when omitted, the gate defaults
  // to ["input", "output"] — matching the policy resolver's documented
  // default. Verify the default flow lets a large cache-only session through.
  const { sm, ledger } = await ledgerWith([
    { cumulative: { tokens: 100, costUsd: 1, runs: 1 } },
  ]);
  const policy: WorkerBudgetPolicy = {
    worker: { tokens: { cap: 20_000, window: "per-session" } }, // no include
    team: {},
  };
  const branch = sm.getBranch();
  const stats = {
    sessionFile: undefined as undefined,
    sessionId: "x",
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: statsOf(5_000, 1_000, 800_000, 100_000), // total = 906K, but input+output = 6K
    cost: 1.0,
  } as const;
  const block = checkBudgetPolicy(ledger, policy, branch, stats as unknown as SessionStats);
  assert.equal(block, undefined, "include=undefined → default [input,output] → 6K < 20K → no block");
});

test("checkBudgetPolicy 4-arg overload: include includes reasoning → reasoning contributes 0 (limitation: not on SessionStats)", async () => {
  // Documented limitation: reasoning tokens are on the runtime, not on
  // SessionStats. The helper accepts reasoning in the include list for
  // future-proofing, but cannot sum it from stats alone. This test pins
  // the current behavior (other dimensions still summed correctly) so a
  // future fix that wires reasoning through is caught by the diff.
  const { sm, ledger } = await ledgerWith([
    { cumulative: { tokens: 100, costUsd: 1, runs: 1 } },
  ]);
  const policy: WorkerBudgetPolicy = {
    worker: { tokens: { cap: 1000, window: "per-session", include: ["input", "output", "cacheRead", "cacheWrite", "reasoning"] } },
    team: {},
  };
  const branch = sm.getBranch();
  // input+output+cacheRead+cacheWrite = 800; reasoning contributes 0.
  const stats = {
    sessionFile: undefined as undefined,
    sessionId: "x",
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: statsOf(200, 200, 200, 200), // total = 800 (reasoning is on runtime)
    cost: 0,
  } as const;
  const block = checkBudgetPolicy(ledger, policy, branch, stats as unknown as SessionStats);
  assert.equal(block, undefined, "include with reasoning still gates on the 4 stats-tracked dimensions (sum=800 < cap=1000)");
  // Bump input+output to push over cap and confirm the gate fires despite
  // the reasoning contribution being 0.
  const statsOver = {
    sessionFile: undefined as undefined,
    sessionId: "x",
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: statsOf(600, 600, 200, 200), // total = 1600
    cost: 0,
  } as const;
  const blockOver = checkBudgetPolicy(ledger, policy, branch, statsOver as unknown as SessionStats);
  assert.ok(blockOver !== undefined, "gate fires when stats-tracked dimensions exceed cap");
  assert.equal(blockOver!.limit.tokens, 1000);
});

// ── T3: legacy 3-arg overload falls back to ledger.cumulative.tokens ─────

test("checkBudgetPolicy 3-arg overload (no stats): falls back to ledger.cumulative.tokens (legacy behavior)", async () => {
  // The legacy call site (worker-tools.ts:278 pre-flight) does not pass
  // stats because no session is open at delegation start. It uses the
  // ledger's cumulative.tokens as the comparison value. This is the
  // documented fallback — pin it so a future refactor doesn't silently
  // change the comparison semantics at the call site.
  const { sm, ledger } = await ledgerWith([
    { cumulative: { tokens: 5000, costUsd: 1, runs: 1 } }, // cumulative.tokens = 5000
  ]);
  const policy: WorkerBudgetPolicy = {
    worker: { tokens: { cap: 1000, window: "per-session", include: ["input", "output"] } },
    team: {},
  };
  const branch = sm.getBranch();
  // No stats passed → legacy fallback. cumulative.tokens (5000) > cap (1000)
  // → gate fires even though the include-scoped sum might be different.
  const block = checkBudgetPolicy(ledger, policy, branch);
  assert.ok(block !== undefined, "3-arg overload fires on cumulative.tokens when no stats supplied");
  assert.equal(block!.limit.tokens, 1000);
  // reason string shows the cumulative value, not the include-scoped value.
  assert.match(block!.reason, /5000\/1000/, "reason reflects the cumulative.tokens fallback path");
});

// ── T4: the user's exact 350,000-token scenario now respects include ──

test("user's 350,000-token scenario: cache hits do not push include=[input,output] gate over", async () => {
  // The bug report: user set include=[input,output] expecting only those
  // dimensions to count toward the cap, but the gate was comparing the full
  // stats.tokens.total (input + output + cacheRead + cacheWrite). When
  // cache is large, the gate fired earlier than expected. With the
  // include-aware gate, the user can configure cache-heavy sessions
  // without the gate misfiring.
  const { sm, ledger } = await ledgerWith([
    // The ledger writes a single cumulative entry reflecting prior spend.
    // This emulates a worker that has been running for a while; the
    // pre-flight gate reads the cumulative to decide whether to admit
    // the new dispatch.
    { cumulative: { tokens: 350_000, costUsd: 5.0, runs: 5 } },
  ]);
  const policy: WorkerBudgetPolicy = {
    worker: { tokens: { cap: 20_000, window: "per-session", include: ["input", "output"] } },
    team: {},
  };
  const branch = sm.getBranch();
  // Live stats from the worker session: input=10K, output=5K, cacheRead=200K,
  // cacheWrite=135K. total = 350K, but include=[input,output] → 15K < 20K.
  const stats = {
    sessionFile: undefined as undefined,
    sessionId: "user-scenario",
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: statsOf(10_000, 5_000, 200_000, 135_000),
    cost: 5.0,
  } as const;
  const block = checkBudgetPolicy(ledger, policy, branch, stats as unknown as SessionStats);
  assert.equal(block, undefined, "350,000-token scenario with include=[input,output] does NOT block when input+output < cap");

  // Negative control: same scenario but include=all-four → block fires
  // because total = 350K >> cap = 20K. Pin that the include filter is
  // what prevents the false positive, not a bug in the comparison itself.
  const allFourPolicy: WorkerBudgetPolicy = {
    worker: { tokens: { cap: 20_000, window: "per-session", include: ["input", "output", "cacheRead", "cacheWrite"] } },
    team: {},
  };
  const blockAllFour = checkBudgetPolicy(ledger, allFourPolicy, branch, stats as unknown as SessionStats);
  assert.ok(blockAllFour !== undefined, "include=all-four DOES block when total = 350K >> cap = 20K (negative control)");
  assert.match(blockAllFour!.reason, /350000\/20000/);
});

// =====================================================================
// Wave context-constraint — T4: pre-flight gate context check.
//
// 3 new tests pin the worker.context branch in checkBudgetPolicy:
//   1. Nominal tokens cap: gate fires when ctx.tokens >= cap
//   2. Percentage cap: gate fires when (ctx.tokens / ctx.contextWindow) * 100 >= percent
//   3. Both tokens and context apply: worker is blocked by either
// Plus one null-safety test (mirrors T3): tokens=null means skip, not block.
// =====================================================================

// Build a ContextUsageLike payload for the test (matches the SDK's
// `getContextUsage()` return type — see src/engine/budget/policy.ts).
function ctxUsageOf(tokens: number | null, contextWindow: number, percent?: number | null): { tokens: number | null; contextWindow: number; percent: number | null } {
  return { tokens, contextWindow, percent: percent ?? (tokens != null ? tokens / contextWindow : null) };
}

test("checkBudgetPolicy 5-arg overload: worker.context tokens cap fires when ctx.tokens >= cap (T4 nominal)", async () => {
  // A worker whose LLM is at 100K tokens of context, with a configured
  // nominal cap of 100K. The gate must fire (>=, not >, so the boundary
  // is exhausted). include is intentionally irrelevant — the brief says
  // include does NOT apply to context (the SDK returns a single coherent
  // number, double-counting would be wrong).
  const { sm, ledger } = await ledgerWith([{ cumulative: { tokens: 50, costUsd: 0.001, runs: 1 } }]);
  const policy: WorkerBudgetPolicy = {
    worker: {
      tokens: { cap: 1_000_000, window: "per-session", include: ["input", "output"] },
      context: { tokens: 100_000 },
    },
    team: {},
  };
  const branch = sm.getBranch();
  const ctx = ctxUsageOf(100_000, 200_000);
  const block = checkBudgetPolicy(ledger, policy, branch, undefined, ctx);
  assert.ok(block !== undefined, "context cap fires when ctx.tokens (100K) >= nominal cap (100K)");
  assert.equal(block!.scope, "worker", "scope is worker");
  assert.equal(block!.resource, "context", "resource is context");
  assert.equal(block!.limit.context?.tokens, 100_000, "limit carries the violated cap (100K)");
  assert.equal(block!.remaining.context?.tokens, 0, "remaining.context.tokens is 0 when exhausted");
});

test("checkBudgetPolicy 5-arg overload: worker.context percent cap fires at the configured 0–100 fill (T4 percent)", async () => {
  // A worker whose LLM is at 80% of a 200K context window (160K tokens),
  // with a configured cap of 80%. Gate must fire (>= at the boundary).
  const { sm, ledger } = await ledgerWith([{ cumulative: { tokens: 50, costUsd: 0.001, runs: 1 } }]);
  const policy: WorkerBudgetPolicy = {
    worker: { context: { percent: 80 } },
    team: {},
  };
  const branch = sm.getBranch();
  const ctx = ctxUsageOf(160_000, 200_000); // 80% of 200K
  const block = checkBudgetPolicy(ledger, policy, branch, undefined, ctx);
  assert.ok(block !== undefined, "context percent cap fires at 80% fill with 80% cap");
  assert.equal(block!.resource, "context", "resource is context");
  assert.equal(block!.limit.context?.percent, 80, "limit carries the violated percent (80)");
  assert.equal(block!.remaining.context?.percent, 80, "remaining.context.percent is 80 when the cap is 80% and fill is at the cap");
});

test("checkBudgetPolicy 5-arg overload: BOTH tokens and context apply — worker blocked by either (T4 both)", async () => {
  // Worker has both `tokens:` (cumulative) and `context:` (current view)
  // caps. The brief is explicit: when both are set, the worker is blocked
  // when EITHER fires. The pre-existing tokens check fires first (it's
  // evaluated before context in the documented order).
  const { sm, ledger } = await ledgerWith([{ cumulative: { tokens: 500, costUsd: 0.001, runs: 1 } }]);
  // Scenario A: tokens cap fired (cumulative.tokens=500 >= cap=400); context
  // is well under cap. The gate must report the tokens violation, NOT
  // skip the context check (the worker is blocked regardless).
  const tokensFired: WorkerBudgetPolicy = {
    worker: {
      tokens: { cap: 400, window: "per-session", include: ["input", "output"] },
      context: { tokens: 1_000_000 }, // context is well under cap
    },
    team: {},
  };
  const branch = sm.getBranch();
  const ctxUnder = ctxUsageOf(50_000, 200_000);
  const blockTokens = checkBudgetPolicy(ledger, tokensFired, branch, undefined, ctxUnder);
  assert.ok(blockTokens !== undefined, "gate fires when tokens cap is exhausted, even with context well under cap");
  assert.equal(blockTokens!.resource, "tokens", "resource is tokens (the dimension that fired)");

  // Scenario B: context cap fired (ctx.tokens=200K >= cap=100K); tokens
  // are under cap. The gate must report the context violation.
  const contextFired: WorkerBudgetPolicy = {
    worker: {
      tokens: { cap: 1_000_000, window: "per-session", include: ["input", "output"] },
      context: { tokens: 100_000 },
    },
    team: {},
  };
  const ctxAtCap = ctxUsageOf(200_000, 400_000);
  const blockCtx = checkBudgetPolicy(ledger, contextFired, branch, undefined, ctxAtCap);
  assert.ok(blockCtx !== undefined, "gate fires when context cap is exhausted, even with tokens well under cap");
  assert.equal(blockCtx!.resource, "context", "resource is context (the dimension that fired)");
  assert.equal(blockCtx!.limit.context?.tokens, 100_000);
});

test("checkBudgetPolicy 5-arg overload: context check skipped gracefully when ctx.tokens is null (T4 null safety)", async () => {
  // SDK contract: tokens can be null "right after compaction, before next
  // LLM response." The gate must NOT block — the comparison has no
  // meaningful value, so the check is a no-op. This matches the
  // T3 (cadence) null-handling test in budget-events.test.ts.
  const { sm, ledger } = await ledgerWith([{ cumulative: { tokens: 50, costUsd: 0.001, runs: 1 } }]);
  const policy: WorkerBudgetPolicy = {
    worker: { context: { tokens: 100_000 } },
    team: {},
  };
  const branch = sm.getBranch();
  const ctxNull = ctxUsageOf(null, 200_000, null);
  const block = checkBudgetPolicy(ledger, policy, branch, undefined, ctxNull);
  assert.equal(block, undefined, "null tokens → skip the check (no false-positive block)");
});

// =====================================================================
// Wave context-constraint — T6: budgetRemaining exposes the context
// state. Tests pin the new `context: { tokens, percent }` field on the
// worker BudgetRemaining shape, sourced from the runtime's
// contextTokens/contextPct fields (populated at every message_end by T3).
// =====================================================================

test("budgetRemaining: worker.context reflects the runtime's live context values (T6 display)", () => {
  // The runtime carries the live values from the SDK's getContextUsage()
  // — see dispatch-lifecycle.ts:127-130 (run-end) and events.ts T3
  // (message_end, post-this-wave). budgetRemaining exposes them so the
  // dashboard's existing `formatContextFill` (src/agents/tools.ts:79)
  // continues to render the worker status without a separate code path.
  const worker = runtimeFor("Worker", "worker", {
    inputTokens: 700, outputTokens: 300, cacheReadTokens: 100, cacheWriteTokens: 50, reasoningTokens: 25,
    costUsd: 1.25, runCount: 1, distillerRunCount: 0,
    // Wave context-constraint additions: the runtime's live context values.
    contextPct: 0.45, // 45% on the 0–1 scale
    contextTokens: 90_000,
    contextWindow: 200_000,
  });
  const state = stateFor([worker], {
    workerBudgets: { tokenBudget: 2000, costBudgetUsd: 5, maxRuns: 10, distillerRuns: 5 },
  });
  const { worker: rem } = budgetRemaining(state, worker);
  assert.ok(rem.context !== undefined, "rem.context is defined when runtime has live values");
  assert.equal(rem.context!.tokens, 90_000, "rem.context.tokens mirrors runtime.contextTokens (the SDK's ContextUsage.tokens)");
  assert.equal(rem.context!.percent, 0.45, "rem.context.percent mirrors runtime.contextPct (on the 0–1 scale)");
});

test("budgetRemaining: worker.context returns zeros when runtime has no live values yet (T6 fresh dispatch)", () => {
  // A fresh dispatch has contextPct=0 (runtime default) and
  // contextTokens/contextWindow undefined (no message_end has fired yet).
  // budgetRemaining returns zeros for the context fields rather than
  // undefined so the dashboard can render a deterministic "no fill yet"
  // view without a special-case for missing fields.
  const worker = runtimeFor("Worker", "worker", {});
  const state = stateFor([worker], {});
  const { worker: rem } = budgetRemaining(state, worker);
  assert.ok(rem.context !== undefined, "rem.context is defined (zeros) for a fresh dispatch");
  assert.equal(rem.context!.tokens, 0, "rem.context.tokens is 0 when runtime.contextTokens is undefined");
  assert.equal(rem.context!.percent, 0, "rem.context.percent is 0 when runtime.contextPct is 0 (default)");
});

// =====================================================================
// Wave context-constraint — T7: per-dimension strategy interaction.
//
// 3 new tests pin the pure helpers in src/engine/budget/policy.ts that
// resolve the per-dimension exhaustion action and the per-dimension
// `interventionAvailable` flag. Backward compat: when only the global
// `onExhaustion.action` is set, both dimensions resolve to the same
// value (the documented fallback chain).
// =====================================================================

import { resolveExhaustionAction, resolveInterventionAvailable } from "../src/engine/budget/policy.ts";

test("resolveExhaustionAction: tokens dimension falls back to global onExhaustion.action when onTokenExhaustion absent (T7 default)", () => {
  // Backward-compat: a config that only sets the global `onExhaustion`
  // must apply the same action to BOTH dimensions. The pre-existing
  // `abort` default is the documented behavior for legacy configs.
  const policy: WorkerBudgetPolicy = {
    worker: {},
    team: {},
    strategies: { onApproachingLimit: { action: "wrap-up", threshold: 0.2, hint: "" }, onExhaustion: { action: "compact" }, summary: { maxTokens: 200 } },
  };
  assert.equal(resolveExhaustionAction(policy, "tokens"), "compact", "tokens dimension → global onExhaustion.action=compact");
  assert.equal(resolveExhaustionAction(policy, "context"), "compact", "context dimension → global onExhaustion.action=compact");
});

test("resolveExhaustionAction: onTokenExhaustion override beats global; onContextExhaustion override beats global (T7 per-dim)", () => {
  // Per-dim overrides must take precedence over the global. A user
  // declaring `tokens: abort, context: compact` expects the two to
  // resolve independently — collapsing them back to a single strategy
  // defeats the purpose (per the brief's "per-dimension strategies
  // rationale" note).
  const policy: WorkerBudgetPolicy = {
    worker: {},
    team: {},
    strategies: {
      onApproachingLimit: { action: "wrap-up", threshold: 0.2, hint: "" },
      onExhaustion: { action: "abort" }, // global
      onTokenExhaustion: { action: "abort" }, // explicit
      onContextExhaustion: { action: "compact" }, // explicit
      summary: { maxTokens: 200 },
    },
  };
  assert.equal(resolveExhaustionAction(policy, "tokens"), "abort", "tokens dimension → onTokenExhaustion.action=abort");
  assert.equal(resolveExhaustionAction(policy, "context"), "compact", "context dimension → onContextExhaustion.action=compact");
});

test("resolveInterventionAvailable: per-dimension flag (tokens abort + context compact → mixed) (T7 mixed)", () => {
  // Mixed mode: tokens allow operator intervention, context is
  // auto-managed. The flag must be computed PER-DIMENSION so the F13
  // dashboard renders the right intervention buttons for each warning
  // event. A single global flag (the pre-fix behavior) would either
  // hide the rescue button on the token side (wrong) or offer it on
  // the context side (also wrong).
  const policy: WorkerBudgetPolicy = {
    worker: {},
    team: {},
    strategies: {
      onApproachingLimit: { action: "wrap-up", threshold: 0.2, hint: "" },
      onExhaustion: { action: "abort" },
      onTokenExhaustion: { action: "abort" },
      onContextExhaustion: { action: "compact" },
      summary: { maxTokens: 200 },
    },
  };
  assert.equal(resolveInterventionAvailable(policy, "tokens"), true, "tokens (abort) → interventionAvailable=true (operator may rescue)");
  assert.equal(resolveInterventionAvailable(policy, "context"), false, "context (compact) → interventionAvailable=false (system auto-manages)");
});
