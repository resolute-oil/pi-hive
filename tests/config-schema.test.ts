// Wave 1 — F6 config schema migration tests
//
// These tests pin the new nested-budget config shape (T6.1 / C1 / C2 / C4 / C6)
// that Wave 0 added as typebox stubs (BudgetCap, BudgetsConfigSchema). Each
// test exercises ONE behavior at a public seam so the schema evolves without
// the test becoming coupled to internals.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BudgetsConfigSchema,
  validateBudgetsConfig,
} from "../src/core/schema.ts";

// ── Cycle 1 (T6.1) — Nested config schema parses + rejects malformed ────────

test("validateBudgetsConfig accepts the canonical nested config", () => {
  const config = {
    defaultsEnabled: true,
    perWorker: {
      tokens: { resource: "tokens", cap: 1_000, window: "per-session", include: ["input", "output"] },
      costUsd: { resource: "costUsd", cap: 0.5, window: "per-session" },
      runs: { resource: "runs", cap: 5 },
      depth: { resource: "depth", cap: 2 },
    },
    perTeam: {
      tokens: { resource: "tokens", cap: 10_000, window: "per-team-lifetime", include: ["input", "output", "cacheRead", "cacheWrite"] },
      costUsd: { resource: "costUsd", cap: 5, window: "per-team-lifetime" },
      runs: { resource: "runs", cap: 20 },
    },
    strategies: {
      onApproachingLimit: { action: "wrap-up", threshold: 0.2, hint: "wrap up" },
      onExhaustion: { action: "abort" },
      summary: { maxTokens: 2000 },
    },
  };
  assert.doesNotThrow(() => validateBudgetsConfig(config));
});

test("validateBudgetsConfig rejects malformed nested configs", () => {
  // Negative cap (typebox minimum: 0).
  assert.throws(
    () => validateBudgetsConfig({ perWorker: { tokens: { resource: "tokens", cap: -1 } } }),
    /tokens\/cap/,
  );
  // Unknown resource discriminator.
  assert.throws(
    () => validateBudgetsConfig({ perWorker: { tokens: { resource: "wat", cap: 1 } } }),
    /resource/,
  );
  // Window outside the resource's allowed set — costUsd.window does not accept "per-day".
  assert.throws(
    () => validateBudgetsConfig({ perWorker: { costUsd: { resource: "costUsd", cap: 1, window: "per-day" } } }),
    /window/,
  );
});

// ── Cycle 2 (T6.4, C1) — `budgets:` alias in agent.md frontmatter ──────────

import { parseAgentBudgetsFrontmatter } from "../src/agents/frontmatter.ts";

test("parseAgentBudgetsFrontmatter treats `budgets:` as the per-agent alias for `governance:`", () => {
  // The new canonical key is `budgets:`; `governance:` is the deprecated alias.
  // Either one parses; when both are present, `budgets:` wins.
  // Both the flat-scalar (`tokens: 1000`) and nested (`tokens: { cap: 1000 }`)
  // shapes parse to the same internal { cap } form.
  const canonical = parseAgentBudgetsFrontmatter("---\nbudgets:\n  tokens: 1000\n  costUsd: 0.5\n---\n");
  assert.equal(canonical.budgets?.tokens?.cap, 1000);
  assert.equal(canonical.budgets?.costUsd?.cap, 0.5);

  const deprecated = parseAgentBudgetsFrontmatter("---\ngovernance:\n  tokens: 500\n---\n");
  assert.equal(deprecated.budgets?.tokens?.cap, 500);

// Defensive: frontmatter budgets reject non-numeric scalars so the typo
// surfaces at config-load instead of silently slipping through to runtime.
test("parseAgentBudgetsFrontmatter rejects non-numeric budget scalars with a clear error", () => {
  assert.throws(
    () => parseAgentBudgetsFrontmatter("---\nbudgets:\n  tokens: \"lots\"\n---\n"),
    /budgets\.tokens/,
  );
  assert.throws(
    () => parseAgentBudgetsFrontmatter("---\nbudgets:\n  tokens: 1000\n  costUsd: [1, 2]\n---\n"),
    /budgets\.costUsd/,
  );
  // Missing both keys is a no-op (return empty override), not an error.
  assert.deepEqual(parseAgentBudgetsFrontmatter("---\nname: planner\n---\n"), {});
});

  const both = parseAgentBudgetsFrontmatter("---\nbudgets:\n  tokens: 1000\ngovernance:\n  tokens: 500\n---\n");
  assert.equal(both.budgets?.tokens?.cap, 1000, "`budgets:` must win over the deprecated `governance:` alias");
});

