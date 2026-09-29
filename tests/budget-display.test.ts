/**
 * Wave 5 / F9 — direct tests for the display-only budget helpers.
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md
 *   §2.5 — display surface (`budgetRemaining`)
 *   §3.9 — `effectiveWorkerGovernance` (preserved name + empty body)
 *
 * Coverage (8 tests):
 *   effectiveWorkerGovernance:
 *   1. Returns a frozen empty object.
 *   2. Returns a fresh reference on every call (not memoized).
 *   3. The returned object rejects mutation (strict-mode write throws).
 *
 *   budgetRemaining:
 *   4. Returns the shape `{ worker: BudgetRemaining, team: BudgetRemaining }`.
 *   5. With no spend, returns caps as the remaining values.
 *   6. With partial spend, computes (cap - cumulative) correctly.
 *   7. Window metadata on a cap does not change the (cap - used) math.
 *   8. Multiple caps (tokens + cost + runs) compute independently per resource.
 *
 * Hard constraints honored:
 *   - No `Math.random()` / `Date.now()` / `setTimeout()` in test code.
 *   - No implementation changes — pure test additions.
 *   - Each assertion carries a descriptive third argument for ESLint hygiene.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  budgetRemaining,
  effectiveWorkerGovernance,
  getBudgetsConfig,
} from "../src/engine/budget/display.ts";
import type { AgentRuntime, HiveState } from "../src/core/types.ts";

// ---------------------------------------------------------------------------
// Minimal test fixture builder. Tests only need enough of HiveState / AgentRuntime
// to exercise the display layer — we omit fields the display code never reads.
// ---------------------------------------------------------------------------

interface RuntimeFields {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  runCount?: number;
}

function makeRuntime(name: string, fields: RuntimeFields = {}, role: "lead" | "member" | "orchestrator" = "lead"): AgentRuntime {
  return {
    config: { name, path: `${name.toLowerCase()}.md`, slug: name.toLowerCase(), role },
    systemPrompt: "",
    status: "idle",
    task: "",
    lastWork: "",
    toolCount: 0,
    elapsedMs: 0,
    inputTokens: fields.inputTokens ?? 0,
    outputTokens: fields.outputTokens ?? 0,
    cacheReadTokens: fields.cacheReadTokens ?? 0,
    cacheWriteTokens: fields.cacheWriteTokens ?? 0,
    reasoningTokens: fields.reasoningTokens ?? 0,
    costUsd: fields.costUsd ?? 0,
    contextPct: 0,
    runCount: fields.runCount ?? 0,
    sessionFile: "",
  };
}

interface MakeStateOpts {
  worker?: RuntimeFields;
  /** Extra runtimes to seed alongside the worker. Excluded from worker totals. */
  team?: Array<{ name: string; fields: RuntimeFields }>;
  /** Caps to populate on `settings.budgets.perWorker`. */
  perWorker?: { tokens?: number; costUsd?: number; runs?: number; window?: "per-day" | "per-session" | "per-run" | "per-hour" | "per-team-lifetime" };
  /** Caps to populate on `settings.budgets.perTeam`. */
  perTeam?: { tokens?: number; costUsd?: number; runs?: number };
}

