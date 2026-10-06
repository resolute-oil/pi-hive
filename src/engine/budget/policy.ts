// Wave 1 F1 T1.3 — BudgetPolicy pure functions
//
// Pure (no I/O of their own, no SDK side effects) decision helpers consumed
// by BudgetLedger and the dispatcher. Per the refactor plan §2.5, these
// functions take the live session + ledger + branch as arguments and return
// a BudgetBlock or a numeric metric. They are the easiest to unit-test and
// the foundation for the rest of the budget module.
//
// The G-29 type-mismatch check raises TypeError at the typebox boundary so a
// downstream dispatcher can refuse with a structured error rather than
// silently misclassifying scope.

import type { AgentSession, SessionEntry, SessionStats } from "@earendil-works/pi-coding-agent";
import type { BudgetLedger } from "./ledger";
import { isLedgerEntry } from "./ledger";
import type { AgentRuntime, BudgetBlock, ContextConstraint, HiveState, IncludeKeys, WorkerBudgetPolicy, WorkerGovernance } from "../../core/types";

// Sum the token dimensions named in `include` from a SessionStats snapshot.
// Pure — no I/O, no SDK. Used by checkBudgetPolicy and buildBudgetToolCallHandler
// so the pre-flight gate and the mid-run tool-call gate both honor the
// resolved policy's `include` list (default: ["input", "output"]) instead of
// comparing the cumulative `tokens.total` (which folds cacheRead / cacheWrite
// in per the SDK contract).
//
// Limitation: `reasoning` lives on the runtime (`runtime.reasoningTokens`),
// not on `SessionStats.tokens`, so this helper cannot sum reasoning from
// SessionStats alone. The caller is expected to have access to reasoning via
// the runtime when reasoning is part of the include list — until that seam
// is wired, `reasoning` contributes 0 from this seam. The helper accepts the
// dimension in its signature so future code can plumb a reasoning source
// without changing call sites.
export function tokensForInclude(stats: SessionStats, include: IncludeKeys): number {
  // Defensive: if `include` is undefined or empty, default to input + output
  // (matches the policy.ts §2.13/C2 documented behavior — the F13 dashboard's
  // `tokenBudgetScope: "input_output"` default). The check is up front so a
  // caller that passes an empty list never gets back a stale accumulator
  // value from a prior default run.
  const list = include ?? [];
  if (list.length === 0) {
    return (Number(stats.tokens.input) || 0) + (Number(stats.tokens.output) || 0);
  }
  let sum = 0;
  if (list.includes("input")) sum += Number(stats.tokens.input) || 0;
  if (list.includes("output")) sum += Number(stats.tokens.output) || 0;
  if (list.includes("cacheRead")) sum += Number(stats.tokens.cacheRead) || 0;
  if (list.includes("cacheWrite")) sum += Number(stats.tokens.cacheWrite) || 0;
  // reasoning is NOT in SessionStats.tokens (per dispatch-lifecycle.ts).
  // The helper accepts it in the include list for future-proofing, but it
  // cannot be summed from stats alone — see the limitation note above.
  // (Explicit comment instead of silent no-op so a future reader sees why
  // reasoning is treated as 0 here.)
  if (list.includes("reasoning")) {
    // Intentionally no-op: reasoning tokens are not on SessionStats. The
    // runtime's reasoningTokens field is the source of truth (see
    // dispatch-lifecycle.ts:148-167) but is not plumbed into this helper.
    // When the gate fires on the `reasoning` dimension, the helper returns
    // the sum of the other four — which may underreport. Pin this in the
    // gap report and fix in a follow-up that threads runtime through.
    void stats;
  }
  return sum;
}

