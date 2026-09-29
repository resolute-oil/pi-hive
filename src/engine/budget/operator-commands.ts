/**
 * Operator command surface (F5b + F5c).
 *
 * The 8 operator commands in `src/engine/budget/worker-tools.ts` are
 * function-complete and tested in `tests/budget-eol.test.ts`. They had no
 * production caller until the F5 wiring. This module provides:
 *
 *   - `invokeOperatorCommand(state, commandName, args)` — typed helper that
 *     resolves the worker's runtime, restores the `BudgetLedger`, resolves
 *     the `WorkerBudgetPolicy`, builds the `WorkerSessionHandle` (and any
 *     command-specific deps), and dispatches to the right operator function.
 *     Returns the per-command result envelope.
 *
 *   - `OPERATOR_COMMANDS` — canonical map of operator command names to
 *     metadata (`description`, `argShape`). The Pi command surface in
 *     `src/integration/commands.ts` consumes this to register the slash
 *     commands; the dashboard RPC stub in
 *     `src/observability/server/operator-rpc.ts` consumes it for the
 *     HTTP envelope shape.
 *
 * Source: HANDOFF.md §"Order of operations" task 2 (Wire the F5 surface).
 * Refactor plan: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md §2.8.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentRuntime, HiveState } from "../../core/types";
import { resolveWorkerBudgetPolicy } from "./worker-tools";
import { resolveRuntime } from "../agent-lookup";
import { BudgetLedger } from "./ledger";
import type {
  RespawnWorkerArgs,
  RestoreWorkerArgs,
  SnapshotWorkerArgs,
  WorkerBudgetPolicy,
  WorkerOperatorArgs,
} from "./types";
import {
  abortWorkerCompaction,
  compactWorkerSession,
  endWorkerSession,
  pauseWorkerSession,
  respawnWorkerSession,
  restoreWorkerSession,
  resumeWorkerSession,
  snapshotWorkerSession,
  type OperatorCommandResult,
  type OperatorCommandAborted,
  type RespawnWorkerResult,
  type RestoreWorkerOutcome,
  type SnapshotWorkerResult,
  type WorkerSessionHandle,
} from "./worker-tools";

// ---------------------------------------------------------------------------
// Public command name enum + metadata.
// ---------------------------------------------------------------------------

export type OperatorCommandName =
  | "end"
  | "compact"
  | "pause"
  | "resume"
  | "abort-compaction"
  | "respawn"
  | "snapshot"
  | "restore";

export interface OperatorCommandMeta {
  /** Canonical name (matches the dispatch key in `invokeOperatorCommand`). */
  name: OperatorCommandName;
  /** Human-readable description for `/hive:worker-<name>` command registry. */
  description: string;
  /** Argument shape (informational; full validation lives in each command). */
  argShape: string;
}

/**
 * Canonical table of operator commands. Order is preserved for the CLI
 * surface (`/hive:worker-end <agent>`, etc.). The dashboard RPC uses the
 * `name` field as the route key.
 */
export const OPERATOR_COMMANDS: readonly OperatorCommandMeta[] = [
  { name: "end", description: "Gracefully end a worker session", argShape: "agent:string,reason?:string" },
  { name: "compact", description: "Compact a worker session and snapshot", argShape: "agent:string,reason?:string" },
  { name: "pause", description: "Pause a worker session (resumable)", argShape: "agent:string,reason?:string" },
  { name: "resume", description: "Resume a paused worker session", argShape: "agent:string" },
  { name: "abort-compaction", description: "Cancel an in-flight compaction", argShape: "agent:string,reason?:string" },
  { name: "respawn", description: "Tear down + respawn the worker fresh", argShape: "agent:string,reason?:string,newTask?:string" },
  { name: "snapshot", description: "Branch the session for later restore", argShape: "agent:string,label?:string" },
  { name: "restore", description: "Restore a worker session from a snapshot", argShape: "agent:string,snapshotId:string" },
] as const;

// ---------------------------------------------------------------------------
// Error envelopes.
// ---------------------------------------------------------------------------

export class OperatorCommandError extends Error {
  constructor(
    public readonly commandName: OperatorCommandName,
    public readonly code: "unknown_agent" | "no_runtime" | "no_session" | "operator_failed",
    message: string,
  ) {
    super(message);
    this.name = "OperatorCommandError";
  }
}

// ---------------------------------------------------------------------------
// Session shape (we accept `runtime.session` as `unknown` in AgentRuntime;
// the cooperative tools + operator commands agree on a narrow structural view).
// ---------------------------------------------------------------------------

/** Structural view of `runtime.session` for the operator command surface. */
export interface OperatorWorkerSession {
  sessionId: string;
  abort(): Promise<void>;
  compact(customInstructions?: string): Promise<{ tokensBefore: number; estimatedTokensAfter?: number }>;
  waitForIdle(): Promise<void>;
  abortCompaction(): Promise<void>;
  dispose?(): Promise<void>;
  sessionManager?: SessionManager;
}

/** Look up the runtime, restore the ledger, and resolve the policy. */
async function buildWorkerSessionHandle(state: HiveState, agentName: string): Promise<WorkerSessionHandle> {
  const runtime = resolveRuntime(state, agentName) as AgentRuntime | undefined;
  if (!runtime) {
    throw new OperatorCommandError("end", "unknown_agent",
      `Operator command: unknown agent "${agentName}". Available: ${Array.from(state.runtimes.keys()).join(", ") || "(none)"}.`);
  }
  const session = (runtime as { session?: OperatorWorkerSession }).session;
  if (!session) {
    throw new OperatorCommandError("end", "no_session",
      `Operator command: agent "${agentName}" has no live session (status: ${runtime.status}).`);
  }
  const sessionManager = session.sessionManager;
  if (!sessionManager) {
    throw new OperatorCommandError("end", "no_session",
      `Operator command: agent "${agentName}" has no sessionManager exposed on its session.`);
  }
  const policy = resolveWorkerBudgetPolicy(state, agentName) as WorkerBudgetPolicy;
  // `BudgetLedger.restore` reads existing CustomEntries off the sessionManager
  // and reconstructs the in-memory cumulative. It's idempotent — calling it
  // repeatedly produces a fresh ledger against the latest branch state.
  const ledger = await BudgetLedger.restore(sessionManager, agentName, policy);
  return {
    session: session as unknown as AgentSession,
    ledger,
    policy,
  };
}

