/**
 * C5 — structured budget strategies (refactor plan §2.13).
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md §2.13 C5
 *   Replaces the flat `budget-strategy: default | compact` enum with a structured
 *   config where each event has its own action. Decouples warning behavior from
 *   EOL behavior; extensible without breaking changes.
 *
 * Coverage:
 *   - Schema accepts the new structured shape; rejects invalid action values.
 *   - Schema validates threshold range (0.0-1.0) and rejects bad values.
 *   - `resolveWorkerBudgetStrategy` returns the configured shape OR a default preset.
 *   - `strategyRequestsWrapUp` reads `on-approaching-limit.action === "wrap-up"`.
 *   - `strategyRequestsCompactOnExhaustion` reads `on-exhaustion.action === "compact"`.
 *   - Per-agent `budgets:` frontmatter override (where applicable) wins over global.
 *
 * The placeholder behavior (always returns `undefined`) is replaced wholesale;
 * the legacy `tests/budget-strategy-resolver.test.ts` will be folded into this
 * file in a follow-up commit once the implementation lands.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Value } from "typebox/value";
import { parseYamlLite } from "../src/core/yaml.ts";
import { BudgetsConfigSchema } from "../src/core/schema.ts";
import type { HiveState } from "../src/core/types.ts";
import {
  resolveWorkerBudgetStrategy,
  strategyRequestsCompactOnExhaustion,
  strategyRequestsWrapUp,
} from "../src/engine/budget/strategy.ts";

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function makeHiveState(): HiveState {
  return {
    pi: {} as HiveState["pi"],
    config: null,
    session: null,
    runtimes: new Map(),
    widgetCtx: null,
    activeRuns: 0,
    mode: "normal" as HiveState["mode"],
    normalToolNames: [],
    sddStatus: null,
    obsSeq: 0,
  };
}

function strategiesFromYaml(yaml: string): unknown {
  return parseYamlLite(yaml);
}

// ---------------------------------------------------------------------------
// Slice 1 — Schema: accepts the structured shape; rejects invalid values.
// ---------------------------------------------------------------------------

test("C5a: BudgetsConfigSchema accepts a structured strategies: block (full shape)", () => {
  const parsed = strategiesFromYaml(`
strategies:
  on-approaching-limit:
    action: wrap-up
    threshold: 0.20
    hint: "Wrap up your work and call summarize_progress when done."
  on-exhaustion:
    action: abort
    custom-instructions: ""
  summary:
    max-tokens: 2000
`) as { strategies: unknown };
  assert.equal(Value.Check(BudgetsConfigSchema, parsed), true);
});

test("C5b: BudgetsConfigSchema accepts compact action combinations", () => {
  const wrapUpCompact = strategiesFromYaml(`
strategies:
  on-approaching-limit:
    action: wrap-up
    threshold: 0.20
  on-exhaustion:
    action: compact
`) as { strategies: unknown };
  assert.equal(Value.Check(BudgetsConfigSchema, wrapUpCompact), true);

  const compactCompact = strategiesFromYaml(`
strategies:
  on-approaching-limit:
    action: compact
  on-exhaustion:
    action: compact
`) as { strategies: unknown };
  assert.equal(Value.Check(BudgetsConfigSchema, compactCompact), true);

  const noneNone = strategiesFromYaml(`
strategies:
  on-approaching-limit:
    action: none
  on-exhaustion:
    action: none
`) as { strategies: unknown };
  assert.equal(Value.Check(BudgetsConfigSchema, noneNone), true);
});

test("C5c: BudgetsConfigSchema rejects unknown action values", () => {
  const badApproaching = strategiesFromYaml(`
strategies:
  on-approaching-limit:
    action: panic
`) as { strategies: unknown };
  assert.equal(Value.Check(BudgetsConfigSchema, badApproaching), false);

  const badExhaustion = strategiesFromYaml(`
strategies:
  on-exhaustion:
    action: explode
`) as { strategies: unknown };
  assert.equal(Value.Check(BudgetsConfigSchema, badExhaustion), false);
});

test("C5d: BudgetsConfigSchema validates threshold range (0.0–1.0)", () => {
  const negThreshold = strategiesFromYaml(`
strategies:
  on-approaching-limit:
    action: wrap-up
    threshold: -0.1
`) as { strategies: unknown };
  assert.equal(Value.Check(BudgetsConfigSchema, negThreshold), false);

  const overOne = strategiesFromYaml(`
strategies:
  on-approaching-limit:
    action: wrap-up
    threshold: 1.5
`) as { strategies: unknown };
  assert.equal(Value.Check(BudgetsConfigSchema, overOne), false);

  const zero = strategiesFromYaml(`
strategies:
  on-approaching-limit:
    action: wrap-up
    threshold: 0.0
`) as { strategies: unknown };
  assert.equal(Value.Check(BudgetsConfigSchema, zero), true);

  const one = strategiesFromYaml(`
strategies:
  on-approaching-limit:
    action: wrap-up
    threshold: 1.0
`) as { strategies: unknown };
  assert.equal(Value.Check(BudgetsConfigSchema, one), true);
});

// ---------------------------------------------------------------------------
// Slice 2 — Resolver: returns structured shape OR default preset.
// ---------------------------------------------------------------------------

test("C5e: resolveWorkerBudgetStrategy returns a structured shape (not undefined) once C5 lands", () => {
  // C5 placeholder previously returned undefined; the new contract is
  // a ResolvedBudgetsStrategy object that ALWAYS resolves to a usable shape
  // (either configured or the default preset).
  const state = makeHiveState();
  const resolved = resolveWorkerBudgetStrategy(state, "any-agent");
  assert.ok(resolved, "resolver must return a strategy object, not undefined");
  assert.ok(typeof resolved === "object");
  // Must carry at least on-approaching-limit and on-exhaustion sub-objects.
  assert.ok("onApproachingLimit" in resolved || "on-approaching-limit" in resolved,
    "strategy must carry on-approaching-limit action info");
  assert.ok("onExhaustion" in resolved || "on-exhaustion" in resolved,
    "strategy must carry on-exhaustion action info");
});

test("C5f: resolveWorkerBudgetStrategy returns the configured strategies from state.config.settings.budgets.strategies", () => {
  const state = makeHiveState();
  state.config = {
    settings: {
      defaultTools: "read",
      budgets: {
        strategies: {
          onApproachingLimit: { action: "wrap-up", threshold: 0.30 },
          onExhaustion: { action: "compact" },
        },
      },
    },
  } as unknown as HiveState["config"];
  const resolved = resolveWorkerBudgetStrategy(state, "any-agent");
  assert.ok(resolved);
  const approaching = (resolved as { onApproachingLimit?: { action?: string; threshold?: number } }).onApproachingLimit
    ?? (resolved as { "on-approaching-limit"?: { action?: string; threshold?: number } })["on-approaching-limit"];
  assert.equal(approaching?.action, "wrap-up");
  assert.equal(approaching?.threshold, 0.30);
});

test("C5g: resolveWorkerBudgetStrategy returns the default preset when strategies: is absent", () => {
  // Default preset per refactor plan §2.13: wrap-up warning + abort at exhaustion.
  const state = makeHiveState();
  state.config = {
    settings: {
      defaultTools: "read",
      budgets: {},
    },
  } as unknown as HiveState["config"];
  const resolved = resolveWorkerBudgetStrategy(state, "any-agent");
  assert.ok(resolved);
  assert.equal(resolved.onApproachingLimit?.action, "wrap-up");
  assert.equal(resolved.onExhaustion?.action, "abort");
});

test("C5h: resolveWorkerBudgetStrategy returns the default preset when state.config is null", () => {
  const state = makeHiveState();
  state.config = null;
  const resolved = resolveWorkerBudgetStrategy(state, "worker");
  assert.ok(resolved);
  assert.equal(resolved.onApproachingLimit?.action, "wrap-up");
  assert.equal(resolved.onExhaustion?.action, "abort");
});

// ---------------------------------------------------------------------------
// Slice 3 — Convenience predicates read from the structured shape.
// ---------------------------------------------------------------------------

test("C5i: strategyRequestsWrapUp is true when on-approaching-limit.action === 'wrap-up'", () => {
  assert.equal(strategyRequestsWrapUp({
    onApproachingLimit: { action: "wrap-up", threshold: 0.20 },
    onExhaustion: { action: "abort" },
    summary: { maxTokens: 2000 },
  }), true);
});

test("C5j: strategyRequestsWrapUp is false when on-approaching-limit.action is compact or none", () => {
  assert.equal(strategyRequestsWrapUp({
    onApproachingLimit: { action: "compact", threshold: 0.20 },
    onExhaustion: { action: "abort" },
    summary: { maxTokens: 2000 },
  }), false);
  assert.equal(strategyRequestsWrapUp({
    onApproachingLimit: { action: "none", threshold: 0.20 },
    onExhaustion: { action: "abort" },
    summary: { maxTokens: 2000 },
  }), false);
});

test("C5k: strategyRequestsCompactOnExhaustion is true when on-exhaustion.action === 'compact'", () => {
  assert.equal(strategyRequestsCompactOnExhaustion({
    onApproachingLimit: { action: "wrap-up", threshold: 0.20 },
    onExhaustion: { action: "compact" },
    summary: { maxTokens: 2000 },
  }), true);
});

test("C5l: strategyRequestsCompactOnExhaustion is false when on-exhaustion.action is abort or none", () => {
  assert.equal(strategyRequestsCompactOnExhaustion({
    onApproachingLimit: { action: "wrap-up", threshold: 0.20 },
    onExhaustion: { action: "abort" },
    summary: { maxTokens: 2000 },
  }), false);
  assert.equal(strategyRequestsCompactOnExhaustion({
    onApproachingLimit: { action: "wrap-up", threshold: 0.20 },
    onExhaustion: { action: "none" },
    summary: { maxTokens: 2000 },
  }), false);
});

// ---------------------------------------------------------------------------
// Slice 4 — F1 compliance: budget strategy module stays pure foundation.
// ---------------------------------------------------------------------------

test("C5m: strategy.ts does not import from src/engine/dispatch.ts or src/engine/governance.ts", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const strategySrc = readFileSync(join(here, "..", "src", "engine", "budget", "strategy.ts"), "utf8");
  const stripped = strategySrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(
    !/from\s+["'][^"']*engine\/dispatch(?:["']|\.ts["'])/.test(stripped),
    "strategy.ts must not import from src/engine/dispatch.ts (F1 must remain pure foundation)",
  );
  assert.ok(
    !/from\s+["'][^"']*engine\/governance(?:["']|\.ts["'])/.test(stripped),
    "strategy.ts must not import from src/engine/governance.ts (F1 must remain pure foundation)",
  );
});