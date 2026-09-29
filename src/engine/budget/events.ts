/**
 * Wave 2+3A — F2 mid-run + F3 live tracking + F4 end-of-run event hooks.
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md
 *   §2.6 Mid-run handler — subscribes to `AgentSession.subscribe(...)` and
 *          handles `message_end`, `compaction_end`, `agent_settled`.
 *   §2.7 End-of-run on `agent_settled` (the canonical "Pi will not continue
 *          automatically" event).
 *   §2.12 Every write threads `controller.signal` (or `ctx.signal`).
 *   §3.3 F3 — warning at 20% remaining, exhaustion at 0%, tool_call block
 *              for bash/edit/write/read.
 *   §3.4 F4 — agent_settled is the sole finalization path (the legacy
 *              `agent_end` overwrite math from `src/engine/dispatch.ts` was
 *              deleted by Wave 3A — see WARNINGS_FOR_OTHER_AGENTS).
 *   §6.2 G-01 tool_call block via BudgetBlock discriminated union.
 *   §6.2 G-02 abort fires before agent_settled (pinned by the ordering test).
 *   §6.2 G-17 warning × `summarize_progress` ordering pinned.
 *
 * Returns an unsubscribe function from `session.subscribe(...)`.
 *
 * Event-handler contract (per plan §2.6, §3.3, §3.4):
 *
 *   - `message_end`     → `ledger.recordEvent("message_end", cumulative, signal)`
 *                         + `ledger.maybeSnapshot(cumulative, policy, signal)`
 *                         + WARNING (T3.2) + EXHAUSTION (T3.3) thresholds.
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
 *   - `tool_call`       → handled out-of-band by `createBudgetToolCallGuard`
 *     (the session's `subscribe(...)` does not see `tool_call` events;
 *     tool_call interception uses `agent.beforeToolCall` instead — see
 *     `createBudgetToolCallGuard` for the factory).
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
 *   - Warning dedup keyed by `${scope}:${resource}:${agent|team}` exactly
 *     (matches Wave 0's `WorkerBudgetPolicy` contract; T3.2 / plan §3.3).
 *   - Tool-call block via the `BudgetBlock` discriminated union serialized
 *     into `{ block: true, reason: <JSON.stringify(block)>, terminate: false }`
 *     (T3.4 / G-01). The SDK then turns this into a tool result with
 *     `isError: true` carrying the BudgetBlock JSON.
 */

import type { AgentSession, SessionManager, SessionStats } from "@earendil-works/pi-coding-agent";
import type { BudgetLedger } from "./ledger";
import { checkBudgetPolicy, crossedThreshold, ratioRemaining } from "./policy";
import type {
  BudgetBlock,
  BudgetResource,
  BudgetScope,
  WorkerBudgetPolicy,
} from "./types";

// ---------------------------------------------------------------------------
// Constants — wave 3A thresholds. Per plan §3.3 + §6.2 (G-01, G-02, G-17).
// Exported as named constants so tests can pin them.
// ---------------------------------------------------------------------------

/** T3.2 — warning fires at or below this remaining ratio. */
export const WARNING_REMAINING_RATIO = 0.20;

/** T3.3 — exhaustion fires at or below this remaining ratio. */
export const EXHAUSTED_REMAINING_RATIO = 0;

/**
 * Safely invoke `session.abort()` and ensure a rejected Promise cannot
 * become an unhandledRejection (which crashes the Node 26 process by
 * default). If abort is undefined or returns void, this is a no-op. If
 * abort throws synchronously, the throw is swallowed (the comment on
 * the call site explains why fakes do this).
 *
 * Per the audit (HTML §5 B2): the prior code used `void session.abort()`,
 * which discards the Promise. The SDK's `session.abort(): Promise<void>`
 * can reject asynchronously during teardown (e.g. an internal dispose
 * step fails) — a rejection on a `void`-discarded Promise becomes an
 * unhandledRejection. dispatch.ts:393 already uses the `?.catch(...)`
 * pattern; this helper centralizes it for events.ts:382.
 */
