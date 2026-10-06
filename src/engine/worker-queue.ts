// Wave 5A F9 T9.1 — Worker queue primitives.
//
// Extracted from src/engine/governance.ts so the legacy budget-enforcement
// module can be deleted. These functions are pure concurrency primitives that
// govern how many workers run concurrently and queue overflow. They have no
// budget-enforcement surface — they only read `settings.maxParallel` and
// `settings.queueSize` and mutate `state.activeRuns` + `state.workerQueue`.
//
// Acquisition is FIFO and cancellation-friendly: a queued waiter rejects
// (resolves to "cancelled") when the parent signal aborts before a slot
// opens, and the abort listener is removed on resolve to keep the queue
// walker leak-free. releaseWorkerSlot pulls the head waiter off the queue
// and resolves it inline so the released slot is immediately reusable.

import type { HiveState } from "../core/types";

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
    const waiter = {
      id,
      signal,
      resolve: () => resolve("acquired" as const),
      reject: () => resolve("cancelled" as const),
      abort: undefined as (() => void) | undefined,
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