// SDK contract for the `getContextUsage()` return value (re-declared here
// so the policy module does not pull a heavy import from the SDK and the
// test seam can pass a plain object). The SDK pins `tokens: number | null`
// (null right after compaction, before next LLM response) and `percent:
// number | null` (null when tokens is null). `contextWindow` is always
// present once the model is resolved. Per the brief T4 / T5 graceful-handling
// note: when tokens is null, the gate MUST skip the check (no block).
export interface ContextUsageLike {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

// Per-worker context-window-fill gate (wave context-constraint T4). Pure —
// no I/O, no SDK. Compares the SDK's live `getContextUsage()` payload
// against a `ContextConstraint` (nominal tokens or percentage of the
// context window on the 0–100 scale). Returns a BudgetBlock describing the
// violation, or undefined when the worker is under the cap (or when the
// SDK has no usable value yet — tokens null / contextWindow 0).
//
// The 0–100 percent scale is what users write in the config: `{ percent:
// 80 }` means "80% full," NOT 0.80. Internally we compare against
// `(ctx.tokens / ctx.contextWindow) * 100` (which gives the same
// percentage on the same scale). The SDK's `ctx.percent` is on the 0–1
// scale — we do NOT use it directly here; the tokens / contextWindow
// ratio is the source of truth.
export function checkContextConstraint(
  ctx: ContextUsageLike,
  constraint: ContextConstraint,
): BudgetBlock | undefined {
  // Graceful handling: tokens=null means "right after compaction, before
  // next LLM response." The gate must not false-fire. Same when the SDK
  // has not yet resolved a context window (contextWindow=0). Both cases
  // are the documented "skip" — the runtime keeps its last-known fill.
  if (ctx.tokens == null || ctx.contextWindow <= 0) return undefined;

  if ("tokens" in constraint && constraint.tokens !== undefined) {
    // Nominal cap: stop when the LLM's current context equals or exceeds
    // the configured absolute token count.
    if (ctx.tokens >= constraint.tokens) {
      return {
        reason: `Worker context budget exhausted: ${ctx.tokens}/${constraint.tokens} tokens of context`,
        scope: "worker",
        resource: "context",
        remaining: { context: { tokens: 0, percent: 100 } },
        limit: { context: { tokens: constraint.tokens } },
      };
    }
    return undefined;
  }

  if ("percent" in constraint && constraint.percent !== undefined) {
    // Percentage cap (0–100 scale). Compute the current fill on the same
    // scale and compare. The condition is `currentFill >= cap`; the
    // warning path uses the same ratio with the warningThreshold.
    const currentPct = (ctx.tokens / ctx.contextWindow) * 100;
    if (currentPct >= constraint.percent) {
      return {
        reason: `Worker context budget exhausted: ${currentPct.toFixed(1)}% of context window (cap ${constraint.percent}%)`,
        scope: "worker",
        resource: "context",
        remaining: { context: { tokens: 0, percent: constraint.percent } },
        limit: { context: { percent: constraint.percent } },
      };
    }
    return undefined;
  }

  // Schema enforces "exactly one of tokens/percent is set" — reaching
  // here is a programming error (the constraint object is empty or both
  // fields were set). Returning undefined matches the gate's "no cap
  // configured → no block" outcome so a misconfigured constraint does
  // NOT block the worker.
  return undefined;
}

// Wave context-constraint (continuation) — team-tier context aggregate.
// `TeamContextUsageLike` is the per-team live aggregate consumed by
// `checkTeamContextConstraint`. The caller computes it by walking
// `state.runtimes` (typically via `aggregateTeamContext` below) so this
// gate stays pure and decoupled from the HiveState shape. Mirrors the
// per-worker `ContextUsageLike` shape but adds a `membersCount` field so
// the gate can distinguish "no team at all" (skip) from "team with all
// members at zero tokens" (compare against the cap and let the cap
// decide).
export interface TeamContextUsageLike {
  // Sum of `runtime.contextTokens` across all non-orchestrator team
  // members that have a resolved context window. The numerator for
  // both the nominal and the percentage comparison.
  totalTokens: number;
  // The smallest `runtime.contextWindow` across all team members. Used
  // as the percentage denominator — the most conservative interpretation
  // (if one worker has a 32K window and another has 200K, the team is
  // constrained by the 32K worker's window). 0 when no member has a
  // resolved window yet (graceful skip).
  smallestWindow: number;
  // Number of team members that contributed to `totalTokens` and
  // `smallestWindow`. 0 when no member has a resolved context yet —
  // the gate uses this to skip the check.
  membersCount: number;
}

// Pure walk: sum the live context values across all team members in the
// runtimes map. Returns the aggregate; when no runtimes are present (or
// all are orchestrators, or no runtime has a resolved context window),
// `membersCount=0` and the team-context check is skipped. Mirrors the
// `teamUsage(branch)` walk on the branch (which is ledger-based for
// tokens/cost/runs) but is runtime-based for context — `getContextUsage()`
// is volatile and lives on the runtime, not on the ledger CustomEntry.
export function aggregateTeamContext(
  runtimes: Iterable<AgentRuntime>,
): TeamContextUsageLike {
  let totalTokens = 0;
  let smallestWindow = Number.POSITIVE_INFINITY;
  let membersCount = 0;
  for (const runtime of runtimes) {
    // Skip orchestrators — the team budget applies to worker members.
    // The legacy `teamTotals` walk in `budgetRemaining` uses the same
    // filter; match it so the two views are consistent.
    if (runtime.config?.role === "orchestrator") continue;
    const window = Number(runtime.contextWindow) || 0;
    if (window <= 0) continue; // skip workers without a resolved context window
    const tokens = Number(runtime.contextTokens) || 0;
    totalTokens += tokens;
    if (window < smallestWindow) smallestWindow = window;
    membersCount += 1;
  }
  return {
    totalTokens,
    smallestWindow: membersCount === 0 ? 0 : smallestWindow,
    membersCount,
  };
}

// Team-tier context-window-fill gate. Mirrors `checkContextConstraint`
// but compares the team aggregate against the constraint. Returns a
// BudgetBlock describing the violation, or undefined when the team is
// under the cap (or when the team has no live values yet — membersCount
// 0, totalTokens 0, or smallestWindow 0). Pure — no I/O, no SDK. The
// caller decides the per-dimension exhaustion action via
// `resolveExhaustionAction(policy, "context")` (abort / compact / none).
//
// Design choices:
//   - Nominal cap: `totalTokens >= cap` (e.g., 100K tokens across the
//     team).
//   - Percentage cap: `totalTokens / smallestWindow * 100 >= cap` on
//     the 0–100 scale (e.g., 80% of the smallest worker's context
//     window). The smallest window is the conservative denominator —
//     the team is "full" when the sum of all workers' contexts
//     exceeds the cap of the most-constrained worker.
//   - The `include` list does NOT apply (per the brief design decision
//     4 — `getContextUsage().tokens` is a single coherent number from
//     the SDK).
export function checkTeamContextConstraint(
  teamCtx: TeamContextUsageLike,
  constraint: ContextConstraint,
): BudgetBlock | undefined {
  // Graceful: no team members with resolved context, or no live values
  // yet. Same skip pattern as the per-worker `checkContextConstraint`.
  if (teamCtx.membersCount === 0) return undefined;
  if (teamCtx.smallestWindow <= 0) return undefined;
  if (teamCtx.totalTokens <= 0) return undefined;

  if ("tokens" in constraint && constraint.tokens !== undefined) {
    if (teamCtx.totalTokens >= constraint.tokens) {
      return {
        reason: `Team context budget exhausted: ${teamCtx.totalTokens}/${constraint.tokens} tokens of context across ${teamCtx.membersCount} worker(s)`,
        scope: "team",
        resource: "context",
        remaining: { context: { tokens: 0, percent: 100 } },
        limit: { context: { tokens: constraint.tokens } },
      };
    }
    return undefined;
  }

  if ("percent" in constraint && constraint.percent !== undefined) {
    // Percentage cap (0–100 scale). The denominator is the SMALLEST
    // context window in the team — conservative; the team is "full"
    // when the sum crosses the most-constrained worker's cap.
    const currentPct = (teamCtx.totalTokens / teamCtx.smallestWindow) * 100;
    if (currentPct >= constraint.percent) {
      return {
        reason: `Team context budget exhausted: ${currentPct.toFixed(1)}% of smallest context window (cap ${constraint.percent}%, ${teamCtx.totalTokens} tokens across ${teamCtx.membersCount} worker(s))`,
        scope: "team",
        resource: "context",
        remaining: { context: { tokens: 0, percent: constraint.percent } },
        limit: { context: { percent: constraint.percent } },
      };
    }
    return undefined;
  }

  // Schema enforces "exactly one of tokens/percent is set" — reaching
  // here is a programming error (the constraint object is empty or both
  // fields were set). Match the per-worker helper: return undefined so
  // a misconfigured constraint does NOT block the team.
  return undefined;
}

// Pre-flight gate: returns a BudgetBlock describing the first violated cap
// (worker or team scope; tokens/costUsd/runs/depth), or undefined when the
// ledger + branch are under every configured cap. Pure — no I/O, no SDK.
//
// `stats` is optional — when supplied, the worker-tokens comparison uses
// `tokensForInclude(stats, include)` so the gate honors the policy's
// `include` list (the wave-budget-include-filter fix). When absent, the gate
// falls back to `ledger.cumulative.tokens` (the legacy behavior, which
// folds cacheRead / cacheWrite in). The fallback is used at delegation-time
// pre-flight in worker-tools.ts:278 because no AgentSession is open yet at
// that point — the mid-run gate (events.ts buildBudgetToolCallHandler) is
// where the include-aware comparison fires during the run.
//
// `contextUsage` is optional — when supplied, the per-worker context check
// (T4 from the prior wave) compares against the live SDK payload. When
// absent, the per-worker context check is skipped (graceful — used at
// pre-flight where no AgentSession is open yet).
//
// `teamContext` is optional — when supplied, the team-tier context
// aggregate (sum across all team members, smallest context window as the
// percentage denominator) is compared against `policy.team.context`.
// When absent, the team-context check is skipped (graceful — used at
// pre-flight where no runtimes are live yet). The team aggregate is
// caller-computed (typically by `aggregateTeamContext(state.runtimes)`)
// so this function stays pure and decoupled from the HiveState shape.
export function checkBudgetPolicy(
  ledger: BudgetLedger,
  policy: WorkerBudgetPolicy,
  branch: SessionEntry[],
  stats?: SessionStats,
  contextUsage?: ContextUsageLike,
  teamContext?: TeamContextUsageLike,
): BudgetBlock | undefined {
  // G-29 boundary check: a structurally-malformed policy (missing the
  // required `worker` field) raises TypeError so the dispatcher refuses with
  // a structured error rather than silently misclassifying scope. A policy
  // with `worker: {}` (present but empty) means "no caps configured" /
  // "unlimited" and is valid.
  if (policy === null || typeof policy !== "object" || policy.worker === undefined || policy.worker === null) {
    throw new TypeError(
      "BudgetPolicy scope mismatch: WorkerBudgetPolicy.worker is required (got undefined / non-object / null)",
    );
  }

  const workerCaps = policy.worker;
  // `team` is required by the WorkerBudgetPolicy type contract; if a
  // structurally-malformed caller passes team as undefined, the
  // team-tier checks below just skip (no caps to evaluate) and the
  // documented "no caps configured → no block" outcome holds.
  const teamCaps = policy.team;

  // Worker scope (in documented evaluation order: tokens → costUsd → runs).
  // Wave-budget-include-filter: when `stats` is supplied, the comparison
  // uses tokensForInclude(stats, include) so cacheRead / cacheWrite are
  // excluded from the comparison when the policy's include list says so.
  // Without stats, the legacy ledger.cumulative.tokens fallback is used.
  const workerTokensInclude: IncludeKeys = workerCaps.tokens?.include ?? ["input", "output"];
  const workerTokensUsed = stats
    ? tokensForInclude(stats, workerTokensInclude)
    : ledger.cumulative.tokens;
  if (
    workerCaps.tokens?.cap !== undefined &&
    workerTokensUsed >= workerCaps.tokens.cap
  ) {
    return {
      reason: `Worker token budget exhausted: ${workerTokensUsed}/${workerCaps.tokens.cap}`,
      scope: "worker",
      resource: "tokens",
      remaining: { tokens: 0 },
      limit: { tokens: workerCaps.tokens.cap },
    };
  }
  if (
    workerCaps.costUsd?.cap !== undefined &&
    ledger.cumulative.costUsd >= workerCaps.costUsd.cap
  ) {
    return {
      reason: `Worker cost budget exhausted: $${ledger.cumulative.costUsd.toFixed(2)}/$${workerCaps.costUsd.cap}`,
      scope: "worker",
      resource: "costUsd",
      remaining: { costUsd: 0 },
      limit: { costUsd: workerCaps.costUsd.cap },
    };
  }
  if (
    workerCaps.runs?.cap !== undefined &&
    ledger.cumulative.runs >= workerCaps.runs.cap
  ) {
    return {
      reason: `Worker run budget exhausted: ${ledger.cumulative.runs}/${workerCaps.runs.cap}`,
      scope: "worker",
      resource: "runs",
      remaining: { runs: 0 },
      limit: { runs: workerCaps.runs.cap },
    };
  }

  // Worker.context (wave context-constraint T4). The pre-flight gate at
  // delegation start has no AgentSession open, so the legacy worker-tools
  // pre-flight (worker-tools.ts:278) calls checkBudgetPolicy without
  // `contextUsage` — the context check is skipped in that path. The mid-
  // run callers (events.ts message_end + buildBudgetToolCallHandler) DO
  // pass a contextUsage, so the cap is enforced during the run. The check
  // is graceful: when tokens is null (right after compaction, before next
  // LLM response) or the contextWindow is 0, the gate returns undefined
  // instead of false-firing. The `include` list does NOT apply to context
  // (getContextUsage().tokens is a single coherent number from the SDK;
  // including the include list would be double-counting — per the brief
  // design decision 4).
  if (contextUsage !== undefined && workerCaps.context !== undefined) {
    const ctxBlock = checkContextConstraint(contextUsage, workerCaps.context);
    if (ctxBlock !== undefined) return ctxBlock;
  }

  // Team scope — sum the latest CustomEntry per agentSlug from the active branch.
  {
    const team = teamUsage(branch);
    if (teamCaps.tokens?.cap !== undefined && team.tokens >= teamCaps.tokens.cap) {
      return {
        reason: `Team token budget exhausted: ${team.tokens}/${teamCaps.tokens.cap}`,
        scope: "team",
        resource: "tokens",
        remaining: { tokens: 0 },
        limit: { tokens: teamCaps.tokens.cap },
      };
    }
    if (teamCaps.costUsd?.cap !== undefined && team.costUsd >= teamCaps.costUsd.cap) {
      return {
        reason: `Team cost budget exhausted: $${team.costUsd.toFixed(2)}/$${teamCaps.costUsd.cap}`,
        scope: "team",
        resource: "costUsd",
        remaining: { costUsd: 0 },
        limit: { costUsd: teamCaps.costUsd.cap },
      };
    }
    if (teamCaps.runs?.cap !== undefined && team.runs >= teamCaps.runs.cap) {
      return {
        reason: `Team run budget exhausted: ${team.runs}/${teamCaps.runs.cap}`,
        scope: "team",
        resource: "runs",
        remaining: { runs: 0 },
        limit: { runs: teamCaps.runs.cap },
      };
    }
  }

  // Team.context (continuation of wave context-constraint). The pre-flight
  // gate at delegation start has no live runtimes, so the caller passes
  // `teamContext=undefined` and this check is skipped — same graceful
  // pattern as the per-worker `contextUsage=undefined` skip above. The
  // mid-run caller (events.ts) calls `aggregateTeamContext(state.runtimes)`
  // to compute the aggregate before invoking this gate. The `include`
  // list does NOT apply to context (per the brief design decision 4).
  // Per-dimension exhaustion (`resolveExhaustionAction(policy, "context")`)
  // is the caller's responsibility — the gate only signals that the
  // cap was hit; the caller decides abort vs compact vs none. This
  // mirrors the per-worker `checkContextConstraint` helper above.
  if (teamContext !== undefined && teamCaps.context !== undefined) {
    const teamCtxBlock = checkTeamContextConstraint(teamContext, teamCaps.context);
    if (teamCtxBlock !== undefined) return teamCtxBlock;
  }

  return undefined;
}

// Sum a worker's consumed tokens, scoped by the include-list. The refactor
// plan §1.3 specifies a single call to session.getSessionStats().tokens.total
// (the session-lifetime count); the include scope is captured upstream by the
// resolver so this pure function reads total regardless of the passed scope.
export function workerConsumedTokens(_session: AgentSession, _scope: IncludeKeys): number {
  // The session argument is captured for the documented seam — Wave 3 wires
  // this to a real session; Wave 1's test seam passes a fake with the
  // expected shape. The function reads .getSessionStats().tokens.total.
  const session = _session;
  return session.getSessionStats().tokens.total;
}

// A worker's consumed cost (USD). Reads session.getSessionStats().cost.
export function workerConsumedCost(_session: AgentSession): number {
  return _session.getSessionStats().cost;
}

// Walk the active branch's pi-hive-budget-ledger CustomEntry records and
// return the team's aggregate spend (sum of the latest snapshot per worker).
export function teamUsage(branch: SessionEntry[]): { tokens: number; costUsd: number; runs: number } {
  // The branch is ordered root-to-leaf. For each agentSlug we keep the LATEST
  // cumulative (the most recent write wins). After the walk we sum across all
  // distinct slugs.
  const latestBySlug = new Map<string, { tokens: number; costUsd: number; runs: number }>();
  for (const entry of branch) {
    if (!isLedgerEntry(entry)) continue;
    const data = entry.data;
    if (!data.agentSlug || !data.cumulative) continue;
    latestBySlug.set(data.agentSlug, { ...data.cumulative });
  }
  let tokens = 0;
  let costUsd = 0;
  let runs = 0;
  for (const cumulative of latestBySlug.values()) {
    tokens += cumulative.tokens;
    costUsd += cumulative.costUsd;
    runs += cumulative.runs;
  }
  return { tokens, costUsd, runs };
}

// Pure ratio: how much of a cap remains. Used for the warning/exhausted
// threshold checks. Returns 0 when the cap is 0 (avoid divide-by-zero at
// configuration time).
export function ratioRemaining(used: number, cap: number): number {
  if (cap === 0) return 0;
  return used / cap;
}

// Pure threshold check: did the remaining ratio cross below the threshold?
// Used to dedup the warning emit per (scope, resource, agent) pair.
//
// Both arguments are interpreted as ratios in the [0, 1] range — NOT a
// (used, cap) pair as the plan prose (§2.5) originally suggested. The
// caller pre-computes the remaining ratio via `ratioRemaining(used, cap)`
// (or `1 - ratioRemaining(used, cap)` for the "remaining ratio") before
// passing it in. This two-arg signature was chosen over a three-arg
// `(used, cap, threshold)` form to keep the pure function decoupled from
// the cap arithmetic; the test at budget-policy.test.ts pins the
// ratio-vs-ratio interpretation (`crossedThreshold(0.10, 0.20)` = true).
export function crossedThreshold(remaining: number, threshold: number): boolean {
  return remaining <= threshold;
}

// Wave context-constraint (T7) — per-dimension exhaustion action
// resolution. The user requested independent exhaustion strategies for
// tokens and context because the two measure different resources
// (cumulative cost vs LLM current view). A user may want
// `tokens: abort` (immediate) but `context: compact` (auto-compact when
// the LLM's view fills up). Returns the dimension-specific action, or
// the global `onExhaustion.action` as a fallback, or `"abort"` when
// strategies are absent. Pure — no I/O, no SDK.
export type ExhaustionDimension = "tokens" | "context";

export function resolveExhaustionAction(
  policy: WorkerBudgetPolicy,
  dimension: ExhaustionDimension,
): "compact" | "abort" | "none" {
  const global = policy.strategies?.onExhaustion?.action;
  if (dimension === "tokens") {
    return policy.strategies?.onTokenExhaustion?.action ?? global ?? "abort";
  }
  return policy.strategies?.onContextExhaustion?.action ?? global ?? "abort";
}

// Per-dimension interventionAvailable flag. With per-dimension strategies,
// the operator-facing flag must be computed per-dimension too: a worker in
// `tokens: abort, context: compact` mode has `interventionAvailable: true`
// for the token warning (operator can still rescue on the token side) and
// `interventionAvailable: false` for the context warning (system handles
// it). Mirrors the F13 `interventionAvailable` semantics, computed
// independently for each dimension.
export function resolveInterventionAvailable(
  policy: WorkerBudgetPolicy,
  dimension: ExhaustionDimension,
): boolean {
  const approaching = policy.strategies?.onApproachingLimit?.action;
  const exhaustion = resolveExhaustionAction(policy, dimension);
  return exhaustion !== "compact" && approaching !== "compact";
}

// §1.3/§1.4 replacement: the worker's remaining budget under the legacy
// WorkerGovernance-shaped caps. The runtime now carries the SDK's
// session-lifetime aggregates (overwritten from getSessionStats in
// dispatch-lifecycle.ts), so worker consumed tokens/cost reads from those
// fields directly — no more `runStart*` baselines (per §1.1, those are gone
// from AgentRuntime). The team total walks the live state.runtimes Map,
// matching the legacy `teamUsage` shape so the worker-prompt display and the
// checkDispatchBudgets surface stay consistent.
//
// Wave context-constraint (T6): the `context` field exposes the worker's
// live context-window fill (the values the runtime picks up at every
// `message_end` from `getContextUsage()` — see T3 in events.ts). `tokens`
// is the LLM's current context in tokens (0 when not yet known), and
// `percent` is the same value expressed as a 0–1 ratio (matches the
// SDK's `ContextUsage.percent` scale; multiply by 100 for the user-
// facing 0–100 view the `formatContextFill` helper at
// `src/agents/tools.ts:79` already renders). The shape is additive — the
// pre-existing `tokens` / `costUsd` / `runs` / `distillerRuns` fields are
// untouched. When the runtime has not yet seen a `message_end` event
// (contextPct=0 from a fresh dispatch, contextTokens/contextWindow
// undefined), `context` is still returned with the available fields so
// the dashboard has a stable shape.
export interface BudgetRemaining {
  runs?: number;
  tokens?: number;
  costUsd?: number;
  distillerRuns?: number;
  // Wave context-constraint: live context-window fill on the 0–1 scale
  // (matches `runtime.contextPct` which is the SDK's `ContextUsage.percent`
  // value). `tokens` is the raw SDK value (0 when not yet known).
  context?: { tokens: number; percent: number };
}

// Merge shim: combines the project-wide `workerBudgets` config tier with
// per-agent `governance` overrides (per-agent wins on conflict). Moved from
// `budget/remaining.ts` when that legacy module was deleted by Gap 3. The
// resolver (`resolveWorkerBudgetPolicy`) does NOT model timeoutMs /
// distillerRuns because those are per-agent concurrency settings, not
// budget caps — keeping them out of `WorkerBudgetPolicy` is intentional
// and the seam is documented at the call sites (see dispatch.ts and
// distiller.ts).
export function effectiveWorkerGovernance(state: HiveState, runtime: AgentRuntime): WorkerGovernance {
  return { ...(state.config?.settings.workerBudgets || {}), ...(runtime.config.governance || {}) };
}

function runtimeTokensForScope(runtime: AgentRuntime, scope: "input_output" | "all"): number {
  const base = runtime.inputTokens + runtime.outputTokens;
  return scope === "input_output"
    ? base
    : base + runtime.cacheReadTokens + runtime.cacheWriteTokens + runtime.reasoningTokens;
}

function teamTotals(state: HiveState, scope: "input_output" | "all"): { runs: number; tokens: number; costUsd: number } {
  let runs = 0;
  let tokens = 0;
  let costUsd = 0;
  for (const runtime of state.runtimes.values()) {
    if (runtime.config.role === "orchestrator") continue;
    runs += runtime.runCount;
    tokens += runtimeTokensForScope(runtime, scope);
    costUsd += runtime.costUsd;
  }
  return { runs, tokens, costUsd };
}

function remaining(limit: number | undefined, used: number): number | undefined {
  return limit === undefined ? undefined : Math.max(0, limit - used);
}

export function budgetRemaining(state: HiveState, runtime: AgentRuntime): { worker: BudgetRemaining; team: BudgetRemaining } {
  const limits = effectiveWorkerGovernance(state, runtime);
  const teamLimits = state.config?.settings.teamBudgets || {};
  const workerScope = limits.tokenBudgetScope ?? "all";
  const teamScope = teamLimits.tokenBudgetScope ?? "all";
  const team = teamTotals(state, teamScope);
  // Wave context-constraint (T6): read the live context values from the
  // runtime (populated at every message_end by the events.ts handler; see
  // T3). When `contextPct` is the runtime-default 0 and `contextTokens` is
  // undefined, return zeros rather than undefined so callers can render a
  // deterministic "no fill yet" view. The `percent` here is on the 0–1
  // scale (the SDK's `ContextUsage.percent`); callers that want a 0–100
  // percentage multiply by 100.
  const ctxTokens = Number(runtime.contextTokens) || 0;
  const ctxPct = Number(runtime.contextPct) || 0;
  return {
    worker: {
      runs: remaining(limits.maxRuns, runtime.runCount),
      tokens: remaining(limits.tokenBudget, runtimeTokensForScope(runtime, workerScope)),
      costUsd: remaining(limits.costBudgetUsd, runtime.costUsd),
      distillerRuns: remaining(limits.distillerRuns, runtime.distillerRunCount || 0),
      context: { tokens: ctxTokens, percent: ctxPct },
    },
    team: {
      runs: remaining(teamLimits.maxRuns, team.runs),
      tokens: remaining(teamLimits.tokenBudget, team.tokens),
      costUsd: remaining(teamLimits.costBudgetUsd, team.costUsd),
    },
  };
}
