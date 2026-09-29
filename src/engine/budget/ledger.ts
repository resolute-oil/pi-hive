/**
 * Wave 1+3A — `BudgetLedger` class implementation.
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md
 *   §2.3 ledger persistence via `appendCustomEntry("pi-hive-budget-ledger", ...)`
 *   §2.4 `BudgetLedger.restore(...)` is called by `createBudgetAwareSession` (idempotent,
 *        branch-aware — walks `sessionManager.getBranch()` filtering for the
 *        customType)
 *   §2.6 mid-run snapshot + warning + exhausted handlers
 *   §2.7 end-of-run on `agent_settled` (the canonical "Pi will not continue
 *        automatically" event)
 *   §2.12 every write MUST thread `controller.signal`
 *   §3.3 F3 — `markWarning` / `markExhaustion` write CustomEntries with the
 *              threshold-crossing marker so the dashboard timeline and the
 *              G-02 ordering test can pin warning/exhausted before checkpoint.
 *
 * Design notes:
 * - Single source of truth: cumulative tokens/costUsd are pulled from
 *   `session.getSessionStats()` (passed in by callers) rather than tracked
 *   via mutable counters. The ledger is a derived view; `getSessionStats()`
 *   is authoritative (Hard constraint).
 * - Throttling constants are module-level named exports
 *   (`THROTTLE_MESSAGE_INTERVAL`, `THROTTLE_SPEND_RATIO`) — not magic numbers.
 *   They should be lifted to `WorkerBudgetPolicy` in a future wave (see
 *   WARNINGS_FOR_OTHER_AGENTS in the captain's handoff).
 * - No `Date.now()` / `Math.random()` / `setTimeout()` in production paths.
 *   Callers pass `stats.tokens.total` / `stats.cost` and the ledger writes
 *   `writtenAt = Date.now()` ONCE per write — this is the only place a clock
 *   is consulted and it is the canonical "when this was committed" stamp
 *   that the plan §2.3 schema requires.
 */

import type { SessionEntry, SessionManager, SessionStats } from "@earendil-works/pi-coding-agent";
import type {
  BudgetLedgerCaps,
  BudgetLedgerCumulative,
  BudgetLedgerData,
  BudgetLedgerEntry,
  BudgetLedgerKind,
  BudgetLedgerMarker,
  WorkerBudgetPolicy,
} from "./types";

/** §2.6 — write cadence defaults. Named constants, not magic numbers. */
export const THROTTLE_MESSAGE_INTERVAL = 10;
/** §2.6 — minimum relative spend change since last snapshot that triggers a write. */
export const THROTTLE_SPEND_RATIO = 0.05;
/** §2.3 — `customType` discriminator for ledger CustomEntry writes. */
export const BUDGET_LEDGER_CUSTOM_TYPE = "pi-hive-budget-ledger" as const;

/** All valid `BudgetLedgerKind` literal values — used to validate legacy entries. */
const BUDGET_LEDGER_KINDS: ReadonlySet<BudgetLedgerKind> = new Set<BudgetLedgerKind>([
  "end",
  "compact",
  "respawn",
  "pause",
  "snapshot",
  "restore",
  "resume",
  "compact-aborted",
  "cooperative-compact",
  "cooperative-end",
  "cooperative-snapshot",
]);

function asBudgetLedgerKind(value: unknown): BudgetLedgerKind | undefined {
  return typeof value === "string" && BUDGET_LEDGER_KINDS.has(value as BudgetLedgerKind)
    ? (value as BudgetLedgerKind)
    : undefined;
}

function asBudgetLedgerMarker(value: unknown): BudgetLedgerMarker | undefined {
  return value === "warning" || value === "exhausted" || value === "checkpoint"
    ? value
    : undefined;
}

/** Minimal structural shape we need to filter the branch — keeps the typebox-free path dependency-light. */
type LedgerCustomEntry = SessionEntry & {
  type: "custom";
  customType: typeof BUDGET_LEDGER_CUSTOM_TYPE;
  data?: BudgetLedgerData;
};

function isLedgerEntry(entry: SessionEntry): entry is LedgerCustomEntry {
  return (
    entry.type === "custom" &&
    (entry as { customType?: unknown }).customType === BUDGET_LEDGER_CUSTOM_TYPE
  );
}

/** Branch-aware filter: ledger entries for this worker, oldest first. */
function ledgerEntries(sessionManager: SessionManager): LedgerCustomEntry[] {
  return sessionManager.getBranch().filter(isLedgerEntry);
}

