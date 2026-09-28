/**
 * Wave 1 — T1.4 WorkerBudgetStrategy resolver tests.
 *
 * C5 is a placeholder per plan §2.13: the resolver always returns undefined,
 * and the cooperative convenience helpers always return false. These four
 * tests pin that contract so future waves can land the structured strategy
 * config without breaking the existing cooperative tools (`summarize_progress`
 * falls back to default `compact` behavior when no strategy is configured).
 *
 * Tests:
 *   1. resolveWorkerBudgetStrategy returns undefined for a normal HiveState
 *   2. resolveWorkerBudgetStrategy returns undefined even when state.config is null
 *   3. strategyRequestsWrapUp returns false for undefined / any strategy
 *   4. strategyRequestsCompactOnExhaustion returns false for undefined / any strategy
 *   5. (compliance) No imports from `src/engine/dispatch.ts` or `src/engine/governance.ts`
 *
 * The compliance check is enforced via a static assertion in a test — kept as
 * a regression guard so a future wave cannot accidentally couple F1 primitives
 * back to the legacy dispatch / governance modules.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { HiveState } from "../src/core/types.ts";
import {
  resolveWorkerBudgetStrategy,
  strategyRequestsCompactOnExhaustion,
  strategyRequestsWrapUp,
} from "../src/engine/budget/strategy.ts";

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

// ── Case 1: resolver returns undefined for a normal HiveState ──────────

test("resolveWorkerBudgetStrategy: returns undefined (C5 placeholder behavior)", () => {
  const state = makeHiveState();
  assert.equal(resolveWorkerBudgetStrategy(state, "any-agent"), undefined);
  // Agent name is ignored in the placeholder — verify a different name still resolves.
  assert.equal(resolveWorkerBudgetStrategy(state, "another-agent"), undefined);
});

// ── Case 2: resolver returns undefined with no config ──────────────────

test("resolveWorkerBudgetStrategy: returns undefined when state.config is null (no resolved strategy possible)", () => {
  const state = makeHiveState();
  state.config = null;
  assert.equal(resolveWorkerBudgetStrategy(state, "worker"), undefined);
});

// ── Case 3: strategyRequestsWrapUp is false ─────────────────────────────

test("strategyRequestsWrapUp: returns false for undefined strategy (no wrap-up hint emitted)", () => {
  assert.equal(strategyRequestsWrapUp(undefined), false);
  // Defensive: even if a strategy value ever leaks through, the placeholder
  // must still return false so the warning handler doesn't change behavior.
  assert.equal(strategyRequestsWrapUp({} as unknown as undefined), false);
});

// ── Case 4: strategyRequestsCompactOnExhaustion is false ────────────────

test("strategyRequestsCompactOnExhaustion: returns false for undefined strategy (no auto-compact at exhaustion)", () => {
  assert.equal(strategyRequestsCompactOnExhaustion(undefined), false);
  assert.equal(strategyRequestsCompactOnExhaustion({} as unknown as undefined), false);
});

// ── Case 5: F1 does NOT import from legacy dispatch/governance modules ──

test("compliance: src/engine/budget/strategy.ts does not import from src/engine/dispatch.ts or src/engine/governance.ts", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const strategySrc = readFileSync(join(here, "..", "src", "engine", "budget", "strategy.ts"), "utf8");
  // Strip line comments before scanning (the AGENTS.md reference link is allowed).
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
