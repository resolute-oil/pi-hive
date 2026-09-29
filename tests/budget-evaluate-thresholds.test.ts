/**
 * Wave 5 / Coverage-1 — Direct `evaluateThresholds` tests.
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md
 *   §3.3 F3 — T3.2 warning at ≤20% remaining; T3.3 exhaustion at 0%.
 *   §6.2 G-17 — warning × summarize_progress ordering pinned.
 *   §2.6  — evaluateThresholds is the extracted pure-ish helper that
 *             installBudgetEventHooks delegates to for warning/exhaustion.
 *
 * Why this test exists:
 *
 * `evaluateThresholds` is exported "so the test file can drive it directly"
 * (its docstring in events.ts). The subscribe wrapper (`installBudgetEventHooks`)
 * hides the dedup-key behavior behind event-emission, so a direct test pins:
 *
 *   (1) The dedup-key shape is EXACTLY `${scope}:${resource}:${agent|team}`
 *       — Wave 1A's contract for the warning/exhaustion guard.
 *   (2) A second call at the same dedup key does NOT re-emit (idempotent guard).
 *   (3) Worker-scope and team-scope pairs use independent keys even when the
 *       resource is the same (so exhausting tokens doesn't block the costUsd
 *       pair on the same worker, and exhausting team caps doesn't block the
 *       worker caps).
 *   (4) Warning and exhaustion are independent pairs — crossing 20% AND then
 *       0% on the same resource emits BOTH (two distinct dedup keys).
 *   (5) Two BudgetLedger instances with the same policy have INDEPENDENT
 *       `warnedKeys` sets — no shared module-level state.
 *
 * All six tests are deterministic: no Math.random(), no Date.now() in test
 * paths, no setTimeout. The script drives `evaluateThresholds` synchronously
 * against a fake `SubscribableSession` and a real `SessionManager.inMemory`
 * so the write contract (CustomEntry ids, branch positions) is exercised
 * end-to-end.
 *
 * Seed strategy: the threshold check in `evaluateThresholds` reads
 * `usage.worker.tokens` from `ledger.cumulative` AND the team aggregate by
 * walking the branch for ledger CustomEntries. So to set up a scenario,
 * the ledger CustomEntry for THIS worker must already be on the branch
 * BEFORE `BudgetLedger.restore` — `restore` reads the most-recent
 * entry-for-our-slug off the branch and mirrors it into `ledger.cumulative`,
 * AND the team-aggregate walk in `computeWorkerAndTeamUsage` will see it
 * on the branch.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionStats } from "@earendil-works/pi-coding-agent";
import {
  evaluateThresholds,
  BUDGET_WARNING_CUSTOM_TYPE,
  BUDGET_EXHAUSTED_CUSTOM_TYPE,
} from "../src/engine/budget/events.ts";
import { BudgetLedger, BUDGET_LEDGER_CUSTOM_TYPE } from "../src/engine/budget/ledger.ts";
import type {
  BudgetLedgerData,
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
    sessionId: "thresholds-test",
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens },
    cost,
  };
}

/** Minimal SubscribableSession for evaluateThresholds. */
interface FakeSubscribableSession {
  listener: ((event: unknown) => void) | null;
  stats: SessionStats;
  abortCallCount: number;
  subscribe(listener: (event: unknown) => void): () => void;
  getSessionStats(): SessionStats;
  abort(): void;
}

function makeSession(initialStats: SessionStats): FakeSubscribableSession {
  return {
    listener: null,
    stats: initialStats,
    abortCallCount: 0,
    subscribe(listener: (event: unknown) => void): () => void {
      this.listener = listener;
      return () => { if (this.listener === listener) this.listener = null; };
    },
    getSessionStats(): SessionStats {
      return this.stats;
    },
    abort(): void {
      this.abortCallCount += 1;
    },
  };
}

/**
 * Build a fresh ledger with an OPTIONAL pre-seeded CustomEntry on the
 * branch for `agentSlug`. `BudgetLedger.restore` will mirror the entry's
 * cumulative into `ledger.cumulative` and the team-aggregate walk will
 * pick it up.
 */
