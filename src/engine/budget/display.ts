/**
 * Wave 5 / F9 — Budget display helpers (extracted from the deleted
 * `governance.ts`).
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md §3.9.
 *
 * `budgetRemaining` and `effectiveWorkerGovernance` previously lived in
 * `governance.ts` and read the legacy `settings.workerBudgets` /
 * `settings.teamBudgets` / `runtime.config.governance` blocks that Wave 1B's
 * hard cutover removed from config validation. With no config source left
 * to read, those functions returned empty results — so callers' display
 * layers were silently broken.
 *
 * This module rewrites the display-only surface against the new
 * `settings.budgets.perWorker` / `settings.budgets.perTeam` shape
 * (src/core/schema.ts). The cumulative tokens/cost come from the runtime's
 * already-maintained SDK-aligned mirror (inputTokens + outputTokens +
 * cacheReadTokens + cacheWriteTokens + reasoningTokens + costUsd), which
 * is overwritten from `session.getSessionStats()` at run end (see
 * dispatch.ts). This is the "single source of truth" the plan requires
 * for display reads.
 *
 * The functions here are display-only — they DO NOT enforce policy. The
 * policy gate is `checkBudgetPolicy()` in `./policy.ts`, called by
 * `runBudgetPreflight()` in `./worker-tools.ts`, which is the Wave 2/F2
 * replacement for the deleted `checkDispatchBudgets`.
 */

import type { AgentRuntime, HiveState } from "../../core/types";
import type {
  ResolvedBudgetsConfig,
  ResolvedTeamBudgets,
  ResolvedWorkerBudgets,
} from "./types";

// ---------------------------------------------------------------------------
// Types — the public shape callers (observability, buildBudgetVisibility,
// team_status, TUI header) consume. Field names match the legacy
// `governance.ts` interface so call-sites are unchanged.
//
// Note: there is a same-named `BudgetRemaining` in `./types.ts` (the F1
// runtime contract). This module's `BudgetRemaining` is intentionally NOT
// re-exported from `./types` because the legacy `distillerRuns` field is
// unique to the display surface; the F1 contract deliberately omits it.
// Callers that want the runtime-contract shape should import from
// `./types`; callers that want the display shape should import from
// `./display`.
// ---------------------------------------------------------------------------

export interface BudgetRemaining {
  runs?: number;
  tokens?: number;
  costUsd?: number;
  distillerRuns?: number;
}

// ---------------------------------------------------------------------------
// New-shape readers — pull caps from `settings.budgets.*` (with the legacy
// `settings.workerBudgets` / `settings.teamBudgets` keys kept ONLY for
// backward compat with in-flight state objects; the Wave 1B config
// validator no longer accepts these keys in YAML). Wave 5 / F9's gate
// check requires this fallback to be empty, since nothing in the test
// suite sets the legacy keys any more. Kept here as a no-op for code
// clarity; the cleanup wave does not add or remove this branch.
// ---------------------------------------------------------------------------

interface NewShapeSettings {
  budgets?: ResolvedBudgetsConfig;
  workerBudgets?: {
    maxRuns?: number;
    tokenBudget?: number;
    tokenBudgetScope?: "input_output" | "all";
    costBudgetUsd?: number;
    maxDelegationDepth?: number;
    distillerRuns?: number;
    timeoutMs?: number;
  };
  teamBudgets?: {
    maxRuns?: number;
    tokenBudget?: number;
    tokenBudgetScope?: "input_output" | "all";
    costBudgetUsd?: number;
  };
}

/**
 * Resolve the `settings.budgets:` block from `state.config` with the
 * cast performed once. The audit (HTML §5 B5) flagged three call sites
 * duplicating `state.config?.settings as unknown as { budgets?: ... }` —
 * worker-tools.ts:229, display.ts:87 (readWorkerBlock), and display.ts:94
 * (readTeamBlock). This helper centralizes the cast.
 *
 * The return type preserves the legacy shape (`perWorker` is the
 * resolved runtime shape, `perTeam` is the pre-resolve `TeamBudgetConfig`)
 * because that's what the three duplicated casts produced. The internal
 * window-shape mismatch between `BudgetWindowSpec` (core/types) and
 * `BudgetWindow` (budget/types) is handled by a single `as unknown as`
 * here instead of being repeated at each call site — same lossy
 * semantics, one place to change later if the types are unified.
 */
export function getBudgetsConfig(state: HiveState): {
  perWorker: ResolvedWorkerBudgets | undefined;
  perTeam: import("../../core/types").TeamBudgetConfig | undefined;
} {
  const settings = state.config?.settings as unknown as NewShapeSettings | undefined;
  return {
    perWorker: settings?.budgets?.perWorker,
    perTeam: settings?.budgets?.perTeam as import("../../core/types").TeamBudgetConfig | undefined,
  };
}

function readWorkerBlock(state: HiveState, runtime: AgentRuntime): ResolvedWorkerBudgets {
  const globalWorker = getBudgetsConfig(state).perWorker ?? {};
  const agentBlock = (runtime.config as unknown as { budgets?: ResolvedWorkerBudgets }).budgets ?? {};
  return { ...globalWorker, ...agentBlock };
}

function readTeamBlock(state: HiveState): ResolvedTeamBudgets {
  // The budgets block's perTeam is a pre-resolve TeamBudgetConfig but
  // the runtime wants ResolvedTeamBudgets. The structural compatibility
  // is close enough (both are { tokens?, costUsd?, runs? }) that a
  // single cast here preserves the legacy behavior of readTeamBlock.
  return (getBudgetsConfig(state).perTeam ?? {}) as unknown as ResolvedTeamBudgets;
}