export function safelyAbortSession(session: { abort?: () => Promise<void> | void } | null | undefined): void {
  if (!session || typeof session.abort !== "function") return;
  try {
    const result = session.abort();
    if (result && typeof (result as { catch?: unknown }).catch === "function") {
      (result as Promise<void>).catch((): undefined => undefined);
    }
  } catch {
    // synchronous throw — best-effort cancel; controller signal carries the
    // cancel for real workers.
  }
}

/** T3.4 — tool names whose execution is blocked when the worker budget is exhausted. */
const TOOL_CALL_BLOCK_TOOLS: ReadonlySet<string> = new Set<string>([
  "bash",
  "edit",
  "write",
  "read",
]);

/** CustomMessageEntry customType used by the worker-visible warning emit (T3.2). */
export const BUDGET_WARNING_CUSTOM_TYPE = "budget_warning";

/** CustomMessageEntry customType used by the worker-visible exhaustion emit (T3.3). */
export const BUDGET_EXHAUSTED_CUSTOM_TYPE = "budget_exhausted";

// ---------------------------------------------------------------------------
// Event shape narrowing — kept narrow so unit tests can build events without
// standing up the entire SDK type tree.
// ---------------------------------------------------------------------------

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
  abort(): Promise<void> | void;
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
 * Aggregate the worker + team tokens/cost across the current branch so the
 * warning/exhaustion handlers can compute remaining ratios without reaching
 * back into `state.runtimes` (Hard constraint: single source of truth).
 *
 * Worker tokens/cost come from `ledger.cumulative` (which mirrors
 * `getSessionStats()`). Team totals are the sum of the LATEST cumulative
 * per `agentSlug` across the branch — same logic as `teamUsage()` in
 * `policy.ts`, inlined here to keep the factory's dependencies minimal.
 */
function computeWorkerAndTeamUsage(
  ledger: BudgetLedger,
  sessionManager: SessionManager,
): {
  worker: { tokens: number; costUsd: number };
  team: { tokens: number; costUsd: number };
} {
  const worker = { tokens: ledger.cumulative.tokens, costUsd: ledger.cumulative.costUsd };
  // Team aggregate: walk the branch and sum the LATEST ledger entry per agentSlug.
  const byAgent = new Map<string, { tokens: number; costUsd: number }>();
  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== "custom") continue;
    const custom = entry as { customType?: unknown; data?: { agentSlug?: unknown; cumulative?: { tokens?: unknown; costUsd?: unknown } } };
    if (custom.customType !== "pi-hive-budget-ledger") continue;
    const slug = custom.data?.agentSlug;
    if (typeof slug !== "string") continue;
    const tokens = Number(custom.data?.cumulative?.tokens);
    const costUsd = Number(custom.data?.cumulative?.costUsd);
    if (!Number.isFinite(tokens) || !Number.isFinite(costUsd)) continue;
    byAgent.set(slug, { tokens, costUsd });
  }
  let teamTokens = 0;
  let teamCostUsd = 0;
  for (const v of byAgent.values()) {
    teamTokens += v.tokens;
    teamCostUsd += v.costUsd;
  }
  return { worker, team: { tokens: teamTokens, costUsd: teamCostUsd } };
}

/**
 * Worker agent slug for the dedup key. The worker key MUST be the literal
 * `agentSlug` of the running worker; the team-wide key is the literal
 * `"team"` (matches Wave 0's `WorkerBudgetPolicy` contract — T3.2 / plan §3.3).
 */
function warningDedupKey(scope: BudgetScope, resource: BudgetResource, agentSlug: string): string {
  const agentOrTeam = scope === "worker" ? agentSlug : "team";
  return `${scope}:${resource}:${agentOrTeam}`;
}

/**
 * Build the human-readable warning message (T3.2). The `interventionAvailable`
 * flag is true for the default strategy and stays true until structured
 * strategies (C5) land — kept as a `details` field so dashboards and tests can
 * distinguish "wrap-up hint available" from "no intervention".
 */
