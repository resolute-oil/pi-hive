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
//
// Region markers (per `04-refactor-plan.md` §11.5): Wave 3's four parallel
// agents (3A, 3B, 3C, 3D) each fill in the functions inside their region.
// 3A does not edit this file (it touches F3+F4 elsewhere); 3B / 3C / 3D own
// the three regions below. The markers are pure comments — no runtime cost.

import type { BudgetLedgerEntry } from "../../core/types";

// >>> region: agent-3B (T5.1, T5.2, T5.4, T5.8, T5.9, T5.13, T5.14, T5.15)
//
// 3B region: F5 stop / pause / resume / escape commands (8 of 11 operator
// commands). The branch/clone subset (respawn / snapshot / restore) lives in
// agent-3C below because they share SessionManager branch-with-summary code
// paths and benefit from being colocated in one diff.

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

// Save the worker's state without aborting. SDK: session.waitForIdle() +
// ledger entry. Ledger: kind: "pause". Resumable via resumeWorkerSession.
export async function pauseWorkerSession(
  _agent: string,
  _reason: string,
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
// <<< region: agent-3B

// >>> region: agent-3C (T5.3, T5.5, T5.6)
//
// 3C region: F5 branch / clone commands (3 of 11 operator commands). These
// share SessionManager branchWithSummary plumbing and benefit from a single
// agent owning them. Distinct from agent-3B because their SDK surface is
// session-tree navigation rather than session lifecycle.

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
// <<< region: agent-3C

// >>> region: agent-3D (T5.10, T5.11, T5.12)
//
// 3D region: F5 cooperative tools (3 agent-callable tools). Worker agents
// invoke these to suggest their own end-of-life; the operator surface sees
// the resulting `cooperative-*` kind entries and can confirm or override.
// Distinct from agent-3B / agent-3C because these are agent-callable rather
// than operator-only.

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
// <<< region: agent-3D