// ---------------------------------------------------------------------------
// Per-command deps derivation. The 3 "complex" commands (respawn / snapshot /
// restore) take a `Deps` parameter rather than the simple WorkerSessionHandle;
// all three can be derived from the handle + args.
// ---------------------------------------------------------------------------

function depsForSnapshot(handle: WorkerSessionHandle): {
  sessionManager: SessionManager;
  ledger: typeof handle.ledger;
  session: typeof handle.session;
  policy: typeof handle.policy;
} {
  const session = handle.session as unknown as OperatorWorkerSession;
  if (!session.sessionManager) {
    throw new OperatorCommandError("snapshot", "no_session",
      `snapshot: agent session has no exposed sessionManager — cannot branch.`);
  }
  return {
    sessionManager: session.sessionManager,
    ledger: handle.ledger,
    session: handle.session,
    policy: handle.policy,
  };
}

function depsForRespawn(handle: WorkerSessionHandle): {
  oldSession: AgentSession;
  oldSessionManager: SessionManager;
  oldLedger: typeof handle.ledger;
  policy: typeof handle.policy;
} {
  const session = handle.session as unknown as OperatorWorkerSession;
  if (!session.sessionManager) {
    throw new OperatorCommandError("respawn", "no_session",
      `respawn: agent session has no exposed sessionManager — cannot branch old session.`);
  }
  return {
    oldSession: handle.session,
    oldSessionManager: session.sessionManager,
    oldLedger: handle.ledger,
    policy: handle.policy,
  };
}

function depsForRestore(handle: WorkerSessionHandle, args: RestoreWorkerArgs): {
  sourceSessionManager: SessionManager;
  snapshotLeafId: string;
  policy: typeof handle.policy;
} {
  const session = handle.session as unknown as OperatorWorkerSession;
  if (!session.sessionManager) {
    throw new OperatorCommandError("restore", "no_session",
      `restore: agent session has no exposed sessionManager — cannot open snapshot.`);
  }
  if (!args.snapshotId || typeof args.snapshotId !== "string") {
    throw new OperatorCommandError("restore", "operator_failed",
      `restore: snapshotId is required (the branch_leaf_id returned by snapshotWorkerSession).`);
  }
  return {
    sourceSessionManager: session.sessionManager,
    snapshotLeafId: args.snapshotId,
    policy: handle.policy,
  };
}

// ---------------------------------------------------------------------------
// The dispatcher.
// ---------------------------------------------------------------------------

/** Union of all operator command return envelopes. */
export type OperatorCommandEnvelope =
  | OperatorCommandResult
  | OperatorCommandAborted
  | RespawnWorkerResult
  | SnapshotWorkerResult
  | RestoreWorkerOutcome;

/**
 * Dispatch an operator command by name. Resolves the runtime + handle, then
 * invokes the corresponding function from `worker-tools.ts`.
 *
 * @param state         Live HiveState.
 * @param commandName   Canonical command name (see `OPERATOR_COMMANDS`).
 * @param args          `WorkerOperatorArgs` (extended per command: `newTask?`
 *                      for respawn, `label?` for snapshot, `snapshotId` for
 *                      restore). The `agent` field is always required.
 * @param ctx           Extension context (passed through to operator functions).
 * @returns Per-command result envelope (OperatorCommandResult, RespawnWorkerResult,
 *          SnapshotWorkerResult, or RestoreWorkerOutcome).
 */
export async function invokeOperatorCommand(
  state: HiveState,
  commandName: OperatorCommandName,
  args: WorkerOperatorArgs & Partial<RespawnWorkerArgs> & Partial<SnapshotWorkerArgs> & RestoreWorkerArgs,
  ctx?: ExtensionContext,
): Promise<OperatorCommandEnvelope> {
  const handle = await buildWorkerSessionHandle(state, args.agent);
  const extCtx = (ctx ?? ({ cwd: process.cwd(), hasUI: false }) as unknown) as ExtensionContext;

  switch (commandName) {
    case "end":
      return await endWorkerSession(args as WorkerOperatorArgs, extCtx, handle);
    case "compact":
      return await compactWorkerSession(args as WorkerOperatorArgs, extCtx, handle);
    case "pause":
      return await pauseWorkerSession(args as WorkerOperatorArgs, extCtx, handle);
    case "resume":
      return await resumeWorkerSession(args as WorkerOperatorArgs, extCtx, handle);
    case "abort-compaction":
      return await abortWorkerCompaction(args as WorkerOperatorArgs, extCtx, handle);
    case "respawn":
      return await respawnWorkerSession(args as RespawnWorkerArgs, extCtx, depsForRespawn(handle));
    case "snapshot":
      return await snapshotWorkerSession(args as SnapshotWorkerArgs, extCtx, depsForSnapshot(handle));
    case "restore":
      return await restoreWorkerSession(args as RestoreWorkerArgs, extCtx, depsForRestore(handle, args as RestoreWorkerArgs));
    default: {
      const exhaustive: never = commandName;
      throw new OperatorCommandError(exhaustive, "operator_failed", `Unknown operator command: ${String(commandName)}`);
    }
  }
}
