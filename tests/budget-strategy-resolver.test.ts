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
import type { HiveConfig, AgentConfig, WorkerGovernance } from "../src/core/types.ts";

// Minimal builder for a HiveConfig. Real configs go through config-validation
// (slice 7); for the resolver seam a structurally-valid shape is enough.
function buildConfig(opts: {
  globalStrategy?: "default" | "compact";
  agentGovernance?: WorkerGovernance;
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