/**
 * Wave 2 — F2 delegate-agent spine + cooperative tools.
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md
 *   §2.4 The new `delegateAgent` flow — throws `BudgetExhaustedError` to refuse
 *   §2.5 Pre-flight gate (`checkBudgetPolicy`) — caller is the depth + budget
 *          pre-flight, throws on violation
 *   §2.8 EOL flexibility — 7 operator commands + 3 cooperative tools
 *          (`summarize_progress` is preserved in src/agents/tools/summarize-progress.ts
 *           per Wave 1 Agent 1D T5.7)
 *   §2.12 Every write threads `controller.signal`.
 *
 * `delegateAgent` is the budget-aware session creator: it resolves the
 * worker's policy, restores the ledger, runs the pre-flight check
 * (depth + tokens/cost/runs), creates or opens the session, installs the
 * mid-run budget event hooks, and returns the session + ledger. It does
 * NOT run the prompt — the caller does. This is the F2 spine; downstream
 * waves (F3 wiring, F5 EOL, F6 schema) extend the surface without
 * re-touching the core flow.
 *
 * Implementation notes:
 *
 *   - The Wave 0 stub (still present in git history) used
 *     `SessionManager.create(...).toAgentSession()` — a one-step helper that
 *     does NOT exist in the local SDK. We use the explicit two-step form:
 *     open a `SessionManager`, then `createAgentSession({ sessionManager, ... })`.
 *
 *   - `delegateAgent` throws `BudgetExhaustedError` on pre-flight violation
 *     (per Pi docs §2 "Throw from execute() to produce a failed tool result").
 *     It does NOT return a `{ output: "...", exitCode: 1 }` envelope — the
 *     legacy shape that did so is replaced.
 *
 *   - `installBudgetEventHooks` is called BEFORE returning. The caller owns
 *     the returned teardown function (or lets session dispose tear it down).
 *
 *   - `createSession` is injectable as a 6th optional argument so unit tests
 *     can stand up a scripted AgentSession without booting the SDK's
 *     extension runner.
 *
 *   - `sessionManagerFactory` is injectable as a 6th-arg key for tests that
 *     want to observe `SessionManager.create(cwd)` vs
 *     `SessionManager.continueRecent(cwd)` invocations. Production callers
 *     leave it undefined; the default uses the real SDK factory.
 *
 *   - The `controller` argument: `delegateAgent` instantiates its own
 *     `AbortController` per call (consistent with the plan §2.4 example).
 *     The controller's signal is threaded into every ledger write per §2.12.
 *     It is exposed via the `DelegateAgentResult.controller` field so the
 *     caller can abort mid-run if needed (e.g., parent-tool abort signal).
 *
 *   - `resolveWorkerBudgetPolicy` is the pure resolver. It walks
 *     `settings.budgets.perWorker` (global), then the agent's `budgets:`
 *     override (per-agent), and produces a flat-string `WorkerBudgetPolicy`
 *     via `resolveWindow` (F2 contract-drift reconciliation). Pure function
 *     — testable in isolation.
 *
 *   - The remaining operator commands (end / compact / respawn / pause /
 *     snapshot / restore / resume / abortCompaction) and cooperative tools
 *     (request_compaction / request_end_session / request_snapshot) remain
 *     stubs throwing "not implemented" — they belong to Wave 5 / F5, not
 *     F2. The F2 spine ONLY ships `delegateAgent` + `resolveWorkerBudgetPolicy`.
 */

import {
  type AgentSession,
  type ExtensionContext,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig, HiveState } from "../../core/types";
import { agentSlug } from "../../core/utils";
import { currentDelegationDepth } from "../session";
import type { CompactionResult } from "@earendil-works/pi-coding-agent";
import { resolveRuntime } from "../agent-lookup";
import { BUDGET_LEDGER_CUSTOM_TYPE, BudgetLedger } from "./ledger";
import { checkBudgetPolicy } from "./policy";
import { resolveWindow } from "./window-resolver";
import { installBudgetEventHooks } from "./events";
import type {
  BudgetLedgerEntry,
  BudgetExhaustedError as _BudgetExhaustedError,
  DelegateAgentResult,
  RequestCompactionArgs,
  RequestCompactionResult,
  RequestEndSessionArgs,
  RequestEndSessionResult,
  RequestSnapshotArgs,
  RequestSnapshotResult,
  RespawnWorkerArgs,
  RestoreWorkerArgs,
  SnapshotWorkerArgs,
  WorkerBudgetPolicy,
  WorkerOperatorArgs,
} from "./types";

import type {
  CostUsdCap,
  DepthCap,
  ResolvedWorkerBudgets,
  RunsCap,
  TokensCap,
} from "./types";

// ---------------------------------------------------------------------------
// §2.13 C4 — adapter from the F6 schema layer's per-resource cap shape to
// the F1 runtime's flat-string cap shape. `resolveWindow` is the actual
// flattening seam; this adapter only normalizes "optional vs. undefined"
// and applies the resolver uniformly.
// ---------------------------------------------------------------------------

/**
 * Schema-layer cap shape (from `src/core/types.ts` / `src/core/schema.ts`).
 * The `resource` discriminant is implicit — the outer key (`tokens:`,
 * `costUsd:`) carries it; the cap object itself only has the per-resource
 * fields plus the optional `window`/`include` block.
 *
 * NOTE: F2 does NOT carry `include` through to the F1 TokensCap surface
 * because the Wave 0 `UsageKey` union does not include `"cost"` (added in
 * Wave 1B's `IncludeKeys`). The `include` filter is a Wave 3 / F3 concern;
 * F2 ignores it. If a future wave lifts `UsageKey`, drop the omit and pass
 * the array through.
 */
interface SchemaTokensCap {
  cap: number;
  window?: import("../../core/types").BudgetWindowSpec;
  include?: import("../../core/types").IncludeKeys[];
}

interface SchemaCostUsdCap {
  cap: number;
  window?: import("../../core/types").BudgetWindowSpec;
}

interface SchemaRunsCap {
  cap: number;
  window?: import("../../core/types").BudgetWindowSpec;
}

interface SchemaDepthCap {
  cap: number;
}

function normalizeTokensCap(cap: SchemaTokensCap | undefined): TokensCap | undefined {
  if (!cap) return undefined;
  const window = resolveWindow(cap.window);
  return {
    resource: "tokens",
    cap: cap.cap,
    ...(window !== undefined ? { window } : {}),
  };
}

function normalizeCostUsdCap(cap: SchemaCostUsdCap | undefined): CostUsdCap | undefined {
  if (!cap) return undefined;
  const window = resolveWindow(cap.window);
  return {
    resource: "costUsd",
    cap: cap.cap,
    ...(window !== undefined ? { window } : {}),
  };
}

