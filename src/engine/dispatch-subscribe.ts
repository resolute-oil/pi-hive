// Wave 2 F2 T2.2 — Extracted dispatch subscribe handler.
//
// The session.subscribe() callback that powers the streaming / tool / retry /
// compaction / message_end / agent_end telemetry is a large block (~180 LOC)
// that pulls dispatch.ts's budget-aware LOC over 600. Wave 2 extracts the
// handler into this module so dispatch.ts becomes a thin orchestration layer
// that delegates to delegateAgent (T2.2) + installBudgetEventHooks (T2.1).
//
// Non-budget event handling lives here. Budget logic (warning at 20% / abort
// at 0% / recordCompaction) is in installBudgetEventHooks — do NOT duplicate
// it here. The handler is intentionally stripped of inline budget math so the
// budget invariants have exactly one definition site.
//
// The handler mutates a `DispatchStreamState` object (chunks, modelsSeen, etc.)
// passed in by the caller; this preserves the closure-mutation pattern of the
// inline handler without forcing the helper to be a class.

import { addHiveActivity } from "../ui/tui/activity";
import { emitHiveEvent, writeHiveStateSnapshot } from "./observability";
import { publishRuntimeUpdate } from "./dispatch";
import {
  boundedDiagnostics,
  extractUsage,
  textFromMessage,
  textOfResult,
  truncateMiddle,
} from "../core/utils";
import type { AgentRuntime, HiveState } from "../core/types";

const MAX_DIAGNOSTICS = 20;

// All mutable bookkeeping that the subscribe callback updates across calls.
// Hoisted into a single object so the helper signature stays compact and the
// caller retains ownership of the state.
export interface DispatchStreamState {
  chunks: string[];
  streamedSnapshot: string;
  modelsSeen: Set<string>;
  providersSeen: Set<string>;
  apisSeen: Set<string>;
  firstResponseId?: string;
  lastResponseId?: string;
  diagnostics: Array<{ type?: string; message?: string }>;
  lastStopReason?: string;
  toolStartedAt: Map<string, number>;
  lastRetryMaxAttempts?: number;
}

export function makeDispatchStreamState(): DispatchStreamState {
  return {
    chunks: [],
    streamedSnapshot: "",
    modelsSeen: new Set(),
    providersSeen: new Set(),
    apisSeen: new Set(),
    diagnostics: [],
    toolStartedAt: new Map(),
  };
}

