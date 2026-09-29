/**
 * Wave 5 / F9 — `getSessionStats` → `AgentRuntime` overwrite (extracted from
 * dispatch.ts).
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md §3.9
 *   §2.6 "Single source of truth: cumulative tokens/cost come from
 *         `session.getSessionStats()`."
 *
 * At end-of-run dispatch.ts overwrites the live-display counters with the
 * SDK's session-lifetime aggregate. This kills the double-count and any
 * accumulation drift in one move (Decision 1). The overwrite was a
 * ~45-line `try { session.getSessionStats() ... }` block sitting between
 * the `prompt()` call and the `delegation_end` emit — extracted here so
 * dispatch.ts stays focused on orchestration.
 *
 * Behavior is byte-identical to the pre-extraction inline version: the
 * reasoning guard (`reasoning > 0 || runtime.reasoningTokens === 0`),
 * the R3-1.3 carve-out that keeps `runtime.toolCount` per-run, and the
 * numeric guards that fall back to incremental accumulators on `NaN`.
 */

import type { AgentRuntime } from "../core/types";

export interface SdkCounts {
  toolCalls?: number;
  toolResults?: number;
  userMessages?: number;
  assistantMessages?: number;
}

/**
 * Read `session.getSessionStats()` and apply it to `runtime`. Returns the
 * SDK-authoritative message/tool counts (`counts` payload); the caller
 * threads them into the `delegation_end` event payload so the dashboard
 * shows the SDK's own numbers, not the hand-tallied per-run `toolCount`.
 *
 * Throws when the session exposes no `getSessionStats()` — caller treats
 * that as "stats unavailable; keep incremental values" (no-op).
 */
export function applySessionStatsToRuntime(session: { getSessionStats?: () => unknown }, runtime: AgentRuntime): SdkCounts | undefined {
  const stats: any = session.getSessionStats?.();
  if (!stats) return undefined;

  const toolCalls = Number(stats.toolCalls);
  const toolResults = Number(stats.toolResults);
  const userMessages = Number(stats.userMessages);
  const assistantMessages = Number(stats.assistantMessages);
  const sdkCounts: SdkCounts = {
    toolCalls: Number.isFinite(toolCalls) ? toolCalls : undefined,
    toolResults: Number.isFinite(toolResults) ? toolResults : undefined,
    userMessages: Number.isFinite(userMessages) ? userMessages : undefined,
    assistantMessages: Number.isFinite(assistantMessages) ? assistantMessages : undefined,
  };
  // R3-1.3: do NOT overwrite runtime.toolCount with stats.toolCalls here.
  // runtime.toolCount is reset per run (see the run-start block in
  // dispatch.ts) and tallied live from tool_execution_start, so it means
  // "tool calls THIS run". But stats.toolCalls is session-LIFETIME — on a
  // resumed (non-fresh) re-run it covers the whole conversation, which would
  // make the Agents "Tools" cell and delegation_end.runtime.toolCount jump
  // from this-run to lifetime at run end. The lifetime count is preserved
  // separately in the `counts` payload above, which honestly documents its
  // session-lifetime semantics.
  const tokens = stats.tokens ?? stats.usage ?? stats;
  const input = Number(tokens.input ?? tokens.inputTokens);
  const output = Number(tokens.output ?? tokens.outputTokens);
  if (Number.isFinite(input)) runtime.inputTokens = input;
  if (Number.isFinite(output)) runtime.outputTokens = output;
  const cacheRead = Number(tokens.cacheRead ?? tokens.cacheReadTokens);
  const cacheWrite = Number(tokens.cacheWrite ?? tokens.cacheWriteTokens);
  if (Number.isFinite(cacheRead)) runtime.cacheReadTokens = cacheRead;
  if (Number.isFinite(cacheWrite)) runtime.cacheWriteTokens = cacheWrite;
  const cost = Number(stats.cost?.total ?? stats.cost ?? stats.costUsd);
  if (Number.isFinite(cost)) runtime.costUsd = cost;
  // reasoning is NOT part of SessionStats.tokens (Phase 4.8): only overwrite
  // when the SDK actually reports a POSITIVE value, otherwise keep the value
  // accumulated from message_end. A finite 0 from stats (reasoning simply
  // absent) must not wipe accumulation — only trust it to zero when nothing
  // was accumulated in the first place.
  const reasoning = Number(tokens.reasoning ?? tokens.reasoningTokens);
  if (Number.isFinite(reasoning) && (reasoning > 0 || runtime.reasoningTokens === 0)) {
    runtime.reasoningTokens = reasoning;
  }
  return sdkCounts;
}
