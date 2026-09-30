// ── Agent.md frontmatter parsing — Wave 1 (F6, T6.4 / C1) ────────────────────
//
// Frontmatter parsing for an agent.md prompt. Splits YAML frontmatter from
// body, then surfaces a per-agent budget block. The canonical top-level key
// is `budgets:`; `governance:` is the deprecated alias kept for one release
// so existing agent files don't have to be rewritten alongside the schema
// cutover. When both keys are present, `budgets:` wins.
//
// The shape returned here is the LEGACY flat per-agent budget (the same one
// `WorkerGovernance` carries in src/core/types.ts). The hard cutover to the
// nested shape (§2.10 / §2.13) lives in `settings.budgets` (validateBudgetsConfig
// in src/core/schema.ts) — agent.md frontmatter keeps the simpler flat shape
// because agents only override their own token/cost budget, never team-level
// or strategies config.

import { parseFrontmatter } from "../core/yaml.ts";

export interface AgentBudgetFrontmatter {
  // Per-agent budget overrides in the legacy flat shape. Omitted when the
  // frontmatter carries no `budgets:` or `governance:` block. Optional fields
  // mirror WorkerGovernance's scalar fields; only `tokens` and `costUsd` are
  // surfaced here because those are the ones the per-agent override carries.
  budgets?: {
    tokens?: number;
    costUsd?: number;
  };
}

// Extract the per-agent budget block from a raw agent.md file. Parses YAML
// frontmatter and resolves the canonical `budgets:` key against the deprecated
// `governance:` alias. Pure (no I/O) — file reads happen in the caller.
export function parseAgentBudgetsFrontmatter(raw: string): AgentBudgetFrontmatter {
  const { attrs } = parseFrontmatter(raw);
  // Canonical key wins over deprecated alias when both are present.
  const rawBudgets = (attrs as Record<string, unknown>).budgets ?? (attrs as Record<string, unknown>).governance;
  if (rawBudgets === undefined || rawBudgets === null) return {};
  if (typeof rawBudgets !== "object" || Array.isArray(rawBudgets)) {
    throw new Error(`agent.md frontmatter: 'budgets' must be an object; got ${Array.isArray(rawBudgets) ? "array" : typeof rawBudgets}.`);
  }
  const budgets = rawBudgets as Record<string, unknown>;
  const result: AgentBudgetFrontmatter["budgets"] = {};
  if (budgets.tokens !== undefined) {
    if (typeof budgets.tokens !== "number" || !Number.isFinite(budgets.tokens)) {
      throw new Error(`agent.md frontmatter: 'budgets.tokens' must be a finite number; got ${JSON.stringify(budgets.tokens)}.`);
    }
    result.tokens = budgets.tokens;
  }
  if (budgets.costUsd !== undefined) {
    if (typeof budgets.costUsd !== "number" || !Number.isFinite(budgets.costUsd)) {
      throw new Error(`agent.md frontmatter: 'budgets.costUsd' must be a finite number; got ${JSON.stringify(budgets.costUsd)}.`);
    }
    result.costUsd = budgets.costUsd;
  }
  return { budgets: result };
}