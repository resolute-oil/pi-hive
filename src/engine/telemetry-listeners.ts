// B-2 Telemetry Listeners extraction (Region 1).
//
// Twelve simple orchestrator-side `pi.on(...)` handlers plus the
// orchestratorToolStartedAt / turnStartedAt Maps plus the
// `setOrchestratorStatus` setter move out of
// `src/integration/hooks.ts` so adding a new SDK event class becomes a
// one-line registration and the mode-gate stops drifting across handlers.
//
// `registerOrchestratorTelemetryListeners(pi, state)` returns a handle with
// a `dispose()` method. `hooks.ts` calls it once per session and invokes
// `dispose()` from `session_shutdown` — that releases the two shared Maps
// and the registered listeners. The Pi SDK's `pi.on(...)` returns a
// cleanup function per registration and `dispose()` invokes every one of
// them, so listener teardown is observable from the SDK's perspective
// (not just an internal `.clear()`).
//
// Two invariants the original code preserved and this module must keep:
//
//   1. The `tool_result` handler releases its `orchestratorToolStartedAt`
//      entry BEFORE the mode-gate check, even in normal mode (M-misc leak
//      fix). Otherwise a mode flip between tool_call and tool_result
//      strands the key forever.
//   2. `turn_start` / `turn_end` always call `setOrchestratorStatus` (the
//      orchestrator-runtime status counter is updated for any mode), but
//      only emit a `turn` telemetry row outside normal mode. They share
//      the `turnStartedAt` Map and the eviction cap at MAX_TRACKED_TURNS
//      with each other — that pair must move together.
//
// `tool_call` additionally calls `enforceDomainForTool` so the domain +
// agent-type policy still applies after the move. `domain.ts` has no
// transitive dependency on this module, so importing it here does not
// introduce a cycle.

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { HiveState } from "../core/types";
import type { HiveTelemetryEventType } from "../shared/telemetry";
import { safeJson, textOfResult, truncateMiddle } from "../core/format";
import { emitHiveEvent, emitModelCatalog, writeHiveStateSnapshot } from "./observability";
import { enforceDomainForTool } from "./domain";

/**
 * Set the orchestrator's runtime status. Used by `turn_start` /
 * `turn_end` (moving here) and by `message_end` (which stays in
 * `hooks.ts` and imports this). The setter is purely an
 * orchestrator-runtime concern — moving it here keeps the closure tight
 * instead of forcing the new module to depend on `hooks.ts`.
 */
export function setOrchestratorStatus(state: HiveState, status: "idle" | "running" | "done" | "error"): void {
  const orch = state.orchestratorRuntime;
  if (!orch) return;
  orch.status = status;
  if (status === "running") {
    orch.startedAt = Date.now();
    orch.elapsedMs = 0;
  } else if (orch.startedAt) {
    orch.elapsedMs = Date.now() - orch.startedAt;
    orch.startedAt = undefined;
  }
  try { writeHiveStateSnapshot(state); } catch { /* best-effort */ }
}

/**
 * Disposable returned by `registerOrchestratorTelemetryListeners`.
 *
 * - `dispose()` clears the shared Maps (orchestratorToolStartedAt +
 *   turnStartedAt) AND invokes every per-handler cleanup function the
 *   Pi SDK returned from `pi.on(...)`. The dual teardown is what
 *   prevents the leak that prompted the M-misc fix: without the Map
 *   clear the next session would see stranded entries; without the
 *   listener removal the next session would accumulate duplicate
 *   handlers.
 */
export interface OrchestratorTelemetryListeners {
  dispose(): void;
}

/**
 * Register the orchestrator's SDK event listeners that fit the simple
 * `emitHiveEvent(state, type, payload, caller)` shape. `session_shutdown`
 * in `hooks.ts` must invoke the returned `dispose()` to preserve the
 * leak-prevention behavior that previously lived inline there.
 */
