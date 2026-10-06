// Wave 2 + Wave 3 F3+F4 — installBudgetEventHooks (T2.1, T2.4, T3.1-T3.6, T4.1)
//
// Wires the AgentSession event subscription into the BudgetLedger so:
//   - message_end → ledger.recordEvent (live cumulative) + maybeSnapshot (throttled)
//                  + warning at the configured threshold (default 20% remaining
//                  via resolveStrategies; configurable via
//                  strategies.onApproachingLimit.threshold, 0..1 ratio) + abort
//                  at 0% remaining (unless strategies.onExhaustion.action ===
//                  "compact" or "none")
//
// Warning threshold defaults to 20% of cap; configurable via
// strategies.onApproachingLimit.threshold (ratio in [0, 1]).
//   - compaction_end → ledger.recordCompaction(savings) for completed compactions
//                  (skipped on aborted/errored payloads per SDK ref §1.4)
//   - agent_settled → ledger.snapshot(stats, policy, "checkpoint", signal)
//
// T3.4 (G-01) — `tool_call` blocking for `bash`, `edit`, `write`, `read` is
// wired via the extension API (`pi.on("tool_call", handler)`), NOT through
// `session.subscribe` (which only sees AgentSessionEvents and never
// `tool_call`). The handler is built by `buildBudgetToolCallHandler(agentName)`
// and registered by the worker's resource-loader factory in
// `src/engine/worker-extension.ts`. The handler looks up its budget context
// from the module-level `budgetContextsByAgent` map, populated by
// `installBudgetEventHooks` and cleared on unsubscribe.
//
// Returns the unsubscribe function from session.subscribe() so callers can
// detach without disposing the session. The unsubscribe also removes the
// budget-context registration so a stale agent name cannot leak the context
// to a future worker that happens to reuse the slug.