function normalizeRunsCap(cap: SchemaRunsCap | undefined): RunsCap | undefined {
  if (!cap) return undefined;
  const window = resolveWindow(cap.window);
  return {
    resource: "runs",
    cap: cap.cap,
    ...(window !== undefined ? { window } : {}),
  };
}

function normalizeDepthCap(cap: SchemaDepthCap | undefined): DepthCap | undefined {
  if (!cap) return undefined;
  return { resource: "depth", cap: cap.cap };
}

// ---------------------------------------------------------------------------
// §2.13 C1 — Per-agent override layered on top of the global worker block.
// `override` fields take precedence; omitted fields inherit from `base`.
// ---------------------------------------------------------------------------

function mergeWorkerOverrides(
  base: ResolvedWorkerBudgets | undefined,
  override: ResolvedWorkerBudgets | undefined,
): ResolvedWorkerBudgets {
  if (!base && !override) return {};
  return {
    tokens: override?.tokens ?? base?.tokens,
    costUsd: override?.costUsd ?? base?.costUsd,
    runs: override?.runs ?? base?.runs,
    depth: override?.depth ?? base?.depth,
  };
}

// ---------------------------------------------------------------------------
// §2.10 — `resolveWorkerBudgetPolicy` (T2.2 step 1).
//
// Pure function: reads `state.config.settings.budgets` + `state.config`'s
// agent tree (the agent identified by `agentName`), applies the per-agent
// override, and returns the merged `WorkerBudgetPolicy` with `worker` and
// `team` layers resolved.
// ---------------------------------------------------------------------------

/**
 * Resolve the worker's effective `WorkerBudgetPolicy`.
 *
 * Layering (per §2.10 + §2.13 C1):
 *   1. `settings.budgets.perWorker` (global defaults)
 *   2. `<agent>.budgets` (per-agent override)
 *   3. LEGACY BACKWARD-COMPAT (Wave 2 only):
 *      - `<agent>.governance.*` (per-agent, legacy v1 `WorkerGovernance`)
 *      - `settings.workerBudgets.*` + `settings.teamBudgets.*` (global)
 *      Legacy fields are layered as a fallback only — a new field already
 *      set wins. The legacy shape was removed from the Wave 1B config
 *      validator (hard cutover), but legacy state objects can still carry
 *      it (test fixtures, in-flight dispatches during the rollout window).
 *      Wave 5 / F9 deletes this fallback.
 *
 * The team layer is taken from `settings.budgets.perTeam` (new shape) or
 * `settings.teamBudgets` (legacy shape). There is no per-team-agent
 * override — `team` aggregates across the whole team, not per-agent.
 *
 * Missing `state.config` (uninitialized hive): returns an empty policy
 * (no caps). Callers should treat an empty policy as "everything unlimited"
 * and skip the pre-flight check.
 */
export function resolveWorkerBudgetPolicy(state: HiveState, agentName: string): WorkerBudgetPolicy {
  const settings = state.config?.settings as unknown as {
    budgets?: {
      perWorker?: ResolvedWorkerBudgets;
      perTeam?: import("../../core/types").TeamBudgetConfig;
    };
    // Legacy v1 shape — still on `HiveSettings` for backward compat; removed
    // by the Wave 1B config validator's allowlist but visible here on
    // hand-built state objects.
    workerBudgets?: import("../../core/types").WorkerGovernance;
    teamBudgets?: import("../../core/types").TeamBudgets;
  } | undefined;
  const globalWorker = settings?.budgets?.perWorker;
  const globalTeam = settings?.budgets?.perTeam;

  // Find the agent's per-agent override. `state.config.agents` is the flat
  // list; the orchestrator's members/children hold nested reports. Walk the
  // tree to find the agent by slug/name (matching the legacy
  // resolveRuntime lookups so behavior is consistent).
  const override = findAgentBudgetsOverride(state.config, agentName);

  const worker: ResolvedWorkerBudgets = mergeWorkerOverrides(
    normalizeWorkerBudgets(globalWorker),
    override,
  );

  // LEGACY FALLBACK — overlay `governance:` (per-agent) and
  // `settings.workerBudgets` (global) onto the new-shape worker layer. Only
  // fills absent fields; new-shape values win. Wave 5 / F9 deletes this
  // branch along with the legacy `WorkerGovernance` readers in
  // `src/engine/governance.ts`.
  applyLegacyWorkerFallback(worker, settings?.workerBudgets, findAgentLegacyGovernance(state.config, agentName));

  const team: ResolvedWorkerBudgets = normalizeWorkerBudgets(globalTeam);
  // LEGACY FALLBACK for team — overlay `settings.teamBudgets` if no new
  // team shape was provided. Same wave-5-deletion disclaimer.
  applyLegacyTeamFallback(team, settings?.teamBudgets);

  return { worker, team };
}

/** Find a legacy `governance:` override on an agent in the config tree. */
function findAgentLegacyGovernance(
  config: HiveState["config"],
  agentName: string,
): import("../../core/types").WorkerGovernance | undefined {
  if (!config) return undefined;
  const targets = [config.orchestrator, ...(config.agents ?? [])].filter(Boolean) as AgentConfig[];
  const stack: AgentConfig[] = [...targets];
  const wanted = String(agentName || "").trim().toLowerCase();
  while (stack.length > 0) {
    const node = stack.shift()!;
    const slug = agentSlug(node).toLowerCase();
    const name = String(node.name || "").trim().toLowerCase();
    if (slug === wanted || name === wanted) {
      return (node as { governance?: import("../../core/types").WorkerGovernance }).governance;
    }
    if (node.members?.length) stack.unshift(...node.members);
    if (node.children?.length) stack.unshift(...node.children);
  }
  return undefined;
}

/** Layer legacy `WorkerGovernance` over the new-shape worker block. */
function applyLegacyWorkerFallback(
  worker: ResolvedWorkerBudgets,
  globalLegacy: import("../../core/types").WorkerGovernance | undefined,
  agentLegacy: import("../../core/types").WorkerGovernance | undefined,
): void {
  const merged = { ...(globalLegacy ?? {}), ...(agentLegacy ?? {}) } as import("../../core/types").WorkerGovernance;
  if (worker.tokens?.cap === undefined && merged.tokenBudget !== undefined) {
    worker.tokens = { resource: "tokens", cap: merged.tokenBudget };
  }
  if (worker.costUsd?.cap === undefined && merged.costBudgetUsd !== undefined) {
    worker.costUsd = { resource: "costUsd", cap: merged.costBudgetUsd };
  }
  if (worker.runs?.cap === undefined && merged.maxRuns !== undefined) {
    worker.runs = { resource: "runs", cap: merged.maxRuns };
  }
  if (worker.depth?.cap === undefined && merged.maxDelegationDepth !== undefined) {
    worker.depth = { resource: "depth", cap: merged.maxDelegationDepth };
  }
}