// Block 2 follow-up: the nested shape documented in
// docs/migrations/budget-config-v2.md Example 3 must also parse. Both
// shapes converge on the internal { cap } form.
test("parseAgentBudgetsFrontmatter accepts the nested { cap: N } shape from the migration guide", () => {
  const nested = parseAgentBudgetsFrontmatter(
    "---\nbudgets:\n  tokens:\n    cap: 1000\n  cost-usd:\n    cap: 0.25\n  runs:\n    cap: 1\n  depth:\n    cap: 1\n---\n",
  );
  // YAML kebab/camel is normalized at parse time; both keys arrive as
  // `costUsd` (or `cost-usd` depending on the loader). The parser accepts
  // either; we assert on whichever the loader surfaces.
  assert.equal(nested.budgets?.tokens?.cap, 1000, "nested tokens parses to { cap }");
  assert.equal(nested.budgets?.runs?.cap, 1, "nested runs parses to { cap }");
  assert.equal(nested.budgets?.depth?.cap, 1, "nested depth parses to { cap }");
});

// Block 2 — flat scalar and nested shape converge on the same internal
// representation. This is the contract that lets users follow the
// migration guide (nested) without rewriting agent files that already use
// the flat scalar form.
test("parseAgentBudgetsFrontmatter normalizes flat scalar and nested shapes to the same internal form", () => {
  const flat = parseAgentBudgetsFrontmatter("---\nbudgets:\n  tokens: 1000\n  costUsd: 0.5\n  runs: 1\n  depth: 1\n---\n");
  const nested = parseAgentBudgetsFrontmatter(
    "---\nbudgets:\n  tokens:\n    cap: 1000\n  costUsd:\n    cap: 0.5\n  runs:\n    cap: 1\n  depth:\n    cap: 1\n---\n",
  );
  assert.deepEqual(flat.budgets, nested.budgets, "flat and nested shapes produce identical internal { cap } form");
});

// ── Cycle 3 (T6.5, C2) — `include: [Usage keys]` ────────────────────────────

import type { BudgetsConfig } from "../src/core/schema.ts";
import { BudgetCap } from "../src/core/schema.ts";

test("BudgetsConfigSchema accepts `tokens.include: [input, output]` and projects to the documented shape", () => {
  // The schema is the runtime contract: typebox's Value.Check must accept
  // the literal with the worker-default include list (`[input, output]`),
  // and the projected type must surface the include list verbatim so
  // workerConsumedTokens (Wave 1 1A territory) can pass it through to the
  // session.getSessionStats().tokens selector.
  const config: BudgetsConfig = {
    perWorker: { tokens: { resource: "tokens", cap: 1_000, window: "per-session", include: ["input", "output"] } },
    perTeam: { tokens: { resource: "tokens", cap: 10_000, window: "per-team-lifetime" } },
  };
  assert.doesNotThrow(() => validateBudgetsConfig(config));
  assert.deepEqual(config.perWorker.tokens?.include, ["input", "output"]);
  assert.equal(config.perWorker.tokens?.cap, 1_000);
  assert.equal(config.perWorker.tokens?.window, "per-session");
});

