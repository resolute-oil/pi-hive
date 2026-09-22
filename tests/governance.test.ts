import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRuntime, HiveState } from "../src/core/types.ts";
import {
  acquireWorkerSlot,
  budgetRemaining,
  checkDispatchBudgets,
  effectiveWorkerGovernance,
  releaseWorkerSlot,
} from "../src/engine/governance.ts";

function runtime(name: string, overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    config: { name, path: `${name}.md`, role: "member", governance: undefined },
    systemPrompt: "", status: "idle", task: "", lastWork: "", toolCount: 0, elapsedMs: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, costUsd: 0, contextPct: 0, runCount: 0, sessionFile: `${name}.jsonl`,
    ...overrides,
  };
}

function state(runtimes: AgentRuntime[], settings: Record<string, unknown> = {}): HiveState {
  return {
    config: { settings, orchestrator: { name: "Main", path: "main.md" }, agents: [], sharedContext: [] } as any,
    runtimes: new Map(runtimes.map((entry) => [entry.config.name, entry])),
    activeRuns: 0,
    workerQueue: [],
    nextQueueId: 0,
  } as any;
}

test("worker governance is unlimited when omitted and supports per-agent overrides", () => {
  const worker = runtime("worker");
  const hive = state([worker]);
  assert.deepEqual(effectiveWorkerGovernance(hive, worker), {});
  assert.equal(checkDispatchBudgets(hive, worker, 1000), undefined);
  assert.ok(Object.values(budgetRemaining(hive, worker).worker).every((value) => value === undefined));
  assert.ok(Object.values(budgetRemaining(hive, worker).team).every((value) => value === undefined));

  hive.config!.settings.worker = { maxRuns: 5, timeoutMs: 1000 };
  worker.config.governance = { maxRuns: 2 };
  assert.deepEqual(effectiveWorkerGovernance(hive, worker), { maxRuns: 2, timeoutMs: 1000 });
});

test("worker and team budgets block independently and report remaining values", () => {
  const first = runtime("first", { runCount: 2, inputTokens: 60, outputTokens: 40, costUsd: 1.5 });
  const second = runtime("second", { runCount: 1, inputTokens: 25, costUsd: 0.5 });
  const hive = state([first, second], {
    worker: { maxRuns: 2, tokenBudget: 100, costBudgetUsd: 2, maxDelegationDepth: 3, distillerRuns: 1 },
    teamBudgets: { maxRuns: 4, tokenBudget: 200, costBudgetUsd: 3 },
  });
  assert.equal(checkDispatchBudgets(hive, first, 1)?.scope, "worker");
  assert.deepEqual(budgetRemaining(hive, second), {
    worker: { runs: 1, tokens: 75, costUsd: 1.5, distillerRuns: 1 },
    team: { runs: 1, tokens: 75, costUsd: 1 },
  });
  second.runCount = 2;
  assert.equal(checkDispatchBudgets(hive, second, 4)?.resource, "depth");
  first.config.governance = { maxRuns: 10, tokenBudget: 1000, costBudgetUsd: 10, maxDelegationDepth: 10 };
  second.config.governance = { maxRuns: 10, tokenBudget: 1000, costBudgetUsd: 10, maxDelegationDepth: 10 };
  assert.equal(checkDispatchBudgets(hive, second, 1)?.scope, "team");
});

test("monotonic governance usage prevents fresh transcript resets from bypassing budgets", () => {
  const worker = runtime("worker", { inputTokens: 5, governanceTokens: 100, costUsd: 0.1, governanceCostUsd: 4 });
  const hive = state([worker], { worker: { tokenBudget: 100, costBudgetUsd: 10 } });
  assert.equal(checkDispatchBudgets(hive, worker, 1)?.resource, "tokens");
  assert.equal(budgetRemaining(hive, worker).worker.costUsd, 6);
});

test("worker slot queue is FIFO and reserves released slots without races", async () => {
  const hive = state([], { maxParallel: 1, queueSize: 2 });
  assert.equal(await acquireWorkerSlot(hive), "acquired");
  assert.equal(hive.activeRuns, 1);

  const order: number[] = [];
  const first = acquireWorkerSlot(hive).then((result) => { order.push(1); return result; });
  const second = acquireWorkerSlot(hive).then((result) => { order.push(2); return result; });
  assert.equal(hive.workerQueue?.length, 2);

  releaseWorkerSlot(hive);
  assert.equal(await first, "acquired");
  assert.deepEqual(order, [1]);
  assert.equal(hive.activeRuns, 1);

  releaseWorkerSlot(hive);
  assert.equal(await second, "acquired");
  assert.deepEqual(order, [1, 2]);
  releaseWorkerSlot(hive);
  assert.equal(hive.activeRuns, 0);
});