export function registerOrchestratorTelemetryListeners(
  pi: ExtensionAPI,
  state: HiveState,
): OrchestratorTelemetryListeners {
  // toolCallId → startedAt for the orchestrator's own tool calls, so
  // orchestrator_tool_end can carry durationMs the same way workers do (J5).
  // Bounded by in-flight calls: entries are deleted on tool_result.
  const orchestratorToolStartedAt = new Map<string, number>();

  // turnIndex → startedAt for the orchestrator's own turns.
  const turnStartedAt = new Map<number, number>();
  // W1.7: a turn that errors or is aborted never fires turn_end, so its
  // start stamp would live in the map forever. Cap the map by evicting
  // the oldest insertion (Map preserves insertion order) whenever it
  // grows past the bound — only the newest in-flight turns can still
  // legitimately match a turn_end.
  const MAX_TRACKED_TURNS = 64;

  // Centralized mode-gate: every gated handler runs `gatedEmit(...)` to
  // centralize the `state.mode === "normal"` early-return so future
  // handlers can't drift. The two exceptions (`tool_result`, which
  // must release its Map entry before bailing, and `turn_start` /
  // `turn_end`, which must update status counters for any mode) inline
  // their gate explicitly.
  const gatedEmit = <E, P extends Record<string, unknown>>(
    type: HiveTelemetryEventType,
    caller: "Orchestrator" | "User",
    project: (event: E) => P,
  ) => (event: E) => {
    if (state.mode === "normal") return;
    emitHiveEvent(state, type, project(event), caller);
  };

  // Track each registration's cleanup so dispose() can tear them down.
  // The SDK signature (`pi.on(event, handler): () => void`) is what
  // makes per-handler removal observable; we collect them here rather
  // than wrap them in a class so the closure-mutation shape matches
  // the existing `registerHooks` factory.
  const disposers: Array<() => void> = [];

  // --- Tool lifecycle (paired: tool_call stamps, tool_result releases). ---

  disposers.push(pi.on("tool_call", async (event, ctx) => {
    // Enforcement (domain + agent-type policy) runs in plan AND hive
    // mode; only normal mode is unguarded plain Pi.
    if (state.mode === "normal") return;
    // Orchestrator tool telemetry parity (A5). This hook fires on the
    // main session's own tool calls; worker tool calls are emitted
    // from dispatch.ts.
    const orch = state.orchestratorRuntime;
    if (orch) orch.toolCount++;
    if (event.toolCallId) orchestratorToolStartedAt.set(event.toolCallId, Date.now());
    const argsJson = safeJson(event.input);
    emitHiveEvent(state, "orchestrator_tool_start", {
      agent: "Orchestrator",
      toolName: event.toolName || "unknown",
      toolCallId: event.toolCallId,
      args: truncateMiddle(argsJson, 500),
      truncated: argsJson.length > 500,
    }, "Orchestrator");
    return enforceDomainForTool(state, event, ctx);
  }));

  disposers.push(pi.on("tool_result", async (event) => {
    // Always release the start-time entry, even when we bail below —
    // otherwise a mode flip to normal between tool_call and tool_result
    // strands the key forever (M-misc leak).
    const startedAt = event.toolCallId ? orchestratorToolStartedAt.get(event.toolCallId) : undefined;
    if (event.toolCallId) orchestratorToolStartedAt.delete(event.toolCallId);
    if (state.mode === "normal") return;
    const resultText = textOfResult(event.content);
    emitHiveEvent(state, "orchestrator_tool_end", {
      agent: "Orchestrator",
      toolName: event.toolName || "unknown",
      toolCallId: event.toolCallId,
      isError: event.isError === true,
      resultPreview: truncateMiddle(resultText, 500),
      truncated: resultText.length > 500,
      durationMs: startedAt != null ? Date.now() - startedAt : undefined,
    }, "Orchestrator");
  }));

  // --- Model / thinking level selection. ---

  // J3: re-emit the model catalog when the main model changes
  // mid-session, so `inherit` workers aren't left described by a stale
  // catalog. Gated off in normal mode (the extension does nothing
  // there). The DB upsert is idempotent.
  disposers.push(pi.on("model_select", async (event, ctx) => {
    if (state.mode === "normal") return;
    // The event carries the newly-selected model; pass it through so
    // the catalog covers what `inherit` workers now resolve to, even
    // if it isn't config-declared (M1). Fall back to ctx.model if the
    // event shape lacks it.
    const contextModel = (ctx as ExtensionContext & { model?: { provider?: string; id?: string } }).model;
    const m = event.model || contextModel;
    const effectiveModel = m?.provider && m?.id ? `${m.provider}/${m.id}` : undefined;
    try { emitModelCatalog(state, state.modelRegistry ?? ctx.modelRegistry, effectiveModel); } catch { /* best-effort */ }
    // Phase 4.4: emit the SWITCH itself (not just the catalog re-emit)
    // so the main session's model changes are an observable event,
    // with provenance.
    const prev = event?.previousModel;
    const previousModel = prev?.provider && prev?.id ? `${prev.provider}/${prev.id}` : undefined;
    emitHiveEvent(state, "model_select", {
      agent: "Orchestrator", model: effectiveModel, previousModel, source: event?.source,
    }, "Orchestrator");
  }));

  // Phase 4.4: the main session's thinking-level changes, previously
  // invisible.
  disposers.push(pi.on("thinking_level_select", gatedEmit(
    "thinking_level_select",
    "Orchestrator",
    (e) => ({ agent: "Orchestrator", level: e?.level, previousLevel: e?.previousLevel }),
  )));

  // --- Compaction + per-turn timing (turn_start / turn_end paired). ---

  // Phase 4.1: main-session compactions produced zero telemetry — the
  // orchestrator was a second-class citizen next to its own workers
  // (which emit worker_compaction).
  disposers.push(pi.on("session_compact", gatedEmit(
    "orchestrator_compaction",
    "Orchestrator",
    (e) => ({
      agent: "Orchestrator",
      reason: e?.reason,
      willRetry: e?.willRetry === true,
      fromExtension: e?.fromExtension === true,
    }),
  )));

  // Phase 4.10/4.11: per-turn latency. turn_start stamps the start;
  // turn_end emits one `turn` event carrying turnIndex + the measured
  // duration — the only per-turn timing the dashboard can surface for
  // the main session.
  //
  // Both handlers always update the orchestrator-runtime status (the
  // counter is updated for any mode), but only emit telemetry rows
  // outside normal mode. They share turnStartedAt with each other and
  // must move together.
  disposers.push(pi.on("turn_start", async (event) => {
    setOrchestratorStatus(state, "running");
    if (state.mode === "normal") return;
    if (typeof event?.turnIndex !== "number") return;
    turnStartedAt.set(event.turnIndex, Date.now());
    while (turnStartedAt.size > MAX_TRACKED_TURNS) {
      const oldest = turnStartedAt.keys().next().value;
      if (oldest === undefined) break;
      turnStartedAt.delete(oldest);
    }
  }));
  disposers.push(pi.on("turn_end", async (event) => {
    setOrchestratorStatus(state, "done");
    if (state.mode === "normal") return;
    const started = typeof event?.turnIndex === "number" ? turnStartedAt.get(event.turnIndex) : undefined;
    if (typeof event?.turnIndex === "number") turnStartedAt.delete(event.turnIndex);
    emitHiveEvent(state, "turn", {
      agent: "Orchestrator",
      turnIndex: event?.turnIndex,
      durationMs: started != null ? Date.now() - started : undefined,
    }, "Orchestrator");
  }));

  // --- Provider back-pressure (the only pre-retry view of stalls). ---

  // Phase 4.10/4.11: surface rate-limit / overload responses (429/529)
  // and their retry-after headers so a stalled session has a visible
  // cause. Only emit non-2xx to avoid one row per successful call
  // flooding the log.
  disposers.push(pi.on("after_provider_response", async (event) => {
    if (state.mode === "normal") return;
    const status = Number(event?.status);
    if (!Number.isFinite(status) || (status >= 200 && status < 300)) return;
    const headers = event?.headers || {};
    const pick = (k: string) => headers[k] ?? headers[k.toLowerCase()];
    emitHiveEvent(state, "provider_response", {
      agent: "Orchestrator",
      status,
      retryAfter: pick("retry-after"),
      rateLimitRemaining: pick("anthropic-ratelimit-requests-remaining") ?? pick("x-ratelimit-remaining"),
    }, "Orchestrator");
  }));

  // --- Remaining SDK event classes (Phase 4 "everything the SDK exposes"). ---
  // Each is emitted with a bounded payload and rendered generically in
  // the Activity feed (the feed titles the common ones and dumps the
  // payload for the rest). None carries unbounded bodies.

  disposers.push(pi.on("user_bash", gatedEmit(
    "user_bash",
    "Orchestrator",
    (e) => ({
      agent: "Orchestrator",
      command: truncateMiddle(String(e?.command || ""), 500),
      excludeFromContext: e?.excludeFromContext === true,
    }),
  )));
  // `input` telemetry is source-only (the footer already re-renders on
  // input, a separate concern): record where user input came from and
  // how it will be delivered, not the text (that lands as a
  // user_message already). Caller label is `User`, not `Orchestrator`,
  // to match the existing dashboard grouping contract.
  disposers.push(pi.on("input", gatedEmit(
    "input",
    "User",
    (e) => ({
      agent: "User",
      source: e?.source,
      streamingBehavior: e?.streamingBehavior,
      hasImages: Array.isArray(e?.images) && e.images.length > 0,
    }),
  )));
  disposers.push(pi.on("session_before_fork", gatedEmit(
    "session_fork",
    "Orchestrator",
    (e) => ({ agent: "Orchestrator", entryId: e?.entryId, position: e?.position }),
  )));
  disposers.push(pi.on("session_tree", gatedEmit(
    "session_tree",
    "Orchestrator",
    (e) => ({
      agent: "Orchestrator",
      newLeafId: e?.newLeafId ?? undefined,
      oldLeafId: e?.oldLeafId ?? undefined,
      fromExtension: e?.fromExtension === true,
    }),
  )));
  disposers.push(pi.on("session_info_changed", gatedEmit(
    "session_info_changed",
    "Orchestrator",
    (e) => ({ agent: "Orchestrator", name: e?.name ? truncateMiddle(String(e.name), 200) : undefined }),
  )));

  return {
    dispose() {
      // Order matters: clear the Maps first so any in-flight
      // listener (theoretically impossible during session_shutdown,
      // but defensive) sees cleared state if it happens to run after
      // dispose. Then invoke each SDK-returned disposer to detach
      // the handlers. Wrap each in try/catch — one failing disposer
      // must not strand the rest.
      orchestratorToolStartedAt.clear();
      turnStartedAt.clear();
      for (const dispose of disposers) {
        try { dispose(); } catch { /* best-effort */ }
      }
      disposers.length = 0;
    },
  };
}