async function makeLedger(policy: WorkerBudgetPolicy, options: { agentSlug?: string; tokens?: number; costUsd?: number } = {}): Promise<{ ledger: BudgetLedger; sm: SessionManager }> {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-eval-"));
  const sm = SessionManager.inMemory(cwd);
  const agentSlug = options.agentSlug ?? "worker";
  if (options.tokens !== undefined || options.costUsd !== undefined) {
    sm.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, {
      caps: {},
      cumulative: {
        tokens: options.tokens ?? 0,
        costUsd: options.costUsd ?? 0,
        runs: 1,
      },
      writtenAt: 1,
      agentSlug,
    });
  }
  const ledger = await BudgetLedger.restore(sm, agentSlug, policy);
  return { ledger, sm };
}

/** Drain ledger entries from the branch. */
function ledgerEntries(sm: SessionManager): BudgetLedgerData[] {
  return sm.getBranch()
    .filter((e) => e.type === "custom" && (e as { customType?: unknown }).customType === BUDGET_LEDGER_CUSTOM_TYPE)
    .map((e) => (e as { data: BudgetLedgerData }).data);
}

/** Drain budget_warning / budget_exhausted CustomMessageEntries. */
function messagesOfType(sm: SessionManager, customType: string): Array<{ details?: { scope?: string; resource?: string; remaining?: number; cap?: number; interventionAvailable?: boolean } }> {
  return sm.getBranch().filter((e) => {
    if (e.type !== "custom" && e.type !== "custom_message") return false;
    return (e as { customType?: unknown }).customType === customType;
  }) as Array<{ details?: { scope?: string; resource?: string; remaining?: number; cap?: number; interventionAvailable?: boolean } }>;
}

// ── Case 1: dedup-key format is exactly `${scope}:${resource}:${agent|team}` ──

test("evaluateThresholds: dedup key is exactly `${scope}:${resource}:${agent|team}` (worker + team shape pinned)", async () => {
  const workerCap = 1_000;
  const teamCap = 5_000;
  const policy = makePolicy({ tokens: { resource: "tokens", cap: workerCap } });
  // Seed THIS worker at 800 (worker 20% remaining). Worker branch entry.
  const { ledger, sm } = await makeLedger(policy, { tokens: 800 });
  // Add a sibling worker at 3_200 so the team aggregate = 800 + 3_200 = 4_000
  // / 5_000 = 20% remaining → team warning also fires in the SAME call.
  sm.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, {
    caps: { teamTokens: teamCap, workerTokens: workerCap },
    cumulative: { tokens: 3_200, costUsd: 0, runs: 1 },
    writtenAt: 1,
    agentSlug: "other-worker",
  });
  const session = makeSession(makeStats(0, 0));
  const controller = new AbortController();

  evaluateThresholds(
    session, ledger, policy, sm, controller,
    { tokens: 800, costUsd: 0, runs: 1 },
    "worker",
  );
  assert.ok(
    ledger.warnedKeys.has("worker:tokens:worker"),
    "worker-scope warning key is `${scope}:${resource}:${agentSlug}` — must use literal 'worker' for the agent segment when scope is 'worker'",
  );
  assert.ok(
    ledger.warnedKeys.has("team:tokens:team"),
    "team-scope warning key is `${scope}:${resource}:team` — must use literal 'team' (NOT the agentSlug) for the agent segment when scope is 'team'",
  );

  // Negative: worker key must NOT be recorded for the team-scope key (and
  // vice versa).
  assert.equal(
    ledger.warnedKeys.has("team:tokens:worker"),
    false,
    "team scope must NOT use the agentSlug in the key — that would couple worker identity to team-wide events",
  );
  assert.equal(
    ledger.warnedKeys.has("worker:tokens:team"),
    false,
    "worker scope must NOT use the literal 'team' — agentSlug must be the worker segment",
  );
});

// ── Case 2: warning fires once per dedup key (second call does not re-emit) ──