/** Layer legacy `TeamBudgets` over the new-shape team block. */
function applyLegacyTeamFallback(
  team: ResolvedWorkerBudgets,
  legacy: import("../../core/types").TeamBudgets | undefined,
): void {
  if (!legacy) return;
  if (team.tokens?.cap === undefined && legacy.tokenBudget !== undefined) {
    team.tokens = { resource: "tokens", cap: legacy.tokenBudget };
  }
  if (team.costUsd?.cap === undefined && legacy.costBudgetUsd !== undefined) {
    team.costUsd = { resource: "costUsd", cap: legacy.costBudgetUsd };
  }
  if (team.runs?.cap === undefined && legacy.maxRuns !== undefined) {
    team.runs = { resource: "runs", cap: legacy.maxRuns };
  }
}

/** Normalize the schema-layer per-team/per-worker shape into the F1 flat-string shape. */
function normalizeWorkerBudgets(
  block:
    | ResolvedWorkerBudgets
    | import("../../core/types").WorkerBudgetConfig
    | import("../../core/types").TeamBudgetConfig
    | undefined,
): ResolvedWorkerBudgets {
  if (!block) return {};
  const result: ResolvedWorkerBudgets = {
    tokens: normalizeTokensCap(block.tokens as SchemaTokensCap | undefined),
    costUsd: normalizeCostUsdCap(block.costUsd as SchemaCostUsdCap | undefined),
    runs: normalizeRunsCap(block.runs as SchemaRunsCap | undefined),
  };
  // `depth` is worker-only — TeamBudgetConfig does not carry it. Guard
  // before normalizeDepthCap so a team block with no `depth` produces an
  // absent cap rather than a runtime "undefined" access.
  if ("depth" in block && block.depth !== undefined) {
    result.depth = normalizeDepthCap(block.depth as SchemaDepthCap | undefined);
  }
  return result;
}

