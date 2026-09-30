// Wave 2 F2 — installBudgetEventHooks (T2.1, T2.4)
//
// Wires the AgentSession event subscription into the BudgetLedger so:
//   - message_end → ledger.recordEvent (live cumulative) + maybeSnapshot (throttled)
//                  + warning at the configured threshold (default 20% remaining
//                  via resolveStrategies; configurable via
//                  strategies.onApproachingLimit.threshold, 0..1 ratio) + abort
//                  at 0% remaining (unless strategies.onExhaustion.action ===
//                  "compact" or "none")
//   - compaction_end → ledger.recordCompaction(savings) for completed compactions
//                  (skipped on aborted/errored payloads per SDK ref §1.4)
//   - agent_settled → ledger.snapshot(stats, policy, "checkpoint", signal)
//
// Returns the unsubscribe function from session.subscribe() so callers can
// detach without disposing the session.

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

  return off;
}