test("evaluateThresholds: warning fires exactly once per `${scope}:${resource}:${agent|team}` key", async () => {
  const cap = 1_000;
  const policy = makePolicy({ tokens: { resource: "tokens", cap } });
  // Seed worker at 800 (20% remaining).
  const { ledger, sm } = await makeLedger(policy, { tokens: 800 });
  const session = makeSession(makeStats(0, 0));
  const controller = new AbortController();

  // First call — at 20% remaining → warning fires.
  evaluateThresholds(
    session, ledger, policy, sm, controller,
    { tokens: 800, costUsd: 0, runs: 1 },
    "worker",
  );
  const warningsAfterFirst = messagesOfType(sm, BUDGET_WARNING_CUSTOM_TYPE).length;
  const ledgerWarningsAfterFirst = ledgerEntries(sm).filter((d) => d.marker === "warning").length;
  assert.equal(warningsAfterFirst, 1, "first call: exactly one budget_warning message");
  assert.equal(ledgerWarningsAfterFirst, 1, "first call: exactly one ledger CustomEntry with marker 'warning'");

  // Second call at the same dedup key (still at 20% remaining — no cumulative
  // change between calls; the ratio stays the same and the dedup set already
  // contains the key).
  evaluateThresholds(
    session, ledger, policy, sm, controller,
    { tokens: 800, costUsd: 0, runs: 1 },
    "worker",
  );
  assert.equal(
    messagesOfType(sm, BUDGET_WARNING_CUSTOM_TYPE).length,
    warningsAfterFirst,
    "second call at the same dedup key: NO new budget_warning message",
  );
  assert.equal(
    ledgerEntries(sm).filter((d) => d.marker === "warning").length,
    ledgerWarningsAfterFirst,
    "second call at the same dedup key: NO new ledger warning entry",
  );

  // Third call, cumulative grows slightly but the dedup key is the same and
  // the ratio is still ≤ 20% — must STILL not re-emit.
  evaluateThresholds(
    session, ledger, policy, sm, controller,
    { tokens: 850, costUsd: 0, runs: 1 },
    "worker",
  );
  assert.equal(
    messagesOfType(sm, BUDGET_WARNING_CUSTOM_TYPE).length,
    warningsAfterFirst,
    "third call (cumulative grew, ratio still ≤ 20%): NO new warning (same dedup key)",
  );
});

// ── Case 3: exhaustion fires once per dedup key ─────────────────────────

test("evaluateThresholds: exhaustion fires exactly once per `${scope}:${resource}:${agent|team}` key", async () => {
  const cap = 1_000;
  const policy = makePolicy({ tokens: { resource: "tokens", cap } });
  // Seed worker AT the cap → 0% remaining.
  const { ledger, sm } = await makeLedger(policy, { tokens: cap });
  const session = makeSession(makeStats(0, 0));
  const controller = new AbortController();

  // First call — cumulative hits cap → exhaustion fires.
  evaluateThresholds(
    session, ledger, policy, sm, controller,
    { tokens: cap, costUsd: 0, runs: 1 },
    "worker",
  );
  const exhaustedAfterFirst = messagesOfType(sm, BUDGET_EXHAUSTED_CUSTOM_TYPE).length;
  const ledgerExhaustedAfterFirst = ledgerEntries(sm).filter((d) => d.marker === "exhausted").length;
  assert.equal(exhaustedAfterFirst, 1, "first call: exactly one budget_exhausted message");
  assert.equal(ledgerExhaustedAfterFirst, 1, "first call: exactly one ledger CustomEntry with marker 'exhausted'");
  assert.equal(session.abortCallCount, 1, "first call: session.abort() was called once");

  // Second call — fresh controller (simulating session respawn) and the same
  // dedup key. The dedup set survives in `BudgetLedger.warnedKeys` even if
  // the controller is fresh, so the second call MUST still short-circuit.
  const freshController = new AbortController();
  evaluateThresholds(
    session, ledger, policy, sm, freshController,
    { tokens: cap, costUsd: 0, runs: 1 },
    "worker",
  );
  assert.equal(
    messagesOfType(sm, BUDGET_EXHAUSTED_CUSTOM_TYPE).length,
    exhaustedAfterFirst,
    "second call with a fresh AbortController but same dedup key: NO new exhaustion message (dedup wins)",
  );
  assert.equal(
    ledgerEntries(sm).filter((d) => d.marker === "exhausted").length,
    ledgerExhaustedAfterFirst,
    "second call with a fresh AbortController but same dedup key: NO new ledger exhaustion entry",
  );
  assert.equal(
    freshController.signal.aborted,
    false,
    "dedup short-circuit means a fresh controller is NOT aborted by the second call",
  );
});