function makeState(opts: MakeStateOpts = {}): HiveState {
  const workerName = "Builder";
  const workerRuntime: AgentRuntime = makeRuntime(workerName, opts.worker ?? {}, "lead");
  // The orchestrator is excluded from team totals. We add it as an "orchestrator"
  // role runtime to verify the team aggregation skips it (per display.ts:teamRuns).
  const orchestratorRuntime = makeRuntime("Orchestrator", {}, "orchestrator");
  const teamRuntimes = (opts.team ?? []).map((t) => makeRuntime(t.name, t.fields, "lead"));
  const runtimes = new Map<string, AgentRuntime>([
    [workerRuntime.config.slug!, workerRuntime],
    [orchestratorRuntime.config.slug!, orchestratorRuntime],
    ...teamRuntimes.map((r) => [r.config.slug!, r] as const),
  ]);

  const workerCapsBlock: Record<string, unknown> = {};
  if (opts.perWorker?.tokens !== undefined) {
    workerCapsBlock.tokens = opts.perWorker.window !== undefined
      ? { resource: "tokens", cap: opts.perWorker.tokens, window: opts.perWorker.window }
      : { resource: "tokens", cap: opts.perWorker.tokens };
  }
  if (opts.perWorker?.costUsd !== undefined) {
    workerCapsBlock.costUsd = { resource: "costUsd", cap: opts.perWorker.costUsd };
  }
  if (opts.perWorker?.runs !== undefined) {
    workerCapsBlock.runs = { resource: "runs", cap: opts.perWorker.runs };
  }

  const teamCapsBlock: Record<string, unknown> = {};
  if (opts.perTeam?.tokens !== undefined) {
    teamCapsBlock.tokens = { resource: "tokens", cap: opts.perTeam.tokens };
  }
  if (opts.perTeam?.costUsd !== undefined) {
    teamCapsBlock.costUsd = { resource: "costUsd", cap: opts.perTeam.costUsd };
  }
  if (opts.perTeam?.runs !== undefined) {
    teamCapsBlock.runs = { resource: "runs", cap: opts.perTeam.runs };
  }

  return {
    pi: {} as HiveState["pi"],
    config: {
      orchestrator: { name: "Orchestrator", path: "o.md", slug: "orchestrator" },
      agents: [workerRuntime.config, ...teamRuntimes.map((r) => r.config)],
      sharedContext: [],
      settings: {
        subagentOutputLimit: 100,
        defaultTools: "read",
        distiller: { enabled: false, model: "", conversationLines: 10 },
        budgets: {
          perWorker: workerCapsBlock as never,
          perTeam: teamCapsBlock as never,
        },
      },
    },
    session: null,
    runtimes,
    widgetCtx: null,
    activeRuns: 0,
    mode: "hive",
    normalToolNames: [],
    sddStatus: null,
    obsSeq: 0,
  };
}

// ---------------------------------------------------------------------------
// effectiveWorkerGovernance — 3 tests
// ---------------------------------------------------------------------------

// ── Case 1: returns a frozen empty object ───────────────────────────────

test("effectiveWorkerGovernance: returns a frozen empty object", () => {
  const state = makeState();
  const runtime = state.runtimes.get("builder")!;
  const result = effectiveWorkerGovernance(state, runtime);

  assert.deepEqual(result, {}, "the body is empty after Wave 1B removed the legacy `governance:` block");
  assert.ok(Object.isFrozen(result), "result is Object.freeze()-sealed");
});

// ── Case 2: fresh reference per call (no memoization across calls) ──────

test("effectiveWorkerGovernance: returns a fresh object reference on each call (not memoized)", () => {
  const state = makeState();
  const runtime = state.runtimes.get("builder")!;

  const a = effectiveWorkerGovernance(state, runtime);
  const b = effectiveWorkerGovernance(state, runtime);
  const c = effectiveWorkerGovernance(state, runtime);

  assert.notEqual(a, b, "second call returns a distinct reference");
  assert.notEqual(b, c, "third call returns a distinct reference");
  assert.deepEqual(a, {}, "all calls return equivalent empty-object shapes");
  assert.deepEqual(b, {}, "all calls return equivalent empty-object shapes");
  assert.deepEqual(c, {}, "all calls return equivalent empty-object shapes");
});

// ── Case 3: the frozen object rejects mutation in strict mode ───────────

test("effectiveWorkerGovernance: returned object rejects property writes (mutation impossible)", () => {
  const state = makeState();
  const runtime = state.runtimes.get("builder")!;
  const result = effectiveWorkerGovernance(state, runtime) as Record<string, unknown>;

  // In strict-mode TypeScript (which the test suite uses via tsconfig.tests.json),
  // writing to a frozen object throws. ESLint + tsc both enforce this; we mirror
  // the runtime contract here so a future caller that breaks the seal trips the test.
  assert.throws(
    () => {
      result.timeoutMs = 1000;
    },
    /Cannot assign to read only property|Cannot redefine property|object is not extensible/i,
    "Object.freeze() in strict mode throws on write to existing or new property",
  );
});

// ---------------------------------------------------------------------------
// budgetRemaining — 5 tests
// ---------------------------------------------------------------------------

// ── Case 4: shape — returns { worker, team } objects with the documented fields ─

