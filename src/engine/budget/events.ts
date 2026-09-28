/**
 * Wave 0 contract stubs — `installBudgetEventHooks` factory.
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md
 *   §2.6 Mid-run handler — subscribes to `AgentSession.subscribe(...)` and
 *          handles `message_end`, `compaction_end`, `agent_settled` events.
 *   §2.12 Every write threads `controller.signal` (or `ctx.signal`).
 *
 * Returns an unsubscribe function.
 *
 * Bodies throw — Wave 1 fills them in.
 */

import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { BudgetLedger } from "./ledger";
import type { WorkerBudgetPolicy } from "./types";

/**
 * Install all budget-related event hooks on the given AgentSession.
 *
 * Per §2.6, this subscribes once and dispatches on event.type:
 *   - `message_end`     → ledger.recordEvent + ledger.maybeSnapshot + warning/exhausted
 *   - `compaction_end`  → ledger.recordCompaction
 *   - `agent_settled`   → ledger.snapshot with marker "checkpoint"
 *
 * @param session          The AgentSession to observe.
 * @param ledger           The worker's restored BudgetLedger.
 * @param policy           The worker's resolved WorkerBudgetPolicy.
 * @param sessionManager   Read-only SessionManager (for `appendCustomMessageEntry`).
 * @param controller       AbortController whose signal is threaded into every write.
 * @returns                Unsubscribe function.
 */
export function installBudgetEventHooks(
  _session: AgentSession,
  _ledger: BudgetLedger,
  _policy: WorkerBudgetPolicy,
  _sessionManager: SessionManager,
  _controller: AbortController,
): () => void {
  throw new Error("not implemented");
}
