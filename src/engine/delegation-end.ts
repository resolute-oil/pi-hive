/**
 * Wave 5 / F9 — `delegation_end` event payload assembly (extracted from
 * dispatch.ts).
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md §3.9.
 *
 * The `delegation_end` emit at the bottom of `dispatchAgent` was a ~80-line
 * payload-assembler + emit-helper block. The fields it threads through
 * (completion copy, per-run deltas, message/tool/usage summaries, error
 * surface) have no business living in `dispatchAgent` itself — they are
 * telemetry-shape concerns. Extracted here so dispatch.ts can stay focused
 * on orchestration. Behavior is byte-identical to the pre-extraction
 * inline version.
 */

import type { AgentRuntime, HiveState } from "../core/types";
import { emitHiveEvent, runtimeSummary, writeHiveStateSnapshot } from "./observability";
import { logRecord } from "./state";
import { addHiveActivity } from "../ui/tui/activity";
import { truncateMiddle } from "../core/format";

export interface DelegationEndPayload {
  state: HiveState;
  runtime: AgentRuntime;
  output: string;
  exitCode: number;
  errorMessage?: string;
  caller: string;
  lastStopReason?: string;
  modelsSeen: Set<string>;
  providersSeen: Set<string>;
  apisSeen: Set<string>;
  firstResponseId?: string;
  lastResponseId?: string;
  diagnostics: Array<{ type?: string; message?: string }>;
  sdkCounts?: { toolCalls?: number; toolResults?: number; userMessages?: number; assistantMessages?: number };
  delta: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    costUsd: number;
  };
  messageLimit: number;
}

export function emitDelegationEnd(payload: DelegationEndPayload): void {
  const { state, runtime, output, exitCode, errorMessage, caller, lastStopReason, modelsSeen, providersSeen, apisSeen, firstResponseId, lastResponseId, diagnostics, sdkCounts, delta, messageLimit } = payload;

  const completionMessage = truncateMiddle(output, messageLimit);
  const completion = {
    from: runtime.config.name,
    // The real delegation parent: the ALS caller (A6). For top-level
    // delegations this resolves to "Orchestrator"; nested lead→member
    // delegations now record the truthful parent instead of a hardcoded root.
    to: caller,
    type: runtime.status,
    message: completionMessage,
    costUsd: runtime.costUsd,
    inputTokens: runtime.inputTokens,
    outputTokens: runtime.outputTokens,
    elapsedMs: runtime.elapsedMs,
  };
  logRecord(state, completion);
  addHiveActivity(state, { kind: "delegation_end", parent: caller, agent: runtime.config.name, status: runtime.status, text: `${runtime.status} in ${Math.round(runtime.elapsedMs / 1000)}s${runtime.toolCount ? ` · ${runtime.toolCount} tools` : ""}` });

  emitHiveEvent(state, "delegation_end", {
    ...completion,
    truncated: output.length > messageLimit,
    exitCode,
    stopReason: lastStopReason,
    errorMessage: errorMessage ? truncateMiddle(errorMessage, 500) : undefined,
    models: [...modelsSeen],
    // Per-message identity the SDK exposes on AssistantMessage (Item 9 / R3-1.4):
    // distinct providers + apis behind this run's assistant messages, the first and
    // last responseId (run bookends), and a bounded/truncated diagnostics list.
    providers: providersSeen.size ? [...providersSeen] : undefined,
    apis: apisSeen.size ? [...apisSeen] : undefined,
    firstResponseId,
    lastResponseId,
    diagnostics: diagnostics.length ? diagnostics : undefined,
    // Authoritative SDK message/tool counts for this session (Item 9), preferred
    // over the hand-tallied toolCount. Session-lifetime (not per-run) — a re-run
    // agent's stats cover the whole conversation.
    counts: sdkCounts,
    // Schema marker so the materializer stores per-run deltas and the dashboard
    // never sums these rows with legacy cumulative ones (delegationsSchema=1).
    delegationsSchema: 1,
    delta,
    runtime: runtimeSummary(state, runtime),
  }, runtime.config.name);

  // Surface delegation failures as the now-live `error` telemetry event (A3).
  if (errorMessage) {
    emitHiveEvent(state, "error", {
      agent: runtime.config.name,
      message: truncateMiddle(errorMessage, 500),
      stopReason: lastStopReason,
    }, runtime.config.name);
  }
  publishRuntimeUpdate(state);
  writeHiveStateSnapshot(state);
}

function publishRuntimeUpdate(state: HiveState) {
  state.onRuntimeUpdate?.(state);
}
