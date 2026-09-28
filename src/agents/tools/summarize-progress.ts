// summarize_progress tool — see tmp/budget-strategy-plan.md and
// src/engine/budget-strategy.ts.
//
// Registered for ALL workers regardless of strategy. Two effects:
//   1. Always: stores `notes` on runtime.progressNotes (overwrites previous).
//      The latest call wins so the worker can refine the wrap-up state.
//   2. Conditionally: when `compact === true` AND the runtime's resolved
//      strategy is "compact", triggers session.compact(notes). Under the
//      "default" strategy the `compact` flag is silently ignored — the tool
//      returns success and the operator drives intervention.
//
// The notes are capped at progressSummaryTokenLimit tokens (default 2000) so
// the next prompt isn't dominated by the wrap-up report. Over-cap notes are
// rejected with the current size + limit so the worker can trim and retry.

import { Type, type Static } from "typebox";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext, Theme, ToolDefinition, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { resolveRuntime } from "../../engine/agent-lookup";
import { resolveBudgetStrategy, progressSummaryTokenLimit, triggerSummarizeProgress, validateProgressNotes } from "../../engine/budget-strategy";
import type { HiveState } from "../../core/types";
import { agentSlug } from "../../core/utils";

type ToolUpdate = AgentToolUpdateCallback<object>;

const summarizeProgressParams = Type.Object({
  notes: Type.String({ description: "Wrap-up notes. Should capture current task, decisions made, files touched, validation status, and explicit next step. Will be available to operator interventions." }),
  compact: Type.Optional(Type.Boolean({ description: "Only honored under the `compact` budget strategy: when true, roll the context window now using these notes as customInstructions. Ignored under `default` strategy." })),
});

function compactOutcomeMessage(compacted: boolean, requested: boolean, strategy: "default" | "compact"): string {
  if (compacted) return "Context window rolled.";
  if (requested && strategy === "compact") return "Compact requested but session.compact() did not execute (no live session). Notes stored.";
  if (requested && strategy === "default") return `compact flag ignored under "${strategy}" strategy — operator drives intervention. Notes stored.`;
  return "Notes stored.";
}

// buildSummarizeProgressTool returns the tool definition. `callerName` is the
// worker that is calling the tool (resolved by buildHiveTools at registration
// time); `resolveRuntime(state, callerName)` looks up that worker's runtime so
// we can update progressNotes and call session.compact() on the right session.
export function buildSummarizeProgressTool(state: HiveState, callerName: string): ToolDefinition {
  return {
    name: "summarize_progress",
    label: "Summarize Progress",
    description: "Record wrap-up notes for your worker session. The notes persist on the runtime and are available to operator interventions (end / compact / respawn). Under the `compact` budget strategy, you can also pass `compact: true` to roll your context window now using these notes; otherwise the system force-compacts at 0%. Keep notes tight — the cap is the worker's progressSummaryTokenLimit (default 2000 tokens).",
    parameters: summarizeProgressParams,
    async execute(_toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: ToolUpdate | undefined, _ctx: ExtensionContext) {
      const p = (params || {}) as Static<typeof summarizeProgressParams>;
      const notes = typeof p.notes === "string" ? p.notes : "";
      const compact = Boolean(p.compact);

      const runtime = resolveRuntime(state, callerName);
      if (!runtime) {
        return {
          content: [{ type: "text", text: `summarize_progress: caller "${callerName}" has no runtime in this hive session.` }],
          details: { ok: false, reason: "no_runtime", caller: callerName },
          isError: true,
        };
      }

      const validation = validateProgressNotes(state, runtime, notes);
      if (!validation.ok) {
        return {
          content: [{ type: "text", text: `summarize_progress: ${validation.reason}` }],
          details: { ok: false, reason: "over_cap", estimatedTokens: validation.estimatedTokens, limit: validation.limit },
          isError: true,
        };
      }

      // triggerSummarizeProgress rethrows on compact failure (the runtime's
      // session.compact() can throw on provider errors). We catch here so the
      // worker gets a structured `isError: true` response matching every other
      // tool-failure path, rather than a generic propagated exception.
      let result: Awaited<ReturnType<typeof triggerSummarizeProgress>>;
      try {
        result = await triggerSummarizeProgress(state, runtime, notes, compact);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `summarize_progress: compact failed — ${message}. Notes stored.` }],
          details: { ok: false, reason: "compact_failed", error: message, estimatedTokens: validation.estimatedTokens, limit: validation.limit },
          isError: true,
        };
      }

      const strategy = resolveBudgetStrategy(state, runtime);
      const cap = progressSummaryTokenLimit(state, runtime);
      const compactMsg = compactOutcomeMessage(result.compacted, compact, strategy);
      const sizeMsg = `${validation.estimatedTokens}/${cap} tokens`;
      return {
        content: [{ type: "text", text: `summarize_progress: ${sizeMsg}. ${compactMsg}` }],
        details: { ok: true, agent: agentSlug(runtime.config), name: runtime.config.name, strategy, stored: true, compacted: result.compacted, compactRequested: compact, estimatedTokens: validation.estimatedTokens, limit: cap },
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
    renderResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, _context: unknown) {
      const r = result as { details?: { ok?: boolean; strategy?: string; compacted?: boolean; estimatedTokens?: number; limit?: number } } | undefined;
      if (options.isPartial) return { render: () => [], invalidate() {} };
      const details = r?.details || {};
      const ok = details.ok !== false;
      const header = theme.fg(ok ? "success" : "error", `${ok ? "✓" : "✗"} `) +
        theme.fg("muted", "summarize_progress") +
        theme.fg("dim", ` ${details.strategy ?? ""}${details.compacted ? " compacted" : ""} ${details.estimatedTokens ?? "?"}/${details.limit ?? "?"} tokens`);
      return { render: () => [header], invalidate() {} };
    },
  } satisfies ToolDefinition;
}
