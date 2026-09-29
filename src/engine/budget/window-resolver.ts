/**
 * Wave 2 — F2 window spec resolver.
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md §2.13 C6
 *
 * Reconciles the Wave 0 contract (flat `BudgetWindow` string at the resolved-
 * policy layer, see `src/engine/budget/types.ts`) with the Wave 1B schema
 * (object form `BudgetWindowSpec`, see `src/core/types.ts`).
 *
 * Background — the contract drift
 * -------------------------------
 * Wave 0 declared:
 *
 *     export type BudgetWindow =
 *       | "per-session" | "per-run" | "per-day" | "per-team-lifetime" | "per-hour";
 *
 * Wave 1B declared (in `src/core/types.ts`):
 *
 *     export type WindowKind = "rolling" | "per-day" | "all-time";
 *     export interface BudgetWindowSpec { kind: WindowKind; duration?: number; }
 *
 * The F1 runtime primitives (`BudgetLedger`, `checkBudgetPolicy`,
 * `installBudgetEventHooks`, `createBudgetAwareSession`) were authored against the flat
 * string surface in `src/engine/budget/types.ts` and the F6 schema validator
 * produces the object surface. A resolver sits between the schema layer and
 * the runtime layer so neither has to widen to accept the other.
 *
 * Recommended approach (per the F2 captain's directive): keep the flat string
 * as the canonical runtime surface, flatten the object form to it on read.
 * `resolveWindow` is the single point of flattening; every consumer in F1/F2
 * calls it instead of duplicating the mapping.
 *
 * Mapping rules (deterministic, no clock reads, no I/O)
 * -----------------------------------------------------
 *  - `undefined`              → `undefined` (no window = unlimited)
 *  - `{ kind: "all-time" }`   → `"per-team-lifetime"` (the v1 unbounded alias)
 *  - `{ kind: "per-day" }`    → `"per-day"`
 *  - `{ kind: "rolling", duration <= 1h }`            → `"per-hour"`
 *  - `{ kind: "rolling", duration > 1h, <= 24h }`     → `"per-day"`
 *  - `{ kind: "rolling", duration > 24h }`            → `"per-session"` (best fallback)
 *
 * Duration bounds are wall-clock-neutral (`duration` is in ms; the validation
 * layer caps it at 365 days — see `validateBudgetWindowSpec` in
 * `src/core/schema.ts`).
 *
 * The resolver is a pure function: no I/O, no clock reads, no SDK state.
 * Same input → same output across processes; trivially unit-testable.
 */

import type { BudgetWindowSpec } from "../../core/types";
import type { BudgetWindow } from "./types";

/** Duration thresholds used by `resolveWindow` to bucket a rolling window. */
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Flatten a `BudgetWindowSpec` to a `BudgetWindow` string.
 *
 * Returns `undefined` when `spec` is `undefined` — the absence of a window
 * is meaningful at the policy layer (no time-bound means "unlimited") and
 * must propagate as `undefined` rather than coerce to a sentinel like
 * `"per-team-lifetime"`.
 *
 * @param spec Object-form window spec from the F6 schema layer, or undefined.
 * @returns     Flat-string window consumed by the F1 runtime layer.
 */
export function resolveWindow(spec: BudgetWindowSpec | undefined): BudgetWindow | undefined {
  if (spec === undefined) return undefined;
  switch (spec.kind) {
    case "all-time":
      // Wave 0's only unbounded string is `per-team-lifetime` — that's the
      // closest match for the new "all-time" spec. (Both mean "unbounded".)
      return "per-team-lifetime";
    case "per-day":
      return "per-day";
    case "rolling":
      if (typeof spec.duration === "number" && Number.isFinite(spec.duration) && spec.duration > 0) {
        if (spec.duration <= HOUR_MS) return "per-hour";
        if (spec.duration <= DAY_MS) return "per-day";
        return "per-session";
      }
      // Schema validator REQUIRES a duration on `rolling`, so this branch is
      // unreachable for validated configs. Kept as a defensive fallback that
      // returns the safest string (per-session) rather than `undefined` —
      // a missing window would silently disable cap enforcement.
      return "per-session";
  }
}

/**
 * Re-export `BudgetWindow` so consumers that only need the resolver don't
 * have to import the type from `./types` separately.
 */
export type { BudgetWindow };