// ── Case 4: team-scope vs worker-scope are independent (same resource, different scope) ──

test("evaluateThresholds: worker-scope and team-scope use independent dedup keys for the same resource", async () => {
  const workerCap = 1_000;
  const teamCap = 4_000;
  const policy: WorkerBudgetPolicy = {
    worker: { tokens: { resource: "tokens", cap: workerCap } },
    team: { tokens: { resource: "tokens", cap: teamCap } },
  };
  // Seed this worker at 850 (15% remaining — worker warning fires).
  // Add a sibling worker at 3_000 so team aggregate = 850 + 3_000 = 3_850 /
  // 4_000 = 3.75% remaining — team warning also fires in the SAME call.
  const { ledger, sm } = await makeLedger(policy, { tokens: 850 });
  sm.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, {
    caps: { teamTokens: teamCap, workerTokens: workerCap },
    cumulative: { tokens: 3_000, costUsd: 0, runs: 1 },
    writtenAt: 1,
    agentSlug: "other-worker",
  });
  const session = makeSession(makeStats(0, 0));
  const controller = new AbortController();

  // First call — BOTH scope:resource pairs fire (independent keys).
  evaluateThresholds(
    session, ledger, policy, sm, controller,
    { tokens: 850, costUsd: 0, runs: 1 },
    "worker",
  );
  const warningEntries = messagesOfType(sm, BUDGET_WARNING_CUSTOM_TYPE);
  assert.equal(warningEntries.length, 2, "one warning per (scope, resource) pair — 2 total");
  const scopeResourcePairs = warningEntries.map((e) => `${e.details?.scope}:${e.details?.resource}`);
  assert.ok(scopeResourcePairs.includes("worker:tokens"), "worker:tokens warning fired");
  assert.ok(scopeResourcePairs.includes("team:tokens"), "team:tokens warning fired");

  // Independent dedup: a second call at the same cumulative must NOT re-emit
  // EITHER warning.
  evaluateThresholds(
    session, ledger, policy, sm, controller,
    { tokens: 850, costUsd: 0, runs: 1 },
    "worker",
  );
  assert.equal(
    messagesOfType(sm, BUDGET_WARNING_CUSTOM_TYPE).length,
    2,
    "second call: no new warning (both worker and team dedup keys recorded)",
  );

  // Verify the keys are exactly worker:tokens:worker and team:tokens:team.
  assert.ok(ledger.warnedKeys.has("worker:tokens:worker"));
  assert.ok(ledger.warnedKeys.has("team:tokens:team"));
  // Confirm no key sharing — each scope/resource has its own entry.
  assert.equal(ledger.warnedKeys.size, 2, "exactly two independent dedup keys recorded");
});

// ── Case 5: warning fires at 20%, exhaustion at 0% — both gated by the same key (documented contract) ──