import type { AgentSession, AgentSessionEvent, ExtensionToolContext, SessionStats, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { BudgetLedger } from "./ledger";
import type { HiveState, WorkerBudgetPolicy } from "../../core/types";
import { emitHiveEvent } from "../observability";
import { tokensForInclude, checkContextConstraint, resolveExhaustionAction, resolveInterventionAvailable } from "./policy";

// Read threshold + action from the policy's optional Strategies block (per
// §2.13 C5 v2 wiring). Falls back to the legacy defaults (0.20 warning,
// abort-on-zero) when the block is absent.
//
// interventionAvailable (T13.2) is the operator-facing flag the F13
// dashboard reads off the `budget_warning` event to decide which
// intervention buttons to render. It is `true` under the "default"
// strategy (the system aborts on exhaustion, so the operator can rescue
// the worker by hand) and `false` under the "compact" strategy (the
// system auto-compacts, so operator intervention would conflict with the
// automation). The brief maps this to the `WorkerBudgetStrategy` enum
// ("default" | "compact") at `src/core/types.ts:568` — the flat enum's
// "compact" value matches the structured `onExhaustion.action === "compact"`
// (or `onApproachingLimit.action === "compact"`), both of which are the
// auto-recovery paths the F13 dashboard should NOT offer an "abort" /
// "compact" / "respawn" escape hatch for.
//
// Wave context-constraint (T7): per-dimension strategies. The
// `dimension` argument selects which dimension's exhaustion action to
// resolve (`onTokenExhaustion` for tokens, `onContextExhaustion` for
// context); both fall back to the global `onExhaustion.action` (then to
// "abort") when their per-dimension field is absent. The
// `interventionAvailable` flag is computed per-dimension too — a worker
// in `tokens: abort, context: compact` mode has `interventionAvailable:
// true` for the token warning (operator can still rescue on the token
// side) and `false` for the context warning. The pure helpers
// `resolveExhaustionAction` and `resolveInterventionAvailable` in
// policy.ts are the public seam (testable in isolation); this function
// composes them with the warning-threshold default.
function resolveStrategies(policy: WorkerBudgetPolicy, dimension: "tokens" | "context" = "tokens") {
  const warningThreshold = policy.strategies?.onApproachingLimit?.threshold ?? 0.20;
  const onExhaustionAction = resolveExhaustionAction(policy, dimension);
  const onApproachingLimitAction = policy.strategies?.onApproachingLimit?.action ?? "wrap-up";
  // "default" strategy → operator may intervene. "compact" strategy → system
  // handles recovery, so the operator buttons would be misleading. Per
  // dimension (T7) so each warning event carries the right flag.
  const interventionAvailable = resolveInterventionAvailable(policy, dimension);
  return { warningThreshold, onExhaustionAction, onApproachingLimitAction, interventionAvailable };
}

// Extract a synthetic cumulative from session.getSessionStats() so message_end
// can call ledger.recordEvent with the documented shape {tokens, costUsd, runs}.
// `runs` is not tracked by getSessionStats() — the live ledger carries it
// separately, so we read it from the ledger's current cumulative.
function cumulativeFromStats(stats: SessionStats, ledger: BudgetLedger): { tokens: number; costUsd: number; runs: number } {
  return {
    tokens: stats.tokens.total,
    costUsd: stats.cost,
    runs: ledger.cumulative.runs,
  };
}

// T3.4 — budget context registry. Each worker's `installBudgetEventHooks`
// call writes one entry keyed by the ledger's agent slug; the matching
// `pi.on("tool_call", handler)` in the worker's resource-loader factory
// reads from this map so it can compute remaining tokens/cost and block
// expensive tools mid-run. The unsubscribe function removes the entry so a
// re-delegated worker reusing the slug cannot inherit a stale context.
//
// Module-private — the public surface is `installBudgetToolCallHandler`
// (registers the handler) and `getBudgetContextForAgent` (read-only peek
// for tests).
interface BudgetContext {
  session: AgentSession;
  ledger: BudgetLedger;
  policy: WorkerBudgetPolicy;
  controller: AbortController;
}

const budgetContextsByAgent = new Map<string, BudgetContext>();

// Read-only accessor for tests and the extension factory in
// worker-extension.ts. Returns undefined when no context is registered
// for the agent (e.g., tests that bypass installBudgetEventHooks).
export function getBudgetContextForAgent(agentName: string): BudgetContext | undefined {
  return budgetContextsByAgent.get(agentName);
}

// For tests only — wipes the registry between cases. Not exported in the
// production API; tests import it directly to keep cases hermetic.
export function __resetBudgetContextsForTests(): void {
  budgetContextsByAgent.clear();
}

// The four tool names the F3 brief calls out (T3.4 G-01). Other tools
// (grep, find, ls, custom tools) pass through the budget gate untouched;
// the brief's scope is explicit on these four. S4: exported so the
// four-tool gate can be pinned from a single source of truth.
export const BLOCKED_TOOL_NAMES = new Set(["bash", "edit", "write", "read"]);

// Build a `tool_call` handler for a specific worker. The returned closure
// is registered via the extension API (`pi.on("tool_call", handler)`) by
// the worker's resource-loader factory. Each per-worker factory call
// captures the agent name in the closure so the handler can look up its
// own budget context from `budgetContextsByAgent`.
//
// Behavior:
//   1. Fast-path: if the worker's controller is already aborted (the
//      message_end exhaustion branch fired, or the operator hit
//      Ctrl+C), return `undefined` so the abort propagates through the
//      normal termination path rather than racing with a block result.
//   2. Tool-name filter: only `bash`, `edit`, `write`, `read` are subject
//      to the budget gate; everything else passes through.
//   3. Read the live cumulative from `session.getSessionStats()` (the
//      SDK's authoritative session-lifetime counter) and compute the
//      remaining tokens / cost against the policy caps. If either
//      remaining drops to ≤0, return a block result with a reason
//      string and `terminate: false` (the existing controller abort
//      path will trigger the eventual end-of-run, not this block).
//   4. Otherwise return `undefined` and let the tool run.
//
// `agentName` MUST match a registered `BudgetContext`; if it doesn't
// (e.g., test wiring that bypasses installBudgetEventHooks), the
// handler is a no-op and the tool runs.
export function buildBudgetToolCallHandler(agentName: string) {
  // The event shape is `ToolCallEvent` (extensions/types.d.ts:884) — a
  // discriminated union on `toolName`; for budget-gating we only need the
  // `toolName` discriminator, so the wider shape is structurally compatible.
  // C4 + I5: typed as `ToolCallEventResult` / `ExtensionToolContext` from
  // the SDK. The handler still returns the same `{ block, reason,
  // terminate }` shape; the type just moves from a local literal to the
  // SDK's discriminated `ToolCallEventResult` so future arms (e.g.,
  // `notify`, `content`) are typed automatically.
  return async (event: { toolName: string; input?: unknown }, _ctx: ExtensionToolContext): Promise<ToolCallEventResult | undefined> => {
    const budgetCtx = budgetContextsByAgent.get(agentName);
    if (!budgetCtx) return undefined;

    // Fast-path: controller already aborted. The abort signal is the
    // canonical end-of-run trigger (T3.3 wiring); returning a block
    // result here would race with the abort's terminate-on-idle
    // behavior. Fall through and let the abort take effect.
    if (budgetCtx.controller.signal.aborted) return undefined;

    // Only block the four tools the brief calls out. Other tools pass
    // through untouched; the brief's G-01 scope is explicit.
    if (!BLOCKED_TOOL_NAMES.has(event.toolName)) return undefined;

    // Compute remaining against the caps in policy.worker. Either cap
    // being absent means "unlimited" → do not block on that dimension.
    //
    // Wave-budget-include-filter: the tokens comparison honors the
    // resolved policy's `include` list (default ["input", "output"]) via
    // `tokensForInclude` instead of comparing `stats.tokens.total` (which
    // folds cacheRead / cacheWrite in per the SDK contract). Without this
    // filter, a worker with high cache hits would get blocked mid-run
    // even when the dashboard's "tokens used" counter (which DOES honor
    // the scope) shows it well under cap.
    //
    // Wave context-constraint (T5): the handler ALSO reads the live
    // `getContextUsage()` payload and checks the worker's
    // `policy.worker.context` cap (nominal tokens or percentage fill).
    // The check reuses the pure `checkContextConstraint` from policy.ts
    // for parity with the pre-flight gate (T4). When tokens is null
    // (right after compaction) or contextWindow is 0, the check is
    // skipped gracefully — matches the gate's null-handling.
    const stats = budgetCtx.session.getSessionStats();
    const workerTokensCap = budgetCtx.policy.worker.tokens?.cap;
    const workerCostCap = budgetCtx.policy.worker.costUsd?.cap;
    const workerTokensInclude = budgetCtx.policy.worker.tokens?.include ?? ["input", "output"];
    const tokensUsed = tokensForInclude(stats, workerTokensInclude);
    const tokensRemaining = workerTokensCap !== undefined ? workerTokensCap - tokensUsed : Infinity;
    const costRemaining = workerCostCap !== undefined ? workerCostCap - stats.cost : Infinity;
    // Context check (mid-run, post-T3 cadence). getContextUsage() may be
    // absent on some SDK builds (capability probe via `?.()`); when
    // absent, the comparison is skipped (no context cap → no block).
    const ctxUsage = budgetCtx.session.getContextUsage?.();
    let contextExhausted: { cap: number | { percent: number }; current: number; kind: "tokens" | "percent" } | undefined;
    if (ctxUsage && budgetCtx.policy.worker.context) {
      const ctxConstraint = budgetCtx.policy.worker.context;
      const ctxBlock = checkContextConstraint(ctxUsage, ctxConstraint);
      if (ctxBlock) {
        // Reuse the cap shape (nominal tokens OR percentage) so the
        // reason string matches the constraint the user wrote. The
        // discriminated-union narrowing uses an explicit `tokens` check
        // (the second variant has `tokens?: never`, so a `tokens`
        // property check is the discriminator).
        if ("tokens" in ctxConstraint && ctxConstraint.tokens !== undefined) {
          contextExhausted = { cap: ctxConstraint.tokens, current: ctxUsage.tokens ?? 0, kind: "tokens" };
        } else if ("percent" in ctxConstraint && ctxConstraint.percent !== undefined) {
          contextExhausted = { cap: { percent: ctxConstraint.percent }, current: Math.round((ctxUsage.tokens ?? 0) / Math.max(1, ctxUsage.contextWindow) * 100), kind: "percent" };
        }
      }
    }
    if (tokensRemaining > 0 && costRemaining > 0 && contextExhausted === undefined) return undefined;

    const ctxPart = contextExhausted
      ? contextExhausted.kind === "tokens"
        ? `, context ${contextExhausted.current}/${contextExhausted.cap} tokens`
        : `, context ${contextExhausted.current}% of cap ${(contextExhausted.cap as { percent: number }).percent}%`
      : "";
    return {
      block: true,
      reason: `Worker budget exhausted: tokens ${tokensUsed}/${workerTokensCap ?? "∞"}, cost $${stats.cost.toFixed(4)}/${workerCostCap ?? "∞"}${ctxPart}`,
      terminate: false,
    };
  };
}

// Install the budget event hooks on a session. Returns an unsubscribe function.
// `controller` carries the AbortSignal that mid-run aborts (and the warning
// emit checks) read; aborting it is what fast-cancels the run.
//
// `state` (optional) is the parent HiveState. When supplied, every
// `budget_warning` and `budget_exhausted` emit ALSO writes a
// HiveTelemetryEvent of the matching type to the parent's
// observabilityLog (via `emitHiveEvent`). The dashboard server only
// ingests the parent's telemetry log (`addSource(telemetry_log)` in
// `src/observability/server/runtime.ts:114`); the per-worker
// `sessionManager.appendCustomMessageEntry` path that previously
// surfaced warnings reached the dashboard in the F1-F13 design but
// the audit caught that the dashboard never subscribed to worker
// session.jsonl files. This emit is the production wiring that makes
// the F13 "interventionAvailable" flag and the dashboard's rescue-
// button enable/disable observable end-to-end.
//
// `actor` (optional) is the agent's display name. Used as the
// `actor` field on the emitted HiveTelemetryEvent. Defaults to
// `ledger.agentName` when omitted.
//
// When `state` is undefined (e.g., unit tests that want to keep the
// handler hermetic and observe only the per-worker `appendCustom*`
// calls), the emit is skipped — the per-worker custom entries are
// still produced, so the test surface is unchanged.
export function installBudgetEventHooks(
  session: AgentSession,
  ledger: BudgetLedger,
  policy: WorkerBudgetPolicy,
  controller: AbortController,
  state?: HiveState,
  actor?: string,
): () => void {
  const { warningThreshold, onExhaustionAction, interventionAvailable } = resolveStrategies(policy, "tokens");
  const warnedKeys = new Set<string>();
  // session.sessionManager is the canonical SDK seam (agent-session.d.ts:170).
  const sessionManager = session.sessionManager;
  // The worker's sessionId is what the dashboard reducer keys the
  // `interventionBySession` map by (`buildInterventionBySession` at
  // ui/web/src/store/status.ts:11). The parent's `state.session.sessionId`
  // is what `emitHiveEvent` writes to the event's `session_id` field,
  // so we thread the worker's id through the payload — the reducer is
  // expected to look at `payload.session_id` (with a fallback to
  // `e.session_id` for legacy rows that pre-date F13-fixes).
  const workerSessionId = session.sessionId;
  const emitActor = actor ?? ledger.agentName;

  // T3.4 (G-01) — register this worker's budget context for the tool_call
  // handler. Keyed by the ledger's agent slug (read once at install time)
  // so a re-delegation that reuses the same slug overwrites the prior
  // context — the prior context's unsubscribe already removed the old
  // entry, so there is no leak window.
  //
  // I2 fix: register the context BEFORE `session.subscribe(...)` so the
  // very first event the listener sees can already resolve the budget
  // context. The regression test in tests/budget-events.test.ts asserts
  // the registration order via a captured subscribe-call timing.
  const agentSlug = ledger.agentName;
  budgetContextsByAgent.set(agentSlug, { session, ledger, policy, controller });

  const off = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_end") {
      const stats = session.getSessionStats();
      const cumulative = cumulativeFromStats(stats, ledger);
      ledger.recordEvent("message_end", cumulative, controller.signal);
      ledger.maybeSnapshot(cumulative, policy, controller.signal);

      // Wave context-constraint (T3) — refresh the runtime's live context
      // fields at every message_end so the mid-run tool-call gate
      // (T5) and the `formatContextFill` display (T6) see current values
      // instead of the run-end-only snapshot from
      // `dispatch-lifecycle.ts:127-130`. `getContextUsage()` is best-effort:
      // the SDK can return null tokens (right after compaction, before next
      // LLM response) — we skip the update in that case so the runtime
      // keeps its last-known value rather than flashing to 0. Mirrors the
      // orchestrator's own context poll in `src/integration/hooks.ts:360`.
      // The runtime is keyed by the agent slug in `state.runtimes`; when
      // `state` is undefined (e.g., unit tests), this update is a no-op
      // because there is no live runtime to mutate.
      try {
        const usage = session.getContextUsage?.();
        if (usage && state) {
          const runtime = state.runtimes.get(agentSlug);
          if (runtime) {
            if (usage.percent != null) runtime.contextPct = usage.percent;
            if (usage.tokens != null) runtime.contextTokens = usage.tokens;
            if (usage.contextWindow != null) runtime.contextWindow = usage.contextWindow;
          }
        }
      } catch { /* capability probe is best-effort; matches hooks.ts:365 */ }

      // Warning at warningThreshold remaining (default 0.20).
      const workerTokensCap = policy.worker.tokens?.cap;
      if (workerTokensCap !== undefined && workerTokensCap > 0) {
        const remaining = Math.max(0, workerTokensCap - cumulative.tokens);
        const ratio = remaining / workerTokensCap;
        if (ratio <= warningThreshold) {
          const warningKey = "worker:tokens";
          if (!warnedKeys.has(warningKey)) {
            warnedKeys.add(warningKey);
            const pct = (100 * (1 - ratio)).toFixed(0);
            const warningDetails = { scope: "worker", resource: "tokens", remaining, cap: workerTokensCap, interventionAvailable, session_id: workerSessionId };
            sessionManager.appendCustomMessageEntry(
              "budget_warning",
              `Worker tokens at ${pct}% of cap. Wrap up your work; call summarize_progress({ notes: "..." }) to record completion intent.`,
              true,
              warningDetails,
            );
            // F13 production wiring (Wave 7 fixup): the dashboard server
            // only ingests the parent's telemetry log, so we MUST also
            // emit a HiveTelemetryEvent of the same type for the
            // dashboard reducer to see. The reducer keys the
            // interventionBySession map by `session_id` (the worker's
            // session id, threaded through the payload).
            if (state) emitHiveEvent(state, "budget_warning", warningDetails, emitActor);
          }
        }
      }

      // Exhausted at 0% remaining. Strategies.onExhaustion.action:
      //   "abort"   → controller.abort() + write budget_exhausted entry
      //   "compact" → write budget_exhausted entry, do NOT abort
      //   "none"    → do nothing (no event, no abort)
      if (workerTokensCap !== undefined && workerTokensCap > 0) {
        const remaining = Math.max(0, workerTokensCap - cumulative.tokens);
        if (remaining <= 0 && onExhaustionAction !== "none") {
          if (onExhaustionAction !== "compact") {
            const exhaustedDetails = { scope: "worker", resource: "tokens", remaining, cap: workerTokensCap, session_id: workerSessionId };
            sessionManager.appendCustomEntry("budget_exhausted", exhaustedDetails);
            if (state) emitHiveEvent(state, "budget_exhausted", exhaustedDetails, emitActor);
            if (!controller.signal.aborted) controller.abort(new Error("Worker token budget exhausted"));
          } else {
            // "compact" strategy: log the exhausted marker but do not abort
            // so the cooperative tools can run. (The cooperative-compact call
            // is in T5.10; we surface the marker first so the dashboard sees
            // the threshold crossing even when the strategy is "compact".)
            const exhaustedDetails = { scope: "worker", resource: "tokens", remaining, cap: workerTokensCap, action: "compact", session_id: workerSessionId };
            sessionManager.appendCustomEntry("budget_exhausted", exhaustedDetails);
            if (state) emitHiveEvent(state, "budget_exhausted", exhaustedDetails, emitActor);
          }
        }
      }
      return;
    }

    if (event.type === "compaction_end") {
      // T2.4 — honor event.aborted and event.errorMessage per SDK ref §1.4.
      // A compaction that did not complete has no meaningful savings number.
      const aborted = event.aborted === true;
      const errorMessage = event.errorMessage != null ? String(event.errorMessage) : null;
      if (aborted || errorMessage) {
        // Skip recordCompaction. Optionally emit a dashboard-friendly marker.
        sessionManager.appendCustomEntry("compaction_skipped", {
          reason: aborted ? "aborted" : "error",
          errorMessage: errorMessage ?? undefined,
        });
        return;
      }
      const result = event.result;
      if (result != null && result.tokensBefore != null && result.estimatedTokensAfter != null) {
        const savings = result.tokensBefore - result.estimatedTokensAfter;
        ledger.recordCompaction(savings, controller.signal);
      }
      return;
    }

    if (event.type === "agent_settled") {
      const stats = session.getSessionStats();
      ledger.snapshot(stats, policy, "checkpoint", controller.signal);
      return;
    }
  });

  return () => {
    off();
    // Only clear the context if it's still ours — a re-install with the
    // same slug overwrites the entry, and we must not delete the new
    // context when the old unsubscribe fires.
    const current = budgetContextsByAgent.get(agentSlug);
    if (current && current.controller === controller) {
      budgetContextsByAgent.delete(agentSlug);
    }
  };
}