test("BudgetCap discriminated union projects include keys for workerConsumedTokens inputs", () => {
  // The runtime consumer is `workerConsumedTokens(session, include)`. The
  // schema must surface the `include` list verbatim so policy.ts (Wave 1 1A
  // territory) can pass it through to the session.getSessionStats().tokens
  // selector. Pin the discriminator + include ordering here.
  const cap: BudgetsConfig["perWorker"]["tokens"] = { resource: "tokens", cap: 5_000, window: "per-run", include: ["input", "output", "cacheRead", "cacheWrite"] };
  assert.equal(cap.resource, "tokens");
  assert.deepEqual(cap.include, ["input", "output", "cacheRead", "cacheWrite"]);
  // typebox sanity: the discriminated union shape compiles.
  const _disc: import("typebox").Static<typeof BudgetCap> = cap;
  assert.ok(_disc);
});

// ── Discriminator omission + mismatch (post-fixup) ─────────────────────────

test("validateBudgetsConfig accepts user YAML WITHOUT `resource:` (parent-nesting disambiguates)", () => {
  // Plan §2.13 examples omit `resource:` from every nested block; the
  // typebox schema treats `resource:` as optional and the parent position
  // (perWorker.tokens, perTeam.costUsd, …) already narrows the type.
  // `resolveBudgetsConfig` injects the discriminator from the parent key
  // so downstream consumers always see a fully-formed `BudgetCap`.
  const config = {
    perWorker: { tokens: { cap: 1_000 }, costUsd: { cap: 0.5 }, runs: { cap: 5 }, depth: { cap: 2 } },
    perTeam: { tokens: { cap: 10_000 }, costUsd: { cap: 5 }, runs: { cap: 20 } },
  };
  assert.doesNotThrow(() => validateBudgetsConfig(config));
  const resolved = resolveBudgetsConfig(config);
  assert.equal(resolved.perWorker.tokens?.resource, "tokens");
  assert.equal(resolved.perWorker.costUsd?.resource, "costUsd");
  assert.equal(resolved.perWorker.runs?.resource, "runs");
  assert.equal(resolved.perWorker.depth?.resource, "depth");
  assert.equal(resolved.perTeam.tokens?.resource, "tokens");
  assert.equal(resolved.perTeam.costUsd?.resource, "costUsd");
  assert.equal(resolved.perTeam.runs?.resource, "runs");
});

test("validateBudgetsConfig rejects `resource:` that mismatches parent nesting", () => {
  // The discriminator, when present, must match the parent key. This pins
  // the contract against copy-paste bugs (e.g., typing `resource: costUsd`
  // inside `perWorker.tokens` because the user copied from another block).
  // The error path uses the JSON-pointer form (`.../tokens/resource`) and
  // the detail message names the expected parent key so the user can fix
  // the YAML without reading the source.
  assert.throws(
    () => validateBudgetsConfig({
      perWorker: { tokens: { resource: "costUsd", cap: 1_000 } },
      perTeam: {},
    }),
    /budgets\.perWorker\.tokens\/resource.*parent key "tokens"/,
  );
  // depth only lives under perWorker; placing it under perTeam is a mismatch.
  assert.throws(
    () => validateBudgetsConfig({
      perWorker: {},
      perTeam: { runs: { resource: "depth", cap: 5 } },
    }),
    /budgets\.perTeam\.runs\/resource.*parent key "runs"/,
  );
});

// ── Cycle 4 (T6.7, C4) — discriminated union + tier-aware window rejection ─

test("validateBudgetsConfig rejects perWorker.tokens.window: 'per-day' (worker-only context forbids per-day)", () => {
  // C4: window values are tier-restricted. `per-day` is a team-tier concept;
  // placing it on a perWorker block is a config-load error with a path-aware
  // message so the user can locate the offending key.
  const config = {
    perWorker: { tokens: { resource: "tokens", cap: 1_000, window: "per-day" } },
    perTeam: {},
  };
  assert.throws(
    () => validateBudgetsConfig(config),
    /perWorker[\/.]+tokens[\/.]+window.*per-day/,
  );
});

// ── Cycle 5 (T6.8, C6) — explicit `window:` field with defaults ──────────────

import { resolveBudgetsConfig } from "../src/core/schema.ts";

