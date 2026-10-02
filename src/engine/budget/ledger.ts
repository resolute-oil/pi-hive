// Wave 1 F1 T1.2 — BudgetLedger implementation
//
// BudgetLedger persists spend + event markers for a single worker session via
// appendCustomEntry. The active branch is the source of truth on reload:
// restore() walks the branch, filters pi-hive-budget-ledger entries, and
// reduces to the latest cumulative state.
//
// Write cadence (per the refactor plan §2.3 / §2.6):
//   - recordEvent(): live-spend observation per message_end. Throttled: writes
//     a CustomEntry only when one of the gates fires (C D2). Always updates
//     the in-memory cumulative regardless of whether a write fires.
//   - maybeSnapshot(): throttled checkpoint write. Writes only when the
//     message-count OR token-delta gates fire — same semantics as
//     recordEvent but invoked separately when the dispatcher wants a
//     explicit checkpoint (e.g., right after a budget-warning emit).
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

// Throttle constants (per the refactor plan §2.6 / T3.1 defaults, refined
// per C D2 fixup). The previous Wave 2 implementation had recordEvent write
// on EVERY message_end (~10× the planned cadence). These constants land the
// write cadence at "every 5 messages OR every 100 cumulative tokens" — the
// "or" is exclusive: satisfying either gate triggers a write.
export const MESSAGE_COUNT_THRESHOLD = 5;
export const TOKEN_COUNT_THRESHOLD = 100;

// Public knob so callers (and tests) can opt out of throttling per-call.
// `forceWrite: true` skips the gates and always writes a CustomEntry. The
// dispatcher uses this on threshold crossings so warning / exhausted markers
// land even if neither throttle gate has fired.
export interface RecordEventOptions {
  forceWrite?: boolean;
}

// Exported so policy.ts (which only consumes the branch shape) can share
// the same predicate without re-implementing the customType check. The
// entry is the SDK's generic SessionEntry; the predicate narrows it to
// the documented BudgetLedgerEntry shape.
export function isLedgerEntry(entry: SessionEntry): entry is SessionEntry & { data: BudgetLedgerEntry["data"] } {
  return entry.type === "custom" && (entry as unknown as { customType?: string }).customType === LEDGER_CUSTOM_TYPE;
}

export class BudgetLedger {
  private readonly sessionManager: SessionManager;
  // Public read accessor (F3 T3.4) so events.ts can key its budget-context
  // map by agent slug without exposing the write surface. Stored as
  // `_agentName` to keep the public field name `agentName` reserved for the
  // getter — avoids a setter and prevents callers from overwriting the
  // constructor-supplied slug.
  private readonly _agentName: string;
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
  // call; it resets on every successful write. lastWrittenTokens is the
  // cumulative.tokens value at the last successful write. Used to gate the
  // next write on either the message-count OR the absolute token-delta gate.
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
    this._agentName = agentName;
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

  // Live spend recorded on every event observation (the dispatcher calls
  // this per message_end per the §2.6 event hook). Always updates the
  // in-memory cumulative, but only writes a CustomEntry when the throttle
  // gates fire OR the caller passes forceWrite (C D2).
  //
  // Throttle gates (exclusive OR):
  //   messageGate: messagesSinceLastSnapshot >= MESSAGE_COUNT_THRESHOLD
  //   tokenGate:   |cumulative.tokens - lastWrittenTokens| >= TOKEN_COUNT_THRESHOLD
  recordEvent(
    _type: string,
    cumulative: { tokens: number; costUsd: number; runs: number },
    _signal: AbortSignal,
    options: RecordEventOptions = {},
  ): void {
    this.cumulative.tokens = cumulative.tokens;
    this.cumulative.costUsd = cumulative.costUsd;
    this.cumulative.runs = cumulative.runs;
    this.messagesSinceLastSnapshot += 1;

    if (!options.forceWrite && !this.shouldWriteCheckpoint()) return;

    const written = this.appendLedgerEntry({
      caps: this.snapshotCaps(),
      cumulative: { ...cumulative },
      writtenAt: Date.now(),
      agentSlug: this.agentName,
      // No marker / no kind — this is a throttled event write (§2.3 table).
    });
    this.entries.push(written);
    this.lastWrittenTokens = cumulative.tokens;
    this.messagesSinceLastSnapshot = 0;
  }

  // Throttled checkpoint snapshot. Writes only when the message-count OR
  // token-delta gates fire. The dispatcher also calls this with always-on
  // semantics at threshold crossings (handled by snapshot() below).
  maybeSnapshot(
    cumulative: { tokens: number; costUsd: number; runs: number },
    _policy: WorkerBudgetPolicy,
    _signal: AbortSignal,
  ): void {
    // Update the in-memory cumulative first so shouldWriteCheckpoint can
    // compute the delta against the latest observed tokens (otherwise
    // lastWrittenTokens == cumulative.tokens and the token-delta gate
    // never fires after restore()).
    this.cumulative.tokens = cumulative.tokens;
    this.cumulative.costUsd = cumulative.costUsd;
    this.cumulative.runs = cumulative.runs;
    if (!this.shouldWriteCheckpoint()) return;

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

  // Pure helper: returns true if either throttle gate is satisfied.
  // Extracted so recordEvent and maybeSnapshot share the gate evaluation
  // (C D2: one definition of the cadence rule).
  private shouldWriteCheckpoint(): boolean {
    const tokenDelta = Math.abs(this.cumulative.tokens - this.lastWrittenTokens);
    const messageGate = this.messagesSinceLastSnapshot >= MESSAGE_COUNT_THRESHOLD;
    const tokenGate = tokenDelta >= TOKEN_COUNT_THRESHOLD;
    return messageGate || tokenGate;
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
  // one of "warning" / "exhausted" / "checkpoint". The optional `kind`
  // parameter writes a distinct `data.kind` value on the ledger entry — the
  // F5 operator commands (end / compact / pause / resume / force-kill /
  // force-end / tear-down-all) and the cooperative tools
  // (request_compaction / request_end_session / request_snapshot) all pass
  // a distinct kind here so the dashboard can distinguish operator- vs
  // worker-initiated shutdowns. When `kind` is omitted, the entry is a
  // generic "checkpoint" with no documented kind — this matches the
  // pre-Wave-3 contract that the F5 layer is the only producer of the typed
  // kind values. Returns the persisted BudgetLedgerEntry so callers
  // (operator commands) can hand the snapshot back to the operator surface.
  snapshot(
    stats: SessionStats,
    _policy: WorkerBudgetPolicy,
    marker: "warning" | "exhausted" | "checkpoint",
    signal: AbortSignal,
    kind: BudgetLedgerKind | undefined = undefined,
  ): BudgetLedgerEntry {
    const cumulative = {
      tokens: stats.tokens.total,
      costUsd: stats.cost,
      runs: this.cumulative.runs,
    };
    const data: BudgetLedgerEntry["data"] = {
      caps: this.snapshotCaps(),
      cumulative,
      writtenAt: Date.now(),
      agentSlug: this.agentName,
      marker,
    };
    if (kind !== undefined) data.kind = kind;
    const written = this.appendLedgerEntry(data);
    this.entries.push(written);
    this.lastWrittenTokens = cumulative.tokens;
    this.messagesSinceLastSnapshot = 0;
    return written;
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

  // Public read accessor for the worker slug (F3 T3.4). The `installBudget
  // ToolCallHandler` extension in events.ts keys its budget-context map by
  // this string so each worker's `tool_call` handler can look up its own
  // session state. Read-only — the slug is fixed at restore() time and
  // never reassigned for the ledger's lifetime.
  get agentName(): string {
    return this._agentName;
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