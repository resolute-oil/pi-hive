/**
 * Wave 5 / F9 — Worker session-subscription handler (extracted from
 * dispatch.ts).
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md §3.9.
 *
 * `dispatchAgent` historically inlined a ~130-line `session.subscribe(...)`
 * callback that translated SDK message/tool/retry/compaction events into
 * `emitHiveEvent` calls + runtime counter updates. The handler carries no
 * budget math (that was already removed by F9 — `installBudgetEventHooks`
 * owns the budget-event surface) and no orchestration logic; it is a
 * pure telemetry bridge between the SDK session and the shared
 * observability layer. Extracting it keeps dispatch.ts focused on
 * orchestration and makes the event-translation rules easy to audit in
 * isolation.
 *
 * Behavior is byte-identical to the pre-extraction inline version: same
 * event-type dispatch order, same field selection, same bounded diagnostics
 * cap, same incremental-accumulation semantics for tokens/cost.
 */

import type { AgentRuntime, HiveState } from "../core/types";
import { emitHiveEvent, writeHiveStateSnapshot } from "./observability";
import { addHiveActivity } from "../ui/tui/activity";
import { boundedDiagnostics, extractUsage, safeJson, textFromMessage, textOfResult, truncateMiddle } from "../core/utils";

export interface WorkerSubscriptionState {
  /** Streaming output chunks accumulated from `message_update.text_delta`. */
  chunks: string[];
  /** Latest full snapshot of the assistant message (fallback for live status). */
  streamedSnapshot: string;
  /** `tool_call_id → startedAt` map for per-call durationMs (A4). */
  toolStartedAt: Map<string, number>;
  /** Distinct `provider` strings seen across assistant messages in this run. */
  providersSeen: Set<string>;
  /** Distinct `api` strings seen across assistant messages in this run. */
  apisSeen: Set<string>;
  /** Distinct `model` strings seen across assistant messages in this run. */
  modelsSeen: Set<string>;
  /** Bookend responseIds (first / last) for telemetry over `denom_ids`. */
  firstResponseId?: string;
  lastResponseId?: string;
  /** Bounded diagnostics captured from assistant message metadata. */
  diagnostics: Array<{ type?: string; message?: string }>;
  /** `auto_retry_start.maxAttempts` cached for the matching `auto_retry_end`. */
  lastRetryMaxAttempts?: number;
  /** Authoritative SDK session-lifetime tool/message counts (Item 9). */
  sdkCounts?: { toolCalls?: number; toolResults?: number; userMessages?: number; assistantMessages?: number };
  /** Most recent `message.stopReason` (drives the run's terminal status). */
  lastStopReason?: string;
}

export interface WorkerSubscriptionOptions {
  state: HiveState;
  runtime: AgentRuntime;
  sub: WorkerSubscriptionState;
  /** `publishRuntimeUpdate(state)` — see dispatch.ts for the impl. */
  publishRuntimeUpdate: (state: HiveState) => void;
  /** Hard cap on how many diagnostics the handler will accept. */
  maxDiagnostics: number;
}

