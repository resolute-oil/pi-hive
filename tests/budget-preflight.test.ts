/**
 * Wave 2 — F2 / T2 / §2.5 — direct tests for `runBudgetPreflight`.
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md
 *   §2.5 — Pre-flight gate (the single source of truth for the cap/depth gate)
 *   §2.13 — C1/C4 — per-agent overrides + the depth resource
 *
 * Coverage (7 tests):
 *   1. Returns the documented `{ policy, depth }` shape.
 *   2. Unknown agent throws a plain Error with a clear message.
 *   3. Missing `ctx.sessionManager` exercises the no-op fast path — returns
 *      `{ policy, depth }` without throwing, regardless of cap configuration.
 *   4. T2.3 isolated — depth-cap violation throws BudgetExhaustedError with
 *      `scope: "worker", resource: "depth"`.
 *   5. Isolated — tokens-cap violation throws BudgetExhaustedError with
 *      `scope: "worker", resource: "tokens"`.
 *   6. Isolated — cost-cap violation throws BudgetExhaustedError with
 *      `scope: "worker", resource: "costUsd"`.
 *   7. Multiple caps configured, all below threshold → no throw; the
 *      returned `{ policy, depth }` reflects the resolved policy verbatim.
 *
 * The tests seed the branch directly on the SessionManager used by the
 * pre-flight (via `SessionManager.inMemory` + `appendCustomEntry`). This
 * mirrors the production restore path: the ledger reads the branch, picks
 * the latest cumulative per `agentSlug`, and `checkBudgetPolicy` evaluates
 * worker + team resources against the resolved caps.
 *
 * Hard constraints honored:
 *   - No `Math.random()` / `Date.now()` / `setTimeout()` in test code.
 *   - Each assertion carries a descriptive third argument.
 *   - No implementation changes — pure test additions.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runAtDelegationDepth } from "../src/engine/session.ts";
import {
  BUDGET_EXHAUSTED_ERROR_NAME,
  runBudgetPreflight,
} from "../src/engine/budget/worker-tools.ts";
import { BUDGET_LEDGER_CUSTOM_TYPE } from "../src/engine/budget/ledger.ts";
import type { AgentConfig, AgentRuntime, HiveConfig, HiveState } from "../src/core/types.ts";

// ---------------------------------------------------------------------------
// Fixture builders — minimal HiveState + ExtensionContext. We avoid the heavy
// `createAgentSession` path entirely: the pre-flight never creates a session.
// ---------------------------------------------------------------------------

function makeRuntime(agentConfig: AgentConfig): AgentRuntime {
  return {
    config: agentConfig,
    systemPrompt: "",
    status: "idle",
    task: "",
    lastWork: "",
    toolCount: 0,
    elapsedMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    contextPct: 0,
    runCount: 0,
    sessionFile: "",
  };
}

interface PreflightOpts {
  agentName?: string;
  /** Per-worker caps to inject under `settings.budgets.perWorker`. */
  perWorker?: {
    tokens?: number;
    costUsd?: number;
    runs?: number;
    depth?: number;
  };
  /** Per-team caps to inject under `settings.budgets.perTeam`. */
  perTeam?: {
    tokens?: number;
    costUsd?: number;
    runs?: number;
  };
}

function makeState(opts: PreflightOpts = {}): HiveState {
  const agentName = opts.agentName ?? "Builder";
  const slug = agentName.toLowerCase();
  const agentConfig: AgentConfig = {
    name: agentName,
    path: `${slug}.md`,
    slug,
    agentType: "lead",
  };

  const budgets: NonNullable<HiveConfig["settings"]["budgets"]> = {};
  if (opts.perWorker || opts.perTeam) {
    budgets.perWorker = {
      ...(opts.perWorker?.tokens !== undefined ? { tokens: { resource: "tokens", cap: opts.perWorker.tokens } } : {}),
      ...(opts.perWorker?.costUsd !== undefined ? { costUsd: { resource: "costUsd", cap: opts.perWorker.costUsd } } : {}),
      ...(opts.perWorker?.runs !== undefined ? { runs: { resource: "runs", cap: opts.perWorker.runs } } : {}),
      ...(opts.perWorker?.depth !== undefined ? { depth: { resource: "depth", cap: opts.perWorker.depth } } : {}),
    };
    if (opts.perTeam) {
      budgets.perTeam = {
        ...(opts.perTeam.tokens !== undefined ? { tokens: { resource: "tokens", cap: opts.perTeam.tokens } } : {}),
        ...(opts.perTeam.costUsd !== undefined ? { costUsd: { resource: "costUsd", cap: opts.perTeam.costUsd } } : {}),
        ...(opts.perTeam.runs !== undefined ? { runs: { resource: "runs", cap: opts.perTeam.runs } } : {}),
      };
    }
  }

  const config: HiveConfig = {
    orchestrator: { name: "Orchestrator", path: "o.md", slug: "orchestrator" },
    agents: [agentConfig],
    sharedContext: [],
    settings: {
      subagentOutputLimit: 100,
      defaultTools: "read",
      distiller: { enabled: false, model: "", conversationLines: 10 },
      budgets,
    },
  };

  const runtime = makeRuntime(agentConfig);
  return {
    pi: {} as HiveState["pi"],
    config,
    session: null,
    runtimes: new Map([[slug, runtime]]),
    widgetCtx: null,
    activeRuns: 0,
    mode: "hive",
    normalToolNames: [],
    sddStatus: null,
    obsSeq: 0,
  };
}