test("parallel cap without queue fails immediately and queued cancellation frees capacity", async () => {
  const noQueue = state([], { maxParallel: 1 });
  assert.equal(await acquireWorkerSlot(noQueue), "acquired");
  assert.equal(await acquireWorkerSlot(noQueue), "parallel");
  releaseWorkerSlot(noQueue);

  const hive = state([], { maxParallel: 1, queueSize: 1 });
  assert.equal(await acquireWorkerSlot(hive), "acquired");
  const controller = new AbortController();
  const waiting = acquireWorkerSlot(hive, controller.signal);
  controller.abort();
  assert.equal(await waiting, "cancelled");
  assert.equal(hive.workerQueue?.length, 0);
  releaseWorkerSlot(hive);
});

// tokenBudgetScope lets a project's hive-config.yaml restrict the budget to
// just input + output tokens (what fills the model's context window on each
// call). Default "all" preserves the legacy cumulative-of-everything
// behavior; this is the only test surface that documents the contract.
test("tokenBudgetScope: input_output excludes cache reads/writes/reasoning from the budget", () => {
  const worker = runtime("worker", {
    inputTokens: 100_000,
    outputTokens: 50_000,
    // Each of these would push the budget past 200k under the legacy "all"
    // accounting; under "input_output" they must be ignored entirely.
    cacheReadTokens: 800_000,
    cacheWriteTokens: 50_000,
    reasoningTokens: 200_000,
  });
  const hive = state([worker], { worker: { tokenBudget: 200_000, tokenBudgetScope: "input_output" } });
  // input + output = 150k, under the 200k cap → no block.
  assert.equal(checkDispatchBudgets(hive, worker, 1), undefined);
  assert.equal(budgetRemaining(hive, worker).worker.tokens, 50_000);
});

test("tokenBudgetScope: all (default) keeps the cumulative-of-everything accounting", () => {
  const worker = runtime("worker", {
    inputTokens: 100_000,
    outputTokens: 50_000,
    cacheReadTokens: 900_000,
  });
  // No scope set → defaults to "all". Cache reads count toward the cap.
  const hive = state([worker], { worker: { tokenBudget: 1_000_000 } });
  assert.equal(checkDispatchBudgets(hive, worker, 1)?.resource, "tokens");
  assert.equal(budgetRemaining(hive, worker).worker.tokens, 0);
});

test("tokenBudgetScope on teamBudgets is independent of the worker scope", () => {
  const worker = runtime("worker", {
    inputTokens: 100_000,
    outputTokens: 50_000,
    cacheReadTokens: 900_000,
  });
  // Worker uses "input_output" (cache ignored). Team uses "all" (cache counts).
  const hive = state([worker], {
    worker: { tokenBudget: 200_000, tokenBudgetScope: "input_output" },
    teamBudgets: { tokenBudget: 1_000_000, tokenBudgetScope: "all" },
  });
  // checkDispatchBudgets returns the FIRST blocking condition; with the team
  // cap exhausted it returns the team block, not undefined. Verify the two
  // scopes are independently applied via budgetRemaining instead.
  const remaining = budgetRemaining(hive, worker);
  assert.equal(remaining.worker.tokens, 50_000, "worker scope ignores cache");
  assert.equal(remaining.team.tokens, 0, "team scope counts cache");
});

test("tokenBudgetScope defaults to 'all' when omitted (backward compatibility)", () => {
  // input+output = 400k (under 1M), but with cache reads the cumulative is
  // 1.1M which should block under the legacy "all" accounting.
  const worker = runtime("worker", { inputTokens: 200_000, outputTokens: 200_000, cacheReadTokens: 700_000 });
  // No scope set → defaults to "all". Cache reads count toward the cap.
  const hive = state([worker], { worker: { tokenBudget: 1_000_000 } });
  assert.equal(checkDispatchBudgets(hive, worker, 1)?.resource, "tokens");
});