test("budgetRemaining: returns the documented { worker, team } shape with the four resource fields", () => {
  const state = makeState({
    perWorker: { tokens: 100, costUsd: 5, runs: 3 },
    perTeam: { tokens: 1000, costUsd: 50, runs: 20 },
  });
  const runtime = state.runtimes.get("builder")!;

  const result = budgetRemaining(state, runtime);

  assert.ok("worker" in result, "top-level worker key present");
  assert.ok("team" in result, "top-level team key present");
  assert.deepEqual(Object.keys(result.worker).sort(), ["costUsd", "distillerRuns", "runs", "tokens"], "worker exposes runs/tokens/costUsd/distillerRuns");
  assert.deepEqual(Object.keys(result.team).sort(), ["costUsd", "runs", "tokens"], "team exposes runs/tokens/costUsd (no distillerRuns)");
  assert.equal(result.worker.distillerRuns, undefined, "distillerRuns is always undefined post-cutover (F9)");
});

// ── Case 5: no spend — caps ARE the remaining values ───────────────────

test("budgetRemaining: with no spend (cumulative = 0), the remaining equals the cap for every resource", () => {
  const state = makeState({
    perWorker: { tokens: 1000, costUsd: 5, runs: 3 },
    perTeam: { tokens: 10_000, costUsd: 50, runs: 20 },
  });
  const runtime = state.runtimes.get("builder")!;

  const result = budgetRemaining(state, runtime);

  assert.equal(result.worker.tokens, 1000, "worker.tokens = cap when no spend");
  assert.equal(result.worker.costUsd, 5, "worker.costUsd = cap when no spend");
  assert.equal(result.worker.runs, 3, "worker.runs = cap when no spend");
  assert.equal(result.team.tokens, 10_000, "team.tokens = cap when no spend");
  assert.equal(result.team.costUsd, 50, "team.costUsd = cap when no spend");
  assert.equal(result.team.runs, 20, "team.runs = cap when no spend");
});

// ── Case 6: partial spend — (cap - cumulative) per resource ─────────────

test("budgetRemaining: partial spend yields (cap - cumulative) per resource, clamped at 0", () => {
  const state = makeState({
    worker: {
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: 25,
      cacheWriteTokens: 25,
      costUsd: 1.5,
      runCount: 1,
    },
    perWorker: { tokens: 1000, costUsd: 5, runs: 3 },
  });
  const runtime = state.runtimes.get("builder")!;

  const result = budgetRemaining(state, runtime);

  // Worker cumulative tokens: 200 + 50 + 25 + 25 = 300 (reasoning tokens default = 0)
  assert.equal(result.worker.tokens, 700, "worker.tokens = 1000 - 300");
  assert.equal(result.worker.costUsd, 3.5, "worker.costUsd = 5 - 1.5");
  assert.equal(result.worker.runs, 2, "worker.runs = 3 - 1");
});

test("budgetRemaining: spend that exceeds the cap clamps to 0 (never negative)", () => {
  const state = makeState({
    worker: { inputTokens: 5000, outputTokens: 0, costUsd: 10, runCount: 10 },
    perWorker: { tokens: 100, costUsd: 5, runs: 3 },
  });
  const runtime = state.runtimes.get("builder")!;

  const result = budgetRemaining(state, runtime);

  assert.equal(result.worker.tokens, 0, "tokens clamp at 0 when cumulative > cap");
  assert.equal(result.worker.costUsd, 0, "costUsd clamps at 0 when cumulative > cap");
  assert.equal(result.worker.runs, 0, "runs clamp at 0 when cumulative > cap");
});

// ── Case 7: window metadata on a cap does not change the math ──────────

