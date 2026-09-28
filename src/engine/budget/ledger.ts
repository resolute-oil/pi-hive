/**
 * Wave 0 contract stubs — `BudgetLedger` class.
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md
 *   §2.3 ledger persistence via `appendCustomEntry("pi-hive-budget-ledger", ...)`
 *   §2.4 `BudgetLedger.restore(...)` is called by `delegateAgent` (idempotent,
 *        branch-aware — walks `sessionManager.getBranch()` filtering for the
 *        customType)
 *   §2.6 mid-run snapshot + warning + exhausted handlers
 *   §2.7 end-of-run on `agent_settled` (the canonical "Pi will not continue
 *        automatically" event)
 *   §2.12 every write MUST thread `controller.signal`
 *
 * Bodies throw — Wave 1 fills them in.
 */

import type { SessionManager, SessionStats } from "@earendil-works/pi-coding-agent";
import type {
  BudgetLedgerCaps,
  BudgetLedgerCumulative,
  BudgetLedgerKind,
  BudgetLedgerMarker,
  WorkerBudgetPolicy,
} from "./types";

/**
 * `BudgetLedger` is the persistent, branch-aware state store for a worker's
 * budget consumption. It is reconstructed from `appendCustomEntry` writes at
 * session start (`restore`) and updated on each event the policy hooks observe.
 *
 * All write methods take an `AbortSignal` (per §2.12) so Ctrl+C cancels
 * in-flight ledger writes.
 */
export class BudgetLedger {
  private readonly agentSlug: string;
  private readonly policy: WorkerBudgetPolicy;
  private readonly sessionManager: SessionManager;
  /** Cumulative spend reconstructed from the branch at restore time. */
  public readonly cumulative: BudgetLedgerCumulative;
  /** Caps captured at restore time. */
  public readonly caps: BudgetLedgerCaps;
  /** Wall-clock timestamp of the most recent ledger write. */
  public writtenAt: number;
  /** Sub-classifier for the most recent checkpoint. */
  public lastKind?: BudgetLedgerKind;
  /** Marker for the most recent ledger write (warning / exhausted / checkpoint). */
  public lastMarker?: BudgetLedgerMarker;

  private constructor(params: {
    agentSlug: string;
    policy: WorkerBudgetPolicy;
    sessionManager: SessionManager;
    cumulative: BudgetLedgerCumulative;
    caps: BudgetLedgerCaps;
    writtenAt: number;
    lastKind?: BudgetLedgerKind;
    lastMarker?: BudgetLedgerMarker;
  }) {
    this.agentSlug = params.agentSlug;
    this.policy = params.policy;
    this.sessionManager = params.sessionManager;
    this.cumulative = params.cumulative;
    this.caps = params.caps;
    this.writtenAt = params.writtenAt;
    this.lastKind = params.lastKind;
    this.lastMarker = params.lastMarker;
  }

  /**
   * §2.4 — Restore the ledger by walking `getBranch()` and reducing over
   * entries where `type === "custom" && customType === "pi-hive-budget-ledger"`.
   * Idempotent; safe to call multiple times.
   *
   * NOTE: `ctx.sessionManager` from `ExtensionContext` is `ReadonlySessionManager`,
   * a Pick of `SessionManager` not re-exported from the SDK main barrel. We
   * accept `SessionManager` here; the readonly subset (`getBranch`, `getEntries`,
   * `getLeafId`, etc.) is structurally compatible.
   */
  public static async restore(
    sessionManager: SessionManager,
    agentSlug: string,
    policy: WorkerBudgetPolicy,
    signal?: AbortSignal,
  ): Promise<BudgetLedger> {
    throw new Error("not implemented");
  }

  /**
   * §2.6 — Record a run event (e.g., `message_end`). Updates the in-memory
   * `cumulative` totals but does NOT necessarily write to the branch.
   */
  public recordEvent(_event: string, _cumulative: BudgetLedgerCumulative, _signal?: AbortSignal): void {
    throw new Error("not implemented");
  }

  /**
   * §2.6 — Throttled CustomEntry snapshot. Writes only when (a) ≥10 messages
   * since last snapshot, OR (b) ≥5% spend change since last snapshot.
   */
  public maybeSnapshot(
    cumulative: BudgetLedgerCumulative,
    policy: WorkerBudgetPolicy,
    signal?: AbortSignal,
  ): boolean {
    throw new Error("not implemented");
  }

  /**
   * §2.6 — Record a compaction event. Adjusts the cumulative token count by
   * `tokensBefore - estimatedTokensAfter`.
   */
  public recordCompaction(savings: number, signal?: AbortSignal): void {
    throw new Error("not implemented");
  }

  /**
   * §2.7 — Final snapshot on `agent_settled`. Always writes a CustomEntry
   * with `marker: "checkpoint"` and the supplied `kind`.
   */
  public snapshot(
    _stats: SessionStats,
    _policy: WorkerBudgetPolicy,
    _kind: BudgetLedgerKind | "checkpoint",
    _signal?: AbortSignal,
  ): void {
    throw new Error("not implemented");
  }

  /**
   * Read-only view of the ledger entries in the current branch (oldest first).
   * Used by the dashboard's timeline view and by tests that need to assert
   * "this event was written".
   */
  public entries(): ReadonlyArray<{
    customType: "pi-hive-budget-ledger";
    data: import("./types").BudgetLedgerData;
  }> {
    throw new Error("not implemented");
  }
}