test("evaluateThresholds: warning and exhaustion are independent pairs (distinct events with distinct keys)", async () => {
  // The events.ts implementation shares ONE `warnedKeys` Set between warning
  // and exhaustion paths ("the same warnedKeys Set guards exhaustion too" —
  // events.ts source). For the SAME (scope, resource), the warning's key
  // ALSO guards the exhaustion path. So a single transition
  // (20% → warning, then 0% → exhaustion) on the same resource emits
  // exactly ONE event (the warning); the exhaustion path short-circuits on
  // the shared key.
  //
  // To exercise the "independent pairs" contract, we use TWO resources
  // (tokens vs costUsd) — each resource gets its own key, so each can fire
  // independently.

  // Scenario A: tokens pair. Worker hits 20% (warning fires); then the
  // worker hits 0% on the SAME tokens pair — exhaustion does NOT re-fire
  // (shared key).
  const policyA = makePolicy({ tokens: { resource: "tokens", cap: 1_000 } });
  const { ledger: ledgerA, sm: smA } = await makeLedger(policyA, { tokens: 800 });
  const sessionA = makeSession(makeStats(0, 0));
  const controllerA = new AbortController();

  // Step 1: warning at 20% on tokens.
  evaluateThresholds(
    sessionA, ledgerA, policyA, smA, controllerA,
    { tokens: 800, costUsd: 0, runs: 1 },
    "worker",
  );
  assert.equal(messagesOfType(smA, BUDGET_WARNING_CUSTOM_TYPE).length, 1, "A: warning at 20%");
  assert.equal(messagesOfType(smA, BUDGET_EXHAUSTED_CUSTOM_TYPE).length, 0, "A: no exhaustion yet");

  // Step 2: same dedup key as the warning, fresh controller, cumulative at
  // the cap. Exhaustion does NOT fire (shared key — events.ts contract).
  evaluateThresholds(
    sessionA, ledgerA, policyA, smA, new AbortController(),
    { tokens: 1_000, costUsd: 0, runs: 1 },
    "worker",
  );
  assert.equal(
    messagesOfType(smA, BUDGET_WARNING_CUSTOM_TYPE).length,
    1,
    "A: does not re-emit (same dedup key)",
  );
  assert.equal(
    messagesOfType(smA, BUDGET_EXHAUSTED_CUSTOM_TYPE).length,
    0,
    "A: exhaustion does NOT fire — same dedup key as the warning (events.ts: shared warnedKeys Set)",
  );

  // Scenario B: distinct resources. Warning on tokens + exhaustion on
  // costUsd — different keys → both fire independently.
  const policyB = makePolicy({ tokens: { resource: "tokens", cap: 1_000 }, costUsd: { resource: "costUsd", cap: 5 } });
  // Seed this worker at tokens=800, costUsd=5 (cap). The branch entry sets
  // both, so ledger.cumulative mirrors them and the team aggregate sees
  // them too.
  const cwdB = mkdtempSync(join(tmpdir(), "pi-hive-eval-B-"));
  const smB = SessionManager.inMemory(cwdB);
  smB.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, {
    caps: {},
    cumulative: { tokens: 800, costUsd: 5, runs: 1 },
    writtenAt: 1,
    agentSlug: "worker",
  });
  const ledgerB = await BudgetLedger.restore(smB, "worker", policyB);
  const sessionB = makeSession(makeStats(0, 0));
  const controllerB = new AbortController();

  // First call: tokens warning fires (key worker:tokens:worker);
  // costUsd exhaustion fires (key worker:costUsd:worker — different key).
  evaluateThresholds(
    sessionB, ledgerB, policyB, smB, controllerB,
    { tokens: 800, costUsd: 5, runs: 1 },
    "worker",
  );
  assert.equal(
    messagesOfType(smB, BUDGET_WARNING_CUSTOM_TYPE).length,
    1,
    "B: warning fires on tokens (20% remaining)",
  );
  assert.equal(
    messagesOfType(smB, BUDGET_EXHAUSTED_CUSTOM_TYPE).length,
    1,
    "B: exhaustion fires on costUsd (0% remaining) — DISTINCT dedup key",
  );
  const exhaustedEntry = messagesOfType(smB, BUDGET_EXHAUSTED_CUSTOM_TYPE)[0]!;
  assert.equal(exhaustedEntry.details?.resource, "costUsd", "B: exhaustion entry records costUsd");
  assert.equal(exhaustedEntry.details?.scope, "worker");
  assert.equal(exhaustedEntry.details?.remaining, 0);

  // Verify the two keys are distinct and both recorded.
  assert.ok(ledgerB.warnedKeys.has("worker:tokens:worker"), "B: tokens key");
  assert.ok(ledgerB.warnedKeys.has("worker:costUsd:worker"), "B: costUsd key");
  assert.equal(ledgerB.warnedKeys.size, 2, "B: exactly two distinct dedup keys recorded");
});

// ── Case 6: in-memory `warnedKeys` Set isolation across BudgetLedger instances ──

