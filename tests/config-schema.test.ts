// Wave 1 — F6 config schema migration tests
//
// These tests pin the new nested-budget config shape (T6.1 / C1 / C2 / C4 / C6)
// that Wave 0 added as typebox stubs (BudgetCap, BudgetsConfigSchema). Each
// test exercises ONE behavior at a public seam so the schema evolves without
// the test becoming coupled to internals.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateBudgetsConfig,
} from "../src/core/schema.ts";
import { parseYamlLite } from "../src/core/yaml.ts";

// ── Cycle 1 (T6.1) — Nested config schema parses + rejects malformed ────────

// Convention: feed validators parsed YAML, not object literals, so the parser
// path stays covered. This test exercises the YAML → kebab→camel → schema
// chain end-to-end (the object-literal version of the same assertion is
// below).
test("validateBudgetsConfig accepts the canonical nested config (parsed from YAML)", () => {
  const yaml = `
defaults-enabled: true
per-worker:
  tokens:
    resource: tokens
    cap: 1000
    window: per-session
    include:
      - input
      - output
  cost-usd:
    resource: costUsd
    cap: 0.5
    window: per-session
  runs:
    resource: runs
    cap: 5
  depth:
    resource: depth
    cap: 2
per-team:
  tokens:
    resource: tokens
    cap: 10000
    window: per-team-lifetime
    include:
      - input
      - output
      - cacheRead
      - cacheWrite
  cost-usd:
    resource: costUsd
    cap: 5
    window: per-team-lifetime
  runs:
    resource: runs
    cap: 20
strategies:
  on-approaching-limit:
    action: wrap-up
    threshold: 0.2
    hint: wrap up
  on-exhaustion:
    action: abort
  summary:
    max-tokens: 2000
`;
  const config = parseYamlLite(yaml);
  assert.doesNotThrow(() => validateBudgetsConfig(config));
});

// Object-literal variant for fast iteration on shape changes. Kept beside
// the YAML-parsed variant above so a regression in the parser path is
// isolated to the test above.
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

// Convention: feed validators parsed YAML, not object literals, so the parser
// path stays covered. The negative-cap / unknown-resource / wrong-window
// cases below exercise the same error paths an object literal would, but
// they reach the validator through parseYamlLite first — so a parser bug
// (e.g. swallowed type coercion) is caught alongside the schema bug.
test("validateBudgetsConfig rejects malformed nested configs (parsed from YAML)", () => {
  // Negative cap (typebox minimum: 0).
  assert.throws(
    () => validateBudgetsConfig(parseYamlLite("per-worker:\n  tokens:\n    resource: tokens\n    cap: -1\n")),
    /tokens\/cap/,
  );
  // Unknown resource discriminator.
  assert.throws(
    () => validateBudgetsConfig(parseYamlLite("per-worker:\n  tokens:\n    resource: wat\n    cap: 1\n")),
    /resource/,
  );
  // Window outside the resource's allowed set — costUsd.window does not accept "per-day".
  assert.throws(
    () => validateBudgetsConfig(parseYamlLite("per-worker:\n  cost-usd:\n    resource: costUsd\n    cap: 1\n    window: per-day\n")),
    /window/,
  );
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
  // costUsd now pinned here so a future regression in kebab→camel is caught.
  assert.equal(nested.budgets?.tokens?.cap, 1000, "nested tokens parses to { cap }");
  assert.equal(nested.budgets?.costUsd?.cap, 0.25, "nested cost-usd kebab key normalizes to { cap }");
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
  assert.deepEqual(config.perWorker?.tokens?.include, ["input", "output"]);
  assert.equal(config.perWorker?.tokens?.cap, 1_000);
  assert.equal(config.perWorker?.tokens?.window, "per-session");
});

test("BudgetCap discriminated union projects include keys for workerConsumedTokens inputs", () => {
  // The runtime consumer is `workerConsumedTokens(session, include)`. The
  // schema must surface the `include` list verbatim so policy.ts (Wave 1 1A
  // territory) can pass it through to the session.getSessionStats().tokens
  // selector. Pin the discriminator + include ordering here.
  const cap: NonNullable<BudgetsConfig["perWorker"]>["tokens"] = { resource: "tokens", cap: 5_000, window: "per-run", include: ["input", "output", "cacheRead", "cacheWrite"] };
  assert.equal(cap.resource, "tokens");
  assert.deepEqual(cap.include, ["input", "output", "cacheRead", "cacheWrite"]);
  // typebox sanity: the discriminated union shape compiles.
  const _disc: import("typebox").Static<typeof BudgetCap> = cap;
  assert.ok(_disc);
});

// ── Discriminator omission + mismatch (post-fixup) ─────────────────────────

