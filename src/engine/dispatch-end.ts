// Wave 2 F2 T2.2 — Extracted post-prompt dispatch emit.
//
// After session.prompt() resolves, dispatch.ts used to do ~110 lines of
// bookkeeping in-line: completion log + activity + per-run delta + governance
// accumulation + reviewer-verdict persistence + delegation_end event + error
// event. Extracted here so dispatch.ts stays under the ≤600 LOC refactor
// target while preserving every behavior the existing test suite verifies.

import { withFileMutationQueue, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRuntime, HiveState } from "../core/types";
import { addHiveActivity } from "../ui/tui/activity";
import { emitHiveEvent, runtimeSummary, writeHiveStateSnapshot } from "./observability";
import { truncateMiddle } from "../core/utils";
import { logRecord } from "./state";
import { inferArtifactFromReviewTask, inferChangeIdFromReviewTask, inferReviewVerdict } from "./dispatch";
import { currentChangeId } from "./session";
import { approvalRecordPath, setAgentReviewVerdict } from "./openspec";
import type { DispatchStreamState } from "./dispatch-subscribe";

// Dashboard activity should show reviewer/worker conclusions without confusing
// middle elision in normal cases. Keep a high hard cap to avoid unbounded shared
// telemetry rows if an agent accidentally returns a huge dump.
const DELEGATION_EVENT_MESSAGE_LIMIT = 64_000;

export interface DelegationEndInput {
  state: HiveState;
  runtime: AgentRuntime;
  caller: string;
  task: string;
  ctx: ExtensionContext;
  output: string;
  errorMessage: string | undefined;
  exitCode: number;
  streamState: DispatchStreamState;
  sdkCounts: { toolCalls?: number; toolResults?: number; userMessages?: number; assistantMessages?: number } | undefined;
  tokenBudgetScope: "input_output" | "all";
}

// Run the post-prompt emit sequence. The shape mirrors the inline block
// dispatch.ts used to carry (preserved verbatim so the 537-test behavior
// gate continues to pass).
export async function emitDelegationEnd(input: DelegationEndInput): Promise<void> {
  const { state, runtime, caller, task, ctx, output, errorMessage, exitCode, streamState, sdkCounts, tokenBudgetScope } = input;

  // The shared log keeps a bounded copy of the result for the dashboard.
  const completionMessage = truncateMiddle(output, DELEGATION_EVENT_MESSAGE_LIMIT);
  const completion = {
    from: runtime.config.name,
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

  // Per-run deltas (Decision 1): runtime.* now hold session-lifetime aggregates
  // (overwritten from getSessionStats above), so a re-run agent's runtime would
  // make SUM() over delegations double-count. Per §1.1 of the refactor plan,
  // the per-run `runStart*` baselines are gone — the lifetime totals are the
  // single source of truth and the per-run contribution is computed at the
  // dashboard from the difference between this event's lifetime values and
  // the previous ledger snapshot.
  const nonneg = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  const lifetime = {
    inputTokens: nonneg(runtime.inputTokens),
    outputTokens: nonneg(runtime.outputTokens),
    cacheReadTokens: nonneg(runtime.cacheReadTokens),
    cacheWriteTokens: nonneg(runtime.cacheWriteTokens),
    reasoningTokens: nonneg(runtime.reasoningTokens),
    costUsd: nonneg(runtime.costUsd),
  };

  if (runtime.config.agentType === "reviewer") {
    const changeId = currentChangeId() || state.activeChangeId || inferChangeIdFromReviewTask(task) || "";
    const artifact = inferArtifactFromReviewTask(task);
    const verdict = inferReviewVerdict(output);
    if (changeId && artifact && verdict) {
      const recordPath = approvalRecordPath(ctx.cwd, changeId, artifact, "automated-review");
      if (recordPath) {
        await withFileMutationQueue(recordPath, async () => {
          setAgentReviewVerdict(ctx.cwd, changeId, artifact, verdict, runtime.config.name);
        });
      }
    }
  }

  emitHiveEvent(state, "delegation_end", {
    ...completion,
    truncated: output.length > DELEGATION_EVENT_MESSAGE_LIMIT,
    exitCode,
    stopReason: streamState.lastStopReason,
    errorMessage: errorMessage ? truncateMiddle(errorMessage, 500) : undefined,
    models: [...streamState.modelsSeen],
    providers: streamState.providersSeen.size ? [...streamState.providersSeen] : undefined,
    apis: streamState.apisSeen.size ? [...streamState.apisSeen] : undefined,
    firstResponseId: streamState.firstResponseId,
    lastResponseId: streamState.lastResponseId,
    diagnostics: streamState.diagnostics.length ? streamState.diagnostics : undefined,
    counts: sdkCounts,
    // v2: payload carries session-cumulative `lifetime` instead of a per-run
    // `delta` (the §1.1 `runStart*` baselines are gone from AgentRuntime).
    // Dashboards compute the per-run contribution by differencing consecutive
    // delegation_end events; legacy v1 consumers can detect and skip.
    delegationsSchema: 2,
    lifetime,
    runtime: runtimeSummary(state, runtime),
  }, runtime.config.name);

  if (errorMessage) {
    emitHiveEvent(state, "error", {
      agent: runtime.config.name,
      message: truncateMiddle(errorMessage, 500),
      stopReason: streamState.lastStopReason,
    }, runtime.config.name);
  }

  writeHiveStateSnapshot(state);
  state.onRuntimeFinish?.(runtime, ctx);
}