test("evaluateThresholds: two BudgetLedger instances with the same policy have INDEPENDENT warnedKeys Sets (no shared state)", async () => {
  const cap = 1_000;
  const policy = makePolicy({ tokens: { resource: "tokens", cap } });

  // Two INDEPENDENT SessionManager + BudgetLedger instances (each uses its
  // own cwd and its own appendCustomEntry → so the restore walks a
  // separate branch). The dedup Sets are in-memory only (BudgetLedger
  // .warnedKeys = Set) — no module-level shared state — so the two
  // instances have independent sets.
  const cwdA = mkdtempSync(join(tmpdir(), "pi-hive-eval-a-"));
  const cwdB = mkdtempSync(join(tmpdir(), "pi-hive-eval-b-"));
  const smA = SessionManager.inMemory(cwdA);
  const smB = SessionManager.inMemory(cwdB);
  // Seed each branch with a CustomEntry for the respective worker slug,
  // BEFORE restore so the ledger picks up its cumulative at 800.
  smA.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, {
    caps: {},
    cumulative: { tokens: 800, costUsd: 0, runs: 1 },
    writtenAt: 1,
    agentSlug: "worker-a",
  });
  smB.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, {
    caps: {},
    cumulative: { tokens: 800, costUsd: 0, runs: 1 },
    writtenAt: 1,
    agentSlug: "worker-b",
  });
  const ledgerA = await BudgetLedger.restore(smA, "worker-a", policy);
  const ledgerB = await BudgetLedger.restore(smB, "worker-b", policy);

  const sessionA = makeSession(makeStats(0, 0));
  const sessionB = makeSession(makeStats(0, 0));
  const controllerA = new AbortController();
  const controllerB = new AbortController();

  // Fire warning on ledgerA — the dedup key uses workerA's slug.
  evaluateThresholds(
    sessionA, ledgerA, policy, smA, controllerA,
    { tokens: 800, costUsd: 0, runs: 1 },
    "worker-a",
  );
  assert.ok(ledgerA.warnedKeys.has("worker:tokens:worker-a"), "ledgerA recorded its own key (workerSlug = 'worker-a')");

  // ledgerB must NOT have that key (independent Set). Even if its workerSlug
  // happened to match, the Set instance is per-ledger.
  assert.equal(
    ledgerB.warnedKeys.has("worker:tokens:worker-a"),
    false,
    "ledgerB does NOT see ledgerA's key (independent Set instance)",
  );

  // Fire warning on ledgerB — different cumulative, same policy — fires.
  evaluateThresholds(
    sessionB, ledgerB, policy, smB, controllerB,
    { tokens: 800, costUsd: 0, runs: 1 },
    "worker-b",
  );
  assert.ok(ledgerB.warnedKeys.has("worker:tokens:worker-b"), "ledgerB recorded its own key (workerSlug = 'worker-b')");

  // ledgerA still has ONLY its key — ledgerB's call did not pollute it.
  assert.deepEqual(
    Array.from(ledgerA.warnedKeys),
    ["worker:tokens:worker-a"],
    "ledgerA's warnedKeys contains only its own key — no cross-ledger mutation",
  );
  assert.deepEqual(
    Array.from(ledgerB.warnedKeys),
    ["worker:tokens:worker-b"],
    "ledgerB's warnedKeys contains only its own key — no cross-ledger mutation",
  );

  // Final assertion: the two ledger CustomEntry lists are also independent
  // (different SessionManager.branch → different appendCustomEntry targets).
  // Each branch starts with a seed entry (used to bootstrap the ledger's
  // cumulative) and gains one warning marker entry — so 2 ledger entries total.
  assert.equal(ledgerEntries(smA).length, 2, "ledgerA: 1 seed + 1 warning entry");
  assert.equal(ledgerEntries(smB).length, 2, "ledgerB: 1 seed + 1 warning entry");
  assert.equal(
    ledgerEntries(smA).filter((d) => d.marker === "warning").length,
    1,
    "ledgerA: exactly one warning-marker entry",
  );
  assert.equal(
    ledgerEntries(smB).filter((d) => d.marker === "warning").length,
    1,
    "ledgerB: exactly one warning-marker entry",
  );
});
