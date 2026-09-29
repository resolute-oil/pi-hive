/**
 * Wave 5 — Coverage 3: direct unit tests for `BudgetLedger.markWarning`,
 * `BudgetLedger.markExhaustion`, and the `latestCumulativeFor` policy
 * re-export.
 *
 * These two ledger methods are part of the public surface (the dashboard
 * timeline and the G-02 ordering test depend on them) but their only
 * coverage today is through `installBudgetEventHooks` in
 * `budget-events.test.ts`. Direct unit tests pin the contract independently
 * of the event-hook path:
 *
 *   - `markWarning` writes a CustomEntry with `marker: "warning"` carrying
 *     the worker-visible numbers at the time of emission.
 *   - `markExhaustion` writes a CustomEntry with `marker: "exhausted"`.
 *   - The dedup `Set` (`ledger.warnedKeys`, `public readonly`) is the
 *     caller's guard — `markWarning` / `markExhaustion` themselves do NOT
 *     mutate it. The event-hook handler `evaluateThresholds` adds the key
 *     before calling these methods so a second message_end at the same
 *     dedup key is a no-op. These tests exercise that caller pattern
 *     directly so the dedup contract is pinned without the event-hook
 *     plumbing.
 *
 * `latestCumulativeFor` is a thin wrapper over `indexLedgerByAgent` in
 * `policy.ts`. The contract is: latest cumulative per agentSlug, or zero
 * totals for an unknown agent. Three tests pin:
 *
 *   1. Returns the cumulative for a known agent (sanity).
 *   2. Returns zeros for an unknown agent (not undefined, not partial data).
 *   3. Returns the LATEST cumulative when multiple entries exist (matches
 *      `indexLedgerByAgent` insertion order — branch order, oldest first).
 *
 * All tests use real `BudgetLedger` / `SessionManager.inMemory` so the
 * write-side contract (entry ids, persisted branch state, `warnedKeys`
 * semantics) is exercised end-to-end. No `Date.now()` / `Math.random()` /
 * `setTimeout()` in the test code per the Wave 5 coverage audit.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  BUDGET_LEDGER_CUSTOM_TYPE,
  BudgetLedger,
} from "../src/engine/budget/ledger.ts";
import { latestCumulativeFor } from "../src/engine/budget/policy.ts";
import type {
  BudgetLedgerData,
  WorkerBudgetPolicy,
} from "../src/engine/budget/types.ts";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function makePolicy(): WorkerBudgetPolicy {
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
  };
}

function makeFixture(agentSlug: string = "worker"): { sm: SessionManager; agentSlug: string; policy: WorkerBudgetPolicy } {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-coverage-3-"));
  const sm = SessionManager.inMemory(cwd);
  return { sm, agentSlug, policy: makePolicy() };
}

/** Pull the persisted `data` for every `pi-hive-budget-ledger` CustomEntry. */
function ledgerData(sm: SessionManager): BudgetLedgerData[] {
  return sm.getBranch()
    .filter((e) => e.type === "custom" && (e as { customType?: unknown }).customType === BUDGET_LEDGER_CUSTOM_TYPE)
    .map((e) => (e as { data: BudgetLedgerData }).data);
}

/**
 * Caller-side dedup pattern lifted verbatim from `evaluateThresholds` in
 * `events.ts` (lines ~351-365). The dedup guard is the caller's
 * responsibility — `markWarning` / `markExhaustion` write unconditionally;
 * the caller checks + adds the key so a second call with the same key is a
 * no-op. These tests use this helper so the contract under test matches
 * the production wiring.
 */
function emitWarning(ledger: BudgetLedger, key: string, cumulative: { tokens: number; costUsd: number; runs: number }): boolean {
  if (ledger.warnedKeys.has(key)) return false;
  ledger.warnedKeys.add(key);
  ledger.markWarning(cumulative);
  return true;
}

function emitExhaustion(ledger: BudgetLedger, key: string, cumulative: { tokens: number; costUsd: number; runs: number }): boolean {
  if (ledger.warnedKeys.has(key)) return false;
  ledger.warnedKeys.add(key);
  ledger.markExhaustion(cumulative);
  return true;
}

// ── Gap #5 — markWarning + markExhaustion ─────────────────────────────