/** Walk the agent tree and find the per-agent `budgets:` override for `agentName`. */
function findAgentBudgetsOverride(
  config: HiveState["config"],
  agentName: string,
): ResolvedWorkerBudgets | undefined {
  if (!config) return undefined;
  const targets = [config.orchestrator, ...(config.agents ?? [])].filter(Boolean) as AgentConfig[];
  const stack: AgentConfig[] = [...targets];
  const wanted = String(agentName || "").trim().toLowerCase();
  while (stack.length > 0) {
    const node = stack.shift()!;
    const slug = agentSlug(node).toLowerCase();
    const name = String(node.name || "").trim().toLowerCase();
    if (slug === wanted || name === wanted) {
      // The schema-layer shape on `agent.budgets` carries the resource-shape
      // discriminator implicitly via the key (`tokens:`, `costUsd:`); the
      // F2 normalizer reads those blocks and produces a flat-string F1 shape.
      return normalizeWorkerBudgets(node.budgets);
    }
    if (node.members?.length) stack.unshift(...node.members);
    if (node.children?.length) stack.unshift(...node.children);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// §2.4 — `delegateAgent` (T2.2 main flow).
// ---------------------------------------------------------------------------

export interface DelegateAgentOptions {
  fresh?: boolean;
  configOverrides?: Partial<AgentConfig>;
}

/**
 * Test-time dependency-injection seam. NOT part of the public Wave 0
 * contract; production callers MUST NOT pass this. Both factories default
 * to the real SDK implementations.
 */
export interface DelegateAgentDeps {
  /**
   * Override the SessionManager factory. The first argument is `cwd`, the
   * second is `fresh`. Tests inject this to assert which factory was called
   * (e.g., `SessionManager.create` vs `SessionManager.continueRecent`) and
   * to use `SessionManager.inMemory` for hermetic tests.
   */
  sessionManagerFactory?: (cwd: string, fresh: boolean) => SessionManager;
  /** Override `createAgentSession`. Tests inject a scripted session. */
  createSession?: typeof createAgentSession;
}

const defaultSessionManagerFactory = (cwd: string, fresh: boolean): SessionManager => {
  return fresh ? SessionManager.create(cwd) : SessionManager.continueRecent(cwd);
};

// ---------------------------------------------------------------------------
// §2.4 — pre-flight helper used by `dispatchAgent` AND `delegateAgent`.
//
// The pre-flight is the load-bearing step Bug 1 was about: a queued or
// concurrent dispatch can drain the budget between the initial check and
// the actual session creation, so the same check must run both before and
// after slot acquisition. Both call sites use this single helper to keep
// the rule in one place — there is no second copy of the depth / cap
// logic anywhere in the codebase.
//
// The helper does NOT return the restored ledger. Callers that go on to
// install hooks restore the ledger against the WORKER's SessionManager
// (not `ctx.sessionManager`, which is read-only — see Wave 1A note in
// `src/engine/budget/ledger.ts`). Reusing the pre-flight ledger would
// point writes at the read-only SM, which lacks `appendCustomEntry`.
// ---------------------------------------------------------------------------

export interface BudgetPreflightResult {
  policy: WorkerBudgetPolicy;
  /** Depth this dispatch would create (= currentDelegationDepth() + 1). */
  depth: number;
}

/**
 * Run the budget pre-flight for `agentName`. Throws `BudgetExhaustedError`
 * (duck-typed: `error.name === "BudgetExhaustedError"`) on block.
 *
 * The helper takes the `ExtensionContext` only for `ctx.sessionManager`
 * (branch read) and `ctx.signal` (abort propagation into the ledger
 * restore). It does NOT create or open any session.
 */
export async function runBudgetPreflight(
  state: HiveState,
  agentName: string,
  ctx: ExtensionContext,
): Promise<BudgetPreflightResult> {
  const runtime = resolveRuntime(state, agentName);
  if (!runtime) {
    throw new Error(`runBudgetPreflight: unknown agent "${agentName}".`);
  }
  const policy = resolveWorkerBudgetPolicy(state, agentName);
  const depth = currentDelegationDepth() + 1;

  // No-op fast path. The legacy `checkDispatchBudgets` returned `undefined`
  // when no caps were configured. Match that: if the resolved policy has no
  // caps AND no branch can be read (no session manager / no config), return
  // immediately without touching the ledger. This keeps existing tests that
  // build a partial HiveState (`state.config` present but `settings.budgets`
  // absent) working without modification.
  const hasAnyCap =
    Boolean(policy.worker.tokens?.cap) ||
    Boolean(policy.worker.costUsd?.cap) ||
    Boolean(policy.worker.runs?.cap) ||
    Boolean(policy.worker.depth?.cap) ||
    Boolean(policy.team.tokens?.cap) ||
    Boolean(policy.team.costUsd?.cap) ||
    Boolean(policy.team.runs?.cap);
  if (!hasAnyCap || !ctx.sessionManager) {
    return { policy, depth };
  }

  // Standard path: restore the ledger against the active branch and run the
  // pre-flight. The ledger is read-only here (no writes during pre-flight);
  // the worker's own SessionManager (created later) is what writes go to.
  const slug = agentSlug(runtime.config);
  const ledger = await BudgetLedger.restore(
    ctx.sessionManager as unknown as SessionManager,
    slug,
    policy,
    ctx.signal,
  );
  const blocked = checkBudgetPolicy(
    ledger,
    policy,
    ctx.sessionManager.getBranch(),
    depth,
  );
  if (blocked) {
    const error = new Error(blocked.reason) as Error & {
      scope: typeof blocked.scope;
      resource: typeof blocked.resource;
    };
    error.name = "BudgetExhaustedError";
    error.scope = blocked.scope;
    error.resource = blocked.resource;
    throw error;
  }
  return { policy, depth };
}

/**
 * Open (or continue) a worker session, install budget event hooks, and
 * return the session + ledger pair. Throws `BudgetExhaustedError` when the
 * pre-flight gate refuses the dispatch (per Pi docs §2).
 *
 * The flow (per plan §2.4):
 *   1. Pre-flight (runBudgetPreflight): resolve policy + ledger restore +
 *      cap/depth check. Throws `BudgetExhaustedError` on block.
 *   2. Open or create the `SessionManager`.
 *   3. Create the `AgentSession` via the injected `createSession`.
 *   4. Re-restore the `BudgetLedger` against the WORKER's SessionManager
 *      (writes go to the worker SM, not `ctx.sessionManager` which is
 *      read-only — see `src/engine/budget/ledger.ts` Wave 1A note).
 *   5. Install mid-run budget event hooks (controller owned by this call).
 *   6. Return `{ sessionId, session, ledger, controller }`.
 *
 * The caller is responsible for:
 *   - invoking `session.prompt(task)` to start the run,
 *   - calling the teardown returned by `installBudgetEventHooks` (or letting
 *     `session.dispose()` tear it down),
 *   - aborting `controller` if a parent abort signal fires.
 */
export async function delegateAgent(
  state: HiveState,
  agentName: string,
  task: string,
  opts: DelegateAgentOptions,
  ctx: ExtensionContext,
  deps: DelegateAgentDeps = {},
): Promise<DelegateAgentResult> {
  // 1. Pre-flight: policy resolution + ledger restore + cap/depth check.
  // Delegated to the shared helper used by `dispatchAgent` so the rule is
  // defined in exactly one place (no second copy of the depth/cap logic).
  const { policy } = await runBudgetPreflight(state, agentName, ctx);

  // 2. Open or create the SessionManager. Default factory maps directly to
  // the plan §2.4 example (`fresh ? SessionManager.create(cwd) :
  // SessionManager.continueRecent(cwd)`); tests inject a hermetic
  // alternative.
  const sessionManagerFactory = deps.sessionManagerFactory ?? defaultSessionManagerFactory;
  const sessionManager = sessionManagerFactory(ctx.cwd, Boolean(opts.fresh));

  // 3. Create the AgentSession. Default uses `createAgentSession` with the
  // minimum options required for the SDK to spin up a session bound to
  // `sessionManager`. Production callers (`dispatchAgent`) inject their
  // own factory that wires model/tools/loader; F2 ships the minimal
  // default so the spine is runnable without the full dispatcher.
  const createSession = deps.createSession ?? createAgentSession;
  const created = await createSession({ cwd: ctx.cwd, sessionManager });
  const session = created.session as AgentSession;

  // 4. Restore the ledger against the WORKER's SessionManager (writes go
  // here, not to the read-only `ctx.sessionManager`).
  const runtime = resolveRuntime(state, agentName);
  const slug = runtime ? agentSlug(runtime.config) : agentName;
  const ledger = await BudgetLedger.restore(sessionManager, slug, policy, ctx.signal);

  // 5. Install mid-run event hooks. The controller is owned by this call
  // (consistent with the plan §2.4 example) and exposed via the result so
  // callers can abort it when a parent signal fires.
  const controller = new AbortController();
  installBudgetEventHooks(session, ledger, policy, sessionManager, controller);

  return {
    sessionId: session.sessionId,
    session,
    ledger,
    controller,
  };
}

// ---------------------------------------------------------------------------
// §2.8 Operator commands — Wave 3B implementations (F5 stop/pause/resume).
//
// Wave 3B owns five of the seven operator commands. Each operates on a
// single EXISTING session (no branching): `end`, `compact`, `pause`,
// `resume`, `abortWorkerCompaction`. The other six commands (respawn,
// snapshot, restore, plus the three cooperative tools) remain stubs until
// Wave 3C / 3D land.
//
// Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md
//   §2.8 — operator command wire contracts
//   §3.5 — F5 details (T5.1, T5.2, T5.4, T5.8, T5.9)
//   §6.2 — `session.dispose()` NOT called by `endWorkerSession` (G-06);
//           `resumeWorkerSession` added per G-04; `abortWorkerCompaction`
//           added per G-05.
// ---------------------------------------------------------------------------

/**
 * Bundle of live state for an in-flight worker session. Each operator
 * command receives the same handle: the live `AgentSession` (for SDK
 * lifecycle calls), the worker's `BudgetLedger` (for snapshot writes),
 * and the resolved `WorkerBudgetPolicy` (for snapshot signatures).
 *
 * The session manager lives inside the `BudgetLedger` (`ledger`'s
 * constructor captures it) — callers do NOT need to pass it again.
 */
export interface WorkerSessionHandle {
  session: AgentSession;
  ledger: BudgetLedger;
  policy: WorkerBudgetPolicy;
}

/** Returned by every Wave 3B operator command. */
export interface OperatorCommandResult {
  sessionId: string;
  ledgerSnapshot: BudgetLedgerEntry;
}

/**
 * T5.1 — `endWorkerSession(agent, reason)` (plan §3.5).
 *
 * Calls `session.abort()` and writes a ledger snapshot with
 * `kind: "end"`. Per plan §6.2, the session is NOT disposed — the
 * reference is preserved so a follow-up `resumeWorkerSession` can re-attach
 * the event hooks and continue from where it left off.
 *
 * Returns the session id and the snapshot entry that was just written.
 * The session reference is left to the caller; `endWorkerSession` does not
 * invalidate it.
 */
export async function endWorkerSession(
  _args: WorkerOperatorArgs,
  ctx: ExtensionContext,
  handle: WorkerSessionHandle,
): Promise<OperatorCommandResult> {
  // Plan §6.2: do NOT dispose. The session reference stays valid; a later
  // `resumeWorkerSession` call re-attaches event hooks on the SAME session.
  await handle.session.abort();
  const stats = handle.session.getSessionStats();
  handle.ledger.snapshot(stats, handle.policy, "end", ctx.signal);
  return {
    sessionId: handle.session.sessionId,
    ledgerSnapshot: lastLedgerEntry(handle.ledger, "end"),
  };
}

/**
 * T5.2 — `compactWorkerSession(agent, reason, customInstructions?)`.
 *
 * Calls `session.compact(customInstructions)`, writes a ledger snapshot
 * with `kind: "compact"`, and returns the compaction result alongside the
 * snapshot. If the SDK compaction throws (e.g., policy rejected the
 * summary), the error propagates and no ledger snapshot is written — the
 * ledger stays at its pre-call state so the caller can decide whether to
 * retry or fall back to `abortWorkerCompaction`.
 */
export interface CompactWorkerSessionResult extends OperatorCommandResult {
  compaction: CompactionResult;
}

export async function compactWorkerSession(
  _args: WorkerOperatorArgs,
  ctx: ExtensionContext,
  handle: WorkerSessionHandle,
  customInstructions?: string,
): Promise<CompactWorkerSessionResult> {
  const compaction = await handle.session.compact(customInstructions);
  // Snapshot AFTER compact completes — `getSessionStats()` now reflects the
  // post-compaction token total. The earlier `recordCompaction` handler in
  // events.ts already updated the in-memory cumulative from the
  // `compaction_end` event, so the snapshot records the new baseline.
  const stats = handle.session.getSessionStats();
  handle.ledger.snapshot(stats, handle.policy, "compact", ctx.signal);
  return {
    sessionId: handle.session.sessionId,
    ledgerSnapshot: lastLedgerEntry(handle.ledger, "compact"),
    compaction,
  };
}

/**
 * T5.4 — `pauseWorkerSession(agent, reason)`.
 *
 * Calls `session.waitForIdle()` and writes a ledger snapshot with
 * `kind: "pause"`. The session stays open but is now idle — a follow-up
 * `resumeWorkerSession` re-attaches the event hooks and the next
 * `session.prompt(...)` continues from where it paused.
 *
 * Wait ordering: the snapshot is written AFTER `waitForIdle()` so the
 * ledger's `cumulative.tokens` reflects the final pre-pause total
 * (`getSessionStats()` returns the post-final-message state).
 */
export async function pauseWorkerSession(
  _args: WorkerOperatorArgs,
  ctx: ExtensionContext,
  handle: WorkerSessionHandle,
): Promise<OperatorCommandResult> {
  await handle.session.waitForIdle();
  const stats = handle.session.getSessionStats();
  handle.ledger.snapshot(stats, handle.policy, "pause", ctx.signal);
  return {
    sessionId: handle.session.sessionId,
    ledgerSnapshot: lastLedgerEntry(handle.ledger, "pause"),
  };
}

/**
 * T5.8 — `resumeWorkerSession(agent)` (G-04).
 *
 * Counterpart to `pauseWorkerSession`. Re-attaches the budget event hooks
 * on the existing session reference and writes a ledger snapshot with
 * `kind: "resume"`. The session continues from where it paused.
 *
 * This MUST work even if the session has been idle for hours — the new
 * hooks consult `getSessionStats()` on each event, so any `message_end`
 * fired after `resume` reads the current authoritative totals.
 *
 * The new hooks are an ADDITIONAL subscriber alongside any pre-pause
 * subscription. After a long pause the SDK's pre-pause listeners may have
 * been torn down by the session lifecycle; in either case, `resume` adds
 * a fresh subscription so future events are observed.
 */
export async function resumeWorkerSession(
  _args: WorkerOperatorArgs,
  ctx: ExtensionContext,
  handle: WorkerSessionHandle,
): Promise<OperatorCommandResult> {
  // Re-attach on the existing session reference. The fresh controller is
  // owned by this command and is unused by the F2 spine (events.ts ignores
  // it after wiring the listeners) but is required by the signature.
  const controller = new AbortController();
  installBudgetEventHooks(
    handle.session,
    handle.ledger,
    handle.policy,
    // events.ts takes the SessionManager for F3 wiring (warning emit via
    // `appendCustomMessageEntry`); the F2 spine ignores it. Resume uses
    // `handle.session.sessionManager` because the SDK exposes that
    // reference publicly on AgentSession — no extra getter on the ledger
    // is needed.
    handle.session.sessionManager,
    controller,
  );
  const stats = handle.session.getSessionStats();
  handle.ledger.snapshot(stats, handle.policy, "resume", ctx.signal);
  return {
    sessionId: handle.session.sessionId,
    ledgerSnapshot: lastLedgerEntry(handle.ledger, "resume"),
  };
}

/**
 * T5.9 — `abortWorkerCompaction(agent)` (G-05).
 *
 * Cancels in-flight compaction (manual or auto) via `session.abortCompaction()`.
 * Writes a ledger snapshot with `kind: "compact-aborted"`. The session
 * continues; aborted compactions do NOT release a slot.
 */
export async function abortWorkerCompaction(
  _args: WorkerOperatorArgs,
  ctx: ExtensionContext,
  handle: WorkerSessionHandle,
): Promise<OperatorCommandResult> {
  handle.session.abortCompaction();
  // After `abortCompaction()` returns, the SDK is back to a non-compacting
  // state. `getSessionStats()` reflects the pre-compaction totals because
  // the aborted compaction did not rewrite the branch.
  const stats = handle.session.getSessionStats();
  handle.ledger.snapshot(stats, handle.policy, "compact-aborted", ctx.signal);
  return {
    sessionId: handle.session.sessionId,
    ledgerSnapshot: lastLedgerEntry(handle.ledger, "compact-aborted"),
  };
}

/**
 * Pull the most recent ledger entry written for the given `kind`. Throws
 * if the ledger has no entries (which would indicate the snapshot write
 * silently failed — an invariant violation the tests guard against).
 */
function lastLedgerEntry(ledger: BudgetLedger, kind: string): BudgetLedgerEntry {
  const entries = ledger.entries();
  const latest = entries[entries.length - 1];
  if (!latest) {
    throw new Error(`expected ledger entry for kind="${kind}" but ledger is empty`);
  }
  if (latest.data.kind !== kind) {
    throw new Error(
      `expected latest ledger entry to have kind="${kind}" but got "${String(latest.data.kind)}"`,
    );
  }
  return latest;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// === Wave 3C — F5 branch/clone cluster (T5.3, T5.5, T5.6) ===
//
// Resolves the §2.8 branch/clone operator commands. Each one:
//   - Calls an SDK primitive on the worker's SessionManager / session.
//   - Snapshots the ledger with the documented `kind` (see plan §2.3 + §2.8).
//   - Returns a structured result whose `ledgerSnapshot` is the canonical
//     `BudgetLedgerEntry` (customType discriminator + data with kind/marker)
//     that the dashboard / caller can persist as the audit-trail entry.
//
// Deps design:
//   - All three functions take a third `deps` argument carrying the live
//     AgentSession / SessionManager / BudgetLedger / WorkerBudgetPolicy
//     for the worker. Tests inject scripted versions; production callers
//     pull these from a runtime registry / `delegateAgent` result.
//   - The factory pattern matches `delegateAgent` (line ~540) so the test
//     seams stay consistent across the module.
//
// Result-shape note (plan §2.8 + Wave 0 `BudgetLedgerEntry`):
//   - `ledgerSnapshot` is the LAST `BudgetLedgerEntry` in `ledger.entries()`
//     for the worker at the moment the snapshot was written. Each command
//     writes exactly one such entry per invocation (per plan §2.3 "always"
//     write cadence on operator actions), so `entries[entries.length - 1]`
//     is the canonical handle.
//   - `restoreWorkerSession` returns a discriminated union: `{ ok: true, ... }`
//     on success OR `{ isError: true, code: "restore_failed", reason }` when
//     `createBranchedSession` returns `undefined` (in-memory source SM, per
//     `dist/core/session-manager.js:1296`). This matches the legacy
//     `isError: true` envelope used by `summarize-progress` (Wave 1D).
// ---------------------------------------------------------------------------
// === T5.3 — respawnWorkerSession ===

/** Result envelope for `respawnWorkerSession` — success path only. */
export interface RespawnWorkerResult {
  ok: true;
  /** Session ID of the disposed (old) session. */
  oldSessionId: string;
  /** Session ID of the newly-created session. */
  newSessionId: string;
  /** The ledger entry written on the OLD SM with `kind: "respawn"`. */
  ledgerSnapshot: BudgetLedgerEntry;
}

/** Dependency-injection seam for `respawnWorkerSession`. */
export interface RespawnWorkerDeps {
  /** The OLD `AgentSession` to dispose. Required. */
  oldSession: AgentSession;
  /** The OLD `SessionManager` (target of `branchWithSummary`). Required. */
  oldSessionManager: SessionManager;
  /** The OLD worker's `BudgetLedger` (target of the `kind: "respawn"` snapshot). Required. */
  oldLedger: BudgetLedger;
  /** The worker's resolved `WorkerBudgetPolicy`. Required. */
  policy: WorkerBudgetPolicy;
  /** Factory for the NEW `SessionManager`. Default: `SessionManager.create(cwd)`. */
  sessionManagerFactory?: (cwd: string) => SessionManager;
  /** Factory for the NEW `AgentSession`. Default: `createAgentSession`. */
  createSession?: typeof createAgentSession;
}

/**
 * `T5.3` — `respawnWorkerSession(agent, reason, newTask?)`.
 *
 * Sequence (plan §3.2):
 *   1. Capture OLD `getSessionStats()` BEFORE any teardown.
 *   2. Branch the OLD SM with a `branch_summary` entry (operator-driven).
 *   3. Snapshot the OLD ledger with `kind: "respawn"`.
 *   4. Dispose the OLD session (releases listeners / aborts in-flight work).
 *   5. Create a NEW `SessionManager` via the factory (default `SessionManager.create`).
 *   6. Create a NEW `AgentSession` via the factory (default `createAgentSession`).
 *   7. Restore a FRESH `BudgetLedger` against the NEW SM (empty branch —
 *      the bug class is structurally impossible per plan §1.1 / §2.9).
 *   8. Install budget event hooks on the NEW session.
 *   9. Return `{ ok, oldSessionId, newSessionId, ledgerSnapshot }`.
 *
 * Hard constraints honored:
 *   - `session.dispose()` is called (NOT just `session.abort()`); per the
 *     SDK's `dist/core/agent-session.js:822`, `dispose()` aborts the agent,
 *     cancels in-flight retry / compaction / branch-summary / bash, and
 *     invalidates the extension runner. The plan's T5.3 specifies
 *     `dispose()` explicitly; `abort()` alone would leak listeners.
 *   - `controller.signal` (per-call) is threaded into the ledger write.
 *   - No `Math.random()` / `Date.now()` / `setTimeout()` in this path.
 *   - The OLD SM is preserved on disk (the `branch_summary` entry +
 *     `kind: "respawn"` ledger entry live there for audit).
 */
export async function respawnWorkerSession(
  args: RespawnWorkerArgs,
  ctx: ExtensionContext,
  deps: RespawnWorkerDeps,
): Promise<RespawnWorkerResult> {
  // 1. Capture OLD stats BEFORE teardown so the snapshot reflects the
  // session's actual cumulative spend at the moment of the operator action.
  const oldSessionId = deps.oldSession.sessionId;
  const oldStats = deps.oldSession.getSessionStats();

  // 2. Branch the OLD SM with a summary. Per plan §3.2, `branchWithSummary`
  // is the FIRST write so the abandoned path is preserved with its
  // summary before disposal. `getLeafId()` may return `null` for an empty
  // session (no entries yet) — in that case we skip the branch summary
  // (nothing to summarize) and rely on the ledger snapshot alone.
  const leafId = deps.oldSessionManager.getLeafId();
  if (leafId !== null) {
    const summary = args.reason
      ? `Respawned by operator: ${args.reason}`
      : "Respawned by operator";
    deps.oldSessionManager.branchWithSummary(leafId, summary);
  }

  // 3. Snapshot the OLD ledger with `kind: "respawn"` (marker: "checkpoint").
  // `BudgetLedger.snapshot` projects the kind onto the CustomEntry payload
  // and writes to its bound SessionManager (which is the OLD SM here).
  deps.oldLedger.snapshot(oldStats, deps.policy, "respawn", ctx.signal);
  const oldEntries = deps.oldLedger.entries();
  const ledgerSnapshot = oldEntries[oldEntries.length - 1] as BudgetLedgerEntry;

  // 4. Dispose the OLD session. Per `dist/core/agent-session.js:822`,
  // `dispose()` calls `agent.abort()` and tears down the extension runner
  // — releases listeners the `agent_settled` hooks installed. The OLD SM
  // is NOT disposed (the branch_summary + ledger entry persist on disk).
  deps.oldSession.dispose();

  // 5. Create a fresh SessionManager. Default factory is `SessionManager.create(cwd)`
  // which persists to disk — tests inject `SessionManager.inMemory(cwd)` for hermeticity.
  const factory = deps.sessionManagerFactory ?? ((cwd: string) => SessionManager.create(cwd));
  const newSessionManager = factory(ctx.cwd);

  // 6. Create the new AgentSession. Default uses `createAgentSession`; tests
  // inject a scripted session (see `tests/budget-eol.test.ts`).
  const createSession = deps.createSession ?? createAgentSession;
  const created = await createSession({ cwd: ctx.cwd, sessionManager: newSessionManager });
  const newSession = created.session as AgentSession;

  // 7. Restore a FRESH ledger. The NEW SM has an empty branch (a fresh
  // session has no entries), so the ledger starts at zero cumulative spend.
  // This is the structural reason Bug 1's bug class can't recur — there's
  // no dual-counter to drift (plan §1.1).
  const newLedger = await BudgetLedger.restore(
    newSessionManager,
    args.agent,
    deps.policy,
    ctx.signal,
  );

  // 8. Install event hooks on the NEW session.
  const controller = new AbortController();
  installBudgetEventHooks(newSession, newLedger, deps.policy, newSessionManager, controller);

  return {
    ok: true,
    oldSessionId,
    newSessionId: newSession.sessionId,
    ledgerSnapshot,
  };
}

// === T5.5 — snapshotWorkerSession ===

/** Result envelope for `snapshotWorkerSession` — success path only. */
export interface SnapshotWorkerResult {
  ok: true;
  /** Session ID of the worker's session at snapshot time. */
  sessionId: string;
  /**
   * The `branch_summary` entry ID written by `branchWithSummary`. This is
   * the navigation handle a future `restoreWorkerSession(agent, snapshotId)`
   * passes as `snapshotLeafId` (per `dist/core/session-manager.d.ts:380`).
   */
  branchPath: string;
  /** The ledger entry written with `kind: "snapshot"`. */
  ledgerSnapshot: BudgetLedgerEntry;
}

/** Dependency-injection seam for `snapshotWorkerSession`. */
export interface SnapshotWorkerDeps {
  /** The worker's `SessionManager` (target of `branchWithSummary`). Required. */
  sessionManager: SessionManager;
  /** The worker's `BudgetLedger` (target of the `kind: "snapshot"` snapshot). Required. */
  ledger: BudgetLedger;
  /** The worker's `AgentSession` (source of stats for the snapshot). Required. */
  session: AgentSession;
  /** The worker's resolved `WorkerBudgetPolicy`. Required. */
  policy: WorkerBudgetPolicy;
}

/**
 * `T5.5` — `snapshotWorkerSession(agent, label)`.
 *
 * Sequence (plan §2.8):
 *   1. `session_manager.branchWithSummary(leafId, label)` writes a
 *      `branch_summary` entry as a sibling of the current leaf. The entry's
 *      `id` becomes `branchPath` (the future-restore handle).
 *   2. Snapshot the ledger with `kind: "snapshot"` (marker: "checkpoint").
 *   3. Return `{ ok, sessionId, branchPath, ledgerSnapshot }`.
 *
 * The session itself is preserved — `snapshotWorkerSession` does NOT create
 * a new session (unlike `respawnWorkerSession`). The operator can continue
 * using the same session; later, `restoreWorkerSession(agent, branchPath)`
 * can navigate to this branch.
 *
 * Hard constraints honored:
 *   - `controller.signal` (per-call) is threaded into the ledger write.
 *   - No `Math.random()` / `Date.now()` / `setTimeout()` in this path.
 */
export async function snapshotWorkerSession(
  args: SnapshotWorkerArgs,
  ctx: ExtensionContext,
  deps: SnapshotWorkerDeps,
): Promise<SnapshotWorkerResult> {
  // 1. Branch the worker's current leaf with a summary. The branch_summary
  // entry becomes a sibling of the current leaf; subsequent appends land
  // on a NEW branch off the current leaf, leaving the snapshot path intact.
  // Per `dist/core/session-manager.js:1176`, the SDK throws if `leafId` is
  // non-null and not in the index; we skip the call when there's nothing
  // to summarize (empty session).
  const leafId = deps.sessionManager.getLeafId();
  let branchPath = "";
  if (leafId !== null) {
    const summary = args.label ?? args.reason ?? `Snapshot of ${args.agent}`;
    branchPath = deps.sessionManager.branchWithSummary(leafId, summary);
  }

  // 2. Snapshot the ledger with `kind: "snapshot"`. Stats come from the
  // authoritative `session.getSessionStats()` (single source of truth).
  const stats = deps.session.getSessionStats();
  deps.ledger.snapshot(stats, deps.policy, "snapshot", ctx.signal);
  const entries = deps.ledger.entries();
  const ledgerSnapshot = entries[entries.length - 1] as BudgetLedgerEntry;

  return {
    ok: true,
    sessionId: deps.session.sessionId,
    branchPath,
    ledgerSnapshot,
  };
}

// === T5.6 — restoreWorkerSession ===

/** Success-path result envelope for `restoreWorkerSession`. */
export interface RestoreWorkerResult {
  ok: true;
  /** Session ID of the newly-opened branched session. */
  sessionId: string;
  /** The ledger entry written with `kind: "restore"`. */
  ledgerSnapshot: BudgetLedgerEntry;
}

/** Error-path envelope for `restoreWorkerSession`. */
export interface RestoreWorkerError {
  isError: true;
  code: "restore_failed";
  reason: string;
}

/** Discriminated union — caller narrows on `ok` / `isError`. */
export type RestoreWorkerOutcome = RestoreWorkerResult | RestoreWorkerError;

/** Dependency-injection seam for `restoreWorkerSession`. */
export interface RestoreWorkerDeps {
  /**
   * The `SessionManager` that holds the snapshot to restore. Must be a
   * PERSISTED SM (the SDK's `createBranchedSession` returns `undefined`
   * for in-memory sources per `dist/core/session-manager.js:1296`).
   */
  sourceSessionManager: SessionManager;
  /** The leaf ID of the snapshot (the `branchPath` returned by `snapshotWorkerSession`). */
  snapshotLeafId: string;
  /** The worker's resolved `WorkerBudgetPolicy`. Required. */
  policy: WorkerBudgetPolicy;
  /**
   * Factory that opens the branched session file. Default:
   * `SessionManager.open(path)`. Tests inject to observe the exact path
   * argument the SDK returned.
   */
  openSessionManager?: (path: string) => SessionManager;
  /** Factory for the NEW `AgentSession`. Default: `createAgentSession`. */
  createSession?: typeof createAgentSession;
}

/**
 * `T5.6` — `restoreWorkerSession(agent, snapshotId)`.
 *
 * CRITICAL SDK chain (researched against the local SDK source):
 *
 *   - `SessionManager.createBranchedSession(leafId)` is declared as
 *     returning `string | undefined` at
 *     `dist/core/session-manager.d.ts:380` — NOT an `AgentSession`. The
 *     return value is the new session FILE PATH (or `undefined` for
 *     in-memory sources, per `dist/core/session-manager.js:1296`).
 *   - To open the branched session we then call `SessionManager.open(path)`
 *     (static, `dist/core/session-manager.d.ts:369`).
 *   - The opened SM is then passed to `createAgentSession({ sessionManager })`
 *     to materialize the `AgentSession`.
 *
 * Sequence (plan §3.3):
 *   1. `sourceSessionManager.createBranchedSession(snapshotLeafId)`.
 *   2. If `undefined` → return `{ isError: true, code: "restore_failed", reason }`.
 *      (Do NOT crash; surface the error to the operator.)
 *   3. Open the branched file via `SessionManager.open(path)`.
 *   4. Create a NEW `AgentSession` on the branched SM.
 *   5. Restore the ledger against the branched SM (its branch carries the
 *      pre-snapshot `CustomEntry` history — see plan §2.8).
 *   6. Snapshot the ledger with `kind: "restore"` (marker: "checkpoint").
 *   7. Install event hooks.
 *   8. Return `{ ok, sessionId, ledgerSnapshot }`.
 *
 * Coupling note (per plan T5.6 spec): the destination session's
 * `installBudgetEventHooks` writes the FINAL `agent_settled` checkpoint.
 * This call only writes the `kind: "restore"` audit entry; the `agent_settled`
 * flow is unchanged and triggers normally.
 *
 * Hard constraints honored:
 *   - `createBranchedSession` returning `undefined` → `isError: true`
 *     (NOT a thrown exception). Per the task spec: "Do NOT crash."
 *   - `controller.signal` (per-call) is threaded into the ledger write.
 *   - No `Math.random()` / `Date.now()` / `setTimeout()` in this path.
 */
export async function restoreWorkerSession(
  args: RestoreWorkerArgs,
  ctx: ExtensionContext,
  deps: RestoreWorkerDeps,
): Promise<RestoreWorkerOutcome> {
  // 1. createBranchedSession returns string | undefined. In-memory source
  // SMs return `undefined` (per `dist/core/session-manager.js:1296`) —
  // surface as `isError` rather than crashing. The plan's T5.6 task spec
  // is explicit: "createBranchedSession returns string | undefined —
  // handle the undefined case as `isError`."
  const branchedPath = deps.sourceSessionManager.createBranchedSession(deps.snapshotLeafId);
  if (branchedPath === undefined) {
    return {
      isError: true,
      code: "restore_failed",
      reason:
        "createBranchedSession returned undefined (source session is not persisted; cannot create a branched session file).",
    };
  }

  // 2. Open the branched session file. Default factory is `SessionManager.open(path)`;
  // tests inject to observe the exact path argument.
  const open = deps.openSessionManager ?? ((path: string) => SessionManager.open(path));
  const newSessionManager = open(branchedPath);

  // 3. Create the new AgentSession on the branched SM. The branched SM
  // carries the CustomEntry history (including any prior `kind: "snapshot"`
  // entry from the source session), so `BudgetLedger.restore` reconstructs
  // the cumulative spend from the LATEST matching entry.
  const createSession = deps.createSession ?? createAgentSession;
  const created = await createSession({ cwd: ctx.cwd, sessionManager: newSessionManager });
  const newSession = created.session as AgentSession;

  // 4. Restore the ledger. The branched branch carries the source's
  // `CustomEntry` history (because `getBranch()` walks from the new leaf
  // back to the header), so the ledger is reconstructed from the snapshot
  // moment's cumulative spend. NO counter reset needed — the SDK's branch
  // IS the restore primitive (plan §2.8 row).
  const newLedger = await BudgetLedger.restore(
    newSessionManager,
    args.agent,
    deps.policy,
    ctx.signal,
  );

  // 5. Snapshot the ledger with `kind: "restore"`. This is the audit-trail
  // entry showing "the operator navigated to leaf X". The destination's
  // `agent_settled` will write the FINAL `kind: "checkpoint"` entry later
  // (per the T5.6 coupling note).
  const stats = newSession.getSessionStats();
  newLedger.snapshot(stats, deps.policy, "restore", ctx.signal);
  const entries = newLedger.entries();
  const ledgerSnapshot = entries[entries.length - 1] as BudgetLedgerEntry;

  // 6. Install event hooks so the branched session runs under the budget
  // tracking umbrella.
  const controller = new AbortController();
  installBudgetEventHooks(newSession, newLedger, deps.policy, newSessionManager, controller);

  return {
    ok: true,
    sessionId: newSession.sessionId,
    ledgerSnapshot,
  };
}

/** Counterpart to `pauseWorkerSession` — restores worker activity after a pause. */
//      `summarize_progress` which is preserved in src/agents/tools/summarize-progress.ts).
// ---------------------------------------------------------------------------

/** Cooperative: ask the SDK to compact now (vs. waiting for the 0% threshold). */
export async function requestCompaction(
  _args: RequestCompactionArgs,
  _ctx: ExtensionContext,
): Promise<RequestCompactionResult> {
  throw new Error("not implemented");
}

/** Cooperative: graceful self-shutdown. */
export async function requestEndSession(
  _args: RequestEndSessionArgs,
  _ctx: ExtensionContext,
): Promise<RequestEndSessionResult> {
  throw new Error("not implemented");
}

/** Cooperative: branch the session for later `restoreWorkerSession`. */
export async function requestSnapshot(
  _args: RequestSnapshotArgs,
  _ctx: ExtensionContext,
): Promise<RequestSnapshotResult> {
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------
// SDK type re-exports (read-only; F2 must use these, not invent shapes).
// ---------------------------------------------------------------------------

export type { AgentSession, ExtensionContext };

// ---------------------------------------------------------------------------
// Internal re-exports for tests. The `BudgetExhaustedError` class lives in
// `src/engine/budget/types.ts` and is rebuilt here as a duck-typed Error so
// `delegateAgent` does not need to import the Wave 0 surface (which will be
// deprecated in F9 cleanup). Tests assert on `error.name === "BudgetExhaustedError"`
// and `error.scope` / `error.resource` instead of `instanceof`.
// ---------------------------------------------------------------------------

/** Sentinel name used to identify budget-violation throws from `delegateAgent`. */
export const BUDGET_EXHAUSTED_ERROR_NAME = "BudgetExhaustedError";

// Re-export so callers (dispatchAgent, future waves) can read the ledger kind
// without re-importing from ./ledger.
export { BUDGET_LEDGER_CUSTOM_TYPE };
