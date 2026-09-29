/**
 * Wave 5 / F9 — Worker-slot queue (extracted from the deleted `governance.ts`).
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md §3.9.
 *
 * Pure move: the three functions (`acquireWorkerSlot`, `releaseWorkerSlot`,
 * `cancelWorkerQueue`) previously lived in `governance.ts` alongside the
 * deleted budget math. They have no budget coupling — they manage the
 * in-memory FIFO of worker dispatches waiting for a free slot — so they were
 * relocated to this queue-focused module. Behavior is byte-identical to
 * `governance.ts@<pre-merge>`.
 */

import type { HiveState } from "../core/types";

export interface WorkerSlotWaiter {
  id: number;
  signal?: AbortSignal;
  resolve: () => void;
  reject: (error: Error) => void;
  abort: (() => void) | undefined;
}

export async function acquireWorkerSlot(state: HiveState, signal?: AbortSignal): Promise<"acquired" | "parallel" | "queue-full" | "cancelled"> {
  const max = state.config?.settings.maxParallel;
  if (max === undefined || state.activeRuns < max) {
    state.activeRuns++;
    return "acquired";
  }
  const queueSize = state.config?.settings.queueSize;
  if (queueSize === undefined) return "parallel";
  const queue = state.workerQueue ||= [];
  if (queue.length >= queueSize) return "queue-full";
  return new Promise((resolve) => {
    const id = state.nextQueueId = (state.nextQueueId || 0) + 1;
    const waiter: WorkerSlotWaiter = {
      id,
      signal,
      resolve: () => resolve("acquired" as const),
      reject: () => resolve("cancelled" as const),
      abort: undefined,
    };
    waiter.abort = () => {
      const index = queue.findIndex((entry) => entry.id === id);
      if (index >= 0) queue.splice(index, 1);
      resolve("cancelled");
    };
    if (signal?.aborted) return waiter.abort();
    signal?.addEventListener("abort", waiter.abort, { once: true });
    queue.push(waiter);
  });
}

export function releaseWorkerSlot(state: HiveState): void {
  state.activeRuns = Math.max(0, state.activeRuns - 1);
  const waiter = state.workerQueue?.shift();
  if (!waiter) return;
  if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
  state.activeRuns++;
  waiter.resolve();
}

export function cancelWorkerQueue(state: HiveState, reason = "Hive session ended"): void {
  const queue = state.workerQueue?.splice(0) || [];
  for (const waiter of queue) {
    if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
    waiter.reject(new Error(reason));
  }
}
