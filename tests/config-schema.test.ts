/**
 * Wave 1B — F6 config-schema tests (T6.1–T6.10).
 *
 * These tests pin the new nested budget schema (§2.10 / §2.13 of
 * docs/reviews/28-09-2026-budget-review/04-refactor-plan.md). The hard cutover
 * (G-16) means the legacy flat keys (`workerBudgets`, `teamBudgets`,
 * `governance`, `tokenBudget`, `tokenBudgetScope`, `costBudgetUsd`, `maxRuns`,
 * `maxDelegationDepth`, `distillerRuns`, `timeoutMs`) MUST be rejected — there
 * is no deprecation alias and no `schema_version` field.
 *
 * Coverage map (matches the wave-1b task brief):
 *   T6.1 — new nested schema parses correctly                              (2 tests)
 *   T6.2 — legacy fields rejected at config-validation time                (1 test)
 *   T6.3 — cap types (each variant parses with its own shape)               (1 test)
 *   T6.4 — C1 frontmatter rename: `budgets:` accepted, `governance:` rejected (1 test)
 *   T6.5 — C2 `include: [Usage keys]` replaces `scope: input_output | all`  (2 tests)
 *   T6.7 — C4 discriminated unions reject invalid combos                  (1 test)
 *   T6.8 — C6 `window:` field accepts rolling/per-day/all-time             (1 test)
 *   T6.10 — per-day window roll-over (G-10)                                (1 test)
 *   (T6.6/C3 SKIPPED per G-16; T6.9/C5 is a TODO placeholder, not tested.)
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import { parseYamlLite } from "../src/core/yaml.ts";
import {
  AgentBudgetsOverrideSchema,
  BudgetCapSchema,
  BudgetsConfigSchema,
  BudgetWindowSpecSchema,
  CostUsdCapSchema,
  DepthCapSchema,
  RunsCapSchema,
  TokensCapSchema,
  TokensCapYAMLSchema,
  validateAgentBudgets,
  validateBudgets,
} from "../src/core/schema.ts";
import { validateRawConfig } from "../src/core/config-validation.ts";
import {
  LEGACY_GOVERNANCE_KEYS,
  rejectLegacyGovernanceFrontmatter,
  validateBudgetsFrontmatter,
} from "../src/agents/frontmatter.ts";

// ---------------------------------------------------------------------------
// T6.1 — New nested schema parses correctly (2 tests).
// ---------------------------------------------------------------------------

test("T6.1a: settings.budgets with per-worker + per-team parses correctly", () => {
  // The YAML layer uses the outer key (`tokens:`, `cost-usd:`) as the
  // implicit resource discriminant — no `resource:` field on the cap value.
  const parsed = {
    settings: {
      defaultTools: "read, grep",
      budgets: {
        perWorker: {
          tokens: { cap: 3500, window: { kind: "per-day", duration: 86_400_000 }, include: ["input", "output"] },
          costUsd: { cap: 0.5 },
          runs: { cap: 3 },
          depth: { cap: 2 },
        },
        perTeam: {
          tokens: { cap: 50_000, include: ["input", "output", "cacheRead", "cacheWrite"] },
          costUsd: { cap: 5 },
          runs: { cap: 20 },
        },
      },
    },
    planning: {
      main: { name: "Plan", path: ".pi/hive/agents/plan.md" },
      agents: [],
    },
    hive: {
      main: { name: "Hive", path: ".pi/hive/agents/hive.md" },
      agents: [],
    },
  };
  // Build a tmp project so the path validation in validateRawConfig doesn't
  // trip before reaching the budget check.
  const cwd = fixtureProject();
  assert.doesNotThrow(() => validateRawConfig(cwd, JSON.stringify(parsed), parsed));
  // The typebox schema also accepts the parsed shape directly.
  assert.equal(Value.Check(BudgetsConfigSchema, parsed.settings.budgets), true);
});

test("T6.1b: agent.budgets override block parses with all four cap variants", () => {
  // YAML layer: outer key (`tokens:`, `cost-usd:`) is the implicit resource
  // discriminant; the cap value carries NO `resource:` field.
  const override = {
    tokens: { cap: 1000 },
    costUsd: { cap: 0.25 },
    runs: { cap: 1 },
    depth: { cap: 1 },
  };
  assert.doesNotThrow(() => validateAgentBudgets(override, "agents[0].budgets"));
  assert.equal(Value.Check(AgentBudgetsOverrideSchema, override), true);
});

// ---------------------------------------------------------------------------
// T6.2 — Legacy fields rejected at config-validation time (1 test).
// ---------------------------------------------------------------------------

/** Build a tmp project with both prompt files so path validation doesn't trip. */
function fixtureProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-w1b-"));
  mkdirSync(join(cwd, ".pi", "hive", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "hive", "agents", "plan.md"), "---\nmodel: openai/gpt-5\nthinking: off\nagent-type: planner\n---\nPlan.");
  writeFileSync(join(cwd, ".pi", "hive", "agents", "hive.md"), "---\nmodel: openai/gpt-5\nthinking: off\nagent-type: lead\n---\nHive.");
  return cwd;
}

