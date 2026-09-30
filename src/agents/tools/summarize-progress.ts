// Wave 0 contract stub — Slice 9: summarize_progress tool
//
// The summarize_progress tool replaces the existing runtime.progressNotes field
// per the refactor plan §1.5. Wave 1 implements it on top of
// appendCustomMessageEntry("progress_note", ..., display: false, ...); the
// `compact` flag is honored only under the "compact" strategy (per F5 T5.7).
//
// The existing tool pattern (src/agents/tools.ts) exports a builder function
// that returns a ToolDefinition so the same definition can be registered for
// the orchestrator's session and for every worker's AgentSession. This stub
// matches that pattern.

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

// Returns a ToolDefinition for summarize_progress. Wave 1 wires the execute
// function to BudgetLedger.recordEvent("progress_note", ...) and the
// `compact` flag to session.compact() when the resolved strategy is "compact".
export function summarizeProgressTool(): ToolDefinition {
  throw new Error("not implemented");
}
