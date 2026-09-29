/**
 * Wave 2 — F2 mid-run budget event hooks.
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md
 *   §2.6 Mid-run handler — subscribes to `AgentSession.subscribe(...)` and
 *          handles `message_end`, `compaction_end`, `agent_settled`.
 *   §2.12 Every write threads `controller.signal` (or `ctx.signal`).
 *
 * Returns an unsubscribe function.
 *
 * Event-handler contract (per plan §2.6 + Wave 2 / F2 spine):
 *
 *   - `message_end`     → `ledger.recordEvent("message_end", cumulative, signal)`
 *                         + `ledger.maybeSnapshot(cumulative, policy, signal)`
 *     Cumulative tokens/cost are read from `session.getSessionStats()` —
 *     the SDK's authoritative aggregate (single source of truth, Hard
 *     constraint). `ledger.cumulative.runs` is preserved from the in-memory
 *     counter (getSessionStats() does not carry runs).
 *
 *   - `compaction_end`  → `ledger.recordCompaction(savings, signal)`
 *     `savings = tokensBefore - estimatedTokensAfter` from `event.result`.
 *     The ledger adjusts the in-memory cumulative tokens so the next
 *     `message_end` reads a post-compaction total.
 *
 *   - `agent_settled`   → `ledger.snapshot(stats, policy, "checkpoint", signal)`
 *     Final write. Uses the same authoritative stats source as `message_end`.
 *
 * Warning and exhaustion handlers (plan §2.6 mid-run block) belong to F3
 * (Wave 3); F2 is the spine. The factory is shaped so adding `warning` and
 * `exhausted` cases in F3 is a single if-arm change with no signature
 * break.
 *
 * Teardown
 * --------
 * Returns the unsubscribe handle from `session.subscribe(...)`. The
 * controller is owned by the caller — this factory does NOT abort it on
 * unsubscribe (calling abort is destructive; the dispatch path may still be
 * inside `session.prompt()` and need the signal alive).
 *
 * Hard constraints honored:
 *   - `controller.signal` threaded into every ledger write (§2.12).
 *   - No `Date.now()` / `Math.random()` / `setTimeout()` in production paths
 *     (the one allowed `Date.now()` lives in `BudgetLedger.writeEntry` and
 *     stamps `writtenAt` — that is the canonical "when committed" field per
 *     plan §2.3).
 *   - Single source of truth: cumulative tokens/cost are read from
 *     `session.getSessionStats()` only — no mutable counters here.
 */

import type { AgentSession, SessionManager, SessionStats } from "@earendil-works/pi-coding-agent";
import type { BudgetLedger } from "./ledger";
import type { WorkerBudgetPolicy } from "./types";

/**
 * Shape of the `session.subscribe(...)` event the factory consumes. Kept as
 * a narrow union (vs. importing the full `AgentSessionEvent`) so the unit
 * tests can build events without standing up the entire SDK type tree.
 *
 * `result` is narrowed separately inside the compaction branch because
 * TypeScript can't always follow a `{ type: string }` fall-through to the
 * precise variant in a chained conditional.
 */
