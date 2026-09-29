/**
 * Worker runtime factory — `makeFreshRuntime`.
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md §3.9
 *   + tmp/2025-09-29-fresh-true-rebuild-runtime.md (the fix hypothesis).
 *
 * `AgentRuntime` accumulates state across dispatches: counters, status, task,
 * `runCount`, `contextPct`, the SDK session reference, and — critically — a
 * `setInterval` timer that captures the old session in its closure. On
 * `fresh=true`, in-place counter resets (the previous design) are insufficient
 * because:
 *
 *   1. The end-of-run `applySessionStatsToRuntime(session, runtime)` overwrite
 *      re-reads from `runtime.session.getSessionStats()`. If `runtime.session`
 *      still references the prior session (because the dispatch opened an OLD
 *      session file via `SessionManager.open`), the overwrite restores the OLD
 *      lifetime totals. In-place counter resets are immediately undone.
 *
 *   2. Closures (timer handler, `createWorkerSubscriptionHandler`'s
 *      `handleEvent`, the lifecycle's `runtime` field) capture the old runtime
 *      reference. In-place mutation leaves those references live and writing
 *      to the "reset" object — which by then is no longer the registry's
 *      runtime, so the writes go to the orphan and any reader that already
 *      cached the new in-place values sees a consistent state until the next
 *      publish, where the orphan's writes corrupt the dashboard.
 *
 * The clean fix: build a NEW `AgentRuntime` object from scratch, swap it into
 * `state.runtimes`, and let closures hold the orphan reference harmlessly.
 * `state.runtimes.get(agentName)` is the single source of truth readers use
 * (dashboard, `runtimeSummary`, `budgetRemaining`), so a clean swap leaves
 * every consumer seeing the fresh runtime and the orphan going silent.
 *
 * The factory preserves `config` (so the dispatcher keeps using the same
 * reload + permission policy) and `sessionFile` (so the dashboard's "view
 * session" link is stable until the new SM updates it at Move 3 in dispatch.ts).
 * All other fields are zeroed or undefined.
 */

import type { AgentRuntime } from "../core/types";

/**
 * Build a fresh `AgentRuntime` with all counters at zero, no live session,
 * no timer, and no run-start baselines.
 *
 * @param config - The agent's `AgentConfig` (preserved across the fresh swap
 *   so the dispatcher's reload/permission checks continue to operate against
 *   the same identity).
 * @param sessionFile - The worker's session file path. May be the prior file
 *   (caller updates this after `SessionManager.create` returns a new path);
 *   preserved here so a defensive reader can still link to a session file
 *   between the swap and the Move 3 SM-update step.
 */
export function makeFreshRuntime(
  config: AgentRuntime["config"],
  sessionFile: string,
): AgentRuntime {
  return {
    config,
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
    contextTokens: undefined,
    contextWindow: undefined,
    runCount: 0,
    distillerRunCount: 0,
    sessionFile,
    thinkingLevels: undefined,
    runStartInputTokens: undefined,
    runStartOutputTokens: undefined,
    runStartCacheReadTokens: undefined,
    runStartCacheWriteTokens: undefined,
    runStartReasoningTokens: undefined,
    runStartCostUsd: undefined,
    startedAt: undefined,
    timer: undefined,
    session: undefined,
  };
}
