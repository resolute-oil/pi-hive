/**
 * Wave 0 contract stubs — type definitions only. No behavior.
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md
 *   §2.3 BudgetLedgerEntry shape
 *   §2.5 BudgetPolicy functions / BudgetBlock
 *   §2.8 operator commands + cooperative tools
 *   §2.10/§2.13 resolved config shape (C1/C2/C4/C6)
 *   §2.14 appendCustomEntry (not appendUsage)
 *   §2.15 `queue` removed
 *
 * C3 (defaults-enabled): SKIPPED per G-16.
 * C5 (structured strategies): PLACEHOLDER ONLY per plan §2.13.
 * C1/C2/C4/C6: implemented per plan §2.10/§2.13.
 *
 * YAML keys are kebab-case (user convention); TS identifiers are camelCase/PascalCase.
 * Per G-08, BudgetLedgerEntry.data carries `kind?: string` so future ledger
 * payloads can be discriminated by kind without a schema change.
 */

import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { BudgetLedger } from "./ledger";

// ---------------------------------------------------------------------------
// §2.13 C1 — Per-agent override renamed from `governance:` → `budgets:`
// ---------------------------------------------------------------------------

/** Per-agent override block. Replaces the legacy `governance:` frontmatter key. */
export interface AgentBudgetsOverride {
  tokens?: TokensCap;
  costUsd?: CostUsdCap;
  runs?: RunsCap;
  depth?: DepthCap;
}

// ---------------------------------------------------------------------------
// §2.13 C4 — Discriminated union via the `resource` discriminant.
//   TokensCap / CostUsdCap / RunsCap / DepthCap each carry a literal
//   `resource` so typebox + TS narrowing rejects invalid combinations.
// ---------------------------------------------------------------------------

export type UsageKey = "input" | "output" | "cacheRead" | "cacheWrite" | "reasoning";

/**
 * Flat-string window consumed by the F1 runtime layer (BudgetLedger,
 * checkBudgetPolicy, installBudgetEventHooks, createBudgetAwareSession).
 *
 * Contract-drift reconciliation (Wave 2 / F2):
 *
 *   Wave 0 declared this flat-string shape at the resolved-policy layer.
 *   Wave 1B declared a richer object shape (`BudgetWindowSpec` in
 *   `src/core/types.ts`) so a future `duration?` axis can attach without a
 *   schema break. The two coexist via the resolver at
 *   `src/engine/budget/window-resolver.ts` — `resolveWindow(spec)` flattens
 *   the object form to one of these strings before any runtime primitive
 *   sees it. New consumers SHOULD read the object form and call the
 *   resolver; legacy / F1 callers may keep reading the flat string.
 */
export type BudgetWindow = "per-session" | "per-run" | "per-day" | "per-team-lifetime" | "per-hour";

export interface TokensCap {
  resource: "tokens";
  cap: number;
  /** C6: explicit time-period semantics; defaults to per-session for workers, per-team-lifetime for teams. */
  window?: BudgetWindow;
  /** C2: list of Usage keys to include. Replaces the legacy `scope: input_output | all` enum. */
  include?: UsageKey[];
}

export interface CostUsdCap {
  resource: "costUsd";
  cap: number;
  window?: BudgetWindow;
}

export interface RunsCap {
  resource: "runs";
  cap: number;
  window?: BudgetWindow;
}

export interface DepthCap {
  resource: "depth";
  cap: number;
}

export type BudgetCap = TokensCap | CostUsdCap | RunsCap | DepthCap;

// ---------------------------------------------------------------------------
// §2.13 C5 — Structured strategies (full implementation).
//
// Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md
//   §2.13 C5 (structured strategies) — decouples warning behavior from EOL
//          behavior; extensible without breaking changes.
//
// Resolved shape (always populated; defaults applied when absent in config):
//   onApproachingLimit: { action: "wrap-up" | "compact" | "none", threshold?, hint? }
//   onExhaustion:       { action: "compact" | "abort" | "none", customInstructions? }
//   summary:            { maxTokens? }
//
// Field names mirror kebab-case YAML via auto-camelization
// (`on-approaching-limit` → `onApproachingLimit`).
// ---------------------------------------------------------------------------