/**
 * `BudgetLedger` is the persistent, branch-aware state store for a worker's
 * budget consumption. It is reconstructed from `appendCustomEntry` writes at
 * session start (`restore`) and updated on each event the policy hooks observe.
 *
 * All write methods check an optional `AbortSignal` (per §2.12) so Ctrl+C
 * cancels in-flight ledger writes. Because the SDK's `appendCustomEntry` does
 * not accept a signal parameter, the only thing the ledger can do is
 * short-circuit before the write.
 */
export class BudgetLedger {
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
  /**
   * The `agentSlug` this ledger belongs to (T3.2 dedup key component for
   * worker-scope warnings; matches Wave 0's `WorkerBudgetPolicy` contract).
   * Made public in Wave 3A so `installBudgetEventHooks` can read it without
   * an extra constructor parameter — the slug is already known to the
   * factory's caller (the dispatch path passes it to `BudgetLedger.restore`).
   */
  public readonly agentSlug: string;
  /**
   * Wave 3A / F3 — Dedup set for warning emissions, keyed by
   * `${scope}:${resource}:${agent|team}`. In-memory only (not persisted to
   * the branch via `appendCustomEntry`); a session respawn starts fresh so
   * the worker can re-receive the warning in its new context.
   *
   * T3.2 — plan §3.3 requires the key shape to match Wave 0's `WorkerBudgetPolicy`
   * exactly: `${scope}:${resource}:${agent|team}`. The runtime agentSlug is
   * the worker key; the team-wide key is the literal `"team"`.
   */
  public readonly warnedKeys: Set<string> = new Set<string>();

  // Throttling state — kept private; updated by recordEvent / maybeSnapshot.
  private messagesSinceLastSnapshot = 0;
  private lastSnapshottedTokens = 0;
  private lastSnapshottedCostUsd = 0;
  private lastSnapshottedRuns = 0;

  private constructor(params: {
    agentSlug: string;
    policy: WorkerBudgetPolicy;
    sessionManager: SessionManager;
    cumulative: BudgetLedgerCumulative;
    caps: BudgetLedgerCaps;
    writtenAt: number;
    lastKind?: BudgetLedgerKind;
    lastMarker?: BudgetLedgerMarker;
    messagesSinceLastSnapshot?: number;
    lastSnapshottedTokens?: number;
    lastSnapshottedCostUsd?: number;
    lastSnapshottedRuns?: number;
  }) {
    this.agentSlug = params.agentSlug;
    this.policy = params.policy;
    this.sessionManager = params.sessionManager;
    this.cumulative = params.cumulative;
    this.caps = params.caps;
    this.writtenAt = params.writtenAt;
    this.lastKind = params.lastKind;
    this.lastMarker = params.lastMarker;
    this.messagesSinceLastSnapshot = params.messagesSinceLastSnapshot ?? 0;
    this.lastSnapshottedTokens = params.lastSnapshottedTokens ?? params.cumulative.tokens;
    this.lastSnapshottedCostUsd = params.lastSnapshottedCostUsd ?? params.cumulative.costUsd;
    this.lastSnapshottedRuns = params.lastSnapshottedRuns ?? params.cumulative.runs;
  }

  /**
   * Capture the resolved caps from the supplied policy. Pure function, exposed
   * for testability and reused by `restore` and `snapshot`.
   */
  private static captureCaps(policy: WorkerBudgetPolicy): BudgetLedgerCaps {
    return {
      workerTokens: policy.worker.tokens?.cap,
      workerCostUsd: policy.worker.costUsd?.cap,
      workerRuns: policy.worker.runs?.cap,
      workerDepth: policy.worker.depth?.cap,
      teamTokens: policy.team.tokens?.cap,
      teamCostUsd: policy.team.costUsd?.cap,
      teamRuns: policy.team.runs?.cap,
    };
  }

