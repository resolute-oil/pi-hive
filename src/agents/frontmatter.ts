/**
 * Wave 1B — F6 frontmatter validation (C1: rename `governance:` → `budgets:`).
 *
 * The .md files in `.pi/hive/agents/*.md` carry YAML frontmatter. Each file may
 * carry a per-agent budget override that used to live under the `governance:`
 * key. Per §2.13 C1, that key is renamed to `budgets:`. The hard cutover (G-16)
 * means the legacy `governance:` key is REJECTED at validation time — users
 * must update their agent .md files. See
 * docs/reviews/28-09-2026-budget-review/04-refactor-plan.md §2.13 C1.
 *
 * The companion config-layer validator lives in src/core/config-validation.ts
 * (see `validateAgentBudgets` for the typebox check used on
 * `agent.budgets:` blocks; this file covers the frontmatter read path used by
 * `enrichFromFrontmatter` in src/core/config.ts).
 *
 * Wiring note: this file is intentionally side-effect-free. Wave 2+ will call
 * `validateBudgetsFrontmatter(attrs, label)` from `enrichFromFrontmatter` to
 * hard-fail on legacy frontmatter. Until that wiring lands, this module exists
 * for tests + future wiring; the existing read path silently ignores
 * `budgets:` frontmatter.
 */

import { Value } from "typebox/value";
import { AgentBudgetsOverrideSchema } from "../core/schema";

// ---------------------------------------------------------------------------
// Legacy keys rejected at frontmatter-load time. Per the hard cutover (G-16),
// no deprecation alias: presenting any of these in an agent's frontmatter is a
// hard validation error.
// ---------------------------------------------------------------------------

/**
 * Keys that USED to live on agent.md frontmatter for budget overrides and are
 * now rejected. The list mirrors what the previous schema (WorkerGovernance)
 * carried on the agent's per-call override block: timeoutMs, maxDelegationDepth,
 * maxRuns, tokenBudget, tokenBudgetScope, costBudgetUsd, distillerRuns.
 *
 * A bare `governance:` parent key is also rejected (the entire block is
 * replaced by `budgets:`).
 */
export const LEGACY_GOVERNANCE_KEYS = [
  "governance",
  "timeoutMs",
  "maxDelegationDepth",
  "maxRuns",
  "tokenBudget",
  "tokenBudgetScope",
  "costBudgetUsd",
  "distillerRuns",
] as const;

/**
 * Reject any legacy budget-related key in the agent's frontmatter. Throws a
 * path-aware error so the user knows exactly which file + key needs updating.
 *
 * Call this BEFORE the typebox `budgets:` check so a legacy `governance:`
 * parent produces a clear "rename governance → budgets" message instead of a
 * generic schema mismatch.
 */
export function rejectLegacyGovernanceFrontmatter(attrs: Record<string, unknown>, label: string): void {
  for (const key of LEGACY_GOVERNANCE_KEYS) {
    if (key in attrs) {
      throw new Error(
        `${label} uses the legacy '${key === "governance" ? "governance" : `governance.${key}`}' key. ` +
          `Per the Wave 1B hard cutover (G-16), rename 'governance:' to 'budgets:' in agent.md frontmatter ` +
          `and migrate the inner fields to the new nested cap shape (e.g. tokens: { cap: ... }).`,
      );
    }
  }
}

/**
 * Validate the new `budgets:` block in an agent's frontmatter. Mirrors the
 * config-layer `validateAgentBudgets` (src/core/config-validation.ts) — both
 * layers run the same typebox `AgentBudgetsOverrideSchema`, so an error caught
 * here is caught identically at the config layer (defense in depth).
 *
 * Returns the validated value when the block is present; `undefined` when the
 * block is absent (the agent inherits the team's defaults).
 */
export function validateBudgetsFrontmatter(attrs: Record<string, unknown>, label: string): unknown {
  if (attrs.budgets === undefined) return undefined;
  // Legacy-key check runs FIRST so the user sees a "rename" message instead of
  // a generic schema error when they paste old frontmatter next to a new key.
  rejectLegacyGovernanceFrontmatter(attrs, label);
  if (!Value.Check(AgentBudgetsOverrideSchema, attrs.budgets)) {
    const errors = Value.Errors(AgentBudgetsOverrideSchema, attrs.budgets);
    const first = errors[0];
    const path = first?.instancePath ? `${label}.budgets.${first.instancePath.replace(/^\//, "").replace(/\//g, ".")}` : `${label}.budgets`;
    throw new Error(`${path} ${first?.message || first?.keyword || "invalid value"}`);
  }
  return attrs.budgets;
}

// Re-export the schema for downstream consumers that want to drive validation
// without importing the core schema barrel.
export { AgentBudgetsOverrideSchema };
