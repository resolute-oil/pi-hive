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
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { CompactionResult } from "@earendil-works/pi-coding-agent";
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
// the unsubscribe function. `runController` is kept in the signature for
// downstream event-handling parity (the budget warning / abort code path is
// installed separately via installBudgetEventHooks; this handler only tracks
// runtime telemetry + streaming output).
//
// TS I12: the event handler is a `switch (event.type)` over the
// AgentSessionEvent union so adding a new SDK event type surfaces as a
// non-exhaustive-case compile error instead of being silently dropped.
export function wireDispatchSubscription(
  state: HiveState,
  runtime: AgentRuntime,
  session: { subscribe(listener: (event: AgentSessionEvent) => void): () => void },
  streamState: DispatchStreamState,
  runController: AbortController,
): () => void {
  const {
    chunks: _chunks,
    modelsSeen,
    providersSeen,
    apisSeen,
    diagnostics,
    toolStartedAt,
  } = streamState;

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    switch (event.type) {
      case "message_update": {
        const delta = event.assistantMessageEvent;
        if (delta?.type === "text_delta") {
          // The documented SDK contract exposes incremental text on `delta`. Some
          // event shapes also carry the full accumulated snapshot; appending that
          // snapshot duplicates every prefix in the final worker result
          // (e.g. "P", "Pl", "Ple" as separate lines in the TUI). Keep snapshots
          // only for live status/fallback output, never as chunks.
          const deltaText = typeof delta.delta === "string" ? delta.delta : "";
          if (deltaText) streamState.chunks.push(deltaText);
          const snapshot = textFromMessage(event.message);
          if (snapshot) streamState.streamedSnapshot = snapshot;
          const live = streamState.chunks.length ? streamState.chunks.join("") : streamState.streamedSnapshot;
          const last = live.split("\n").filter((line: string) => line.trim()).pop();
          if (last) runtime.lastWork = last;
        }
        break;
      }
      case "tool_execution_start": {
        runtime.toolCount++;
        const toolName = event.toolName;
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
        break;
      }
      case "tool_execution_end": {
        const startedAt = event.toolCallId ? toolStartedAt.get(event.toolCallId) : undefined;
        if (event.toolCallId) toolStartedAt.delete(event.toolCallId);
        const resultText = textOfResult(event.result);
        const toolName = event.toolName;
        addHiveActivity(state, { kind: "tool_end", agent: runtime.config.name, toolName, status: event.isError === true ? "error" : "done", text: event.isError === true ? truncateMiddle(resultText, 160) : undefined });
        emitHiveEvent(state, "worker_tool_end", {
          agent: runtime.config.name,
          toolName,
          toolCallId: event.toolCallId,
          isError: event.isError === true,
          resultPreview: truncateMiddle(resultText, 500),
          truncated: resultText.length > 500,
          durationMs: startedAt != null ? Date.now() - startedAt : undefined,
        }, runtime.config.name);
        break;
      }
      case "auto_retry_start": {
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
        break;
      }
      case "auto_retry_end": {
        // The SDK does not carry maxAttempts on retry-end; fall back to the value
        // captured at the matching retry-start.
        emitHiveEvent(state, "worker_retry", {
          agent: runtime.config.name,
          attempt: event.attempt,
          maxAttempts: streamState.lastRetryMaxAttempts,
          phase: "end",
          success: event.success,
          // Phase 4.6: the terminal error when retries are exhausted.
          finalError: event.finalError ? truncateMiddle(event.finalError, 500) : undefined,
        }, runtime.config.name);
        break;
      }
      case "compaction_start": {
        addHiveActivity(state, { kind: "compaction", agent: runtime.config.name, status: "running", text: `compacting${event.reason ? `: ${event.reason}` : ""}` });
        emitHiveEvent(state, "worker_compaction", { agent: runtime.config.name, reason: event.reason, phase: "start" }, runtime.config.name);
        break;
      }
      case "compaction_end": {
        // Phase 4.5: keep the compaction RESULT fields, not just {reason, phase}.
        // Budget accounting (recordCompaction) is wired via installBudgetEventHooks
        // (T2.1) — this handler only emits telemetry.
        // The SDK types event.result as CompactionResult | undefined; tokensBefore
        // is required, estimatedTokensAfter is optional. aborted / willRetry /
        // errorMessage live on the event itself, NOT on CompactionResult, so
        // they are read off `event` directly (the previous structural cast hid
        // this misread by silently finding undefined on CompactionResult).
        const result: CompactionResult | undefined = event.result;
        emitHiveEvent(state, "worker_compaction", {
          agent: runtime.config.name, reason: event.reason, phase: "end",
          tokensBefore: result ? finiteOrUndef(result.tokensBefore) : undefined,
          estimatedTokensAfter: result ? finiteOrUndef(result.estimatedTokensAfter) : undefined,
          aborted: event.aborted === true ? true : undefined,
          willRetry: event.willRetry === true ? true : undefined,
          errorMessage: event.errorMessage ? truncateMiddle(event.errorMessage, 500) : undefined,
        }, runtime.config.name);
        break;
      }
      case "queue_update": {
        // Worker steering/follow-up queue depth (Phase 4). Bounded to counts — the
        // queued message bodies are not carried into telemetry.
        emitHiveEvent(state, "queue_update", {
          agent: runtime.config.name,
          steering: Array.isArray(event.steering) ? event.steering.length : 0,
          followUp: Array.isArray(event.followUp) ? event.followUp.length : 0,
        }, runtime.config.name);
        break;
      }
      case "session_info_changed": {
        emitHiveEvent(state, "session_info_changed", {
          agent: runtime.config.name,
          name: event.name ? truncateMiddle(String(event.name), 200) : undefined,
        }, runtime.config.name);
        break;
      }
      case "message_end": {
        // message_end fires for any AgentMessage — assistant / user / toolResult /
        // custom. The model/provider/api/usage fields only exist on the
        // assistant branch, so the handler narrows event.message via the
        // isAssistantMessage predicate before reading them. The structural
        // cast in the prior version flattened the union to a single shape and
        // relied on undefined returns for non-assistant messages; the
        // predicate makes that branch explicit at the type level.
        const message = event.message;
        if (isAssistantMessage(message)) {
          const actualModel = message.model || message.responseModel;
          if (actualModel) modelsSeen.add(actualModel);
          if (message.provider) providersSeen.add(message.provider);
          if (message.api) apisSeen.add(message.api);
          if (message.responseId) {
            if (!streamState.firstResponseId) streamState.firstResponseId = message.responseId;
            streamState.lastResponseId = message.responseId;
          }
          if (diagnostics.length < MAX_DIAGNOSTICS) {
            // R4.3: shared bounded/undefined-omitting normalizer, capped across the run.
            const norm = boundedDiagnostics(message.diagnostics, MAX_DIAGNOSTICS - diagnostics.length);
            if (norm) diagnostics.push(...norm);
          }
          if (message.stopReason) streamState.lastStopReason = message.stopReason;
          if (message.usage) {
            // Incremental accumulation for live display only. Authoritative totals
            // are overwritten from getSessionStats() at run end (A1) — this avoids
            // the historical double-count where agent_end re-added the final
            // message's usage.
            // Budget warning / abort is handled in installBudgetEventHooks (T2.1).
            const u = extractUsage(message.usage);
            runtime.inputTokens += u.input;
            runtime.outputTokens += u.output;
            runtime.cacheReadTokens += u.cacheRead;
            runtime.cacheWriteTokens += u.cacheWrite;
            runtime.reasoningTokens += u.reasoning;
            runtime.costUsd += u.cost;
          }
        }
        break;
      }
      case "agent_end": {
        const messages = event.messages || [];
        const last = [...messages].reverse().find((message: { role?: string }) => message.role === "assistant");
        // Keep the chunks fallback for output text; the usage-add block that used
        // to live here is deleted (double-count fix, Decision 1).
        if (last && !streamState.chunks.length && !streamState.streamedSnapshot) streamState.chunks.push(textFromMessage(last));
        break;
      }
      // No-op cases: budget events (warning / exhausted) are handled by
      // installBudgetEventHooks (T2.1) and reach the dashboard via their own
      // session manager appends. lifecycle / model / agent_settled are
      // handled in dispatch.ts and dispatch-end.ts respectively.
      case "agent_start":
      case "turn_start":
      case "turn_end":
      case "message_start":
      case "tool_execution_update":
      case "agent_settled":
      case "thinking_level_changed":
      case "bash_execution_update":
      case "summarization_retry_scheduled":
      case "summarization_retry_attempt_start":
      case "summarization_retry_finished":
      case "entry_appended":
        break;
      default: {
        // Exhaustiveness check — TS narrows event to `never` here if every
        // AgentSessionEvent variant is handled above. Adding a new SDK event
        // type that we don't recognize will surface as a compile error
        // pointing at this line.
        const _exhaustive: never = event;
        void _exhaustive;
      }
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

// Narrow an AgentMessage to the assistant branch. The discriminator is
// role === "assistant" — every other AgentMessage branch (user, toolResult,
// custom) lacks model/provider/api/usage and is silently ignored by the
// message_end handler. The structural cast in the prior code flattened the
// union to a single unknown-typed record and hid this branch; the typed
// predicate makes it explicit. Reads only fields that exist on the SDK's
// AssistantMessage shape (see pi-coding-agent/dist/core/extensions/types.d.ts
// MessageEndEvent and pi-ai/dist/types.d.ts AssistantMessage). The optional
// fields stay optional in the type so test fixtures that emit a subset
// (e.g. role + model + usage, no provider) still narrow successfully —
// every downstream read is guarded by a `typeof X === "string"` or
// truthy check before consumption.
type AssistantMessageLike = {
  role: "assistant";
  model?: string;
  responseModel?: string;
  provider?: string;
  api?: string;
  responseId?: string;
  diagnostics?: unknown;
  stopReason?: string;
  usage?: unknown;
};
function isAssistantMessage(m: unknown): m is AssistantMessageLike {
  return (
    typeof m === "object" &&
    m !== null &&
    (m as { role?: unknown }).role === "assistant"
  );
}