// Install the (non-budget) dispatch subscribe handler on the session. Returns
// the unsubscribe function. `governance` and `runController` are kept in the
// signature for downstream event-handling parity (the budget warning / abort
// code path is installed separately via installBudgetEventHooks; this handler
// only tracks runtime telemetry + streaming output).
export function wireDispatchSubscription(
  state: HiveState,
  runtime: AgentRuntime,
  session: { subscribe(listener: (event: any) => void): () => void },
  streamState: DispatchStreamState,
  governance: { tokenBudget?: number; costBudgetUsd?: number; timeoutMs?: number },
  runController: AbortController,
): () => void {
  const {
    chunks,
    modelsSeen,
    providersSeen,
    apisSeen,
    diagnostics,
    toolStartedAt,
  } = streamState;

  const unsubscribe = session.subscribe((event: any) => {
    if (event.type === "message_update") {
      const delta = event.assistantMessageEvent;
      if (delta?.type === "text_delta") {
        // The documented SDK contract exposes incremental text on `delta`. Some
        // event shapes also carry `text`/`message` as the full accumulated
        // snapshot; appending that snapshot duplicates every prefix in the final
        // worker result (e.g. "P", "Pl", "Ple" as separate lines in the TUI).
        // Keep snapshots only for live status/fallback output, never as chunks.
        const deltaText = typeof delta.delta === "string" ? delta.delta : "";
        if (deltaText) streamState.chunks.push(deltaText);
        const snapshot = textFromMessage(event.message) || (typeof delta.text === "string" ? delta.text : "");
        if (snapshot) streamState.streamedSnapshot = snapshot;
        const live = streamState.chunks.length ? streamState.chunks.join("") : streamState.streamedSnapshot;
        const last = live.split("\n").filter((line: string) => line.trim()).pop();
        if (last) runtime.lastWork = last;
      }
    } else if (event.type === "tool_execution_start") {
      runtime.toolCount++;
      const toolName = event.toolName || event.name || "unknown";
      runtime.lastWork = `tool: ${toolName}`;
      if (event.toolCallId) toolStartedAt.set(event.toolCallId, Date.now());
      const argsJson = JSON.stringify(event.args ?? {});
      addHiveActivity(state, { kind: "tool_start", agent: runtime.config.name, toolName, status: "running" });
      emitHiveEvent(state, "worker_tool_start", {
        agent: runtime.config.name,
        toolName,
        toolCallId: event.toolCallId,
        args: truncateMiddle(argsJson, 500),
        truncated: argsJson.length > 500,
      }, runtime.config.name);
    } else if (event.type === "tool_execution_end") {
      const startedAt = event.toolCallId ? toolStartedAt.get(event.toolCallId) : undefined;
      if (event.toolCallId) toolStartedAt.delete(event.toolCallId);
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
      if (event.maxAttempts != null) streamState.lastRetryMaxAttempts = event.maxAttempts;
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
        maxAttempts: event.maxAttempts ?? streamState.lastRetryMaxAttempts,
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
      // Budget accounting (recordCompaction) is wired via installBudgetEventHooks
      // (T2.1) — this handler only emits telemetry.
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
      if (actualModel) modelsSeen.add(String(actualModel));
      if (message?.provider) providersSeen.add(String(message.provider));
      if (message?.api) apisSeen.add(String(message.api));
      if (message?.responseId) {
        const rid = String(message.responseId);
        if (!streamState.firstResponseId) streamState.firstResponseId = rid;
        streamState.lastResponseId = rid;
      }
      if (diagnostics.length < MAX_DIAGNOSTICS) {
        // R4.3: shared bounded/undefined-omitting normalizer, capped across the run.
        const norm = boundedDiagnostics(message?.diagnostics, MAX_DIAGNOSTICS - diagnostics.length);
        if (norm) diagnostics.push(...norm);
      }
      if (message?.stopReason) streamState.lastStopReason = String(message.stopReason);
      const usage = message?.usage;
      if (usage) {
        // Incremental accumulation for live display only. Authoritative totals
        // are overwritten from getSessionStats() at run end (A1) — this avoids
        // the historical double-count where agent_end re-added the final
        // message's usage.
        // Budget warning / abort is handled in installBudgetEventHooks (T2.1).
        const u = extractUsage(usage);
        runtime.inputTokens += u.input;
        runtime.outputTokens += u.output;
        runtime.cacheReadTokens += u.cacheRead;
        runtime.cacheWriteTokens += u.cacheWrite;
        runtime.reasoningTokens += u.reasoning;
        runtime.costUsd += u.cost;
      }
    } else if (event.type === "agent_end") {
      const messages = event.messages || [];
      const last = [...messages].reverse().find((message: any) => message.role === "assistant");
      // Keep the chunks fallback for output text; the usage-add block that used
      // to live here is deleted (double-count fix, Decision 1).
      if (last && !streamState.chunks.length && !streamState.streamedSnapshot) streamState.chunks.push(textFromMessage(last));
    }
    publishRuntimeUpdate(state);
    writeHiveStateSnapshot(state);
  });

  return unsubscribe;
}

// Coerce to a finite number or undefined. Unlike `Number(x) || undefined`, this
// preserves a legitimate 0 (a real delayMs/tokensAfter of 0 is meaningful; only
// NaN/absent should drop to undefined). Mirrors the Number.isFinite guards used
// on the SessionStats overwrite below. Guards null/undefined FIRST (R3-2.5) so an
// absent field stays undefined rather than coercing to Number(null) === 0.
function finiteOrUndef(x: unknown): number | undefined {
  if (x == null) return undefined;
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}