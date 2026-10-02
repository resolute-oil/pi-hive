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
  // Resolved at dispatch time and threaded through for downstream consumers
  // that still need to inspect the scope. The per-run delta path that
  // consumed this scope was removed by §1.1 (per-run baselines gone;
  // lifetime totals from getSessionStats are the single source of truth),
  // so emitDelegationEnd does not read it.
  tokenBudgetScope: "input_output" | "all";
  // The runtime's lifetime totals captured BEFORE the SessionStats overwrite in
  // dispatch-lifecycle.ts. Used to compute the per-run delta in the v1 emission:
  // delta = current_lifetime - priorLifetime (clamped nonneg). For the first
  // run, priorLifetime is the runtime's initial state (typically zeros); for a
  // fresh=true re-run, dispatch.ts zeros the lifetime counters before this runs
  // so priorLifetime is also zeros (W1.1 fix).
  priorLifetime: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    costUsd: number;
  };
}

// Run the post-prompt emit sequence. The shape mirrors the inline block
// dispatch.ts used to carry (preserved verbatim so the 537-test behavior
// gate continues to pass).
export async function emitDelegationEnd(input: DelegationEndInput): Promise<void> {
  const { state, runtime, caller, task, ctx, output, errorMessage, exitCode, streamState, sdkCounts, tokenBudgetScope: _tokenBudgetScope, priorLifetime } = input;

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
  // make SUM() over delegations double-count. The per-run `runStart*` baselines
  // are gone from AgentRuntime (Fix A); the prior lifetime is captured in
  // dispatch-lifecycle.ts (above the overwrite) and threaded through as
  // priorLifetime. We compute delta = current_lifetime - priorLifetime, clamped
  // nonneg to absorb a single rare race where the stats probe returns slightly
  // less than the prior overwrite.
  const nonneg = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  const lifetime = {
    inputTokens: nonneg(runtime.inputTokens),
    outputTokens: nonneg(runtime.outputTokens),
    cacheReadTokens: nonneg(runtime.cacheReadTokens),
    cacheWriteTokens: nonneg(runtime.cacheWriteTokens),
    reasoningTokens: nonneg(runtime.reasoningTokens),
    costUsd: nonneg(runtime.costUsd),
  };
  const deltaClamp = (current: number, prior: number) => {
    const diff = (Number.isFinite(current) ? current : 0) - (Number.isFinite(prior) ? prior : 0);
    return diff > 0 ? diff : 0;
  };
  const delta = {
    inputTokens: deltaClamp(lifetime.inputTokens, priorLifetime.inputTokens),
    outputTokens: deltaClamp(lifetime.outputTokens, priorLifetime.outputTokens),
    cacheReadTokens: deltaClamp(lifetime.cacheReadTokens, priorLifetime.cacheReadTokens),
    cacheWriteTokens: deltaClamp(lifetime.cacheWriteTokens, priorLifetime.cacheWriteTokens),
    reasoningTokens: deltaClamp(lifetime.reasoningTokens, priorLifetime.reasoningTokens),
    costUsd: deltaClamp(lifetime.costUsd, priorLifetime.costUsd),
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
    // v1: payload carries BOTH the per-run `delta` (for dashboard SUM()) and the
    // session-cumulative `lifetime` (kept for live display + historical consumers).
    // delegationsSchema=1 signals to ingestion that delta is the authoritative
    // per-run value; the dashboard's `p.delta` branch stores schema_version=1 rows
    // directly. Wave 6's brief v2 (delegationsSchema=2, lifetime-only) required
    // dashboard-side differencing of consecutive lifetime values, which is more
    // invasive than the producer-side baseline subtraction; this revert restores
    // the pre-Wave-6 contract.
    delegationsSchema: 1,
    delta,
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