test("validateBudgetsConfig accepts user YAML WITHOUT `resource:` (parent-nesting disambiguates)", () => {
  // Plan §2.13 examples omit `resource:` from every nested block; the
  // parent position (perWorker.tokens, perTeam.costUsd, …) already narrows
  // the type. `validateBudgetsConfig` injects the discriminator from the
  // parent key BEFORE typebox runs (Block 4), and `resolveBudgetsConfig`
  // is the pure projection that downstream consumers use. The cast here
  // is intentional — we're asserting that the validator accepts the
  // loose user-authored shape, not that the type system matches it.
  const config = {
    perWorker: { tokens: { cap: 1_000 }, costUsd: { cap: 0.5 }, runs: { cap: 5 }, depth: { cap: 2 } },
    perTeam: { tokens: { cap: 10_000 }, costUsd: { cap: 5 }, runs: { cap: 20 } },
  } as Record<string, unknown>;
  assert.doesNotThrow(() => validateBudgetsConfig(config));
  const resolved = resolveBudgetsConfig(config as Parameters<typeof resolveBudgetsConfig>[0]);
  assert.equal(resolved.perWorker?.tokens?.resource, "tokens");
  assert.equal(resolved.perWorker?.costUsd?.resource, "costUsd");
  assert.equal(resolved.perWorker?.runs?.resource, "runs");
  assert.equal(resolved.perWorker?.depth?.resource, "depth");
  assert.equal(resolved.perTeam?.tokens?.resource, "tokens");
  assert.equal(resolved.perTeam?.costUsd?.resource, "costUsd");
  assert.equal(resolved.perTeam?.runs?.resource, "runs");
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

// Block 4 follow-up: with `resource:` required on every schema variant,
// the discriminated union is real and the post-validator `cap.resource`
// field narrows in `switch (cap.resource)` for downstream consumers.
// This is the contract that closes the TS B1 latent-bug future bug.
test("Block 4: validated BudgetsConfig lands with `resource:` set on every cap (discriminated union is real)", () => {
  const config = {
    perWorker: { tokens: { cap: 1_000 }, costUsd: { cap: 0.5 }, runs: { cap: 5 }, depth: { cap: 2 } },
    perTeam: { tokens: { cap: 10_000 }, costUsd: { cap: 5 }, runs: { cap: 20 } },
  } as Record<string, unknown>;
  // Post-commit-4 (refactor: make validateBudgetsConfig pure) the input is
  // no longer mutated — `validateBudgetsConfig` returns the
  // discriminated-union-narrowed shape and the caller uses the return
  // value. The input stays in its pre-shape so frozen / shared literals
  // remain intact.
  const validated = validateBudgetsConfig(config);
  // After validation (which injects the discriminator), every cap carries
  // the literal `resource:` tag. A downstream `switch (cap.resource)` is
  // now exhaustive without a fallback — which is exactly the contract the
  // post-fixup comment at schema.ts:341 originally claimed.
  const cw = validated as { perWorker: { tokens: { resource: string }; costUsd: { resource: string }; runs: { resource: string }; depth: { resource: string } } };
  assert.equal(cw.perWorker.tokens.resource, "tokens");
  assert.equal(cw.perWorker.costUsd.resource, "costUsd");
  assert.equal(cw.perWorker.runs.resource, "runs");
  assert.equal(cw.perWorker.depth.resource, "depth");
  // The input object is untouched — callers can pass a shared literal
  // without the validator erasing data on the next read.
  assert.equal((config.perWorker as { tokens: { resource?: string } }).tokens.resource, undefined, "input `resource:` was not injected into the caller's object");
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
    /perWorker[/.]+tokens[/.]+window.*per-day/,
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
  assert.equal(resolved.perWorker?.tokens?.window, "per-session");
  assert.equal(resolved.perTeam?.tokens?.window, "per-team-lifetime");
  assert.equal(resolved.perWorker?.tokens?.cap, 1_000);
  assert.equal(resolved.perTeam?.tokens?.cap, 10_000);
});

// C6 preservation: when the user sets `window:` explicitly, resolve does
// NOT overwrite it. Defaults only fill gaps.
test("resolveBudgetsConfig preserves explicit window values (only fills gaps)", () => {
  const resolved = resolveBudgetsConfig({
    perWorker: { tokens: { resource: "tokens", cap: 1_000, window: "per-run" } },
    perTeam: { tokens: { resource: "tokens", cap: 10_000, window: "per-day" } },
  });
  assert.equal(resolved.perWorker?.tokens?.window, "per-run", "explicit per-run is preserved");
  assert.equal(resolved.perTeam?.tokens?.window, "per-day", "explicit per-day is preserved");
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

// Wave context-constraint (T9) — the migration guide's Example 9 (add a
// `context` cap) is the documented user-facing surface. This test pins
// that the nominal and percentage flavors parse through the typebox
// schema and round-trip through the validateBudgetsConfig seam, AND
// that the "both" and "neither" mistakes are caught with the documented
// error messages.

test("migration guide Example 9a: context.tokens parses and validates", () => {
  const cfg = {
    perWorker: { context: { tokens: 100_000 } },
    perTeam: {},
  };
  assert.doesNotThrow(() => validateBudgetsConfig(cfg), "nominal context cap (100K) validates cleanly");
});

test("migration guide Example 9b: context.percent parses and validates", () => {
  const cfg = {
    perWorker: { context: { percent: 80 } },
    perTeam: {},
  };
  assert.doesNotThrow(() => validateBudgetsConfig(cfg), "percentage context cap (80%) validates cleanly");
});

test("migration guide Example 9: rejecting both tokens AND percent on the same constraint", () => {
  // The "exactly one" rule is enforced by enforceContextConstraint
  // post-typebox. The error message must name the path so the user
  // can find the offending key quickly.
  const cfg = {
    perWorker: { context: { tokens: 100_000, percent: 80 } },
    perTeam: {},
  };
  assert.throws(() => validateBudgetsConfig(cfg), /perWorker\.context.*set either.*but not both/, "both tokens+percent is rejected with a path-bearing error");
});

test("migration guide Example 9: rejecting neither tokens nor percent on the same constraint", () => {
  // The "exactly one" rule also rejects an empty constraint object —
  // configuring a `context:` block without one of tokens/percent is a
  // user mistake (silent unlimited would be worse than a hard fail).
  const cfg = {
    perWorker: { context: {} },
    perTeam: {},
  };
  assert.throws(() => validateBudgetsConfig(cfg), /perWorker\.context.*must set either/, "empty context is rejected with a path-bearing error");
});

// ── Optional tiers (Txx) ─────────────────────────────────────────────────────
//
// Both `perWorker` and `perTeam` are OPTIONAL in `BudgetsConfigSchema`. Real
// configs commonly declare only one tier (a worker-only project, or a planner
// that only needs team-tier caps). The pre-fixup schema required both as
// objects, which surfaced at config-load as `budgets.perTeam: must be object`
// for any user who omitted the empty second tier. These tests pin that the
// one-tier and zero-tier shapes now validate cleanly.

test("validateBudgetsConfig accepts the user's own one-tier YAML (per-worker only, no per-team)", () => {
  // The user's own config from earlier in this session. Block-style YAML
  // is intentional — the YAML flow-style fix is in a separate worktree.
  // Parsed through parseYamlLite to exercise the full parser + kebab→
  // camel + schema chain (matches the convention used for the canonical
  // config above), then passed to validateBudgetsConfig via the
  // settings.budgets path the loader actually takes (canonical budget
  // loading accepts both top-level and settings.budgets; this is the
  // legacy position the loader still supports).
  const yaml = `
settings:
  subagent-output-limit: 12000
  default-tools: read, grep, find, ls
  budgets:
    defaults-enabled: true
    per-worker:
      runs:    { cap: 100 }
      depth:   { cap: 4 }
      context:
        percent: 35
    strategies:
      on-token-exhaustion:   { action: abort }
      on-context-exhaustion: { action: compact }
      summary:
        max-tokens: 5000
`;
  const parsed = parseYamlLite(yaml);
  const budgets = parsed.settings.budgets;
  assert.doesNotThrow(() => validateBudgetsConfig(budgets), "one-tier (per-worker only) YAML validates cleanly");
});

test("validateBudgetsConfig accepts per-team only (no per-worker)", () => {
  // The mirror case: a planner-only project that declares team-tier caps
  // but no per-worker caps (e.g., delegations don't need individual worker
  // budgets, only the team aggregate). Mirrors the user config above.
  const yaml = `
budgets:
  defaults-enabled: true
  per-team:
    tokens:
      resource: tokens
      cap: 100000
      window: per-team-lifetime
    runs:
      resource: runs
      cap: 200
`;
  const parsed = parseYamlLite(yaml);
  const budgets = parsed.budgets;
  assert.doesNotThrow(() => validateBudgetsConfig(budgets), "one-tier (per-team only) YAML validates cleanly");
});

test("validateBudgetsConfig accepts an empty budgets block (no per-worker, no per-team)", () => {
  // The minimal valid budgets config — just the defaults-enabled flag and
  // nothing else. Pre-fixup this failed because both tier objects were
  // required; post-fixup both are optional. Useful for projects that opt
  // in to the budgets feature but don't yet have caps to declare.
  const cfg = { defaultsEnabled: true };
  assert.doesNotThrow(() => validateBudgetsConfig(cfg), "empty budgets block (just defaults-enabled) validates cleanly");
});

test("validateBudgetsConfig rejects an explicitly-null tier (object expected when present)", () => {
  // Optional means "absent" not "present-and-null". A user who sets
  // `per-worker: null` is making a config mistake (likely a typo for an
  // empty object) and should still get a path-bearing error.
  const cfg = { perWorker: null };
  assert.throws(() => validateBudgetsConfig(cfg), /perWorker/, "explicit null on a tier is rejected, not silently accepted");
});