test("markWarning: writes a CustomEntry with marker:'warning' and the supplied cumulative", async () => {
  const { sm, agentSlug, policy } = makeFixture();
  const ledger = await BudgetLedger.restore(sm, agentSlug, policy);

  const before = ledgerData(sm).length;
  const cumulative = { tokens: 84_000, costUsd: 3.5, runs: 2 };
  ledger.markWarning(cumulative);

  const entries = ledgerData(sm);
  assert.equal(entries.length, before + 1, "exactly one new ledger entry");
  const warning = entries.find((d) => d.marker === "warning");
  assert.ok(warning, "a CustomEntry with marker:'warning' was written");
  assert.equal(warning!.agentSlug, agentSlug);
  assert.equal(warning!.cumulative.tokens, 84_000);
  assert.equal(warning!.cumulative.costUsd, 3.5);
  assert.equal(warning!.cumulative.runs, 2);
  assert.equal(warning!.kind, undefined, "warning entries carry no specific kind");
  assert.equal(typeof warning!.writtenAt, "number", "writtenAt is a finite number stamp");
  // ledger.lastMarker reflects the latest write — confirms in-memory caches
  // are refreshed by markWarning (matches the writeEntry contract).
  assert.equal(ledger.lastMarker, "warning");
});

test("markWarning: caller-side dedup (same key) is a no-op — no second ledger entry is written", async () => {
  const { sm, agentSlug, policy } = makeFixture();
  const ledger = await BudgetLedger.restore(sm, agentSlug, policy);
  const key = "worker:tokens:test-agent";

  // First emit: writes the entry and records the dedup key.
  assert.equal(emitWarning(ledger, key, { tokens: 84_000, costUsd: 3.5, runs: 1 }), true);
  const afterFirst = ledgerData(sm).filter((d) => d.marker === "warning").length;
  assert.equal(afterFirst, 1);

  // Second emit at the same key: caller-side guard short-circuits. The
  // ledger MUST NOT receive a second markWarning call. Observable behavior:
  // no new entry on the branch.
  assert.equal(emitWarning(ledger, key, { tokens: 90_000, costUsd: 3.6, runs: 2 }), false);
  const afterSecond = ledgerData(sm).filter((d) => d.marker === "warning").length;
  assert.equal(afterSecond, 1, "second emit at the same dedup key does not write a new entry");

  // Sanity: the dedup key is recorded so a third caller-side guard still
  // short-circuits (the Set is the contract).
  assert.equal(ledger.warnedKeys.has(key), true);
});

test("markWarning: different dedup keys write independent entries", async () => {
  const { sm, agentSlug, policy } = makeFixture();
  const ledger = await BudgetLedger.restore(sm, agentSlug, policy);

  // Two distinct scope:resource:agent-or-team tuples.
  const workerKey = "worker:tokens:test-agent";
  const teamKey = "team:costUsd:team";
  assert.equal(emitWarning(ledger, workerKey, { tokens: 84_000, costUsd: 0, runs: 1 }), true);
  assert.equal(emitWarning(ledger, teamKey, { tokens: 0, costUsd: 4.5, runs: 1 }), true);

  const warnings = ledgerData(sm).filter((d) => d.marker === "warning");
  assert.equal(warnings.length, 2, "two warning entries — one per dedup key");
  assert.equal(ledger.warnedKeys.size, 2, "both dedup keys are recorded independently");
  assert.equal(ledger.warnedKeys.has(workerKey), true);
  assert.equal(ledger.warnedKeys.has(teamKey), true);
});

test("markExhaustion: writes a CustomEntry with marker:'exhausted' and the supplied cumulative", async () => {
  const { sm, agentSlug, policy } = makeFixture();
  const ledger = await BudgetLedger.restore(sm, agentSlug, policy);

  const before = ledgerData(sm).length;
  const cumulative = { tokens: 100_000, costUsd: 5, runs: 3 };
  ledger.markExhaustion(cumulative);

  const entries = ledgerData(sm);
  assert.equal(entries.length, before + 1, "exactly one new ledger entry");
  const exhausted = entries.find((d) => d.marker === "exhausted");
  assert.ok(exhausted, "a CustomEntry with marker:'exhausted' was written");
  assert.equal(exhausted!.agentSlug, agentSlug);
  assert.equal(exhausted!.cumulative.tokens, 100_000);
  assert.equal(exhausted!.cumulative.costUsd, 5);
  assert.equal(exhausted!.cumulative.runs, 3);
  assert.equal(exhausted!.kind, undefined, "exhaustion entries carry no specific kind");
  assert.equal(typeof exhausted!.writtenAt, "number");
  assert.equal(ledger.lastMarker, "exhausted");
});

test("markExhaustion: caller-side dedup (same key) is a no-op — no second ledger entry is written", async () => {
  const { sm, agentSlug, policy } = makeFixture();
  const ledger = await BudgetLedger.restore(sm, agentSlug, policy);
  const key = "worker:tokens:test-agent";

  assert.equal(emitExhaustion(ledger, key, { tokens: 100_000, costUsd: 5, runs: 1 }), true);
  const afterFirst = ledgerData(sm).filter((d) => d.marker === "exhausted").length;
  assert.equal(afterFirst, 1);

  // Re-emit at the same key — the caller-side guard short-circuits.
  assert.equal(emitExhaustion(ledger, key, { tokens: 100_000, costUsd: 5, runs: 2 }), false);
  const afterSecond = ledgerData(sm).filter((d) => d.marker === "exhausted").length;
  assert.equal(afterSecond, 1, "second emit at the same dedup key does not write a new entry");
  assert.equal(ledger.warnedKeys.has(key), true);
});