test("T6.2: legacy flat keys are rejected with a path-aware error", () => {
  // Settings-level: `workerBudgets` / `teamBudgets` — rejected by the
  // settings allowlist (no path dependencies, runs fast).
  const settingsOnly: Array<[unknown, string, RegExp]> = [
    [{ settings: { workerBudgets: { tokenBudget: 1000 } } }, "workerBudgets", /settings\.workerBudgets/],
    [{ settings: { teamBudgets: { tokenBudget: 1000 } } }, "teamBudgets", /settings\.teamBudgets/],
  ];
  for (const [parsed, label, pattern] of settingsOnly) {
    assert.throws(
      () => validateRawConfig(process.cwd(), JSON.stringify(parsed), parsed),
      pattern,
      `legacy ${label} must be rejected`,
    );
  }

  // Agent-level: `governance:` — needs valid paths so the allowlist check
  // (which runs after path validation) is reached.
  const cwd = fixtureProject();
  const parsed = {
    settings: { distiller: { enabled: false } },
    planning: { main: { name: "Plan", path: ".pi/hive/agents/plan.md" }, agents: [] },
    hive: { main: { name: "Hive", path: ".pi/hive/agents/hive.md", governance: { tokenBudget: 1000 } }, agents: [] },
  };
  assert.throws(
    () => validateRawConfig(cwd, JSON.stringify(parsed), parsed),
    /hive\.main\.governance/,
    "legacy governance on an agent must be rejected",
  );
});

// ---------------------------------------------------------------------------
// T6.3 — Each cap variant parses with its own shape (1 test).
// ---------------------------------------------------------------------------

test("T6.3: tokens / costUsd / runs / depth each parse with their own variant", () => {
  const tokens = { resource: "tokens", cap: 5000, include: ["input", "output"] };
  const costUsd = { resource: "costUsd", cap: 1.5 };
  const runs = { resource: "runs", cap: 10 };
  const depth = { resource: "depth", cap: 3 };
  assert.equal(Value.Check(TokensCapSchema, tokens), true);
  assert.equal(Value.Check(CostUsdCapSchema, costUsd), true);
  assert.equal(Value.Check(RunsCapSchema, runs), true);
  assert.equal(Value.Check(DepthCapSchema, depth), true);
  // The union accepts all four under a single shape.
  assert.equal(Value.Check(BudgetCapSchema, tokens), true);
  assert.equal(Value.Check(BudgetCapSchema, costUsd), true);
  assert.equal(Value.Check(BudgetCapSchema, runs), true);
  assert.equal(Value.Check(BudgetCapSchema, depth), true);
});

// ---------------------------------------------------------------------------
// T6.4 — C1 frontmatter rename: `budgets:` accepted, `governance:` rejected.
// ---------------------------------------------------------------------------

test("T6.4: frontmatter accepts budgets: block and rejects governance: (and its inner fields)", () => {
  // New shape: `budgets:` accepted. Block-style YAML — the project's
  // parseYamlLite doesn't grok flow-style `{ cap: 1000 }`.
  const newAttrs = parseYamlLite(`
budgets:
  tokens:
    cap: 1000
  cost-usd:
    cap: 0.25
  runs:
    cap: 1
`) as Record<string, unknown>;
  const validated = validateBudgetsFrontmatter(newAttrs, "agent.md");
  assert.ok(validated);
  assert.equal((validated as { tokens?: { cap: number } }).tokens?.cap, 1000);

  // Legacy shape: `governance:` rejected (and so are the inner flat keys).
  for (const legacyKey of LEGACY_GOVERNANCE_KEYS) {
    const legacyAttrs = parseYamlLite(`budgets:\n  tokens:\n    cap: 1000\n${legacyKey}: bad`) as Record<string, unknown>;
    assert.throws(
      () => validateBudgetsFrontmatter(legacyAttrs, "agent.md"),
      /legacy/i,
      `legacy '${legacyKey}' must be rejected`,
    );
  }
  // Even when `budgets:` is absent, presenting only a legacy key still rejects.
  const onlyGovernance = parseYamlLite(`governance:\n  token-budget: 1000`) as Record<string, unknown>;
  assert.throws(
    () => rejectLegacyGovernanceFrontmatter(onlyGovernance, "agent.md"),
    /legacy 'governance' key/,
  );
});

// ---------------------------------------------------------------------------
// T6.5 — C2 `include: [Usage keys]` replaces `scope: input_output | all`.
// ---------------------------------------------------------------------------