/** Build a SessionManager and seed ledger entries for `agentSlug` so the pre-flight sees non-trivial totals. */
function makeSeededSessionManager(
  agentSlug: string,
  cumulative: Array<{ tokens: number; costUsd: number; runs: number }>,
): { cwd: string; sm: SessionManager } {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-preflight-"));
  const sm = SessionManager.inMemory(cwd);
  for (const entry of cumulative) {
    sm.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, {
      caps: {},
      cumulative: entry,
      writtenAt: 0,
      agentSlug,
    });
  }
  return { cwd, sm };
}

function makeCtx(sessionManager: SessionManager | undefined): ExtensionContext {
  return {
    cwd: "/tmp/pi-hive-preflight",
    sessionManager: sessionManager as unknown as ExtensionContext["sessionManager"],
    ui: {} as ExtensionContext["ui"],
    mode: "tui",
    hasUI: true,
    modelRegistry: {} as ExtensionContext["modelRegistry"],
    model: undefined,
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => "",
  };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

// ── Case 1: returns the documented { policy, depth } shape ──────────────

test("runBudgetPreflight: returns the documented { policy, depth } shape (no ledger field — the spine restores its own)", async () => {
  const state = makeState({ perWorker: { tokens: 1000 } });
  const { sm } = makeSeededSessionManager("builder", [{ tokens: 0, costUsd: 0, runs: 0 }]);
  const ctx = makeCtx(sm);

  const result = await runBudgetPreflight(state, "Builder", ctx);

  assert.ok(result, "result is defined");
  assert.ok("policy" in result, "result carries a `policy` field");
  assert.ok("depth" in result, "result carries a `depth` field");
  assert.equal(result.policy.worker.tokens?.cap, 1000, "policy reflects the resolved per-worker tokens cap");
  assert.equal(typeof result.depth, "number", "depth is a number");
  assert.equal(result.depth, 1, "depth = currentDelegationDepth() + 1 = 0 + 1 at the top level");
  // The pre-flight intentionally does NOT return a ledger — the caller restores
  // its own ledger against the WORKER's SessionManager (see delegateAgent §2.4).
  assert.equal((result as { ledger?: unknown }).ledger, undefined, "no `ledger` field — callers restore their own");
});

// ── Case 2: unknown agent throws a plain Error with a clear message ─────

test("runBudgetPreflight: unknown agent throws a plain Error (NOT BudgetExhaustedError) with the agent name in the message", async () => {
  const state = makeState({ agentName: "Builder", perWorker: { tokens: 1000 } });
  const { sm } = makeSeededSessionManager("builder", [{ tokens: 0, costUsd: 0, runs: 0 }]);
  const ctx = makeCtx(sm);

  await assert.rejects(
    () => runBudgetPreflight(state, "Nonexistent", ctx),
    (err: Error) => {
      assert.notEqual(err.name, BUDGET_EXHAUSTED_ERROR_NAME, "name is NOT BudgetExhaustedError — that is reserved for cap/depth blocks");
      assert.ok(err instanceof Error, "throws an Error instance");
      assert.match(err.message, /unknown agent/i, "message contains 'unknown agent'");
      assert.match(err.message, /Nonexistent/, "message contains the requested agent name");
      return true;
    },
  );
});

// ── Case 3: missing ctx.sessionManager → no-op fast path, no throw ──────

test("runBudgetPreflight: missing ctx.sessionManager exercises the no-op fast path — returns { policy, depth } without throwing, even with caps configured", async () => {
  const state = makeState({ perWorker: { tokens: 1000, costUsd: 5, runs: 3, depth: 2 } });
  const ctx = makeCtx(undefined); // sessionManager absent

  const result = await runBudgetPreflight(state, "Builder", ctx);

  assert.ok(result, "result is defined (no throw)");
  assert.ok(result.policy, "policy is present");
  assert.equal(result.policy.worker.tokens?.cap, 1000, "policy carries the configured caps even when the branch read is skipped");
  assert.equal(typeof result.depth, "number", "depth is still computed from currentDelegationDepth()");
  assert.equal(result.depth, 1, "depth = 1 at the top level");
});

// ── Case 4: T2.3 isolated — depth-cap violation throws BudgetExhaustedError ──

test("T2.3 (isolated): depth-cap violation throws BudgetExhaustedError with scope=worker, resource=depth", async () => {
  // depth cap = 1. With runAtDelegationDepth(2, ...) the dispatch would push
  // depth to 3, which trips the strict-greater-than check (3 > 1).
  // No other caps are configured — the depth check is the only one that can fire.
  const state = makeState({ perWorker: { depth: 1 } });
  const { sm } = makeSeededSessionManager("builder", [{ tokens: 0, costUsd: 0, runs: 0 }]);
  const ctx = makeCtx(sm);

  let caught: (Error & { scope?: string; resource?: string }) | undefined;
  await runAtDelegationDepth(2, async () => {
    try {
      await runBudgetPreflight(state, "Builder", ctx);
    } catch (e) {
      caught = e as typeof caught;
    }
  });

  assert.ok(caught, "must throw");
  assert.equal(caught!.name, BUDGET_EXHAUSTED_ERROR_NAME, "name is BudgetExhaustedError");
  assert.equal(caught!.scope, "worker", "scope=worker");
  assert.equal(caught!.resource, "depth", "resource=depth");
  assert.match(caught!.message, /depth budget exhausted/i, "message explains the depth exhaustion");
});

// ── Case 5: isolated — tokens-cap violation throws BudgetExhaustedError ──

test("isolated: tokens-cap violation throws BudgetExhaustedError with scope=worker, resource=tokens", async () => {
  // tokens cap = 100, cumulative tokens = 100 (equal, not greater — `>=` is the threshold).
  // No other caps configured — the tokens check is the only one that can fire.
  const state = makeState({ perWorker: { tokens: 100 } });
  const { sm } = makeSeededSessionManager(
    "builder",
    [{ tokens: 100, costUsd: 0, runs: 0 }],
  );
  const ctx = makeCtx(sm);

  await assert.rejects(
    () => runBudgetPreflight(state, "Builder", ctx),
    (err: Error & { scope?: string; resource?: string }) => {
      assert.equal(err.name, BUDGET_EXHAUSTED_ERROR_NAME, "name is BudgetExhaustedError");
      assert.equal(err.scope, "worker", "scope=worker");
      assert.equal(err.resource, "tokens", "resource=tokens");
      assert.match(err.message, /token budget exhausted/i, "message explains the tokens exhaustion");
      return true;
    },
  );
});

// ── Case 6: isolated — cost-cap violation throws BudgetExhaustedError ───

test("isolated: cost-cap violation throws BudgetExhaustedError with scope=worker, resource=costUsd", async () => {
  // Only cost cap is set (no tokens cap → tokens check is skipped via the
  // `undefined` guard). costUsd cap = 1, cumulative costUsd = 1 — the
  // cost check fires first among worker-scope checks when tokens is unset.
  const state = makeState({ perWorker: { costUsd: 1 } });
  const { sm } = makeSeededSessionManager(
    "builder",
    [{ tokens: 0, costUsd: 1, runs: 0 }],
  );
  const ctx = makeCtx(sm);

  await assert.rejects(
    () => runBudgetPreflight(state, "Builder", ctx),
    (err: Error & { scope?: string; resource?: string }) => {
      assert.equal(err.name, BUDGET_EXHAUSTED_ERROR_NAME, "name is BudgetExhaustedError");
      assert.equal(err.scope, "worker", "scope=worker");
      assert.equal(err.resource, "costUsd", "resource=costUsd");
      assert.match(err.message, /cost budget exhausted/i, "message explains the cost exhaustion");
      return true;
    },
  );
});

// ── Case 7: multiple caps configured, all below threshold → no throw ───

test("multiple caps: when ALL caps are below threshold, the pre-flight does NOT throw and returns the resolved policy verbatim", async () => {
  // tokens cap = 1000 (cumulative 100 ≪ 1000)
  // costUsd cap = 5 (cumulative 0.5 ≪ 5)
  // runs cap = 10 (cumulative 1 ≪ 10)
  // depth cap = 5 (depth = 1 ≪ 5 — strict-greater-than guard, so 1 ≤ 5 does NOT block)
  const state = makeState({
    perWorker: { tokens: 1000, costUsd: 5, runs: 10, depth: 5 },
    perTeam: { tokens: 10_000, costUsd: 50, runs: 100 },
  });
  const { sm } = makeSeededSessionManager(
    "builder",
    [{ tokens: 100, costUsd: 0.5, runs: 1 }],
  );
  const ctx = makeCtx(sm);

  const result = await runBudgetPreflight(state, "Builder", ctx);

  assert.ok(result, "result is defined");
  assert.equal(result.policy.worker.tokens?.cap, 1000, "worker.tokens cap preserved");
  assert.equal(result.policy.worker.costUsd?.cap, 5, "worker.costUsd cap preserved");
  assert.equal(result.policy.worker.runs?.cap, 10, "worker.runs cap preserved");
  assert.equal(result.policy.worker.depth?.cap, 5, "worker.depth cap preserved");
  assert.equal(result.policy.team.tokens?.cap, 10_000, "team.tokens cap preserved");
  assert.equal(result.policy.team.costUsd?.cap, 50, "team.costUsd cap preserved");
  assert.equal(result.policy.team.runs?.cap, 100, "team.runs cap preserved");
  assert.equal(result.depth, 1, "depth = 1");
});