function buildWarningMessage(scope: BudgetScope, resource: BudgetResource, percentUsed: number): string {
  const scopeLabel = scope === "worker" ? "Worker" : "Team";
  const resourceLabel = resource === "tokens" ? "tokens" : "cost";
  return `${scopeLabel} ${resourceLabel} at ${percentUsed.toFixed(0)}% of cap. Wrap up your work; call summarize_progress({ notes: "..." }) to record completion intent.`;
}

/**
 * Install all budget-related event hooks on the given `AgentSession`.
 *
 * Subscribes once and dispatches on `event.type`. Returns the unsubscribe
 * handle. The caller owns the `AbortController` and is responsible for
 * invoking the unsubscribe (or letting the session dispose tear it down).
 *
 * The worker's `agentSlug` is read from `ledger.agentSlug` (set at restore
 * time) — keeps the factory's signature stable across waves and avoids
 * requiring callers to thread the slug twice.
 *
 * @param session          The session to observe (typed structurally for testability).
 * @param ledger           The worker's restored `BudgetLedger`.
 * @param policy           The worker's resolved `WorkerBudgetPolicy`.
 * @param sessionManager   The worker's `SessionManager` — used to:
 *                         - read the branch for team aggregate (warning/exhaustion)
 *                         - append `budget_warning` / `budget_exhausted` CustomMessageEntries
 * @param controller       AbortController whose signal is threaded into every write.
 * @returns                Unsubscribe function.
 */
export function installBudgetEventHooks(
  session: SubscribableSession,
  ledger: BudgetLedger,
  policy: WorkerBudgetPolicy,
  sessionManager: SessionManager,
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

      // ── T3.2 / T3.3 — Warning + Exhaustion threshold crossings ────────
      // Checked AFTER recordEvent + maybeSnapshot so the ledger is up to date
      // and any throttled snapshot fires before the warning/exhaustion emit
      // (so the warning/exhaustion entries appear AFTER throttled snapshots
      // for the same message_end, but BEFORE the next message's snapshot —
      // a clean monotonic branch).
      //
      // Default-strategy only: emit only when no structured override is set.
      // `WorkerBudgetStrategy` is currently a placeholder per C5 (see
      // `strategy.ts`), so `policy.strategy === undefined` is the
      // "default" case today and the gate is effectively a no-op until
      // structured strategies land. Kept as an explicit branch so the
      // structured-strategy path has a place to diverge.
      if (policy.strategy === undefined) {
        evaluateThresholds(session, ledger, policy, sessionManager, controller, cumulative, ledger.agentSlug);
      }

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
      // §3.4 — F4 / T4.1. The canonical end-of-run entry. Always writes
      // (no throttling on the end-of-run path). The "checkpoint" marker
      // distinguishes this from operator/cooperative kinds; ledger.snapshot
      // handles the marker/kind projection itself.
      const stats = session.getSessionStats();
      ledger.snapshot(stats, policy, "checkpoint", controller.signal);
      return;
    }

    // Unknown event types: intentionally a no-op (the SDK may add new ones).
  });
}

/**
 * Evaluate the warning + exhaustion thresholds for the worker's just-recorded
 * `message_end`. Pure-ish: mutates `ledger.warnedKeys` (idempotent guard) and
 * may call `sessionManager.appendCustomMessageEntry` + `session.abort()` +
 * `ledger.markWarning` / `ledger.markExhaustion`.
 *
 * Extracted from `installBudgetEventHooks` so the test file can drive it
 * directly without standing up the subscribe wrapper.
 */
