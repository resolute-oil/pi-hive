/**
 * Wave 1 — WorkerBudgetStrategy resolver (C5 structured).
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md §2.13 C5
 *   Replaces the flat `budget-strategy: default | compact` enum with a
 *   structured config where each event has its own action. Decouples warning
 *   behavior from EOL behavior; extensible without breaking changes.
 *
 * Design notes:
 * - `resolveWorkerBudgetStrategy` ALWAYS returns a `WorkerBudgetStrategy`
 *   (never `undefined`). When the config carries no `strategies:` block, the
 *   default preset is returned (`on-approaching-limit: wrap-up`,
 *   `on-exhaustion: abort`, `summary.max-tokens: 2000`).
 * - The structured shape makes the "default" preset and the "compact" preset
 *   two explicit named configurations (legacy) that the user can also build
 *   from scratch by combining actions. Old `budget-strategy: compact` maps to
 *   `{ on-approaching-limit: { action: "wrap-up" }, on-exhaustion: { action: "compact" } }`.
 * - `resolveWorkerBudgetPolicy` is intentionally NOT in this module: it lives
 *   in `worker-tools.ts` because it needs the resolved `AgentConfig` for the
 *   target agent (a Wave 2 concern, T2.2).
 */

import type { HiveState } from "../../core/types";
import type {
  ApproachingLimitAction,
  ExhaustionAction,
  WorkerBudgetStrategy,
} from "./types";

// ---------------------------------------------------------------------------
// Default preset (legacy "default" strategy).
//
// Mapped per refactor plan §2.13 C5: warning fires at ≤20% remaining, worker
// gets a "wrap up" prompt hint, exhaustion aborts the run controller. No
// compaction, no auto-wrap; the operator drives intervention.
// ---------------------------------------------------------------------------

export const DEFAULT_STRATEGY: WorkerBudgetStrategy = {
  onApproachingLimit: {
    action: "wrap-up",
    threshold: 0.20,
    hint:
      "Less than 20% of your worker budget remains. Wrap up your current work " +
      "and call `summarize_progress({ notes: \"...\" })` to record wrap-up state. " +
      "The operator has been notified and may end the session, /compact, or " +
      "respawn you at this point. Notes travel with you regardless of which " +
      "action is taken.",
  },
  onExhaustion: {
    action: "abort",
  },
  summary: {
    maxTokens: 2000,
  },
};

/**
 * Compact preset (legacy "compact" strategy).
 *
 * Same warning threshold as default, but exhaustion triggers an automatic
 * `/compact` using the last-recorded progress notes instead of aborting. The
 * worker's `summarize_progress({ compact: true })` tool call is honored under
 * this strategy.
 */
export const COMPACT_STRATEGY: WorkerBudgetStrategy = {
  onApproachingLimit: {
    action: "wrap-up",
    threshold: 0.20,
    hint:
      "Less than 20% of your worker budget remains. You will be force-compacted " +
      "at 0%. To control the compact timing:\n" +
      "  - Reach a natural stopping point in your task\n" +
      "  - Call `summarize_progress({ notes: \"...\" })` to record wrap-up notes\n" +
      "  - Call `summarize_progress({ notes: \"...\", compact: true })` to record AND compact now\n" +
      "Otherwise the system force-compacts at 0% with the last recorded notes. " +
      "Keep notes tight (default cap: 2000 tokens) so the new context window isn't dominated by the report.",
  },
  onExhaustion: {
    action: "compact",
  },
  summary: {
    maxTokens: 2000,
  },
};

/**
 * Apply the structured config (or fallback to defaults) to produce a fully
 * resolved `WorkerBudgetStrategy`. Each sub-block falls back independently so
 * a partial config is still usable.
 *
 * @internal Exported for `resolveWorkerBudgetStrategy`; tests pin the
 *           defaults through `DEFAULT_STRATEGY` and `COMPACT_STRATEGY`.
 */
export function resolveStrategyFromConfig(
  config: HiveState["config"],
): WorkerBudgetStrategy {
  const strategies = (config?.settings?.budgets as { strategies?: Partial<WorkerBudgetStrategy> } | undefined)?.strategies;
  if (!strategies) return DEFAULT_STRATEGY;

  const approaching: Partial<WorkerBudgetStrategy["onApproachingLimit"]> = strategies.onApproachingLimit ?? {};
  const exhaustion: Partial<WorkerBudgetStrategy["onExhaustion"]> = strategies.onExhaustion ?? {};
  const summary: Partial<WorkerBudgetStrategy["summary"]> = strategies.summary ?? {};

  return {
    onApproachingLimit: {
      action: (approaching.action ?? DEFAULT_STRATEGY.onApproachingLimit.action) as ApproachingLimitAction,
      threshold: approaching.threshold ?? DEFAULT_STRATEGY.onApproachingLimit.threshold,
      ...(approaching.hint !== undefined ? { hint: approaching.hint } : DEFAULT_STRATEGY.onApproachingLimit.hint !== undefined
        ? { hint: DEFAULT_STRATEGY.onApproachingLimit.hint }
        : {}),
    },
    onExhaustion: {
      action: (exhaustion.action ?? DEFAULT_STRATEGY.onExhaustion.action) as ExhaustionAction,
      ...(exhaustion.customInstructions !== undefined ? { customInstructions: exhaustion.customInstructions } : {}),
    },
    summary: {
      maxTokens: summary.maxTokens ?? DEFAULT_STRATEGY.summary.maxTokens,
    },
  };
}

/**
 * Resolve the effective `WorkerBudgetStrategy` for an agent.
 *
 * C5 contract: ALWAYS returns a `WorkerBudgetStrategy` (never `undefined`).
 * The legacy "default" / "compact" presets are emitted when the user has not
 * configured a structured `strategies:` block; structured configs can mix
 * actions freely (e.g. wrap-up warning + compact on exhaustion).
 */
export function resolveWorkerBudgetStrategy(
  state: HiveState,
  _agentName: string,
): WorkerBudgetStrategy {
  return resolveStrategyFromConfig(state.config);
}

/**
 * Convenience: does the resolved strategy request a wrap-up hint when the
 * worker crosses the approaching-limit threshold?
 */
export function strategyRequestsWrapUp(
  strategy: WorkerBudgetStrategy | undefined,
): boolean {
  return strategy?.onApproachingLimit?.action === "wrap-up";
}

/**
 * Convenience: does the resolved strategy request an automatic compaction at
 * exhaustion (vs. an abort)?
 */
export function strategyRequestsCompactOnExhaustion(
  strategy: WorkerBudgetStrategy | undefined,
): boolean {
  return strategy?.onExhaustion?.action === "compact";
}
