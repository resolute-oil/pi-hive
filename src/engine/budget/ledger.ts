// Wave 1 F1 T1.2 — BudgetLedger implementation
//
// BudgetLedger persists spend + event markers for a single worker session via
// appendCustomEntry. The active branch is the source of truth on reload:
// restore() walks the branch, filters pi-hive-budget-ledger entries, and
// reduces to the latest cumulative state.
//
// Write cadence (per the refactor plan §2.3 / §2.6):
//   - recordEvent(): high-cadence "I observed an event" write. Always writes.
//   - maybeSnapshot(): throttled checkpoint write. Writes only when 10 messages
//     have elapsed since the last write OR the cumulative tokens changed by
//     >= 5% since the last write. The throttle and the spend-change check are
//     independent — satisfying either triggers a write.
//   - recordCompaction(): always writes a separate pi-hive-budget-compaction
//     CustomEntry so the savings number survives across reloads without
//     polluting the ledger-entry shape.
//   - snapshot(): always writes a ledger CustomEntry with the supplied marker
//     (warning / exhausted / checkpoint). Used for the always-on threshold
//     crossings in the event hooks (§2.6 message_end crossing 20% / 0%).
//
// The customType "pi-hive-budget-compaction" is intentionally distinct from
// "pi-hive-budget-ledger" so the two filter cleanly in the dashboard and in
// reload-time reduction.

import type { SessionManager, SessionEntry, SessionStats } from "@earendil-works/pi-coding-agent";
import type { BudgetLedgerEntry, BudgetLedgerKind, WorkerBudgetPolicy } from "../../core/types";

const LEDGER_CUSTOM_TYPE = "pi-hive-budget-ledger";
const COMPACTION_CUSTOM_TYPE = "pi-hive-budget-compaction";

// Throttle constants (per the refactor plan §2.6 / T3.1 defaults).
const MESSAGE_COUNT_THRESHOLD = 10;
const SPEND_CHANGE_THRESHOLD = 0.05; // 5%

function isLedgerEntry(entry: SessionEntry): entry is SessionEntry & { data: BudgetLedgerEntry["data"] } {
  return entry.type === "custom" && (entry as unknown as { customType?: string }).customType === LEDGER_CUSTOM_TYPE;
}

export class BudgetLedger {
  private readonly sessionManager: SessionManager;
  private readonly agentName: string;
  private readonly policy: WorkerBudgetPolicy;

  // The authoritative cumulative spend. Updated on every recordEvent and used
  // by maybeSnapshot to compute the spend-change percentage.
  cumulative: { tokens: number; costUsd: number; runs: number } = { tokens: 0, costUsd: 0, runs: 0 };

  // The persisted ledger history (newest-last). Includes every pi-hive-budget-ledger
  // CustomEntry from the active branch. Writers go through the methods below
  // so the throttle/dedupe invariants are not bypassed. (TS I1 — the previous
  // `readonly` modifier only prevented FIELD reassignment, not the array
  // contents — `entries.push(...)` and `cumulative.tokens = ...` both
  // worked through the modifier; it was misleading.)
  entries: BudgetLedgerEntry[] = [];

  // Throttle bookkeeping. messagesSinceLastSnapshot counts every recordEvent
  // call; it resets on every successful maybeSnapshot write. lastWrittenTokens
  // is the cumulative.tokens value at the last successful maybeSnapshot write.
  private messagesSinceLastSnapshot = 0;
  private lastWrittenTokens = 0;

  private constructor(
    sessionManager: SessionManager,
    agentName: string,
    policy: WorkerBudgetPolicy,
    initialEntries: BudgetLedgerEntry[],
    initialCumulative: { tokens: number; costUsd: number; runs: number },
  ) {
    this.sessionManager = sessionManager;
    this.agentName = agentName;
    this.policy = policy;
    this.cumulative.tokens = initialCumulative.tokens;
    this.cumulative.costUsd = initialCumulative.costUsd;
    this.cumulative.runs = initialCumulative.runs;
    // entries[] is initialized to the restored list; subsequent recordEvent /
    // maybeSnapshot / snapshot writes append to the in-memory list AND to the
    // branch via appendCustomEntry so the two stay in sync.
    this.entries.push(...initialEntries);
    this.lastWrittenTokens = initialCumulative.tokens;
  }

  // Static factory: re-derive a ledger from the active branch of a session.
  // The arity is pinned at 4 (sessionManager, agentName, policy, signal) so a
  // future refactor that drops a parameter fails the contract test before it
  // can break a downstream caller.
  static async restore(
    sessionManager: SessionManager,
    agentName: string,
    policy: WorkerBudgetPolicy,
    _signal: AbortSignal,
  ): Promise<BudgetLedger> {
    const branch = sessionManager.getBranch();
    const ledgerEntries: BudgetLedgerEntry[] = [];
    let latest: BudgetLedgerEntry["data"]["cumulative"] = { tokens: 0, costUsd: 0, runs: 0 };
    for (const entry of branch) {
      if (isLedgerEntry(entry)) {
        // The branch is ordered root-to-leaf; the LAST matching entry's
        // cumulative is the authoritative state for the worker's session.
        ledgerEntries.push({
          type: "custom",
          customType: LEDGER_CUSTOM_TYPE,
          data: entry.data,
        });
        latest = entry.data.cumulative;
      }
    }
    return new BudgetLedger(sessionManager, agentName, policy, ledgerEntries, latest);
  }