export function evaluateThresholds(
  session: SubscribableSession,
  ledger: BudgetLedger,
  policy: WorkerBudgetPolicy,
  sessionManager: SessionManager,
  controller: AbortController,
  cumulative: { tokens: number; costUsd: number; runs: number },
  workerSlug: string,
): void {
  const usage = computeWorkerAndTeamUsage(ledger, sessionManager);

  // Each (scope, resource) pair has its own dedup key + threshold. The
  // worker scope keys by `workerSlug`; the team scope keys by the literal
  // "team" (per Wave 0's `WorkerBudgetPolicy` contract — T3.2).
  const pairs: ReadonlyArray<{
    scope: BudgetScope;
    resource: BudgetResource;
    used: number;
    cap: number | undefined;
  }> = [
    { scope: "worker", resource: "tokens", used: usage.worker.tokens, cap: policy.worker.tokens?.cap },
    { scope: "worker", resource: "costUsd", used: usage.worker.costUsd, cap: policy.worker.costUsd?.cap },
    { scope: "team", resource: "tokens", used: usage.team.tokens, cap: policy.team.tokens?.cap },
    { scope: "team", resource: "costUsd", used: usage.team.costUsd, cap: policy.team.costUsd?.cap },
  ];

  for (const pair of pairs) {
    if (pair.cap === undefined || pair.cap <= 0) continue;
    const ratio = ratioRemaining(pair.used, pair.cap);
    const key = warningDedupKey(pair.scope, pair.resource, workerSlug);

    // T3.3 — Exhaustion at 0%. Fires BEFORE agent_settled (G-02 — pinned
    // by the ordering test). markExhaustion writes synchronously to the
    // branch so the entry is durable BEFORE session.abort() resolves and
    // agent_settled fires.
    //
    // Dedup: the same `warnedKeys` Set guards exhaustion too. We add the key
    // before session.abort() so even if the SDK's session.abort() does NOT
    // synchronously abort the controller (a known SDK quirk in some modes),
    // the next message_end still sees the dedup key and skips. Tests rely
    // on this for the "second message_end at the cap does NOT re-emit"
    // assertion (case 16 in `budget-events.test.ts`).
    if (
      crossedThreshold(ratio, EXHAUSTED_REMAINING_RATIO) &&
      !controller.signal.aborted &&
      !ledger.warnedKeys.has(key)
    ) {
      ledger.warnedKeys.add(key);
      ledger.markExhaustion(cumulative, controller.signal);
      // Worker-visible hint (best-effort; abort is the load-bearing step).
      try {
        sessionManager.appendCustomMessageEntry(
          BUDGET_EXHAUSTED_CUSTOM_TYPE,
          `${pair.scope === "worker" ? "Worker" : "Team"} ${pair.resource === "tokens" ? "tokens" : "cost"} budget exhausted (${pair.used}/${pair.cap}).`,
          true,
          {
            scope: pair.scope,
            resource: pair.resource,
            remaining: 0,
            cap: pair.cap,
            interventionAvailable: false,
          },
        );
      } catch {
        // best-effort — the abort and ledger write are the load-bearing
        // side effects; the message entry is the worker-visible hint.
      }
      // Abort fires synchronously here. `session.abort()` resolves to a
      // Promise; we don't await — the canonical "Pi will not continue
      // automatically" event (`agent_settled`) is what fires after, and
      // the T3.6 ordering test pins that ordering by emitting both
      // events through a deterministic fake. The Promise's rejection (if
      // any) must be handled inline — `void session.abort()` would let it
      // become an unhandledRejection. `safelyAbortSession` centralizes the
      // try/catch + .catch pattern.
      safelyAbortSession(session);
      continue;
    }

    // T3.2 — Warning at ≤20% remaining. Dedup by `key` so each
    // (scope, resource, agent|team) warning fires exactly once per
    // session (the dedup set is in-memory only — a session respawn
    // starts fresh).
    if (
      crossedThreshold(ratio, WARNING_REMAINING_RATIO) &&
      ratio > EXHAUSTED_REMAINING_RATIO &&
      !ledger.warnedKeys.has(key)
    ) {
      ledger.warnedKeys.add(key);
      ledger.markWarning(cumulative, controller.signal);
      const percentUsed = Math.max(0, Math.min(100, (1 - ratio) * 100));
      try {
        sessionManager.appendCustomMessageEntry(
          BUDGET_WARNING_CUSTOM_TYPE,
          buildWarningMessage(pair.scope, pair.resource, percentUsed),
          true,
          {
            scope: pair.scope,
            resource: pair.resource,
            remaining: Math.max(0, pair.cap - pair.used),
            cap: pair.cap,
            interventionAvailable: true,
          },
        );
      } catch {
        // best-effort — the ledger write is the durable record; the
        // message entry is the worker-visible hint.
      }
    }
  }
}

