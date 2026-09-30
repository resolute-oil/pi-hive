// Wave 0 contract stub — Slice 5 + 6: 11 operator commands + 3 cooperative tools
//
// Operator commands (slice 5) are NOT agent-callable; they are invoked from the
// operator surface (TUI, RPC, dashboard) per the refactor plan §2.8. Each
// command writes a ledger snapshot with marker "checkpoint" and a unique
// `kind` value (end / compact / respawn / pause / snapshot / restore / resume
// / compact-aborted / force-kill / force-end / tear-down-all). Wave 1 will
// implement them on top of session.abort()/compact()/dispose() and
// SessionManager.create()/continueRecent().
//
// Cooperative tools (slice 6) ARE agent-callable: a worker can call them to
// suggest end-of-life actions. They are routed through the same ledger write
// path with a `cooperative-*` kind prefix so the dashboard can distinguish
// agent-initiated vs operator-initiated shutdowns.

import type { BudgetLedgerEntry } from "../../core/types";

// ── 11 operator commands ────────────────────────────────────────────────────

// Graceful stop. SDK: session.abort(). Ledger: kind: "end".
export async function endWorkerSession(
  _agent: string,
  _reason: string,
  _signal: AbortSignal,
): Promise<{ sessionId: string; ledgerSnapshot: BudgetLedgerEntry }> {
  throw new Error("not implemented");
}

// Compact the worker's session. SDK: session.compact(customInstructions?).
// Ledger: kind: "compact". Slot preserved — worker continues after compaction.
export async function compactWorkerSession(
  _agent: string,
  _reason: string,
  _customInstructions?: string,
  _signal?: AbortSignal,
): Promise<{ sessionId: string; ledgerSnapshot: BudgetLedgerEntry }> {
  throw new Error("not implemented");
}

// Dispose the worker's session and create a new one with empty branch.
// SDK: session.dispose() + SessionManager.create() + branchWithSummary.
// Ledger: kind: "respawn". The old session id is preserved in the return for
// the operator's audit trail.
export async function respawnWorkerSession(
  _agent: string,
  _reason: string,
  _newTask?: string,
  _signal?: AbortSignal,
): Promise<{ oldSessionId: string; newSessionId: string; ledgerSnapshot: BudgetLedgerEntry }> {
  throw new Error("not implemented");
}

// Save the worker's state without aborting. SDK: session.waitForIdle() +
// ledger entry. Ledger: kind: "pause". Resumable via resumeWorkerSession.
export async function pauseWorkerSession(
  _agent: string,
  _reason: string,
  _signal: AbortSignal,
): Promise<{ sessionId: string; ledgerSnapshot: BudgetLedgerEntry }> {
  throw new Error("not implemented");
}

// Branch the worker's session at the current leaf with a label.
// SDK: session_manager.branchWithSummary(leafId, label). Ledger: kind:
// "snapshot". snapshotId returned for later restore.
export async function snapshotWorkerSession(
  _agent: string,
  _label: string,
  _signal: AbortSignal,
): Promise<{ sessionId: string; snapshotId: string; ledgerSnapshot: BudgetLedgerEntry }> {
  throw new Error("not implemented");
}

// Navigate to a previously-created snapshot. SDK:
// SessionManager.createBranchedSession(leafId). The destination session's
// installBudgetEventHooks writes the final checkpoint (per T5.6 in the plan).
export async function restoreWorkerSession(
  _agent: string,
  _snapshotId: string,
  _signal: AbortSignal,
): Promise<{ sessionId: string; ledgerSnapshot: BudgetLedgerEntry }> {
  throw new Error("not implemented");
}

// Resume a paused worker. No new SDK primitive; removes the "pause" marker
// from the ledger and continues from the existing session reference.
export async function resumeWorkerSession(
  _agent: string,
  _signal: AbortSignal,
): Promise<{ sessionId: string; ledgerSnapshot: BudgetLedgerEntry }> {
  throw new Error("not implemented");
}

// Cancel an in-flight compaction. SDK: session.abortCompaction(). Ledger:
// kind: "compact-aborted".
export async function abortWorkerCompaction(
  _agent: string,
  _signal: AbortSignal,
): Promise<{ sessionId: string; ledgerSnapshot: BudgetLedgerEntry }> {
  throw new Error("not implemented");
}

// Hard kill: dispose the session immediately. Used as the last-resort escape
// hatch when the worker is stuck and cooperative tools fail. Ledger:
// kind: "force-kill".
export async function forceKillWorkerSession(
  _agent: string,
  _reason: string,
  _signal: AbortSignal,
): Promise<{ sessionId: string; ledgerSnapshot: BudgetLedgerEntry }> {
  throw new Error("not implemented");
}

// Force graceful end (vs cooperative end). Aborts the session and writes a
// ledger entry. Ledger: kind: "force-end".
export async function forceEndWorkerSession(
  _agent: string,
  _reason: string,
  _signal: AbortSignal,
): Promise<{ sessionId: string; ledgerSnapshot: BudgetLedgerEntry }> {
  throw new Error("not implemented");
}

// Tear down every active worker in the team. Force=true disposes; force=false
// aborts. Ledger: kind: "tear-down-all". Returns the stopped list and any
// skipped workers (e.g., already-idle or in an unsaveable state).
export async function tearDownAllWorkers(
  _reason: string,
  _opts?: { force?: boolean },
  _signal?: AbortSignal,
): Promise<{ stopped: string[]; skipped: Array<{ agent: string; reason: string }>; ledgerSnapshot: BudgetLedgerEntry }> {
  throw new Error("not implemented");
}

// ── 3 cooperative tools (agent-callable) ────────────────────────────────────

// Agent-callable: "I want to compact my own session". SDK: session.compact().
// Ledger: kind: "cooperative-compact".
export async function request_compaction(
  _customInstructions?: string,
  _signal?: AbortSignal,
): Promise<{ ledgerSnapshot: BudgetLedgerEntry }> {
  throw new Error("not implemented");
}

// Agent-callable: "I want to end my own session". SDK: session.abort().
// Ledger: kind: "cooperative-end".
export async function request_end_session(
  _reason: string,
  _signal: AbortSignal,
): Promise<{ ledgerSnapshot: BudgetLedgerEntry }> {
  throw new Error("not implemented");
}

// Agent-callable: "snapshot my own session so the operator can restore it".
// SDK: session_manager.branchWithSummary(). Ledger: kind:
// "cooperative-snapshot".
export async function request_snapshot(
  _label: string,
  _signal: AbortSignal,
): Promise<{ ledgerSnapshot: BudgetLedgerEntry }> {
  throw new Error("not implemented");
}
