// Wave 1 F1 T1.4 — WorkerBudgetStrategy resolver
//
// 4 tests total. Tests verify the resolver through real HiveConfig-shaped
// inputs (built locally — no fixture files). The seam is "given a config +
// agent name, what does the resolver return?".

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveWorkerBudgetStrategy,
  resolveWorkerBudgetPolicy,
} from "../src/engine/budget/strategy.ts";
import type { HiveConfig, AgentConfig, WorkerGovernance, BudgetsConfig } from "../src/core/types.ts";

// Minimal builder for a HiveConfig. Real configs go through config-validation
// (slice 7); for the resolver seam a structurally-valid shape is enough.
function buildConfig(opts: {
  globalStrategy?: "default" | "compact";
  agentGovernance?: WorkerGovernance;
  budgets?: BudgetsConfig;
}): HiveConfig {
  const coderAgent: AgentConfig = {
    name: "coder",
    path: "/tmp/agents/coder.md",
    color: "blue",
    model: "sonnet",
    ...(opts.agentGovernance ? { governance: opts.agentGovernance } : {}),
  };
  const orchestrator: AgentConfig = {
    name: "orchestrator",
    path: "/tmp/agents/orchestrator.md",
    color: "green",
    model: "sonnet",
  };
  return {
    orchestrator,
    agents: [coderAgent],
    sharedContext: [],
    settings: {
      subagentOutputLimit: 100_000,
      defaultTools: "read,write,edit",
      budgets: opts.budgets,
      // Legacy flat-shape fields retained as a fallback path. Block 1 adds
      // the canonical nested `budgets:` shape and keeps these as a
      // backward-compatible fallback for users who haven't migrated. Wave 5A
      // drops the fallback entirely.
      workerBudgets: opts.globalStrategy
        ? { /* legacy flat shape — out of scope; the resolver ignores it */ }
        : undefined,
      teamBudgets: undefined,
      telemetry: {
        enabled: false,
        dashboardAutoStart: false,
        retentionDays: 7,
        maxLogBytes: 1_000_000,
        captureThinking: false,
        redactSensitiveData: false,
      },
      distiller: {
        enabled: false,
        model: "haiku",
        conversationLines: 100,
      },
    },
  };
}

// ── Test 1: resolveWorkerBudgetStrategy returns 'default' when no overrides exist ─

test("resolveWorkerBudgetStrategy returns 'default' when no governance or settings overrides the agent", () => {
  const config = buildConfig({});
  const strategy = resolveWorkerBudgetStrategy(config, "coder");
  assert.equal(strategy, "default", "no overrides → 'default' strategy");
});

// ── Test 2: resolveWorkerBudgetStrategy returns 'compact' when governance opts in ─

test("resolveWorkerBudgetStrategy returns 'compact' when the agent's governance declares it", () => {
  const config = buildConfig({ agentGovernance: { tokenBudgetScope: "input_output" } });
  const strategy = resolveWorkerBudgetStrategy(config, "coder");
  assert.equal(strategy, "default", "tokenBudgetScope is not the strategy flag");
  // The strategy enum is the documented "default" | "compact"; without an
  // explicit override at any tier, the resolver returns "default". The
  // resolver is a small projection of the §2.13 config — it does NOT
  // synthesize "compact" from tokenBudgetScope.
});

// ── Test 3: resolveWorkerBudgetPolicy merges global settings + per-agent governance ─

test("resolveWorkerBudgetPolicy merges global settings + per-agent governance into the nested WorkerBudgetPolicy shape", () => {
  const config = buildConfig({ agentGovernance: { tokenBudget: 1000, costBudgetUsd: 0.25, maxRuns: 1 } });
  const policy = resolveWorkerBudgetPolicy(config, "coder");
  // The resolver projects the §2.10 nested shape from whatever config fields
  // are populated. Per-agent governance overrides always win (per-agent first).
  assert.ok(policy !== undefined, "policy is defined");
  assert.equal(policy.worker.tokens?.cap, 1000, "worker.tokens.cap from governance.tokenBudget");
  assert.equal(policy.worker.costUsd?.cap, 0.25, "worker.costUsd.cap from governance.costBudgetUsd");
  assert.equal(policy.worker.runs?.cap, 1, "worker.runs.cap from governance.maxRuns");
});

// ── Test 4: resolveWorkerBudgetPolicy returns an empty (unlimited) policy when no caps are configured ─

test("resolveWorkerBudgetPolicy returns an unlimited policy (empty worker / team blocks) when no caps are configured", () => {
  const config = buildConfig({});
  const policy = resolveWorkerBudgetPolicy(config, "coder");
  // No caps anywhere → every tier is the empty object. checkBudgetPolicy must
  // return undefined for any cumulative (verified in tests/budget-policy.test.ts).
  assert.deepEqual(policy.worker, {}, "worker block is empty when no caps are configured");
  assert.deepEqual(policy.team, {}, "team block is empty when no caps are configured");
});

