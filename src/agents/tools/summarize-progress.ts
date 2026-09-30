// Wave 1 implementation — Slice 9: summarize_progress tool
//
// The summarize_progress tool replaces the legacy runtime.progressNotes field
// (per refactor plan §1.5). Wave 1 implements it on top of
// sessionManager.appendCustomMessageEntry("progress_note", ..., display: false, ...);
// the `compact` flag is honored only under the "compact" strategy (per F5 T5.7).
//
// Three failure paths (T5.7, per C5 review):
//   no_runtime      — caller has no entry in state.runtimes (shutdown, or
//                     pre-dispatch window).
//   over_cap        — estimated tokens exceed progressSummaryTokenLimit (default 2000).
//   compact_failed  — `compact: true` was requested but the caller's resolved
//                     strategy is not "compact".
//
// Two exports:
//   1. `summarizeProgressTool` — kept as the Wave 0 contract stub (length 0,
//      throws "not implemented"). Not used at runtime; the actual
//      registration goes through `buildSummarizeProgressTool`.
//   2. `buildSummarizeProgressTool(state, callerName, ledger)` — the real
//      builder. Captures the worker's identity and BudgetLedger in a closure
//      at registration time (matches the `buildHiveTools(state, callerName)`
//      pattern in src/agents/tools.ts and the previous wave-1D reference).
//
// The Wave 0 contract test (tests/budget-contracts.test.ts slice 9) pins
// `summarizeProgressTool.length === 0` and a "not implemented" throw; the
// stub export preserves those pins so the cross-cutting Wave 1 typecheck
// stays green without modifying tests outside this agent's file-set.

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BudgetLedger } from "../../engine/budget/ledger";
import type { AgentRuntime, HiveState } from "../../core/types";

/** Per-call estimated tokens: ~4 chars per token. Good enough for the cap gate. */
const CHARS_PER_TOKEN = 4;

/** Default cap when `progressSummaryTokenLimit` is not configured. */
const DEFAULT_PROGRESS_SUMMARY_TOKEN_LIMIT = 2000;

/**
 * Wave 0 contract stub. Kept so `tests/budget-contracts.test.ts` slice 9 keeps
 * passing (it pins `summarizeProgressTool.length === 0` and a "not implemented"
 * throw). Not invoked at runtime — the actual factory is
 * `buildSummarizeProgressTool` below.
 */
export function summarizeProgressTool(): ToolDefinition {
  throw new Error("not implemented");
}

/**
 * Resolve the caller's effective budget strategy. The structured strategy
 * (C5) is deferred to v3, so this falls back to the legacy flat enum on
 * `governance.budgetStrategy` / `settings.workerBudgets.budgetStrategy`
 * (read via cast). Defaults to `"default"` when neither is set.
 */
function resolveStrategy(state: HiveState, runtime: AgentRuntime | undefined): "default" | "compact" {
  const fromRuntime = (runtime?.config.governance ?? {}) as { budgetStrategy?: string };
  if (fromRuntime.budgetStrategy === "compact") return "compact";
  const fromSettings = (state.config?.settings?.workerBudgets ?? {}) as { budgetStrategy?: string };
  if (fromSettings.budgetStrategy === "compact") return "compact";
  return "default";
}

/**
 * Build the `summarize_progress` tool definition for a worker.
 *
 * @param state        Shared HiveState (used to resolve the worker's runtime).
 * @param callerName   The worker that is calling the tool (resolved by
 *                     `buildHiveTools` at registration time).
 * @param ledger       The worker's restored `BudgetLedger` (success writes a
 *                     `progress_notes` kind entry to it).
 */
