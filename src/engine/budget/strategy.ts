// Wave 0 contract stub — Slice 3: WorkerBudgetStrategy + resolver
//
// The strategy resolver maps an agent's identity to one of two strategies
// ("default" | "compact"). It is the runtime expression of the agent's
// declared `budget-strategy:` setting (or the project-wide default). The
// resolved policy is the §2.10 nested-shape WorkerBudgetPolicy that the
// dispatcher and BudgetLedger consume.

import type { BudgetsConfig, HiveConfig, WorkerBudgetPolicy, WorkerBudgetStrategy } from "../../core/types";

// Resolve an agent's budget strategy from its config + the project defaults.
// Pure function over config — no I/O, no SDK. The (config, agentName) signature
// is the contract Wave 1 must preserve.
export function resolveWorkerBudgetStrategy(_config: HiveConfig, _agentName: string): WorkerBudgetStrategy {
  throw new Error("not implemented");
}

// Resolve an agent's full budget policy by composing: project budgets default →
// team overrides → per-agent overrides. Pure function over config.
export function resolveWorkerBudgetPolicy(_config: HiveConfig, _agentName: string): WorkerBudgetPolicy {
  throw new Error("not implemented");
}

// Reference unused-import warning suppression — BudgetsConfig is the slice 7
// config shape that the resolver consumes. The forward-reference lets the
// stub typecheck now and link cleanly when slice 7 lands.
export type _BudgetsConfigRef = BudgetsConfig;
