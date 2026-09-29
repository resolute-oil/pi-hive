/**
 * `summarize_progress` tool — T5.7 simplified implementation.
 *
 * Source of truth:
 *   docs/reviews/28-09-2026-budget-review/04-refactor-plan.md §2.8 (cooperative
 *   tool, preserved) + §2.11 (notes storage moves from `runtime.progressNotes`
 *   to `appendCustomMessageEntry`).
 *
 * Behavior (per the Wave 1D spec):
 *   - Always store `notes` on `state.progressNotes[callerName]` so the latest
 *     wrap-up state is available to operator interventions (end / compact /
 *     respawn).
 *   - When `compact: true`:
 *       * If the caller's resolved budget strategy is `compact`, inject the
 *         notes into LLM context via `session.sessionManager.appendCustomMessageEntry`.
 *       * Otherwise, return `isError: true` with `details.reason === "compact_failed"`.
 *   - Always write a ledger entry with `kind: "progress_notes"` so the
 *     dashboard timeline reflects every wrap-up call.
 *
 * Three failure paths (T5.7):
 *   no_runtime      — caller has no entry in `state.runtimes` (shutdown, or
 *                     pre-dispatch window).
 *   over_cap        — estimated tokens exceed `progressSummaryTokenLimit`
 *                     (default 2000). Rough 4-chars-per-token estimate.
 *   compact_failed  — `compact: true` was requested but the caller's resolved
 *                     strategy is not `compact`.
 *
 * The `progressNotes` cache lives on `HiveState` via a module-local cast
 * (declaration-merged at runtime); the field is per-caller and survives
 * across tool calls in the same hive session.
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
import type { AgentRuntime, HiveState } from "../../core/types";

type ToolUpdate = AgentToolUpdateCallback<object>;

// ---------------------------------------------------------------------------
// Param schema (kept identical to the legacy shape; tool name unchanged so
// the harness can keep its existing tool-allowlist regex).
// ---------------------------------------------------------------------------

const summarizeProgressParams = Type.Object({
  notes: Type.String({
    description:
      "Wrap-up notes. Should capture current task, decisions made, files touched, validation status, and explicit next step. Will be available to operator interventions.",
  }),
  compact: Type.Optional(Type.Boolean({
    description:
      "Only honored under the `compact` budget strategy: when true, inject these notes into LLM context immediately via appendCustomMessageEntry. Ignored under `default` strategy.",
  })),
});

/** Per-call estimated tokens: ~4 chars per token. Good enough for the cap gate. */
const CHARS_PER_TOKEN = 4;

/** Default cap when `progressSummaryTokenLimit` is not configured. */
const DEFAULT_PROGRESS_SUMMARY_TOKEN_LIMIT = 2000;

export type SummarizeProgressFailureReason =
  | "no_runtime"
  | "over_cap"
  | "compact_failed";

export interface SummarizeProgressDetails {
  ok: boolean;
  caller?: string;
  stored?: boolean;
  compacted?: boolean;
  compactRequested?: boolean;
  estimatedTokens?: number;
  limit?: number;
  strategy?: "default" | "compact";
  reason?: SummarizeProgressFailureReason;
  error?: string;
}

/**
 * Internal result envelope. The SDK's `AgentToolResult<TDetails>` does not
 * carry an `isError` flag (errors are surfaced by throwing from `execute`),
 * but the legacy tool contract — and the structured-error contract this
 * Wave 1D spec inherits — uses `isError: true` on the return value so the
 * tool call is flagged without unwrapping a thrown exception. The widening
 * to `AgentToolResult<SummarizeProgressDetails> & { isError?: boolean }` is
 * intentional and matches every other tool in this codebase.
 */
type SummarizeProgressResult = AgentToolResult<SummarizeProgressDetails> & {
  isError?: boolean;
};

/**
 * Internal storage bag for `state.progressNotes`. Lives outside the typed
 * `HiveState` surface (the Wave 0 contract stub does not include it yet);
 * the cast on read/write keeps the surface stable while letting this tool
 * own its per-caller notes cache. A future Wave 1 wave that extends
 * `HiveState` can promote this to a typed field without changing call sites.
 */
interface HiveStateWithNotes {
  progressNotes?: Record<string, string>;
}

function getProgressNotesMap(state: HiveState): Record<string, string> {
  const bag = state as unknown as HiveStateWithNotes;
  if (!bag.progressNotes) {
    bag.progressNotes = Object.create(null) as Record<string, string>;
  }
  return bag.progressNotes;
}

/** Rough token estimate from raw note characters. */
function estimateTokens(notes: string): number {
  return Math.ceil(notes.length / CHARS_PER_TOKEN);
}

/**
 * Resolve the worker's token cap. The legacy `progressSummaryTokenLimit`
 * setting (Wave 0's `WorkerGovernance`) was removed by F9 along with the
 * rest of the legacy budget shape. Falls back to the 2000-token default
 * until the structured-strategy config (C5, deferred to v3) lands.
 */
function getProgressSummaryTokenLimit(_state: HiveState): number {
  // TODO C5: lift this into `WorkerBudgetStrategy` once the structured
  // strategy config lands. Until then we use the constant below.
  return DEFAULT_PROGRESS_SUMMARY_TOKEN_LIMIT;
}

/**
 * Resolve the caller's effective budget strategy. The structured strategy
 * (C5) is deferred to v3; for now we always return `"default"` since the
 * legacy `governance.budgetStrategy` / `settings.workerBudgets.budgetStrategy`
 * keys were removed by F9.
 */
function resolveStrategy(_state: HiveState, _runtime: AgentRuntime | undefined): "default" | "compact" {
  return "default";
}