export function createWorkerSubscriptionHandler(opts: WorkerSubscriptionOptions): (event: unknown) => void {
  const { state, runtime, sub, publishRuntimeUpdate, maxDiagnostics } = opts;
  return (event: any) => {
    if (event.type === "message_update") {
      const delta = event.assistantMessageEvent;
      if (delta?.type === "text_delta") {
        // The documented SDK contract exposes incremental text on `delta`. Some
        // event shapes also carry `text`/`message` as the full accumulated
        // snapshot; appending that snapshot duplicates every prefix in the final
        // worker result (e.g. "P", "Pl", "Ple" as separate lines in the TUI).
        // Keep snapshots only for live status/fallback output, never as chunks.
        const deltaText = typeof delta.delta === "string" ? delta.delta : "";
        if (deltaText) sub.chunks.push(deltaText);
        const snapshot = textFromMessage(event.message) || (typeof delta.text === "string" ? delta.text : "");
        if (snapshot) sub.streamedSnapshot = snapshot;
        const live = sub.chunks.length ? sub.chunks.join("") : sub.streamedSnapshot;
        const last = live.split("\n").filter((line: string) => line.trim()).pop();
        if (last) runtime.lastWork = last;
      }
    } else if (event.type === "tool_execution_start") {
      runtime.toolCount++;
      const toolName = event.toolName || event.name || "unknown";
      runtime.lastWork = `tool: ${toolName}`;
      if (event.toolCallId) sub.toolStartedAt.set(event.toolCallId, Date.now());
      const argsJson = safeJson(event.args ?? {});
      addHiveActivity(state, { kind: "tool_start", agent: runtime.config.name, toolName, status: "running" });
      emitHiveEvent(state, "worker_tool_start", {
        agent: runtime.config.name,
        toolName,
        toolCallId: event.toolCallId,
        args: truncateMiddle(argsJson, 500),
        truncated: argsJson.length > 500,
      }, runtime.config.name);
    } else if (event.type === "tool_execution_end") {
      const startedAt = event.toolCallId ? sub.toolStartedAt.get(event.toolCallId) : undefined;
      if (event.toolCallId) sub.toolStartedAt.delete(event.toolCallId);
      const resultText = textOfResult(event.result);
      addHiveActivity(state, { kind: "tool_end", agent: runtime.config.name, toolName: event.toolName || event.name || "unknown", status: event.isError === true ? "error" : "done", text: event.isError === true ? truncateMiddle(resultText, 160) : undefined });
      emitHiveEvent(state, "worker_tool_end", {
        agent: runtime.config.name,
        toolName: event.toolName || event.name || "unknown",
        toolCallId: event.toolCallId,
        isError: event.isError === true,
        resultPreview: truncateMiddle(resultText, 500),
        truncated: resultText.length > 500,
        durationMs: startedAt != null ? Date.now() - startedAt : undefined,
      }, runtime.config.name);
    } else if (event.type === "auto_retry_start") {
      if (event.maxAttempts != null) sub.lastRetryMaxAttempts = event.maxAttempts;
      addHiveActivity(state, { kind: "retry", agent: runtime.config.name, status: "running", text: `retry ${event.attempt}${event.maxAttempts ? `/${event.maxAttempts}` : ""}${event.errorMessage ? `: ${truncateMiddle(String(event.errorMessage), 120)}` : ""}` });
      emitHiveEvent(state, "worker_retry", {
        agent: runtime.config.name,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        errorMessage: event.errorMessage ? truncateMiddle(String(event.errorMessage), 500) : undefined,
        // Phase 4.6: the backoff delay before this retry (W1.7: 0 is a valid delay).
        delayMs: finiteOrUndef(event.delayMs),
        phase: "start",
      }, runtime.config.name);
    } else if (event.type === "auto_retry_end") {
      // The SDK does not carry maxAttempts on retry-end; fall back to the value
      // captured at the matching retry-start.
      emitHiveEvent(state, "worker_retry", {
        agent: runtime.config.name,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts ?? sub.lastRetryMaxAttempts,
        phase: "end",
        success: event.success,
        // Phase 4.6: the terminal error when retries are exhausted.
        finalError: event.finalError ? truncateMiddle(String(event.finalError), 500) : undefined,
      }, runtime.config.name);
    } else if (event.type === "compaction_start") {
      addHiveActivity(state, { kind: "compaction", agent: runtime.config.name, status: "running", text: `compacting${event.reason ? `: ${event.reason}` : ""}` });
      emitHiveEvent(state, "worker_compaction", { agent: runtime.config.name, reason: event.reason, phase: "start" }, runtime.config.name);
    } else if (event.type === "compaction_end") {
      // Phase 4.5: keep the compaction RESULT fields, not just {reason, phase}.
      const result = event.result || {};
      emitHiveEvent(state, "worker_compaction", {
        agent: runtime.config.name, reason: event.reason, phase: "end",
        tokensBefore: finiteOrUndef(result.tokensBefore ?? event.tokensBefore),
        estimatedTokensAfter: finiteOrUndef(result.estimatedTokensAfter ?? event.estimatedTokensAfter),
        aborted: (result.aborted ?? event.aborted) === true ? true : undefined,
        willRetry: (result.willRetry ?? event.willRetry) === true ? true : undefined,
        errorMessage: (result.errorMessage ?? event.errorMessage) ? truncateMiddle(String(result.errorMessage ?? event.errorMessage), 500) : undefined,
      }, runtime.config.name);
    } else if (event.type === "queue_update") {
      // Worker steering/follow-up queue depth (Phase 4). Bounded to counts — the
      // queued message bodies are not carried into telemetry.
      emitHiveEvent(state, "queue_update", {
        agent: runtime.config.name,
        steering: Array.isArray(event.steering) ? event.steering.length : 0,
        followUp: Array.isArray(event.followUp) ? event.followUp.length : 0,
      }, runtime.config.name);
    } else if (event.type === "session_info_changed") {
      emitHiveEvent(state, "session_info_changed", {
        agent: runtime.config.name,
        name: event.name ? truncateMiddle(String(event.name), 200) : undefined,
      }, runtime.config.name);
    } else if (event.type === "message_end") {
      const message = event.message;
      const actualModel = message?.model || message?.responseModel;
      if (actualModel) sub.modelsSeen.add(String(actualModel));
      if (message?.provider) sub.providersSeen.add(String(message.provider));
      if (message?.api) sub.apisSeen.add(String(message.api));
      if (message?.responseId) {
        const rid = String(message.responseId);
        if (!sub.firstResponseId) sub.firstResponseId = rid;
        sub.lastResponseId = rid;
      }
      if (sub.diagnostics.length < maxDiagnostics) {
        // R4.3: shared bounded/undefined-omitting normalizer, capped across the run.
        const norm = boundedDiagnostics(message?.diagnostics, maxDiagnostics - sub.diagnostics.length);
        if (norm) sub.diagnostics.push(...norm);
      }
      if (message?.stopReason) sub.lastStopReason = String(message.stopReason);
      const usage = message?.usage;
      if (usage) {
        // Incremental accumulation for live display only. Authoritative totals
        // are overwritten from getSessionStats() at run end (A1) — this avoids
        // the historical double-count where agent_end re-added the final
        // message's usage.
        const u = extractUsage(usage);
        runtime.inputTokens += u.input;
        runtime.outputTokens += u.output;
        runtime.cacheReadTokens += u.cacheRead;
        runtime.cacheWriteTokens += u.cacheWrite;
        runtime.reasoningTokens += u.reasoning;
        runtime.costUsd += u.cost;
        // Wave 5 / F9 — the legacy budget-warning + budget-exhausted logic
        // that used to live here is gone. `installBudgetEventHooks` (F2 spine
        // + F3 thresholds) is the sole authority: it subscribes to the
        // worker's session, reads `session.getSessionStats()` for the
        // authoritative cumulative, and emits `budget_warning` /
        // `budget_exhausted` from the canonical `checkBudgetPolicy()` path.
      }
    }
    publishRuntimeUpdate(state);
    writeHiveStateSnapshot(state);
  };
}

// Coerce to a finite number or undefined. Unlike `Number(x) || undefined`, this
// preserves a legitimate 0 (a real delayMs/tokensAfter of 0 is meaningful; only
// NaN/absent should drop to undefined). Mirrors the Number.isFinite guards used
// on the SessionStats overwrite in dispatch.ts. Guards null/undefined FIRST
// (R3-2.5) so an absent field stays undefined rather than coercing to
// Number(null) === 0.
function finiteOrUndef(x: unknown): number | undefined {
  if (x == null) return undefined;
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}
