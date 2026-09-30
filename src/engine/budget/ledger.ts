// Wave 0 contract stub — Slice 1: BudgetLedger class shape
//
// The public surface of BudgetLedger (per §2.3 of the refactor plan and the
// Walkthrough decisions). Wave 1 implements the body; Wave 0 pins the signature
// so the rest of the system can be built against a stable API.
//
// All method bodies throw `Error("not implemented")` by design — no behavior
// is locked in here. The readonly `entries` and `cumulative` accessors are
// declared but uninitialized; their material form (initialize in constructor,
// or getters) is a Wave 1 decision.

// AbortSignal is a global (DOM lib + @types/node); the codebase does not
// import it from `node:events` (which only exports EventEmitter). The SDK and
// every other call site use the global type implicitly.
import type { SessionManager, SessionStats } from "@earendil-works/pi-coding-agent";
import type { BudgetLedgerEntry, WorkerBudgetPolicy } from "../../core/types";

export class BudgetLedger {
  // Static factory: re-derive a ledger from the active branch of a session.
  // The arity is pinned at 4 (sessionManager, agentName, policy, signal) so a
  // future refactor that drops a parameter fails the contract test before it
  // can break a downstream caller. Marked async so the stub throws via a
  // rejected promise (matches the eventual async restore implementation).
  static async restore(
    _sessionManager: SessionManager,
    _agentName: string,
    _policy: WorkerBudgetPolicy,
    _signal: AbortSignal,
  ): Promise<BudgetLedger> {
    throw new Error("not implemented");
  }

  // Live spend recorded on every message_end event. Carries the cumulative
  // counters from getSessionStats() (tokens total + cost) plus the run count
  // from the dispatcher. The signal must be honored for cancellation.
  recordEvent(
    _type: string,
    _cumulative: { tokens: number; costUsd: number; runs: number },
    _signal: AbortSignal,
  ): void {
    throw new Error("not implemented");
  }

  // Throttled snapshot writer. Called on every message_end; only persists when
  // the cadence (10 messages or ≥5% spend change) is exceeded, OR when the
  // caller is crossing a warning/exhausted threshold (always-write rule).
  maybeSnapshot(
    _cumulative: { tokens: number; costUsd: number; runs: number },
    _policy: WorkerBudgetPolicy,
    _signal: AbortSignal,
  ): void {
    throw new Error("not implemented");
  }

  // Records a compaction's savings (tokens freed) for the dashboard's
  // pre/post-compaction accounting. Pairs with the `compaction_end` event.
  recordCompaction(_savings: number, _signal: AbortSignal): void {
    throw new Error("not implemented");
  }

  // Explicit snapshot write. Always persisted (no throttle). Marker is one of
  // "warning" / "exhausted" / "checkpoint"; the latter covers operator actions
  // and the agent_settled finalization hook.
  snapshot(
    _stats: SessionStats,
    _policy: WorkerBudgetPolicy,
    _marker: "warning" | "exhausted" | "checkpoint",
    _signal: AbortSignal,
  ): void {
    throw new Error("not implemented");
  }

  // The persisted history, newest-last. Read-only by contract; writers go
  // through the methods above so the throttle/dedupe invariants are not bypassed.
  readonly entries: BudgetLedgerEntry[] = [];

  // The latest cumulative spend (tokens/cost/runs) the ledger has committed.
  // Read-only; updated by recordEvent / maybeSnapshot / snapshot.
  readonly cumulative: { tokens: number; costUsd: number; runs: number } = { tokens: 0, costUsd: 0, runs: 0 };
}