/**
 * Record a `progress_notes` kind entry on the worker's ledger. The legacy
 * typed `BudgetLedgerKind` union does not include `progress_notes`; the cast
 * widens it to the G-08 `kind?: string` forward-compat string. The
 * try/catch keeps the tool working when the Wave 0 ledger stub throws.
 */
function recordProgressLedgerEntry(ledger: BudgetLedger, signal: AbortSignal | undefined): void {
  try {
    const snapshotAny = ledger.snapshot as unknown as (
      stats: unknown,
      policy: unknown,
      kind: string,
      sig?: AbortSignal,
    ) => void;
    snapshotAny({}, {}, "progress_notes", signal);
  } catch {
    // Stub or unsupported ledger — don't fail the tool.
  }
}

/**
 * Build the `summarize_progress` tool definition for a worker.
 *
 * @param state        Shared HiveState (used to resolve the worker's runtime
 *                     and to store per-caller progress notes).
 * @param callerName   The worker that is calling the tool (resolved by
 *                     `buildHiveTools` at registration time).
 * @param ledger       The worker's restored `BudgetLedger`. Receives a
 *                     `progress_notes` kind entry on every successful call.
 */
export function buildSummarizeProgressTool(
  state: HiveState,
  callerName: string,
  ledger: BudgetLedger,
): ToolDefinition {
  return {
    name: "summarize_progress",
    label: "Summarize Progress",
    description:
      "Record wrap-up notes for your worker session. The latest notes are stored on the hive state and replayed to operator interventions (end / compact / respawn). Under the `compact` budget strategy, pass `compact: true` to inject the notes into LLM context immediately; under `default` the flag is rejected. Notes are capped at progressSummaryTokenLimit tokens (default 2000).",
    parameters: summarizeProgressParams,
    async execute(
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: ToolUpdate | undefined,
      _ctx: ExtensionContext,
    ): Promise<SummarizeProgressResult> {
      const p = (params ?? {}) as Static<typeof summarizeProgressParams>;
      const notes = typeof p.notes === "string" ? p.notes : "";
      const compactRequested = Boolean(p.compact);

      // 1. Resolve runtime. Shutdown / pre-dispatch callers have no entry in
      //    state.runtimes; surface that as no_runtime.
      const runtime = state.runtimes.get(callerName);
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

      // 2. Token cap gate.
      const estimatedTokens = estimateTokens(notes);
      const limit = getProgressSummaryTokenLimit(state);
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

      // 3. Always store the notes on state.progressNotes[callerName] so the
      //    operator interventions see the latest wrap-up state.
      getProgressNotesMap(state)[callerName] = notes;

      // 4. Compact-mode branch: validate strategy, then either inject via
      //    appendCustomMessageEntry or return compact_failed.
      if (compactRequested) {
        const strategy = resolveStrategy(state, runtime);
        if (strategy !== "compact") {
          return {
            content: [{
              type: "text",
              text: `summarize_progress: compact flag ignored under "${strategy}" strategy — operator drives intervention. Notes stored.`,
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
        const sessionManager = (
          runtime.session as { sessionManager?: { appendCustomMessageEntry?: (...args: unknown[]) => unknown } } | undefined
        )?.sessionManager;
        if (sessionManager?.appendCustomMessageEntry) {
          sessionManager.appendCustomMessageEntry(
            "progress_note",
            notes,
            false,
            { tokenCount: estimatedTokens, caller: callerName },
          );
        }
      }

      // 5. Ledger write — best-effort; the Wave 0 stub may throw.
      recordProgressLedgerEntry(ledger, signal);

      // 6. Success.
      const strategy = compactRequested ? "compact" : resolveStrategy(state, runtime);
      return {
        content: [{
          type: "text",
          text: `summarize_progress: stored ${estimatedTokens}/${limit} tokens of notes for "${callerName}"${compactRequested ? " (compact honored)" : ""}.`,
        }],
        details: {
          ok: true,
          caller: callerName,
          stored: true,
          compacted: compactRequested,
          compactRequested,
          estimatedTokens,
          limit,
          strategy,
        },
      };
    },
    renderCall(args: unknown, theme: Theme, _context: unknown) {
      const a = (args || {}) as Static<typeof summarizeProgressParams>;
      const notes = typeof a.notes === "string" ? a.notes : "";
      const compact = Boolean(a.compact);
      const header = theme.fg("toolTitle", theme.bold("summarize_progress ")) +
        theme.fg("dim", `[${notes.length} chars${compact ? ", compact=true" : ""}]`);
      const preview = notes.length
        ? theme.fg("dim", `  ${notes.split(/\r?\n/)[0].slice(0, 80)}`)
        : theme.fg("dim", "  (empty)");
      return { render: () => [header, preview], invalidate() {} };
    },
    renderResult(
      result: AgentToolResult<unknown>,
      options: ToolRenderResultOptions,
      theme: Theme,
      _context: unknown,
    ) {
      if (options.isPartial) return { render: () => [], invalidate() {} };
      const details = (result?.details ?? {}) as SummarizeProgressDetails;
      const ok = details.ok !== false;
      const header = theme.fg(ok ? "success" : "error", `${ok ? "✓" : "✗"} `) +
        theme.fg("muted", "summarize_progress") +
        theme.fg(
          "dim",
          ` ${details.compacted ? "compacted" : "stored"} ${details.estimatedTokens ?? "?"}/${details.limit ?? "?"} tokens`,
        );
      return { render: () => [header], invalidate() {} };
    },
  } satisfies ToolDefinition;
}

/**
 * Re-export the parameter schema so tests can `Static<typeof summarizeProgressParams>`
 * without re-declaring it.
 */
export { summarizeProgressParams };

// Re-export SDK render types so consumers can build renderCall/renderResult
// implementations without re-importing them across files.
export type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext, Theme, ToolDefinition, ToolRenderResultOptions, Static };