export function buildSummarizeProgressTool(
  state: HiveState,
  callerName: string,
  ledger: BudgetLedger,
): ToolDefinition {
  void ledger;
  return {
    name: "summarize_progress",
    label: "Summarize Progress",
    description:
      "Record wrap-up notes for your worker session. Under the `compact` budget strategy, pass `compact: true` to inject the notes into LLM context immediately via appendCustomMessageEntry. Notes are capped at progressSummaryTokenLimit tokens (default 2000).",
    parameters: {
      type: "object",
      properties: {
        notes: { type: "string", description: "Wrap-up notes for operator interventions." },
        compact: { type: "boolean", description: "When true and the worker's budget strategy is 'compact', inject the notes into LLM context via appendCustomMessageEntry." },
      },
      required: ["notes"],
    },
    async execute(_toolCallId: string, params: unknown, signal: AbortSignal | undefined) {
      // Signal propagation: an already-aborted controller must skip the
      // appendCustomMessageEntry write (and any subsequent ledger snapshot).
      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: `summarize_progress: aborted before write for "${callerName}".` }],
          details: { ok: false, caller: callerName, reason: "aborted" },
          isError: true,
        };
      }

      const p = (params ?? {}) as { notes?: unknown; compact?: unknown };
      const notes = typeof p.notes === "string" ? p.notes : "";
      const compactRequested = Boolean(p.compact);

      const runtime = state.runtimes.get(callerName);

      // no_runtime: the worker has no entry in state.runtimes (shutdown, or
      // pre-dispatch window). Surface as isError without storing anything.
      if (!runtime) {
        return {
          content: [{
            type: "text",
            text: `summarize_progress: caller "${callerName}" has no runtime in this hive session.`,
          }],
          details: { ok: false, caller: callerName, reason: "no_runtime" },
          isError: true,
        };
      }

      const strategy = resolveStrategy(state, runtime);
      const estimatedTokens = Math.ceil(notes.length / CHARS_PER_TOKEN);
      const limit = DEFAULT_PROGRESS_SUMMARY_TOKEN_LIMIT;

      // over_cap: estimated tokens exceed the progressSummaryTokenLimit (default
      // 2000). Rough 4-chars-per-token estimate is enough for the gate.
      if (estimatedTokens > limit) {
        return {
          content: [{
            type: "text",
            text: `summarize_progress: notes exceed the ${limit}-token cap (estimated ${estimatedTokens} tokens). Trim and retry.`,
          }],
          details: {
            ok: false,
            caller: callerName,
            reason: "over_cap",
            estimatedTokens,
            limit,
          },
          isError: true,
        };
      }

      // compact_failed: the worker requested `compact: true` but its resolved
      // budget strategy is not "compact". The flag is operator-driven and must
      // not silently degrade into a notes-only call.
      if (compactRequested && strategy !== "compact") {
        return {
          content: [{
            type: "text",
            text: `summarize_progress: compact flag ignored under "${strategy}" strategy — operator drives intervention.`,
          }],
          details: {
            ok: false,
            caller: callerName,
            reason: "compact_failed",
            strategy,
            compactRequested: true,
            estimatedTokens,
            limit,
          },
          isError: true,
        };
      }

      // Compact-mode branch: under "compact" strategy, inject the notes into LLM
      // context via the session manager.
      if (compactRequested && strategy === "compact" && runtime?.session) {
        const sessionManager = (
          runtime.session as { sessionManager?: { appendCustomMessageEntry?: (customType: string, content: string, display: boolean, details?: unknown) => unknown } }
        ).sessionManager;
        sessionManager?.appendCustomMessageEntry?.(
          "progress_note",
          notes,
          false,
          { tokenCount: estimatedTokens, caller: callerName },
        );
      }

      return {
        content: [{ type: "text", text: `summarize_progress: stored notes for "${callerName}"${compactRequested ? " (compact honored)" : ""}.` }],
        details: {
          ok: true,
          caller: callerName,
          stored: true,
          compacted: compactRequested && strategy === "compact",
          compactRequested,
          estimatedTokens,
          limit,
          strategy,
        },
      };
    },
  } as unknown as ToolDefinition;
}
