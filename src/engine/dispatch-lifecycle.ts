// Wave 5A F9 T9.3 — Post-prompt lifecycle extracted from dispatch.ts.
//
// Wraps (a) the prompt() invocation under the per-delegation scoped contexts
// (currentAgentName, currentChangeId), (b) the SDK SessionStats overwrite
// of the runtime's live-display counters, (c) the session-shutdown cleanup
// tail (lifecycle.close, timer/abort cleanup, status mutation), and (d)
// the post-prompt delegation_end emit. Extracted from dispatchAgent so
// the dispatcher becomes a thin orchestration layer (≤600 LOC target per
// the refactor plan §X.Y).
//
// The helper takes a parameter object so the call site stays compact and
// the extracted function is testable in isolation. `errorMessage` flows
// back to the caller so the setup-failure catch above can read it.

import type { AgentSession, ExtensionContext, SessionStats } from "@earendil-works/pi-coding-agent";
import { currentChangeId, runAsAgent, runAtDelegationDepth, runWithChange } from "./session";
import type { AgentRuntime, HiveState } from "../core/types";
import type { DispatchStreamState } from "./dispatch-subscribe";
import type { WorkerRunLifecycle } from "./worker-lifecycle";
import { emitDelegationEnd } from "./dispatch-end";

export interface PostPromptInput {
  state: HiveState;
  runtime: AgentRuntime;
  session: AgentSession;
  streamState: DispatchStreamState;
  fresh: boolean;
  task: string;
  ctx: ExtensionContext;
  caller: string;
  prompt: string;
  delegationDepth: number;
  sessionFileExisted: boolean;
  lifecycle: WorkerRunLifecycle;
  timeout: NodeJS.Timeout | undefined;
  abortSignal: AbortSignal | undefined;
  abortFromParent: () => void;
  getAbortedByParent: () => boolean;
  getTimedOut: () => boolean;
  governanceTimeoutMs: number | undefined;
  tokenBudgetScope: "input_output" | "all";
}

export interface PostPromptResult {
  output: string;
  exitCode: number;
  elapsed: number;
}

// Authoritative tool-call counters the SDK surfaces via SessionStats.
// Kept narrow (4 documented keys); null values mean "absent from the
// SDK payload" rather than zero, so the dashboard doesn't synthesize
// bogus zero rows.
interface SdkCounts {
  toolCalls?: number;
  toolResults?: number;
  userMessages?: number;
  assistantMessages?: number;
}

