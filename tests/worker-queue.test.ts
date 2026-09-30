// Wave 5A F9 T9.1 — Worker-slot queue tests.
//
// Moved from tests/governance.test.ts (which exercised acquireWorkerSlot /
// releaseWorkerSlot alongside the budget enforcement surface) when
// src/engine/governance.ts was deleted. The budget-related tests split off
// into tests/budget-remaining.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRuntime, HiveState } from "../src/core/types.ts";
import {
  acquireWorkerSlot,
  releaseWorkerSlot,
} from "../src/engine/worker-queue.ts";

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