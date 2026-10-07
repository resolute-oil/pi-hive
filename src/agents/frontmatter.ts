// ── Agent.md frontmatter parsing — Wave 1 (F6, T6.4 / C1) ────────────────────
//
// Frontmatter parsing for an agent.md prompt. Splits YAML frontmatter from
// body, then surfaces a per-agent budget block. The canonical top-level key
// is `budgets:`; `governance:` is the deprecated alias kept for one release
// so existing agent files don't have to be rewritten alongside the schema
// cutover. When both keys are present, `budgets:` wins.
//
// The internal return shape is the §2.10 nested per-resource shape (each
// resource is `{ cap }`, optionally with `window` / `include`). Both the
// flat-scalar form (`budgets.tokens: 1000`) and the nested form
// (`budgets.tokens: { cap: 1000 }`) parse to the same internal shape, so
// the migration guide's Example 3 (nested) and existing flat-scalar
// configs both work without a follow-up edit.

import { parseFrontmatter } from "../core/yaml.ts";

export interface AgentBudgetFrontmatter {
  // Per-agent budget overrides in the §2.10 nested shape (each resource is
  // `{ cap }`). Omitted when the frontmatter carries no `budgets:` or
  // `governance:` block. Both flat-scalar (`tokens: 1000`) and nested
  // (`tokens: { cap: 1000 }`) frontmatter parse to this internal shape.
  budgets?: {
    tokens?: { cap: number };
    costUsd?: { cap: number };
    runs?: { cap: number };
    depth?: { cap: number };
  };
}

// Extract the per-agent budget block from a raw agent.md file. Parses YAML
// frontmatter and resolves the canonical `budgets:` key against the deprecated
// `governance:` alias. Pure (no I/O) — file reads happen in the caller.
export function parseAgentBudgetsFrontmatter(raw: string): AgentBudgetFrontmatter {
  const { attrs } = parseFrontmatter(raw);
  // Canonical key wins over deprecated alias when both are present.
  // `attrs` is already typed as JsonRecord by parseFrontmatter, so the
  // historical `(attrs as Record<string, unknown>)` casts disappear.
  const rawBudgets = attrs.budgets ?? attrs.governance;
  if (rawBudgets === undefined || rawBudgets === null) return {};
  if (typeof rawBudgets !== "object" || Array.isArray(rawBudgets)) {
    throw new Error(`agent.md frontmatter: 'budgets' must be an object; got ${Array.isArray(rawBudgets) ? "array" : typeof rawBudgets}.`);
  }
  const budgets = rawBudgets as Record<string, unknown>;
  const result: AgentBudgetFrontmatter["budgets"] = {};
  // Per-resource coercion. Accept both shapes:
  //   flat scalar: `tokens: 1000`           → { cap: 1000 }
  //   nested:      `tokens: { cap: 1000 }`  → { cap: 1000 }
  // A nested object with extra keys (window/include) is the planned §2.13
  // shape; we surface only `cap` here because per-agent governance inherits
  // window/include from the global `settings.budgets.per-worker.<resource>`
  // (the resolver's readGlobalBudgets applies them at merge time).
  const coerceCap = (rawValue: unknown, resource: "tokens" | "costUsd" | "runs" | "depth"): { cap: number } => {
    if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
      return { cap: rawValue };
    }
    if (typeof rawValue === "object" && rawValue !== null && !Array.isArray(rawValue)) {
      const obj = rawValue as Record<string, unknown>;
      const cap = obj.cap;
      if (typeof cap !== "number" || !Number.isFinite(cap)) {
        throw new Error(`agent.md frontmatter: 'budgets.${resource}.cap' must be a finite number; got ${JSON.stringify(cap)}.`);
      }
      return { cap };
    }
    throw new Error(`agent.md frontmatter: 'budgets.${resource}' must be a finite number or an object with a numeric 'cap' field; got ${JSON.stringify(rawValue)}.`);
  };
  for (const key of ["tokens", "costUsd", "runs", "depth"] as const) {
    if (budgets[key] !== undefined) {
      result[key] = coerceCap(budgets[key], key);
    }
  }
  return { budgets: result };
}