// Run the worker's prompt, capture authoritative usage from SessionStats,
// then run the shutdown-cleanup tail and emit delegation_end. Returns
// the final result so dispatch.ts can return it to the orchestrator.
export async function runPromptAndFinalize(input: PostPromptInput): Promise<PostPromptResult> {
  const {
    state, runtime, session, streamState, fresh, task, ctx, caller, prompt,
    delegationDepth, sessionFileExisted, lifecycle, timeout, abortSignal,
    abortFromParent, getAbortedByParent, getTimedOut, governanceTimeoutMs,
    tokenBudgetScope,
  } = input;

  let errorMessage: string | undefined;
  let sdkCounts: SdkCounts | undefined;

  try {
    // Scoped so currentAgentName() resolves to this worker for everything
    // causally downstream of prompt() — subscribed event handlers, tool
    // execute() calls (including a nested delegate_agent recursing into
    // dispatchAgent again), and enforceDomainForTool's lookup. Workers can run
    // concurrently now that there's no process boundary between them, so this
    // can no longer be a shared/global value (see currentAgentStorage in
    // session.ts) — each concurrent call gets its own isolated context.
    //
    // prompt() throws synchronously for pre-acceptance failures (no model, no
    // API key); a failure mid-run instead surfaces via session.state.errorMessage.
    //
    // The active change-id is scoped alongside the agent name so the worker's
    // plan/review tools resolve currentChangeId() to the selected change. A
    // nested delegation inherits the caller's change-id unless a more specific
    // one is set. state.activeChangeId is the persistent selection;
    // currentChangeId() carries an already-scoped value into nesting.
    const scopedChangeId = currentChangeId() ?? state.activeChangeId;
    if (getAbortedByParent()) throw new Error("aborted");
    // Fix #3: inject the assembled worker context on new/fresh session starts.
    // fresh=true always starts clean (prior transcript archived above, if any).
    // A first-ever session for this agent (no prior transcript file) also needs
    // the full context so shared_context and the domain boundary reach the worker.
    // Resumed sessions (fresh=false, existing transcript) receive the lean task
    // only — pi-hive's native transcript persistence already carries the context
    // forward, so re-injecting would duplicate it on every resumed delegation.
    // Deliberate non-goal: distiller re-injection into resumed workers (P4).
    const isNewSession = fresh || !sessionFileExisted;
    await runAtDelegationDepth(delegationDepth, () => runAsAgent(runtime.config.name, () => runWithChange(scopedChangeId, () => session.prompt(isNewSession ? prompt : task))));
    errorMessage = getAbortedByParent()
      ? (getTimedOut() ? `Worker timed out after ${governanceTimeoutMs}ms` : "aborted")
      : state.shuttingDown
        ? "aborted during session shutdown"
        : session.state.errorMessage;
    // The 1s timer polls this too, but relying on it alone can miss the final,
    // most accurate reading if the last tick landed moments before completion.
    // Refresh the raw tokens/window alongside the percent (Phase 4.7) so the
    // final snapshot carries the last context fill, not just its percentage.
    const finalUsage = session.getContextUsage?.();
    if (finalUsage?.percent != null) runtime.contextPct = finalUsage.percent;
    if (finalUsage?.tokens != null) runtime.contextTokens = finalUsage.tokens;
    if (finalUsage?.contextWindow != null) runtime.contextWindow = finalUsage.contextWindow;
  } catch (error: any) {
    errorMessage = error?.message || String(error);
  }

  // Authoritative usage: overwrite the incremental live-display counters with
  // the SDK's session-lifetime aggregate (includes cache splits). This kills
  // the double-count and any accumulation drift in one move (Decision 1). If
  // stats throws, the incremental values already on the runtime are kept.
  // Item 9: SessionStats also carries authoritative message/tool counts —
  // preferred over the hand-tallied toolCount so the numbers match the SDK's own.
  // TS I14: typed stats: SessionStats | undefined (was `any` with a fallback
  // chain). The SDK returns the documented SessionStats shape; the legacy
  // `tokens ?? stats.usage ?? stats` fallbacks were a stopgap from before
  // the SDK pinned its surface and are no longer reachable.
  try {
    const stats: SessionStats | undefined = session.getSessionStats?.();
    if (stats) {
      const toolCalls = Number(stats.toolCalls);
      const toolResults = Number(stats.toolResults);
      const userMessages = Number(stats.userMessages);
      const assistantMessages = Number(stats.assistantMessages);
      sdkCounts = {
        toolCalls: Number.isFinite(toolCalls) ? toolCalls : undefined,
        toolResults: Number.isFinite(toolResults) ? toolResults : undefined,
        userMessages: Number.isFinite(userMessages) ? userMessages : undefined,
        assistantMessages: Number.isFinite(assistantMessages) ? assistantMessages : undefined,
      };
      // R3-1.3: do NOT overwrite runtime.toolCount with stats.toolCalls here.
      // runtime.toolCount is reset per run (see the run-start block) and tallied
      // live from tool_execution_start, so it means "tool calls THIS run". But
      // stats.toolCalls is session-LIFETIME — on a resumed (non-fresh) re-run it
      // covers the whole conversation, which would make the Agents "Tools" cell and
      // delegation_end.runtime.toolCount jump from this-run to lifetime at run end.
      // The lifetime count is preserved separately in the `counts` payload below,
      // which honestly documents its session-lifetime semantics.
      const { tokens, cost } = stats;
      const input = Number(tokens.input);
      const output = Number(tokens.output);
      if (Number.isFinite(input)) runtime.inputTokens = input;
      if (Number.isFinite(output)) runtime.outputTokens = output;
      const cacheRead = Number(tokens.cacheRead);
      const cacheWrite = Number(tokens.cacheWrite);
      if (Number.isFinite(cacheRead)) runtime.cacheReadTokens = cacheRead;
      if (Number.isFinite(cacheWrite)) runtime.cacheWriteTokens = cacheWrite;
      const costUsd = Number(cost);
      if (Number.isFinite(costUsd)) runtime.costUsd = costUsd;
      // reasoning is NOT part of SessionStats.tokens (Phase 4.8): the SDK
      // surface returns {input, output, cacheRead, cacheWrite, total} only.
      // Reasoning is accumulated from message_end events in the dispatch
      // subscribe handler and preserved across runs here. The fallback
      // `tokens.reasoning ?? tokens.reasoningTokens` chain was a stopgap;
      // removed by TS I14.
    }
  } catch { /* keep incremental values if stats is unavailable */ }

  // Session-shutdown cleanup. The original code wrapped this in an outer
  // try/finally around the createSession block (since removed). The cleanup
  // itself stays because it clears the timer, removes the abort listener,
  // closes the lifecycle, and sets the final runtime status — all of which
  // run regardless of whether the prompt() or stats() blocks above throw.
  streamState.toolStartedAt.clear();
  if (timeout) clearTimeout(timeout);
  abortSignal?.removeEventListener("abort", abortFromParent);
  await lifecycle.close(Boolean(errorMessage));
  runtime.elapsedMs = runtime.startedAt ? Date.now() - runtime.startedAt : runtime.elapsedMs;
  runtime.status = errorMessage ? "error" : "done";
  const exitCode = errorMessage ? 1 : 0;

  const output = streamState.chunks.join("").trim() || streamState.streamedSnapshot.trim() || errorMessage || "[no output]";
  runtime.lastWork = output.split("\n").filter((line) => line.trim()).pop() || runtime.status;
  // Post-prompt emit (delegation_end / error / completion log + activity +
  // delta + governance + reviewer-verdict). Extracted to dispatch-end.ts so
  // dispatch.ts stays under the ≤600 LOC refactor target.
  await emitDelegationEnd({
    state, runtime, caller, task, ctx, output, errorMessage, exitCode,
    streamState, sdkCounts, tokenBudgetScope,
  });

  return { output, exitCode, elapsed: runtime.elapsedMs };
}