test("budgetRemaining: a `window:` field on a cap is metadata — it does not change the (cap - used) math", () => {
  const stateWithWindow = makeState({
    worker: { inputTokens: 100, outputTokens: 0 },
    perWorker: { tokens: 1000, window: "per-day" },
  });
  const stateWithoutWindow = makeState({
    worker: { inputTokens: 100, outputTokens: 0 },
    perWorker: { tokens: 1000 },
  });
  const runtimeWith = stateWithWindow.runtimes.get("builder")!;
  const runtimeWithout = stateWithoutWindow.runtimes.get("builder")!;

  const withWindow = budgetRemaining(stateWithWindow, runtimeWith);
  const withoutWindow = budgetRemaining(stateWithoutWindow, runtimeWithout);

  assert.equal(withWindow.worker.tokens, 900, "per-day window: tokens remaining = cap - used");
  assert.equal(withoutWindow.worker.tokens, 900, "no window: tokens remaining = cap - used");
  assert.equal(
    withWindow.worker.tokens,
    withoutWindow.worker.tokens,
    "window field is preserved by resolveWindow but display-layer math is identical",
  );
});

// ── Case 8: multiple caps stack independently (no cross-contamination) ──

test("budgetRemaining: tokens / cost / runs compute independently — partial spend in one does not affect the others", () => {
  const state = makeState({
    worker: { inputTokens: 400, outputTokens: 0, costUsd: 1, runCount: 1 },
    team: [
      { name: "Tester", fields: { inputTokens: 200, outputTokens: 0, costUsd: 0.5, runCount: 1 } },
      { name: "Reviewer", fields: { inputTokens: 300, outputTokens: 0, costUsd: 0.25, runCount: 1 } },
    ],
    perWorker: { tokens: 1000, costUsd: 5, runs: 4 },
    perTeam: { tokens: 10_000, costUsd: 50, runs: 20 },
  });
  const runtime = state.runtimes.get("builder")!;

  const result = budgetRemaining(state, runtime);

  // Worker totals — the worker is excluded from its own team aggregate, so the team
  // sums only Tester + Reviewer (and the orchestrator is filtered out by role).
  assert.equal(result.worker.tokens, 600, "worker.tokens: 1000 - 400 (only this worker's own spend)");
  assert.equal(result.worker.costUsd, 4, "worker.costUsd: 5 - 1");
  assert.equal(result.worker.runs, 3, "worker.runs: 4 - 1");

  // Team totals — sum the LATEST cumulative of every non-orchestrator runtime EXCLUDING
  // the worker whose perspective we're computing from (display.ts teamRuns/Cost/Tokens).
  // Tester (200) + Reviewer (300) = 500 team tokens; the worker's own 400 is excluded.
  assert.equal(result.team.tokens, 9500, "team.tokens: 10000 - (200 + 300)");
  assert.equal(result.team.costUsd, 49.25, "team.costUsd: 50 - (0.5 + 0.25)");
  assert.equal(result.team.runs, 18, "team.runs: 20 - (1 + 1)");
});

// ── B5: getBudgetsConfig(state) centralizes the duplicated
//     `state.config?.settings as unknown as { budgets?: ... }` cast.
//     Three call sites in worker-tools.ts and display.ts used to repeat
//     this cast; the helper returns the cast-once value.
// ---------------------------------------------------------------------------

test("getBudgetsConfig: returns perWorker + perTeam from settings.budgets when present", () => {
  const state = makeState({
    perWorker: { tokens: 100, costUsd: 5, runs: 3 },
    perTeam: { tokens: 1000, costUsd: 50, runs: 20 },
  });
  const result = getBudgetsConfig(state);
  assert.deepEqual(result.perWorker, {
    tokens: { resource: "tokens", cap: 100 },
    costUsd: { resource: "costUsd", cap: 5 },
    runs: { resource: "runs", cap: 3 },
  });
  assert.deepEqual(result.perTeam, {
    tokens: { resource: "tokens", cap: 1000 },
    costUsd: { resource: "costUsd", cap: 50 },
    runs: { resource: "runs", cap: 20 },
  });
});

test("getBudgetsConfig: returns empty objects when the budgets block exists but is unpopulated", () => {
  const state = makeState();  // default: empty perWorker/perTeam blocks present
  const result = getBudgetsConfig(state);
  assert.deepEqual(result.perWorker, {}, "perWorker is the empty object the budgets block carries");
  assert.deepEqual(result.perTeam, {}, "perTeam is the empty object the budgets block carries");
});

test("getBudgetsConfig: returns undefined when state.config is missing entirely", () => {
  const state = makeState();
  state.config = null;
  const result = getBudgetsConfig(state);
  assert.equal(result.perWorker, undefined);
  assert.equal(result.perTeam, undefined);
});
