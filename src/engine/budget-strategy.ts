// Budget-strategy feature (see tmp/budget-strategy-plan.md). The wire is:
//   1. emitHiveEvent(state, "budget_warning", { ..., interventionAvailable }) — flag
//      is true ONLY for the "default" strategy, which is the gate the dashboard
//      reads to decide whether to surface operator intervention buttons.
//   2. applyBudgetStrategy(state, runtime, info) — returns the prompt hint for
//      the strategy. The caller appends it to runtime.systemPrompt so the next
//      prompt build (fresh session) picks it up. Resumed sessions may not see
//      the hint until a /compact rebuilds the prompt — documented limitation.
//   3. triggerSummarizeProgress(state, runtime, notes) — stores notes on the
//      runtime and, under the "compact" strategy + the compact=true flag, calls
//      session.compact(progressNotes) to roll the new context window.
//
// Cost is NOT recalculated across compacts (real API charges don't refund).
// Only the tokens budget gets the savings credit — see src/engine/dispatch.ts's
// compaction_end handler for the effectiveTokens debit.

import type { AgentRuntime, HiveState, WorkerGovernance } from "../core/types";
import { emitHiveEvent } from "./observability";

export const DEFAULT_PROGRESS_SUMMARY_TOKEN_LIMIT = 2000;

// Cheap, deterministic token estimate for the progress-notes cap. Pi SDK
// exposes `estimateTokens` for higher fidelity but a 4-chars-per-token heuristic
// is good enough for a hard cap that exists to keep the next prompt from being
// dominated by the report — over-cap notes are rejected so the worker trims
// and retries anyway.
function estimateProgressTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface BudgetWarningInfo {
  scope: "worker" | "team";
  resource: "tokens" | "cost";
  remaining: number;
  limit: number;
}

// Resolves the effective budget strategy for a runtime, falling back to the
// settings-level default. Per-agent `governance:` overrides win over
// settings — same precedence as effectiveWorkerGovernance in governance.ts.
export function resolveBudgetStrategy(state: HiveState, runtime: AgentRuntime): "default" | "compact" {
  const settingsStrategy = state.config?.settings.workerBudgets?.budgetStrategy;
  const overrideStrategy = runtime.config.governance?.budgetStrategy;
  return overrideStrategy ?? settingsStrategy ?? "default";
}

export function progressSummaryTokenLimit(state: HiveState, runtime: AgentRuntime): number {
  const settingsLimit = state.config?.settings.workerBudgets?.progressSummaryTokenLimit;
  const overrideLimit = runtime.config.governance?.progressSummaryTokenLimit;
  const raw = overrideLimit ?? settingsLimit ?? DEFAULT_PROGRESS_SUMMARY_TOKEN_LIMIT;
  // Defensive clamp — config-validation should have caught this already.
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PROGRESS_SUMMARY_TOKEN_LIMIT;
}

// The hint text the worker reads. Two strategies, both gate on the warning
// firing — the caller decides whether to wire the hint at all (it does, via
// dispatch.ts's budget_warning emit).
export function applyBudgetStrategy(
  state: HiveState,
  runtime: AgentRuntime,
  info: BudgetWarningInfo,
): string {
  const strategy = resolveBudgetStrategy(state, runtime);
  if (strategy === "compact") {
    return [
      "## Budget approaching limit",
      `Less than 20% of your ${info.scope} ${info.resource} budget remains. You will be`,
      "force-compacted at 0%. To control the compact timing:",
      "  • Reach a natural stopping point in your task",
      "  • Call `summarize_progress({ notes: \"...\" })` to record wrap-up notes",
      "  • Call `summarize_progress({ notes: \"...\", compact: true })` to record AND compact now",
      "  • Otherwise the system force-compacts at 0% with the last recorded notes",
      `Keep notes tight (default cap: ${progressSummaryTokenLimit(state, runtime)} tokens) so the new context window`,
      "isn't dominated by the report.",
    ].join("\n");
  }
  // default strategy
  return [
    "## Budget approaching limit",
    `Less than 20% of your ${info.scope} ${info.resource} budget remains. Wrap up your`,
    "current work and call `summarize_progress({ notes: \"...\" })` to record wrap-up",
    "state — the operator has been notified and may end the session, trigger",
    "/compact, or respawn you at this point. The notes travel with you regardless",
    "of which action is taken.",
  ].join("\n");
}

// operator-driven intervention gate. ONLY the "default" strategy exposes this —
// the "compact" strategy is fully automatic. Dispatch commands themselves don't
// gate on strategy; the dashboard UI filters by strategy via this flag.
export function shouldInterveneAvailable(state: HiveState, runtime: AgentRuntime): boolean {
  return resolveBudgetStrategy(state, runtime) === "default";
}