interface CompactionResultShape {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

/** Subscription surface we need from `AgentSession`. Declared structurally
 * so unit tests can pass minimal fakes (the real `AgentSession` satisfies
 * this trivially). */
interface SubscribableSession {
  subscribe(listener: (event: unknown) => void): () => void;
  getSessionStats(): SessionStats;
}

/**
 * Pull `tokens.total` and `cost` from `SessionStats`. Defensive: the SDK
 * usually returns a populated `tokens` block but legacy / stub sessions may
 * not; coerce to finite numbers, falling back to 0 so `recordEvent` does
 * not receive `NaN` / `undefined`.
 */
function readAuthoritativeTotals(stats: SessionStats): { tokens: number; costUsd: number } {
  const totalTokens = Number(stats?.tokens?.total);
  const costUsd = Number(stats?.cost);
  return {
    tokens: Number.isFinite(totalTokens) ? totalTokens : 0,
    costUsd: Number.isFinite(costUsd) ? costUsd : 0,
  };
}

/**
 * Install all budget-related event hooks on the given `AgentSession`.
 *
 * Subscribes once and dispatches on `event.type`. Returns the unsubscribe
 * handle. The caller owns the `AbortController` and is responsible for
 * invoking the unsubscribe (or letting the session dispose tear it down).
 *
 * @param session          The session to observe (typed structurally for testability).
 * @param ledger           The worker's restored `BudgetLedger`.
 * @param policy           The worker's resolved `WorkerBudgetPolicy`.
 * @param sessionManager   The worker's `SessionManager` — present for F3 wiring
 *                         (warning emit via `appendCustomMessageEntry`); F2
 *                         accepts it so the call site does not need to change
 *                         when F3 lands. Currently unused in the F2 spine
 *                         (ledger writes go through the ledger's own SM).
 * @param controller       AbortController whose signal is threaded into every write.
 * @returns                Unsubscribe function.
 */
export function installBudgetEventHooks(
  session: SubscribableSession,
  ledger: BudgetLedger,
  policy: WorkerBudgetPolicy,
  _sessionManager: SessionManager,
  controller: AbortController,
): () => void {
  return session.subscribe((event: unknown) => {
    if (!event || typeof event !== "object" || !("type" in event)) return;
    const type = (event as { type: unknown }).type;
    if (typeof type !== "string") return;

    if (type === "message_end") {
      const stats = session.getSessionStats();
      const { tokens, costUsd } = readAuthoritativeTotals(stats);
      // Preserve the in-memory runs counter (the SDK does not carry runs in
      // its aggregate; the ledger maintains it from prior `recordEvent` /
      // `snapshot` calls).
      const cumulative = {
        tokens,
        costUsd,
        runs: ledger.cumulative.runs,
      };
      // §2.6 — record first, then snapshot. The recordEvent update MUST
      // happen before the snapshot reads the new totals so a
      // post-message-end `maybeSnapshot` reflects the message we just saw.
      ledger.recordEvent("message_end", cumulative, controller.signal);
      ledger.maybeSnapshot(cumulative, policy, controller.signal);
      return;
    }

    if (type === "compaction_end") {
      const result = (event as { result?: CompactionResultShape }).result;
      if (!result) return;
      const tokensBefore = Number(result.tokensBefore);
      const estimatedTokensAfter = Number(result.estimatedTokensAfter);
      // Defensive: `Number(undefined)` is `NaN`. Bail rather than subtract
      // garbage — the ledger is a derived view and silently clamping NaN
      // to 0 would mask a real SDK bug.
      if (!Number.isFinite(tokensBefore) || !Number.isFinite(estimatedTokensAfter)) return;
      const savings = tokensBefore - estimatedTokensAfter;
      if (savings <= 0) {
        // No-op compactions (or aborted ones that report zero savings) still
        // record 0 — keeps the in-memory token total consistent with the
        // branch so the next message_end reads the same baseline.
        ledger.recordCompaction(0, controller.signal);
        return;
      }
      ledger.recordCompaction(savings, controller.signal);
      return;
    }

    if (type === "agent_settled") {
      // §2.7 — Final snapshot. Always writes (no throttling on the
      // end-of-run path). The "checkpoint" marker distinguishes this from
      // operator/cooperative kinds; ledger.snapshot handles the
      // marker/kind projection itself.
      const stats = session.getSessionStats();
      ledger.snapshot(stats, policy, "checkpoint", controller.signal);
      return;
    }

    // Unknown event types: intentionally a no-op (the SDK may add new ones).
  });
}

/**
 * Re-export the SDK types we accept structurally so call sites that want a
 * strongly-typed AgentSession do not need a second import.
 */
export type { AgentSession };
