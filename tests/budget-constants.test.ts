/**
 * Wave 5 — Coverage 3 (Gap #8): constant tests.
 *
 * `WARNING_REMAINING_RATIO` and `EXHAUSTED_REMAINING_RATIO` are exported
 * from `src/engine/budget/events.ts` and are part of the public surface —
 * the T3.2 / T3.3 contracts rely on them. The 0.20 warning threshold is a
 * plan-level constant (refactor-plan §3.3) that downstream consumers
 * (dashboard, telemetry, tests) pin against these named exports rather
 * than re-declaring 0.20 inline.
 *
 * `BUDGET_WARNING_CUSTOM_TYPE` and `BUDGET_EXHAUSTED_CUSTOM_TYPE` are the
 * `customType` discriminators the worker-visible
 * `appendCustomMessageEntry` writes carry. They are also pinned by the
 * dashboard timeline and the worker-context rendering — a typo would
 * silently drop every warning/exhausted hint from the worker's context.
 *
 * Four tests pin the constants as the public contract. If any of them
 * changes, downstream consumers (dashboard, tests, real worker integrations)
 * will need to be re-checked.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUDGET_EXHAUSTED_CUSTOM_TYPE,
  BUDGET_WARNING_CUSTOM_TYPE,
  EXHAUSTED_REMAINING_RATIO,
  WARNING_REMAINING_RATIO,
} from "../src/engine/budget/events.ts";

// ── Gap #8 — Constants tests ────────────────────────────────

test("WARNING_REMAINING_RATIO: pinned to 0.20 (T3.2 warning fires at ≤20% remaining)", () => {
  assert.equal(WARNING_REMAINING_RATIO, 0.20, "warning threshold is the plan §3.3 contract");
  // Sanity: a finite, positive number in (0, 1) so callers can do
  // `consumed >= cap * (1 - ratio)` comparisons without divide-by-zero.
  assert.ok(Number.isFinite(WARNING_REMAINING_RATIO), "constant is a finite number");
  assert.ok(WARNING_REMAINING_RATIO > 0 && WARNING_REMAINING_RATIO < 1, "warning threshold is strictly inside (0, 1)");
});

test("EXHAUSTED_REMAINING_RATIO: pinned to 0 (T3.3 exhaustion fires at 0% remaining)", () => {
  assert.equal(EXHAUSTED_REMAINING_RATIO, 0, "exhaustion threshold is the plan §3.3 contract");
  // Sanity: a finite number (0 itself) so callers can do the strict
  // greater-than comparison that separates "exhausted" from "warning".
  assert.ok(Number.isFinite(EXHAUSTED_REMAINING_RATIO), "constant is a finite number");
  // Sanity: warning must be strictly above exhausted so the two
  // thresholds don't collapse into one — the warning-vs-exhaustion
  // ordering test depends on the strict inequality.
  assert.ok(
    WARNING_REMAINING_RATIO > EXHAUSTED_REMAINING_RATIO,
    "warning threshold is strictly above exhaustion threshold",
  );
});

test("BUDGET_WARNING_CUSTOM_TYPE: pinned to the 'budget_warning' customType discriminator", () => {
  assert.equal(BUDGET_WARNING_CUSTOM_TYPE, "budget_warning");
  // Sanity: a non-empty string with no whitespace so the customType
  // round-trips cleanly through SessionEntry serialization (the SDK does
  // not normalize whitespace in customType).
  assert.equal(typeof BUDGET_WARNING_CUSTOM_TYPE, "string");
  assert.ok(BUDGET_WARNING_CUSTOM_TYPE.length > 0);
  assert.ok(!/\s/.test(BUDGET_WARNING_CUSTOM_TYPE), "customType contains no whitespace");
  // Sanity: distinct from the exhaustion customType so the dashboard
  // timeline and worker context can tell them apart.
  assert.notEqual(
    BUDGET_WARNING_CUSTOM_TYPE,
    BUDGET_EXHAUSTED_CUSTOM_TYPE,
    "warning and exhaustion customTypes are distinct strings",
  );
});

test("BUDGET_EXHAUSTED_CUSTOM_TYPE: pinned to the 'budget_exhausted' customType discriminator", () => {
  assert.equal(BUDGET_EXHAUSTED_CUSTOM_TYPE, "budget_exhausted");
  assert.equal(typeof BUDGET_EXHAUSTED_CUSTOM_TYPE, "string");
  assert.ok(BUDGET_EXHAUSTED_CUSTOM_TYPE.length > 0);
  assert.ok(!/\s/.test(BUDGET_EXHAUSTED_CUSTOM_TYPE), "customType contains no whitespace");
});