  /**
   * §2.4 — Restore the ledger by walking `getBranch()` and reducing over
   * entries where `type === "custom" && customType === "pi-hive-budget-ledger"`.
   * Idempotent; safe to call multiple times.
   *
   * Cumulative is taken from the most recent entry for this `agentSlug`. If
   * the branch has no matching entries (fresh session), cumulative is all zeros
   * and the ledger is "empty but ready".
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
  ): Promise<BudgetLedger> {
    const ownEntries = ledgerEntries(sessionManager).filter(
      (entry) => entry.data?.agentSlug === agentSlug,
    );
    const latest = ownEntries[ownEntries.length - 1];
    const latestData = latest?.data;
    const cumulative: BudgetLedgerCumulative = latestData?.cumulative
      ? { ...latestData.cumulative }
      : { tokens: 0, costUsd: 0, runs: 0 };
    return new BudgetLedger({
      agentSlug,
      policy,
      sessionManager,
      cumulative,
      caps: BudgetLedger.captureCaps(policy),
      writtenAt: latestData?.writtenAt ?? 0,
      lastKind: latestData ? asBudgetLedgerKind(latestData.kind) : undefined,
      lastMarker: latestData ? asBudgetLedgerMarker(latestData.marker) : undefined,
      // Re-seeding throttling state from the branch lets a reload resume
      // without immediately writing again on the next message_end.
      lastSnapshottedTokens: cumulative.tokens,
      lastSnapshottedCostUsd: cumulative.costUsd,
      lastSnapshottedRuns: cumulative.runs,
    });
  }

  /**
   * §2.6 — Record a run event (e.g., `message_end`). Updates the in-memory
   * `cumulative` totals but does NOT necessarily write to the branch.
   *
   * Callers (the message_end handler in `events.ts`) source the new totals
   * from `session.getSessionStats()` — this is the only place cumulative is
   * written. The ledger is the cache; `getSessionStats()` is the truth.
   */
  public recordEvent(event: string, cumulative: BudgetLedgerCumulative): void {
    this.cumulative.tokens = cumulative.tokens;
    this.cumulative.costUsd = cumulative.costUsd;
    this.cumulative.runs = cumulative.runs;
    if (event === "message_end") {
      this.messagesSinceLastSnapshot += 1;
    }
  }

  /**
   * §2.6 — Throttled CustomEntry snapshot. Writes only when (a) the message
   * interval is reached OR (b) the spend change since the last snapshot is
   * at least `THROTTLE_SPEND_RATIO` of the last snapshotted value.
   *
   * Returns `true` when a write happened, `false` otherwise. Honors
   * `signal.aborted` (short-circuits before the SDK write).
   */
  public maybeSnapshot(
    cumulative: BudgetLedgerCumulative,
    _policy: WorkerBudgetPolicy,
    signal?: AbortSignal,
  ): boolean {
    if (signal?.aborted) return false;
    const messageTrigger = this.messagesSinceLastSnapshot >= THROTTLE_MESSAGE_INTERVAL;
    // Spend trigger: |delta| / cap >= THROTTLE_SPEND_RATIO.
    //
    // Relative-to-CAP (not relative to last snapshotted value) keeps the
    // threshold stable as cumulative grows and avoids a divide-by-zero on
    // the first post-restore snapshot. The plan §2.6 wording ("≥5% spend
    // change") leaves the baseline ambiguous; cap-relative is the only
    // interpretation that satisfies both the "10 messages" cadence and the
    // "small bumps don't write" throttling contract. When no cap is
    // configured we fall back to the message trigger only.
    const tokensCap = this.policy.worker.tokens?.cap;
    const spendTrigger =
      tokensCap !== undefined &&
      tokensCap > 0 &&
      Math.abs(cumulative.tokens - this.lastSnapshottedTokens) / tokensCap >=
        THROTTLE_SPEND_RATIO;
    if (!messageTrigger && !spendTrigger) return false;
    // Snapshot reuses the canonical "checkpoint" write path; marker is
    // undefined for throttled snapshots because §2.6 reserves markers for
    // threshold-crossing events (warning/exhausted).
    this.writeEntry({ cumulative, marker: undefined, kind: undefined, signal });
    return true;
  }

  /**
   * §2.6 — Record a compaction event. Adjusts the cumulative token count by
   * `tokensBefore - estimatedTokensAfter`. Pure in-memory update; the next
   * `maybeSnapshot` or `snapshot` will pick up the new total.
   */
  public recordCompaction(savings: number): void {
    this.cumulative.tokens = Math.max(0, this.cumulative.tokens - savings);
  }