/**
 * Wave 3A / F3 — T3.4 tool_call blocker (G-01).
 *
 * `session.subscribe(...)` does not surface `tool_call` events — the SDK
 * routes tool interception through `agent.beforeToolCall` (see
 * `agent-loop.js` and `agent-session.js` in the pi-coding-agent dist).
 *
 * This factory returns a `beforeToolCall` handler that:
 *
 *   1. Filters to the four blocking targets: `bash`, `edit`, `write`, `read`
 *      (T3.4 / G-01). Other tool types (`grep`, `ls`, custom tools) pass
 *      through untouched.
 *   2. Runs `checkBudgetPolicy(ledger, policy, branch, depth)` against the
 *      live branch.
 *   3. If the policy returns a `BudgetBlock`, returns
 *      `{ block: true, reason: <JSON.stringify(BudgetBlock)>, terminate: false }`
 *      so the SDK marks the tool result with `isError: true` carrying the
 *      `BudgetBlock` payload (the discriminated-union serialization the
 *      task description requires).
 *   4. Otherwise returns `undefined` (the tool runs normally).
 *
 * The `currentDelegationDepth` callback is the dispatch.ts
 * `currentDelegationDepth() + 1` expression — a pure getter so this
 * function stays free of module-level reads (G-29 / plan §2.5).
 *
 * Production wiring: `dispatch.ts` (or a future extension factory) calls
 * `session.agent.beforeToolCall = createBudgetToolCallGuard(...)`. The
 * factory's return value is the exact handler the SDK invokes.
 *
 * Test wiring: invoke the returned function directly with a fake event
 * shape that mimics `agent-loop`'s `BeforeToolCallContext` (the handler
 * reads `event.toolName` / `event.args` only).
 */
export function createBudgetToolCallGuard(
  ledger: BudgetLedger,
  policy: WorkerBudgetPolicy,
  sessionManager: SessionManager,
  controller: AbortController,
  currentDelegationDepth: () => number,
): (event: { toolName?: unknown; input?: unknown }) => Promise<{ block: true; reason: string; terminate: false } | undefined> {
  return async (event) => {
    const toolName = typeof event?.toolName === "string" ? event.toolName : undefined;
    // T3.4 — only the four blocking targets pass through the gate. Other
    // tool types (`grep`, `ls`, custom tools) are always allowed.
    if (!toolName || !TOOL_CALL_BLOCK_TOOLS.has(toolName)) return undefined;
    // Controller already aborted: the session is winding down. Don't
    // double-block; let the SDK process the in-flight call.
    if (controller.signal.aborted) return undefined;

    const branch = sessionManager.getBranch();
    const block = checkBudgetPolicy(ledger, policy, branch, currentDelegationDepth());
    if (!block) return undefined;

    // Serialize the BudgetBlock discriminated union as the tool-result
    // error reason. The SDK will produce a tool result with `isError: true`
    // and `content: [{ type: "text", text: <reason> }]`.
    return { block: true, reason: JSON.stringify(block satisfies BudgetBlock), terminate: false };
  };
}

/**
 * Re-export the SDK type we accept structurally so call sites that want a
 * strongly-typed AgentSession do not need a second import.
 *
 * Note — `THROTTLE_MESSAGE_INTERVAL` / `THROTTLE_SPEND_RATIO` are exported
 * from `./ledger.ts` (and re-exported through the barrel `./index.ts`).
 * They were previously re-exported from here too, but the re-export was
 * dead — `events.ts` does not consult the throttle constants; it only
 * reads/writes the ledger and the session.
 */
export type { AgentSession };
