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