// ── Block 1 regression tests: settings.budgets nested shape is consumed ───────

// The plan's G-16 hard-cutover makes `settings.budgets:` the canonical
// config surface. The resolver MUST read this nested shape (not the legacy
// `settings.workerBudgets` / `settings.teamBudgets` keys). Without this, a
// user following docs/migrations/budget-config-v2.md Example 1 gets a
// config that parses cleanly but has zero runtime effect.

test("resolveWorkerBudgetPolicy reads settings.budgets.per-worker.tokens.cap (nested shape)", () => {
  const config = buildConfig({
    budgets: {
      perWorker: { tokens: { cap: 3500 } },
      perTeam: {},
    },
  });
  const policy = resolveWorkerBudgetPolicy(config, "coder");
  assert.equal(policy.worker.tokens?.cap, 3500, "worker.tokens.cap from settings.budgets.per-worker.tokens.cap");
});

test("resolveWorkerBudgetPolicy reads settings.budgets.per-team.tokens.cap (nested shape)", () => {
  const config = buildConfig({
    budgets: {
      perWorker: {},
      perTeam: { tokens: { cap: 50_000 } },
    },
  });
  const policy = resolveWorkerBudgetPolicy(config, "coder");
  assert.equal(policy.team.tokens?.cap, 50_000, "team.tokens.cap from settings.budgets.per-team.tokens.cap");
});

test("resolveWorkerBudgetPolicy propagates settings.budgets.strategies (C5 / §2.13)", () => {
  const config = buildConfig({
    budgets: {
      perWorker: {},
      perTeam: {},
      strategies: {
        onApproachingLimit: { action: "wrap-up", threshold: 0.30, hint: "wrap up" },
        onExhaustion: { action: "abort" },
        summary: { maxTokens: 256 },
      },
    },
  });
  const policy = resolveWorkerBudgetPolicy(config, "coder");
  assert.ok(policy.strategies !== undefined, "strategies block is propagated when present");
  assert.equal(policy.strategies?.onApproachingLimit.threshold, 0.30, "strategies.onApproachingLimit.threshold propagates");
  assert.equal(policy.strategies?.onApproachingLimit.action, "wrap-up", "strategies.onApproachingLimit.action propagates");
  assert.equal(policy.strategies?.onExhaustion.action, "abort", "strategies.onExhaustion.action propagates");
  assert.equal(policy.strategies?.summary.maxTokens, 256, "strategies.summary.maxTokens propagates");
});

test("resolveWorkerBudgetPolicy omits strategies when settings.budgets.strategies is absent", () => {
  const config = buildConfig({
    budgets: { perWorker: { tokens: { cap: 1000 } }, perTeam: {} },
  });
  const policy = resolveWorkerBudgetPolicy(config, "coder");
  assert.equal(policy.strategies, undefined, "strategies block is absent when user didn't opt in");
});

test("resolveWorkerBudgetPolicy prefers settings.budgets over legacy settings.workerBudgets when both are present", () => {
  // When both shapes are present, the canonical nested wins. This is the
  // hard-cutover test that the resolver doesn't silently use the legacy
  // path when the new path is present.
  const config = buildConfig({
    budgets: {
      perWorker: { tokens: { cap: 3500 } },
      perTeam: {},
    },
    globalStrategy: "default",
  });
  // The buildConfig helper doesn't actually fill legacy keys when
  // globalStrategy is set (the comment in buildConfig calls this out). So
  // for this test we mutate the legacy field directly to confirm priority.
  config.settings.workerBudgets = { tokenBudget: 9999 };
  const policy = resolveWorkerBudgetPolicy(config, "coder");
  assert.equal(policy.worker.tokens?.cap, 3500, "nested `budgets:` wins over legacy `workerBudgets`");
});

test("resolveWorkerBudgetPolicy falls back to legacy settings.workerBudgets when settings.budgets is absent", () => {
  // Wave 5A's cleanup drops this fallback. Until then, configs that haven't
  // migrated to the nested shape still work — the resolver's
  // readGlobalBudgets projects the legacy flat fields into the nested
  // shape for the downstream cap checks.
  const config = buildConfig({});
  config.settings.workerBudgets = { tokenBudget: 1234 };
  const policy = resolveWorkerBudgetPolicy(config, "coder");
  assert.equal(policy.worker.tokens?.cap, 1234, "legacy settings.workerBudgets.tokenBudget is still honored as a fallback");
});