  /**
   * §2.7 — Final snapshot on `agent_settled`. Always writes a CustomEntry
   * with `marker: "checkpoint"`. The optional `kind` distinguishes operator
   * / cooperative actions from the canonical agent_settled snapshot
   * (which uses the `"checkpoint"` sentinel meaning "no specific kind").
   *
   * Cumulative tokens/costUsd come from `stats.tokens.total` / `stats.cost`
   * — the SDK's authoritative totals (single source of truth, Hard constraint).
   */
  public snapshot(
    stats: SessionStats,
    _policy: WorkerBudgetPolicy,
    kind: BudgetLedgerKind | "checkpoint" = "checkpoint",
    signal?: AbortSignal,
  ): void {
    if (signal?.aborted) return;
    const cumulative: BudgetLedgerCumulative = {
      tokens: stats.tokens.total,
      costUsd: stats.cost,
      runs: this.cumulative.runs,
    };
    this.writeEntry({
      cumulative,
      marker: "checkpoint",
      kind: kind === "checkpoint" ? undefined : kind,
      signal,
    });
  }

  /**
   * Wave 3A / F3 — T3.2. Write a CustomEntry with `marker: "warning"` to record
   * that the worker was just notified it crossed the 20% remaining threshold.
   * The caller (events.ts) emits the matching `appendCustomMessageEntry` so the
   * worker SEES the hint in its next context; this entry is the dashboard-
   * visible record of the threshold crossing and is what the ordering test
   * (T3.6) relies on to pin the warning → checkpoint order in the branch.
   *
   * The cumulative is the worker's running totals AT THE TIME OF EMISSION —
   * never the totals from a later message. This is what makes the warning ×
   * `summarize_progress` ordering test (T3.5) deterministic.
   */
  public markWarning(cumulative: BudgetLedgerCumulative, signal?: AbortSignal): void {
    this.writeEntry({ cumulative, marker: "warning", kind: undefined, signal });
  }

  /**
   * Wave 3A / F3 — T3.3. Write a CustomEntry with `marker: "exhausted"` to
   * record the abort-at-0% threshold crossing. The caller MUST invoke
   * `session.abort()` (or `controller.abort()`) AFTER this write returns so
   * the exhausted entry is on the branch BEFORE the session aborts and emits
   * `agent_settled` (which writes the checkpoint). The branch ordering is
   * what T3.6 pins.
   */
  public markExhaustion(cumulative: BudgetLedgerCumulative, signal?: AbortSignal): void {
    this.writeEntry({ cumulative, marker: "exhausted", kind: undefined, signal });
  }

  /**
   * Internal: write a CustomEntry to the branch and refresh in-memory caches.
   * Honors `signal.aborted` — the SDK cannot cancel mid-write, so we skip
   * before issuing it.
   */
  private writeEntry(params: {
    cumulative: BudgetLedgerCumulative;
    marker: BudgetLedgerMarker | undefined;
    kind: BudgetLedgerKind | undefined;
    signal?: AbortSignal;
  }): void {
    if (params.signal?.aborted) return;
    const writtenAt = Date.now();
    const data: BudgetLedgerData = {
      caps: { ...this.caps },
      cumulative: { ...params.cumulative },
      writtenAt,
      agentSlug: this.agentSlug,
      marker: params.marker,
    };
    if (params.kind !== undefined) data.kind = params.kind;
    this.sessionManager.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, data);
    this.cumulative.tokens = params.cumulative.tokens;
    this.cumulative.costUsd = params.cumulative.costUsd;
    this.cumulative.runs = params.cumulative.runs;
    this.writtenAt = writtenAt;
    this.lastMarker = params.marker;
    this.lastKind = params.kind;
    this.messagesSinceLastSnapshot = 0;
    this.lastSnapshottedTokens = params.cumulative.tokens;
    this.lastSnapshottedCostUsd = params.cumulative.costUsd;
    this.lastSnapshottedRuns = params.cumulative.runs;
  }

  /**
   * Read-only view of the ledger entries in the current branch (oldest first),
   * filtered to this worker's `agentSlug`. Used by the dashboard's timeline
   * view and by tests that need to assert "this event was written".
   */
  public entries(): ReadonlyArray<BudgetLedgerEntry> {
    return ledgerEntries(this.sessionManager).flatMap((entry) => {
      if (entry.data?.agentSlug !== this.agentSlug) return [];
      // Strip the SDK's `id` / `parentId` / `timestamp` from the structural
      // CustomEntry shape so the return type matches our `BudgetLedgerEntry`
      // contract (which intentionally leaves the SDK lifecycle fields out
      // because the dashboard timeline derives them from the SessionEntry
      // tree separately).
      const { type, customType, data } = entry;
      if (data === undefined) return [];
      const projected: BudgetLedgerEntry = { type, customType, data };
      return [projected];
    });
  }
}
