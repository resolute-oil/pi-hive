/**
 * Wave 0 contract stubs — operator commands + cooperative tools.
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md
 *   §2.4 The new `delegateAgent` flow — throws `BudgetExhaustedError` to refuse
 *   §2.8 EOL flexibility — 7 operator commands + 3 cooperative tools
 *          (`summarize_progress` is preserved in src/agents/tools/summarize-progress.ts
 *           per Wave 1 Agent 1D T5.7)
 *   §2.12 Every write threads `controller.signal`.
 *
 * Bodies throw — Wave 1 fills them in.
 *
 * NOTE: The plan §2.4 example uses `SessionManager.create(...).toAgentSession()`,
 * but `toAgentSession()` is not present in the local SDK
 * (`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts`).
 * Wave 1 must use `new AgentSession({...})` or `createAgentSession({...})` —
 * flagged in `WARNINGS_FOR_WAVE1`.
 */

import type {
  AgentSession,
  AgentSessionConfig,
  ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { HiveState } from "../../core/types";
import type { BudgetLedger } from "./ledger";
import {
  type DelegateAgentResult,
  type RequestCompactionArgs,
  type RequestCompactionResult,
  type RequestEndSessionArgs,
  type RequestEndSessionResult,
  type RequestSnapshotArgs,
  type RequestSnapshotResult,
  type RespawnWorkerArgs,
  type RestoreWorkerArgs,
  type SnapshotWorkerArgs,
  type WorkerOperatorArgs,
} from "./types";

// ---------------------------------------------------------------------------
// §2.4 The new `delegateAgent` flow.
// ---------------------------------------------------------------------------

export interface DelegateAgentOptions {
  fresh?: boolean;
  configOverrides?: Partial<import("../../core/types").AgentConfig>;
}

/**
 * Open (or continue) a worker session, install budget event hooks, and run
 * the supplied task. Throws `BudgetExhaustedError` when the pre-flight gate
 * refuses the dispatch (Pi-native refusal per Pi docs §2).
 */
export async function delegateAgent(
  _state: HiveState,
  _agentName: string,
  _task: string,
  _opts: DelegateAgentOptions,
  _ctx: ExtensionContext,
): Promise<DelegateAgentResult> {
  throw new Error("not implemented");
}

/**
 * Resolve the worker's effective `WorkerBudgetPolicy` (per-agent override →
 * global per-worker → global defaults). Pure function; safe to call from
 * tests with hand-built `HiveState` objects.
 */
export function resolveWorkerBudgetPolicy(
  _state: HiveState,
  _agentName: string,
): import("./types").WorkerBudgetPolicy {
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------
// §2.8 Operator commands (7 total: end, compact, respawn, pause, snapshot,
//      restore, resume) + abortWorkerCompaction.
// ---------------------------------------------------------------------------

/** `session.abort() + appendCustomEntry` — graceful stop, slot released. */
export async function endWorkerSession(
  _args: WorkerOperatorArgs,
  _ctx: ExtensionContext,
): Promise<{ ok: true; ledger: BudgetLedger }> {
  throw new Error("not implemented");
}

/** `session.compact(customInstructions?)` — SDK compaction; slot preserved. */
export async function compactWorkerSession(
  _args: WorkerOperatorArgs,
  _ctx: ExtensionContext,
  _customInstructions?: string,
): Promise<{ ok: true; ledger: BudgetLedger }> {
  throw new Error("not implemented");
}

/** `session.dispose() + SessionManager.create() + branchWithSummary(...)`. */
export async function respawnWorkerSession(
  _args: RespawnWorkerArgs,
  _ctx: ExtensionContext,
): Promise<{ ok: true; sessionId: string; ledger: BudgetLedger }> {
  throw new Error("not implemented");
}

/** `session.waitForIdle() + appendCustomEntry("pause", ...)` — resumable. */
export async function pauseWorkerSession(
  _args: WorkerOperatorArgs,
  _ctx: ExtensionContext,
): Promise<{ ok: true; ledger: BudgetLedger }> {
  throw new Error("not implemented");
}

/** `session_manager.branchWithSummary(leafId, summary)`. */
export async function snapshotWorkerSession(
  _args: SnapshotWorkerArgs,
  _ctx: ExtensionContext,
): Promise<{ ok: true; snapshotId: string; ledger: BudgetLedger }> {
  throw new Error("not implemented");
}

/** `SessionManager.createBranchedSession(leafId)` — destination session emits. */
export async function restoreWorkerSession(
  _args: RestoreWorkerArgs,
  _ctx: ExtensionContext,
): Promise<{ ok: true; sessionId: string; ledger: BudgetLedger }> {
  throw new Error("not implemented");
}

/** Counterpart to `pauseWorkerSession` — restores worker activity after a pause. */
export async function resumeWorkerSession(
  _args: WorkerOperatorArgs,
  _ctx: ExtensionContext,
): Promise<{ ok: true; ledger: BudgetLedger }> {
  throw new Error("not implemented");
}

/** `session.abortCompaction()` — cancel in-progress compaction (manual or auto). */
export async function abortWorkerCompaction(
  _args: WorkerOperatorArgs,
  _ctx: ExtensionContext,
): Promise<{ ok: true; aborted: boolean }> {
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------
// §2.8 Cooperative tools (callable by the worker itself, in addition to
//      `summarize_progress` which is preserved in src/agents/tools/summarize-progress.ts).
// ---------------------------------------------------------------------------

/** Cooperative: ask the SDK to compact now (vs. waiting for the 0% threshold). */
export async function requestCompaction(
  _args: RequestCompactionArgs,
  _ctx: ExtensionContext,
): Promise<RequestCompactionResult> {
  throw new Error("not implemented");
}

/** Cooperative: graceful self-shutdown. */
export async function requestEndSession(
  _args: RequestEndSessionArgs,
  _ctx: ExtensionContext,
): Promise<RequestEndSessionResult> {
  throw new Error("not implemented");
}

/** Cooperative: branch the session for later `restoreWorkerSession`. */
export async function requestSnapshot(
  _args: RequestSnapshotArgs,
  _ctx: ExtensionContext,
): Promise<RequestSnapshotResult> {
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------
// SDK type re-exports (read-only; Wave 1 must use these, not invent shapes).
// ---------------------------------------------------------------------------

export type {
  AgentSession,
  AgentSessionConfig,
  ExtensionContext,
  SessionManager,
};