test("markWarning + markExhaustion: independent dedup keys — both fire for the same agent", async () => {
  const { sm, agentSlug, policy } = makeFixture();
  const ledger = await BudgetLedger.restore(sm, agentSlug, policy);

  // Distinct dedup keys per the events.ts contract — warning key has its
  // own slot separate from the exhaustion key, so a worker that crosses the
  // 20% threshold AND then hits the cap fires both (events.ts evaluates
  // warning THEN exhaustion on the same message_end).
  const warningKey = "worker:tokens:test-agent";
  const exhaustionKey = "worker:tokens:test-agent-exhausted";

  // First message: hits 20% remaining → warning fires.
  assert.equal(emitWarning(ledger, warningKey, { tokens: 84_000, costUsd: 0, runs: 1 }), true);
  // Later message: hits 0% remaining → exhaustion fires (distinct key).
  assert.equal(emitExhaustion(ledger, exhaustionKey, { tokens: 100_000, costUsd: 0, runs: 2 }), true);

  const data = ledgerData(sm);
  const warnings = data.filter((d) => d.marker === "warning");
  const exhausted = data.filter((d) => d.marker === "exhausted");
  assert.equal(warnings.length, 1, "warning was written");
  assert.equal(exhausted.length, 1, "exhaustion was written independently");
  assert.equal(ledger.warnedKeys.size, 2, "both dedup keys are recorded");
  assert.equal(ledger.warnedKeys.has(warningKey), true);
  assert.equal(ledger.warnedKeys.has(exhaustionKey), true);
});

// ── Gap #3 — latestCumulativeFor (re-export from policy.ts:277) ────────

/** Seed a branch with explicit ledger entries (raw, no ledger class). */
function seedBranch(entries: BudgetLedgerData[]): { sm: SessionManager; branch: ReturnType<SessionManager["getBranch"]> } {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-coverage-3-"));
  const sm = SessionManager.inMemory(cwd);
  for (const data of entries) {
    sm.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, data);
  }
  return { sm, branch: sm.getBranch() };
}

test("latestCumulativeFor: returns the cumulative for a known agent", () => {
  const { branch } = seedBranch([
    {
      caps: {},
      cumulative: { tokens: 250, costUsd: 0.025, runs: 1 },
      writtenAt: 2_000,
      agentSlug: "worker",
    },
  ]);
  const cumulative = latestCumulativeFor(branch, "worker");
  assert.deepEqual(cumulative, { tokens: 250, costUsd: 0.025, runs: 1 });
});

test("latestCumulativeFor: returns zeroed totals for an unknown agent", () => {
  const { branch } = seedBranch([
    {
      caps: {},
      cumulative: { tokens: 999_999, costUsd: 999, runs: 999 },
      writtenAt: 1_000,
      agentSlug: "someone-else",
    },
  ]);
  const cumulative = latestCumulativeFor(branch, "does-not-exist");
  assert.deepEqual(
    cumulative,
    { tokens: 0, costUsd: 0, runs: 0 },
    "unknown agent returns zeroed totals (not undefined, not someone else's data)",
  );
});

test("latestCumulativeFor: returns the LATEST cumulative when multiple entries exist for the same agent", () => {
  // Three entries for "worker" in branch order (oldest first), plus an
  // unrelated agent. The LATEST worker entry is the second 7500 write —
  // earlier entries are not summed, just replaced.
  const { branch } = seedBranch([
    {
      caps: {},
      cumulative: { tokens: 100, costUsd: 0.01, runs: 1 },
      writtenAt: 1_000,
      agentSlug: "worker",
    },
    {
      caps: {},
      cumulative: { tokens: 999_999, costUsd: 999, runs: 999 },
      writtenAt: 1_500,
      agentSlug: "other-agent",
    },
    {
      caps: {},
      cumulative: { tokens: 2_500, costUsd: 0.25, runs: 2 },
      writtenAt: 2_000,
      agentSlug: "worker",
    },
    {
      caps: {},
      cumulative: { tokens: 7_500, costUsd: 0.75, runs: 3 },
      writtenAt: 3_000,
      agentSlug: "worker",
      marker: "checkpoint",
    },
  ]);
  const cumulative = latestCumulativeFor(branch, "worker");
  assert.deepEqual(
    cumulative,
    { tokens: 7_500, costUsd: 0.75, runs: 3 },
    "returns the LATEST (7_500) — not the sum, not the first",
  );
});