export type ApproachingLimitAction = "wrap-up" | "compact" | "none";
export type ExhaustionAction = "compact" | "abort" | "none";

/** Resolved approaching-limit block. */
export interface ResolvedApproachingLimitStrategy {
  action: ApproachingLimitAction;
  /** Fraction in [0.0, 1.0]; default 0.20 (i.e. 20% remaining). */
  threshold: number;
  /** Optional prompt hint surfaced to the worker when the threshold is crossed. */
  hint?: string;
}

/** Resolved exhaustion block. */
export interface ResolvedExhaustionStrategy {
  action: ExhaustionAction;
  /** Only honored when `action: compact`; prepended to the /compact prompt. */
  customInstructions?: string;
}

/** Resolved summary block (tuning for the `summarize_progress` tool). */
export interface ResolvedSummaryStrategy {
  /** Per-call cap for `notes:`; default 2000 tokens. */
  maxTokens: number;
}

export interface WorkerBudgetStrategy {
  onApproachingLimit: ResolvedApproachingLimitStrategy;
  onExhaustion: ResolvedExhaustionStrategy;
  summary: ResolvedSummaryStrategy;
}

// ---------------------------------------------------------------------------
// §2.10/§2.13 — Resolved per-worker policy + per-team policy.
//   Field names mirror kebab-case YAML via auto-camelization:
//     `cost-usd` → `costUsd`, `on-approaching-limit` → `onApproachingLimit`, etc.
// ---------------------------------------------------------------------------

export interface ResolvedWorkerBudgets {
  tokens?: TokensCap;
  costUsd?: CostUsdCap;
  runs?: RunsCap;
  depth?: DepthCap;
}

export interface ResolvedTeamBudgets {
  tokens?: TokensCap;
  costUsd?: CostUsdCap;
  runs?: RunsCap;
}

export interface ResolvedBudgetsConfig {
  /** C3: SKIPPED per G-16. `defaultsEnabled` is not exposed in Wave 0. */
  perWorker: ResolvedWorkerBudgets;
  perTeam: ResolvedTeamBudgets;
  /** C5 placeholder. */
  strategies?: WorkerBudgetStrategy;
}

export interface WorkerBudgetPolicy {
  worker: ResolvedWorkerBudgets;
  team: ResolvedTeamBudgets;
  /** Strategy placeholder — only used when cooperative tools fire. */
  strategy?: WorkerBudgetStrategy;
}

// ---------------------------------------------------------------------------
// §2.3 BudgetLedgerEntry — customType discriminator + G-08 `kind?: string`.
// ---------------------------------------------------------------------------

export type BudgetLedgerKind =
  | "end"
  | "compact"
  | "respawn"
  | "pause"
  | "snapshot"
  | "restore"
  | "resume"
  | "compact-aborted"
  | "cooperative-compact"
  | "cooperative-end"
  | "cooperative-snapshot";

export type BudgetLedgerMarker = "warning" | "exhausted" | "checkpoint";

export interface BudgetLedgerCaps {
  workerTokens?: number;
  workerCostUsd?: number;
  workerRuns?: number;
  workerDepth?: number;
  teamTokens?: number;
  teamCostUsd?: number;
  teamRuns?: number;
}

export interface BudgetLedgerCumulative {
  tokens: number;
  costUsd: number;
  runs: number;
}

export interface BudgetLedgerData {
  caps: BudgetLedgerCaps;
  cumulative: BudgetLedgerCumulative;
  writtenAt: number;
  agentSlug: string;
  marker?: BudgetLedgerMarker;
  /** G-08: optional `kind` sub-classifier — typed stringly for forward compatibility. */
  kind?: string;
}

/**
 * §2.3 ledger entry written via `appendCustomEntry("pi-hive-budget-ledger", data)`.
 * Matches the SDK's `CustomEntry<T>` shape (customType discriminator, optional data).
 */
export interface BudgetLedgerEntry {
  type: "custom";
  customType: "pi-hive-budget-ledger";
  data: BudgetLedgerData;
}

