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

import type { AgentSession, SessionStats } from "@earendil-works/pi-coding-agent";
import type { BudgetLedger } from "./ledger";
import type { WorkerBudgetPolicy } from "../../core/types";

// Read threshold + action from the policy's optional Strategies block (per
// §2.13 C5 v2 wiring). Falls back to the legacy defaults (0.20 warning,
// abort-on-zero) when the block is absent.
function resolveStrategies(policy: WorkerBudgetPolicy) {
  const warningThreshold = policy.strategies?.onApproachingLimit?.threshold ?? 0.20;
  const onExhaustionAction = policy.strategies?.onExhaustion?.action ?? "abort";
  return { warningThreshold, onExhaustionAction };
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
export function _resetBudgetContextsForTests(): void {
  budgetContextsByAgent.clear();
}

// The four tool names the F3 brief calls out (T3.4 G-01). Other tools
// (grep, find, ls, custom tools) pass through the budget gate untouched;
// the brief's scope is explicit on these four.
const BLOCKED_TOOL_NAMES = new Set(["bash", "edit", "write", "read"]);

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
  return async (event: { toolName: string; input?: unknown }, _ctx: unknown): Promise<{ block: true; reason: string; terminate: false } | undefined> => {
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
    const stats = budgetCtx.session.getSessionStats();
    const workerTokensCap = budgetCtx.policy.worker.tokens?.cap;
    const workerCostCap = budgetCtx.policy.worker.costUsd?.cap;
    const tokensRemaining = workerTokensCap !== undefined ? workerTokensCap - stats.tokens.total : Infinity;
    const costRemaining = workerCostCap !== undefined ? workerCostCap - stats.cost : Infinity;
    if (tokensRemaining > 0 && costRemaining > 0) return undefined;

    return {
      block: true,
      reason: `Worker budget exhausted: tokens ${stats.tokens.total}/${workerTokensCap ?? "∞"}, cost $${stats.cost.toFixed(4)}/${workerCostCap ?? "∞"}`,
      terminate: false,
    };
  };
}

// Install the budget event hooks on a session. Returns an unsubscribe function.
// `controller` carries the AbortSignal that mid-run aborts (and the warning
// emit checks) read; aborting it is what fast-cancels the run.
export function installBudgetEventHooks(
  session: AgentSession,
  ledger: BudgetLedger,
  policy: WorkerBudgetPolicy,
  controller: AbortController,
): () => void {
  const { warningThreshold, onExhaustionAction } = resolveStrategies(policy);
  const warnedKeys = new Set<string>();
  // session.sessionManager is the canonical SDK seam (agent-session.d.ts:170).
  const sessionManager = session.sessionManager;

  // T3.4 (G-01) — register this worker's budget context for the tool_call
  // handler. Keyed by the ledger's agent slug (read once at install time)
  // so a re-delegation that reuses the same slug overwrites the prior
  // context — the prior context's unsubscribe already removed the old
  // entry, so there is no leak window.
  const agentSlug = ledger.agentName;
  budgetContextsByAgent.set(agentSlug, { session, ledger, policy, controller });

  const off = session.subscribe((event: any) => {
    if (event.type === "message_end") {
      const stats = session.getSessionStats();
      const cumulative = cumulativeFromStats(stats, ledger);
      ledger.recordEvent("message_end", cumulative, controller.signal);
      ledger.maybeSnapshot(cumulative, policy, controller.signal);

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
            sessionManager.appendCustomMessageEntry(
              "budget_warning",
              `Worker tokens at ${pct}% of cap. Wrap up your work; call summarize_progress({ notes: "..." }) to record completion intent.`,
              true,
              { scope: "worker", resource: "tokens", remaining, cap: workerTokensCap },
            );
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
            sessionManager.appendCustomEntry("budget_exhausted", {
              scope: "worker",
              resource: "tokens",
              remaining,
              cap: workerTokensCap,
            });
            if (!controller.signal.aborted) controller.abort(new Error("Worker token budget exhausted"));
          } else {
            // "compact" strategy: log the exhausted marker but do not abort
            // so the cooperative tools can run. (The cooperative-compact call
            // is in T5.10; we surface the marker first so the dashboard sees
            // the threshold crossing even when the strategy is "compact".)
            sessionManager.appendCustomEntry("budget_exhausted", {
              scope: "worker",
              resource: "tokens",
              remaining,
              cap: workerTokensCap,
              action: "compact",
            });
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
      const result = event.result ?? {};
      if (result.tokensBefore != null && result.estimatedTokensAfter != null) {
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