// Wire called by the dispatch budget-warning emit. Emits the standard
// `budget_warning` event with the strategy-conditional `interventionAvailable`
// flag, and (when present) appends the prompt hint to runtime.systemPrompt so
// the next fresh-session prompt picks it up. Returns the hint that was
// appended (or empty string if no hint) so tests and downstream callers can
// assert on it.
export function emitBudgetWarning(
  state: HiveState,
  runtime: AgentRuntime,
  info: BudgetWarningInfo,
): string {
  const hint = applyBudgetStrategy(state, runtime, info);
  const interventionAvailable = shouldInterveneAvailable(state, runtime);
  emitHiveEvent(state, "budget_warning", {
    agent: runtime.config.name,
    ...info,
    interventionAvailable,
    strategy: resolveBudgetStrategy(state, runtime),
  }, runtime.config.name);
  if (hint) {
    // The hint is strategy-level (not warning-level): once one budget_warning
    // fires for this runtime, the strategy is fixed and every subsequent
    // warning (worker cost vs. worker tokens, etc.) would re-append the same
    // block. Gate the mutation on a sentinel so the prompt never carries more
    // than one hint block per runtime, even if multiple (scope, resource)
    // warnings fire. The warning-event dedup itself is keyed on
    // `${scope}:${resource}:${agent|team}` in dispatch.ts and unchanged.
    const sentinel = "## Budget approaching limit";
    if (!runtime.systemPrompt.includes(sentinel)) {
      runtime.systemPrompt = `${runtime.systemPrompt}${runtime.systemPrompt.endsWith("\n") ? "" : "\n"}\n${hint}\n`;
    }
  }
  return hint;
}

// Validate progress notes against the size cap. Empty notes are valid (the
// worker may record an empty wrap-up summary). Non-empty notes over the cap
// return the rejection detail so the tool can surface a clear "current size +
// limit" message to the worker.
export interface ProgressNotesValidation {
  ok: boolean;
  estimatedTokens?: number;
  limit?: number;
  reason?: string;
}

export function validateProgressNotes(
  state: HiveState,
  runtime: AgentRuntime,
  notes: string,
): ProgressNotesValidation {
  const limit = progressSummaryTokenLimit(state, runtime);
  const tokens = estimateProgressTokens(notes);
  if (tokens > limit) {
    return {
      ok: false,
      estimatedTokens: tokens,
      limit,
      reason: `progress_notes are ${tokens} tokens; cap is ${limit}. Trim and retry.`,
    };
  }
  return { ok: true, estimatedTokens: tokens, limit };
}

// Stores notes on the runtime and, under "compact" strategy with the explicit
// compact flag, calls session.compact(progressNotes). Under any other
// combination (default strategy, or compact=true on default, or compact=false)
// the call is a no-op for compaction — the notes still get stored.
export interface TriggerSummarizeProgressResult {
  stored: boolean;
  compacted: boolean;
  notes: string;
  compactRequested: boolean;
  strategy: "default" | "compact";
}

export async function triggerSummarizeProgress(
  state: HiveState,
  runtime: AgentRuntime,
  notes: string,
  compactRequested: boolean,
): Promise<TriggerSummarizeProgressResult> {
  const strategy = resolveBudgetStrategy(state, runtime);
  runtime.progressNotes = notes;
  const result: TriggerSummarizeProgressResult = {
    stored: true,
    compacted: false,
    notes,
    compactRequested,
    strategy,
  };
  if (compactRequested && strategy === "compact") {
    const session = runtime.session;
    if (session && typeof session.compact === "function") {
      try {
        // The customInstructions argument is the wire that prepends the
        // worker's wrap-up notes to the next prompt — see CompactionResult
        // shape and the docs/compaction.md reference.
        await session.compact(notes);
        result.compacted = true;
        emitHiveEvent(state, "worker_compaction", {
          agent: runtime.config.name,
          reason: "operator-requested",
          phase: "end",
          trigger: "summarize_progress",
        }, runtime.config.name);
      } catch (err) {
        // session_ended_by_operator is reserved for the operator-intervention
        // commands (endWorkerSession / compactWorkerSession / respawnWorkerSession)
        // — the dashboard pairs the action field with operator-action buttons.
        // A worker-driven compact failure here is a different event class: it
        // pairs with the worker_compaction telemetry stream that the
        // SDK's compaction_end event already feeds. Emit that shape so the
        // dashboard surfaces the failure next to the worker's other compaction
        // activity, not as a phantom operator action.
        emitHiveEvent(state, "worker_compaction", {
          agent: runtime.config.name,
          reason: "operator-requested",
          phase: "end",
          trigger: "summarize_progress",
          errorMessage: err instanceof Error ? err.message : String(err),
        }, runtime.config.name);
        // Re-throw so the tool surfaces the failure to the worker.
        throw err;
      }
    }
  }
  return result;
}

// Re-export for the test surface and the tool wiring. The WorkerGovernance
// shape is needed at the call site so callers can map the existing config
// types without re-importing.
export type { WorkerGovernance };