// ---------------------------------------------------------------------------
// §2.5 Pre-flight gate result.
// ---------------------------------------------------------------------------

export type BudgetScope = "worker" | "team";
export type BudgetResource = "tokens" | "costUsd" | "runs" | "depth";

export interface BudgetRemaining {
  tokens?: number;
  costUsd?: number;
  runs?: number;
}

export interface BudgetLimit {
  tokens?: number;
  costUsd?: number;
  runs?: number;
  depth?: number;
}

export interface BudgetBlock {
  reason: string;
  scope: BudgetScope;
  resource: BudgetResource;
  remaining: BudgetRemaining;
  limit: BudgetLimit;
}

/**
 * Budget violation shape thrown by `createBudgetAwareSession` and
 * `runBudgetPreflight`. The runtime path duck-types this — it builds the
 * error ad hoc with `error.name = "BudgetExhaustedError"` and attaches
 * `.scope` and `.resource`. No `instanceof BudgetExhaustedError` checks
 * exist; consumers should compare `error.name === "BudgetExhaustedError"`.
 *
 * The `BudgetExhaustedError` CLASS that previously lived here was removed
 * in audit C1: never instantiated, only documented. The duck-typed
 * envelope is what callers actually use. See `BUDGET_EXHAUSTED_ERROR_NAME`
 * in `worker-tools.ts` for the canonical sentinel string.
 */

// ---------------------------------------------------------------------------
// Team-usage aggregation across the branch.
// ---------------------------------------------------------------------------

export interface TeamUsageTotals {
  tokens: number;
  costUsd: number;
  runs: number;
}

// ---------------------------------------------------------------------------
// §2.8 operator commands + cooperative tools.
// ---------------------------------------------------------------------------

/** §2.8 operator-command arguments. */
export interface WorkerOperatorArgs {
  /** Worker agent slug (machine identifier). */
  agent: string;
  /** Human-readable reason recorded on the ledger snapshot. */
  reason?: string;
}

export interface RespawnWorkerArgs extends WorkerOperatorArgs {
  newTask?: string;
}

export interface SnapshotWorkerArgs extends WorkerOperatorArgs {
  label?: string;
}

export interface RestoreWorkerArgs extends WorkerOperatorArgs {
  snapshotId: string;
}

/** Cooperative tool input shapes (callable by the worker itself). */
export interface RequestCompactionArgs {
  notes: string;
}

export interface RequestEndSessionArgs {
  reason: string;
}

export interface RequestSnapshotArgs {
  label?: string;
}

/** Cooperative tool result shapes. */
export interface RequestCompactionResult {
  ok: boolean;
  compacted: boolean;
  estimatedTokens: number;
  limit: number;
  reason?: "no_runtime" | "over_cap" | "compact_failed" | "session_unavailable" | "session_settled";
  error?: string;
}

export interface RequestEndSessionResult {
  ok: boolean;
  reason?: "no_runtime" | "session_unavailable" | "session_settled";
  error?: string;
}

export interface RequestSnapshotResult {
  ok: boolean;
  snapshotId?: string;
  reason?: "no_runtime" | "session_unavailable";
  error?: string;
}

// ---------------------------------------------------------------------------
// §2.8 ledger kind for cooperative tools + operator commands.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// §2.4 / §2.6 — Return shapes from the new delegation flow.
// ---------------------------------------------------------------------------

export interface CreateBudgetAwareSessionResult {
  sessionId: string;
  session: AgentSession;
  /** Worker's SessionManager — exposed so callers can thread it through lifecycle. */
  sessionManager: SessionManager;
  ledger: BudgetLedger;
  /**
   * Wave 2 / F2 — controller owned by `createBudgetAwareSession` and exposed
   * here so callers can abort the session mid-run (e.g., parent-tool abort).
   * The signal is threaded into every ledger write per plan §2.12.
   */
  controller: AbortController;
}

// ---------------------------------------------------------------------------
// §2.15 `queue` removed — no `queue` cap variant in the union above.
// ---------------------------------------------------------------------------


