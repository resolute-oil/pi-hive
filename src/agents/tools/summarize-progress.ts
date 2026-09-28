/**
 * Wave 0 contract stub — `summarize_progress` tool.
 *
 * Source of truth:
 *   docs/reviews/28-09-2026-budget-review/04-refactor-plan.md §2.8 (cooperative
 *   tool, preserved).
 *   docs/reviews/28-09-2026-budget-review/05-parallelization-analysis.md §3.4
 *   (Agent 1D, T5.7 — "The tool's signature was updated in Wave 0, so this
 *   agent only needs to fill in the body.").
 *
 * Wave 0 changes from the legacy signature:
 *   - Notes storage moves from `runtime.progressNotes` to
 *     `appendCustomMessageEntry("progress_note", ..., display: false, details: { tokenCount })`
 *     per plan §2.11.
 *   - `compact: true` is honored only when the runtime's resolved strategy is
 *     `compact` (C5 placeholder — currently returns `undefined`).
 *   - Three failure paths (T5.7):
 *       no_runtime      — worker already ended; return `isError: true`
 *       over_cap        — call exceeds `progressSummaryTokenLimit`; structured error
 *       compact_failed  — `session.compact()` threw; catch + structured error
 *
 * Body throws — Agent 1D (Wave 1) fills it in.
 */

import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { BudgetLedger } from "../../engine/budget/ledger";
import type { HiveState } from "../../core/types";

type ToolUpdate = AgentToolUpdateCallback<object>;

const summarizeProgressParams = Type.Object({
  notes: Type.String({
    description:
      "Wrap-up notes. Should capture current task, decisions made, files touched, validation status, and explicit next step. Will be available to operator interventions.",
  }),
  compact: Type.Optional(Type.Boolean({
    description:
      "Only honored under the `compact` budget strategy: when true, roll the context window now using these notes as customInstructions. Ignored under `default` strategy.",
  })),
});

export type SummarizeProgressFailureReason =
  | "no_runtime"
  | "over_cap"
  | "compact_failed";

export interface SummarizeProgressDetails {
  ok: boolean;
  agent?: string;
  name?: string;
  strategy?: "default" | "compact" | string;
  stored?: boolean;
  compacted?: boolean;
  compactRequested?: boolean;
  estimatedTokens?: number;
  limit?: number;
  reason?: SummarizeProgressFailureReason;
  caller?: string;
  error?: string;
}

/**
 * Build the `summarize_progress` tool definition for a worker.
 *
 * @param state        Shared HiveState (used to resolve the worker's runtime + ledger).
 * @param callerName   The worker that is calling the tool (resolved by
 *                     `buildHiveTools` at registration time). Used to look up
 *                     the runtime via `state.runtimes.get(callerName)`.
 * @param ledger       The worker's restored `BudgetLedger`. Used in Wave 1 to
 *                     append `progress_note` CustomMessageEntry records
 *                     instead of mutating `runtime.progressNotes`.
 */
export function buildSummarizeProgressTool(
  _state: HiveState,
  _callerName: string,
  _ledger: BudgetLedger,
): ToolDefinition {
  throw new Error("not implemented");
}

/**
 * Re-export the parameter schema so tests can `Static<typeof summarizeProgressParams>`
 * without re-declaring it.
 */
export { summarizeProgressParams };

// Re-export SDK render types so Agent 1D can build the renderCall/renderResult
// implementations without re-importing them across files.
export type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext, Theme, ToolDefinition, ToolRenderResultOptions, Static };