  // Live spend recorded on every event observation (the dispatcher calls this
  // per message_end per the §2.6 event hook). Always writes — the throttled
  // checkpoint path is maybeSnapshot().
  recordEvent(
    _type: string,
    cumulative: { tokens: number; costUsd: number; runs: number },
    _signal: AbortSignal,
  ): void {
    this.cumulative.tokens = cumulative.tokens;
    this.cumulative.costUsd = cumulative.costUsd;
    this.cumulative.runs = cumulative.runs;
    this.messagesSinceLastSnapshot += 1;

    const written = this.appendLedgerEntry({
      caps: this.snapshotCaps(),
      cumulative: { ...cumulative },
      writtenAt: Date.now(),
      agentSlug: this.agentName,
      // No marker / no kind — this is a high-cadence event write (§2.3 table).
    });
    this.entries.push(written);
  }

  // Throttled checkpoint snapshot. Writes only when the cadence (10 messages
  // since the last write) OR the spend-change threshold (≥5% tokens change
  // since the last write) is exceeded. The dispatcher also calls this with
  // always-on semantics at threshold crossings (handled by snapshot() below).
  maybeSnapshot(
    cumulative: { tokens: number; costUsd: number; runs: number },
    _policy: WorkerBudgetPolicy,
    _signal: AbortSignal,
  ): void {
    const spendDelta = this.lastWrittenTokens > 0
      ? Math.abs(cumulative.tokens - this.lastWrittenTokens) / this.lastWrittenTokens
      : 0;
    const messageGate = this.messagesSinceLastSnapshot >= MESSAGE_COUNT_THRESHOLD;
    const spendGate = spendDelta >= SPEND_CHANGE_THRESHOLD;
    if (!messageGate && !spendGate) return;

    const written = this.appendLedgerEntry({
      caps: this.snapshotCaps(),
      cumulative: { tokens: cumulative.tokens, costUsd: cumulative.costUsd, runs: cumulative.runs },
      writtenAt: Date.now(),
      agentSlug: this.agentName,
    });
    this.entries.push(written);
    this.lastWrittenTokens = cumulative.tokens;
    this.messagesSinceLastSnapshot = 0;
  }

  // Records a compaction's savings (tokens freed) for the dashboard's
  // pre/post-compaction accounting. Pairs with the `compaction_end` event.
  // Writes a SEPARATE customType so the savings number doesn't pollute the
  // ledger-entry shape (no field for savings in BudgetLedgerEntry.data).
  recordCompaction(savings: number, _signal: AbortSignal): void {
    this.sessionManager.appendCustomEntry(COMPACTION_CUSTOM_TYPE, {
      agentSlug: this.agentName,
      savings,
      writtenAt: Date.now(),
    });
  }

  // Explicit checkpoint snapshot. Always persisted (no throttle). Marker is
  // one of "warning" / "exhausted" / "checkpoint"; kind is optional (used by
  // cooperative tools / operator commands — see worker-tools.ts).
  snapshot(
    stats: SessionStats,
    _policy: WorkerBudgetPolicy,
    marker: "warning" | "exhausted" | "checkpoint",
    _signal: AbortSignal,
  ): void {
    const cumulative = {
      tokens: stats.tokens.total,
      costUsd: stats.cost,
      runs: this.cumulative.runs,
    };
    const written = this.appendLedgerEntry({
      caps: this.snapshotCaps(),
      cumulative,
      writtenAt: Date.now(),
      agentSlug: this.agentName,
      marker,
    });
    this.entries.push(written);
    this.lastWrittenTokens = cumulative.tokens;
    this.messagesSinceLastSnapshot = 0;
  }

  // Append a CustomEntry via the SDK and return the typed projection. The
  // SessionEntry that comes back from appendCustomEntry is generic; we re-type
  // it here so callers see the documented BudgetLedgerEntry shape.
  private appendLedgerEntry(
    data: BudgetLedgerEntry["data"],
  ): BudgetLedgerEntry {
    this.sessionManager.appendCustomEntry(LEDGER_CUSTOM_TYPE, data);
    return {
      type: "custom",
      customType: LEDGER_CUSTOM_TYPE,
      data,
    };
  }

  // Project the resolved policy into the ledger entry's caps shape. Each
  // optional cap becomes a flat field; absent caps are omitted. Tolerates
  // partial / missing worker / team blocks (defensive read for the contract
  // test's empty-policy stub and any external caller that omits a tier).
  private snapshotCaps(): BudgetLedgerEntry["data"]["caps"] {
    const caps: BudgetLedgerEntry["data"]["caps"] = {};
    const worker = this.policy.worker ?? {};
    const team = this.policy.team ?? {};
    if (worker.tokens?.cap !== undefined) caps.workerTokens = worker.tokens.cap;
    if (worker.costUsd?.cap !== undefined) caps.workerCostUsd = worker.costUsd.cap;
    if (worker.runs?.cap !== undefined) caps.workerRuns = worker.runs.cap;
    if (worker.depth?.cap !== undefined) caps.workerDepth = worker.depth.cap;
    if (team.tokens?.cap !== undefined) caps.teamTokens = team.tokens.cap;
    if (team.costUsd?.cap !== undefined) caps.teamCostUsd = team.costUsd.cap;
    if (team.runs?.cap !== undefined) caps.teamRuns = team.runs.cap;
    return caps;
  }
}

// Re-exported so worker-tools.ts can use the same BudgetLedgerKind union if it
// wants to enforce the documented value set on operator commands.
export type { BudgetLedgerKind };