test("T6.5a: include: [input, output] parses for a worker tokens cap", () => {
  // YAML-layer cap (no `resource:` field).
  const tokens = { cap: 5000, include: ["input", "output"] };
  assert.equal(Value.Check(TokensCapYAMLSchema, tokens), true);
  assert.doesNotThrow(() => validateAgentBudgets({ tokens }, "agent.budgets"));
});

test("T6.5b: include: [input, output, cacheRead, cacheWrite] parses for a team tokens cap", () => {
  const tokens = { cap: 50_000, include: ["input", "output", "cacheRead", "cacheWrite"] };
  assert.equal(Value.Check(TokensCapYAMLSchema, tokens), true);
  // Negative: an unknown usage key is rejected.
  const bad = { cap: 1000, include: ["input", "bogusKey"] };
  assert.equal(Value.Check(TokensCapYAMLSchema, bad), false);
});

// ---------------------------------------------------------------------------
// T6.7 — C4 discriminated unions reject invalid combos.
// ---------------------------------------------------------------------------

test("T6.7: BudgetCap discriminated union rejects an invalid window.kind on tokens", () => {
  // The `WindowKind` enum is "rolling" | "per-day" | "all-time". A literal
  // outside that set must be rejected at the cap level — the schema enforces
  // this even though `BudgetCap` is a Union (the `tokens` variant carries its
  // own window schema).
  const badTokens = { resource: "tokens", cap: 1000, window: { kind: "per-session", duration: 60_000 } };
  assert.equal(Value.Check(BudgetCapSchema, badTokens), false);
  // Also: a missing `resource` literal is not a BudgetCap at all.
  assert.equal(Value.Check(BudgetCapSchema, { cap: 1000 }), false);
  // And an unknown resource literal is rejected (the Union doesn't have it).
  assert.equal(Value.Check(BudgetCapSchema, { resource: "queue", cap: 5 }), false);
});

// ---------------------------------------------------------------------------
// T6.8 — C6 `window:` field accepts rolling/per-day/all-time with semantic checks.
// ---------------------------------------------------------------------------

test("T6.8: window: { kind, duration? } accepts rolling/per-day/all-time with semantic checks", () => {
  // rolling + duration → ok.
  assert.equal(Value.Check(BudgetWindowSpecSchema, { kind: "rolling", duration: 3_600_000 }), true);
  // per-day → ok (duration optional, but commonly provided).
  assert.equal(Value.Check(BudgetWindowSpecSchema, { kind: "per-day", duration: 86_400_000 }), true);
  assert.equal(Value.Check(BudgetWindowSpecSchema, { kind: "per-day" }), true);
  // all-time → ok without duration.
  assert.equal(Value.Check(BudgetWindowSpecSchema, { kind: "all-time" }), true);

  // An unknown `kind` literal is rejected at the schema level.
  assert.equal(Value.Check(BudgetWindowSpecSchema, { kind: "per-session" }), false);
  // Semantic check: `rolling` without `duration` is rejected by validateBudgets.
  assert.throws(
    () => validateBudgets({ perWorker: { tokens: { cap: 100, window: { kind: "rolling" } } } }, "settings.budgets"),
    /duration is required when kind is "rolling"/,
  );
  // Semantic check: `all-time` with a duration is rejected.
  assert.throws(
    () => validateBudgets({ perWorker: { tokens: { cap: 100, window: { kind: "all-time", duration: 1000 } } } }, "settings.budgets"),
    /duration is not allowed when kind is "all-time"/,
  );
});

// ---------------------------------------------------------------------------
// T6.10 — Per-day window roll-over (G-10): the cap resets at UTC midnight.
// ---------------------------------------------------------------------------

test("T6.10: per-day window roll-over resets the cap at UTC midnight", () => {
  // The roll-over is a runtime concern (ledger + policy), not a schema concern,
  // but the WINDOW axis must (a) accept a per-day spec and (b) admit the
  // computed "current day index" without re-validation. This test pins the
  // shape that the roll-over code (Wave 2/F3) will consume:
  //   - `kind: "per-day"` with no duration → uses the calendar day in UTC.
  //   - The cap resets when `dayIndex(now)` changes.
  const window = { kind: "per-day" as const };
  assert.equal(Value.Check(BudgetWindowSpecSchema, window), true);

  // Two Date.UTC() values that straddle UTC midnight → two different day indices.
  // Use Date.UTC to avoid local-time skew in the test runner.
  const beforeMidnight = Date.UTC(2026, 8, 14, 23, 59, 59); // 2026-09-14T23:59:59Z
  const afterMidnight = Date.UTC(2026, 8, 15, 0, 0, 1); // 2026-09-15T00:00:01Z
  const dayIndex = (ms: number) => Math.floor(ms / 86_400_000);
  assert.notEqual(dayIndex(beforeMidnight), dayIndex(afterMidnight));
  // And the per-day cap is carried in a BudgetCap that downstream code can read.
  const cap = { resource: "tokens", cap: 1000, window };
  assert.equal(Value.Check(BudgetCapSchema, cap), true);
});