// ---------------------------------------------------------------------------
// Effective governance — preserved name + signature so callers compile
// unchanged. Returns an empty object now that the legacy `governance:` block
// is gone from the config; every field is `undefined`, so callers' `if (x)`
// guards skip. The new-shape budget caps are read directly by callers that
// need them (see `./display.ts` exports below).
// ---------------------------------------------------------------------------

export interface EffectiveWorkerGovernance {
  timeoutMs?: number;
  maxDelegationDepth?: number;
  maxRuns?: number;
  tokenBudget?: number;
  tokenBudgetScope?: "input_output" | "all";
  costBudgetUsd?: number;
  distillerRuns?: number;
}

export function effectiveWorkerGovernance(_state: HiveState, _runtime: AgentRuntime): EffectiveWorkerGovernance {
  // F9 — the legacy `WorkerGovernance` config block was removed by Wave 1B's
  // hard cutover (G-16). Return a frozen empty object so any caller's
  // `.timeoutMs` / `.maxRuns` / `.tokenBudgetScope` reads return `undefined`,
  // matching the previous behavior when no budget was configured. Anything
  // that needs the *new-shape* caps should call `budgetRemaining(...)` below
  // or read `state.config.settings.budgets.perWorker` directly.
  return Object.freeze({}) as EffectiveWorkerGovernance;
}

// ---------------------------------------------------------------------------
// Cumulative spend — the legacy function read three counters that Wave 3A
// froze as dead (`runtime.governanceTokens ??= ...`, `runtime.governanceCostUsd
// ??= ...`). The SDK-aligned mirror on `AgentRuntime` (inputTokens +
// outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens +
// costUsd) is overwritten from `session.getSessionStats()` at run end, so
// reading it directly gives the same authoritative total the pre-flight gate
// uses. The display layer is the only consumer.
// ---------------------------------------------------------------------------

function runtimeTokens(runtime: AgentRuntime): number {
  return runtime.inputTokens + runtime.outputTokens + runtime.cacheReadTokens + runtime.cacheWriteTokens + runtime.reasoningTokens;
}

function runtimeCost(runtime: AgentRuntime): number {
  return runtime.costUsd;
}

function teamTokens(state: HiveState, excludeRuntime?: AgentRuntime): number {
  let tokens = 0;
  for (const runtime of state.runtimes.values()) {
    if (runtime.config.role === "orchestrator") continue;
    if (excludeRuntime && runtime === excludeRuntime) continue;
    tokens += runtimeTokens(runtime);
  }
  return tokens;
}

function teamCost(state: HiveState, excludeRuntime?: AgentRuntime): number {
  let cost = 0;
  for (const runtime of state.runtimes.values()) {
    if (runtime.config.role === "orchestrator") continue;
    if (excludeRuntime && runtime === excludeRuntime) continue;
    cost += runtimeCost(runtime);
  }
  return cost;
}

function teamRuns(state: HiveState, excludeRuntime?: AgentRuntime): number {
  let runs = 0;
  for (const runtime of state.runtimes.values()) {
    if (runtime.config.role === "orchestrator") continue;
    if (excludeRuntime && runtime === excludeRuntime) continue;
    runs += runtime.runCount;
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Public display surface.
// ---------------------------------------------------------------------------

/**
 * Compute the worker's and team's remaining budget for display.
 *
 * Reads caps from the NEW shape (`settings.budgets.perWorker` /
 * `settings.budgets.perTeam`). Uses the SDK-aligned mirror of cumulative
 * tokens/cost on `AgentRuntime` (overwritten from
 * `session.getSessionStats()` at run end) as the spent amount.
 *
 * Legacy field names preserved (`runs`, `tokens`, `costUsd`, `distillerRuns`)
 * so the existing `team_status`, `buildBudgetVisibility`, runtimeSummary,
 * and TUI header consumers compile unchanged. `distillerRuns` is always
 * `undefined` now — the field was removed by the Wave 1B cutover; callers
 * that render it gracefully skip when undefined.
 */
export function budgetRemaining(state: HiveState, runtime: AgentRuntime): { worker: BudgetRemaining; team: BudgetRemaining } {
  const workerCaps = readWorkerBlock(state, runtime);
  const teamCaps = readTeamBlock(state);
  const usedTokens = runtimeTokens(runtime);
  const usedCost = runtimeCost(runtime);
  const usedRuns = runtime.runCount;
  const remaining = (limit: number | undefined, used: number): number | undefined =>
    limit === undefined ? undefined : Math.max(0, limit - used);
  return {
    worker: {
      runs: remaining(workerCaps.runs?.cap, usedRuns),
      tokens: remaining(workerCaps.tokens?.cap, usedTokens),
      costUsd: remaining(workerCaps.costUsd?.cap, usedCost),
      // `distillerRuns` is intentionally absent from the new config — see
      // src/core/schema.ts. The display call sites all guard with
      // `if (... !== undefined)`, so leaving the field undefined preserves
      // the previous behavior under an empty config.
      distillerRuns: undefined,
    },
    team: {
      runs: remaining(teamCaps.runs?.cap, teamRuns(state, runtime)),
      tokens: remaining(teamCaps.tokens?.cap, teamTokens(state, runtime)),
      costUsd: remaining(teamCaps.costUsd?.cap, teamCost(state, runtime)),
    },
  };
}