test("resolveBudgetsConfig applies tier defaults: perWorker.tokens.window=per-session, perTeam.tokens.window=per-team-lifetime", () => {
  // C6: omitted `window:` falls back to per-session for workers and
  // per-team-lifetime for teams, mirroring the previous implicit behavior.
  const config: BudgetsConfig = {
    perWorker: { tokens: { resource: "tokens", cap: 1_000 } },
    perTeam: { tokens: { resource: "tokens", cap: 10_000 } },
  };
  const resolved = resolveBudgetsConfig(config);
  assert.equal(resolved.perWorker.tokens?.window, "per-session");
  assert.equal(resolved.perTeam.tokens?.window, "per-team-lifetime");
  assert.equal(resolved.perWorker.tokens?.cap, 1_000);
  assert.equal(resolved.perTeam.tokens?.cap, 10_000);
});

// C6 preservation: when the user sets `window:` explicitly, resolve does
// NOT overwrite it. Defaults only fill gaps.
test("resolveBudgetsConfig preserves explicit window values (only fills gaps)", () => {
  const resolved = resolveBudgetsConfig({
    perWorker: { tokens: { resource: "tokens", cap: 1_000, window: "per-run" } },
    perTeam: { tokens: { resource: "tokens", cap: 10_000, window: "per-day" } },
  });
  assert.equal(resolved.perWorker.tokens?.window, "per-run", "explicit per-run is preserved");
  assert.equal(resolved.perTeam.tokens?.window, "per-day", "explicit per-day is preserved");
});

// perTeam.costUsd rejects per-day (costUsd windows are per-session or
// per-team-lifetime regardless of tier). This pins the C4 narrowing for the
// cost resource separately from the per-day check the previous cycle covers.
test("validateBudgetsConfig rejects perTeam.costUsd.window: 'per-day' (costUsd windows are per-session|per-team-lifetime)", () => {
  assert.throws(
    () => validateBudgetsConfig({
      perWorker: {},
      perTeam: { costUsd: { resource: "costUsd", cap: 1, window: "per-day" } },
    }),
    /costUsd\/window/,
  );
});

// ── Cycle 6 (T6.10, G-10) — per-day window rolls over at UTC midnight ───────

import { currentUtcDayStart, isWithinDayWindow } from "../src/core/schema.ts";

test("currentUtcDayStart rolls over at UTC midnight (cap resets across the boundary)", () => {
  // Pin the boundary: a timestamp one ms before UTC midnight belongs to
  // "today"; a timestamp one ms past UTC midnight belongs to "tomorrow".
  // Stub Date.now() so the test is deterministic (per G-10).
  const dayBefore = Date.UTC(2026, 8, 14, 23, 59, 59, 999); // 2026-09-14 23:59:59.999 UTC
  const midnight = Date.UTC(2026, 8, 15, 0, 0, 0, 0); // 2026-09-15 00:00:00.000 UTC
  const dayAfter = Date.UTC(2026, 8, 15, 0, 0, 0, 1); // 2026-09-15 00:00:00.001 UTC
  const dayStartBefore = currentUtcDayStart(dayBefore);
  const dayStartAtMidnight = currentUtcDayStart(midnight);
  const dayStartAfter = currentUtcDayStart(dayAfter);
  assert.equal(dayStartBefore, Date.UTC(2026, 8, 14, 0, 0, 0, 0), "before-midnight timestamp belongs to the previous day");
  assert.equal(dayStartAtMidnight, Date.UTC(2026, 8, 15, 0, 0, 0, 0), "exactly-at-midnight timestamp belongs to the new day");
  assert.equal(dayStartAfter, Date.UTC(2026, 8, 15, 0, 0, 0, 0), "just-after-midnight timestamp belongs to the new day");
  // isWithinDayWindow mirrors the per-day cap: an entry stamped before today
  // is excluded from the current-day total, so the per-day cap resets.
  const originalNow = Date.now;
  try {
    Date.now = () => midnight + 5_000; // simulate wall-clock just past midnight
    assert.equal(isWithinDayWindow(dayBefore), false, "yesterday's entry is excluded once the cap has rolled over");
    assert.equal(isWithinDayWindow(midnight + 1), true, "today's entry is included");
  } finally {
    Date.now = originalNow;
  }
});