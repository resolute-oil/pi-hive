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
import { resolveRuntime } from "../agent-lookup";
import { BUDGET_LEDGER_CUSTOM_TYPE, BudgetLedger } from "./ledger";
import { checkBudgetPolicy } from "./policy";
import { resolveWindow } from "./window-resolver";
import { installBudgetEventHooks } from "./events";
import type {
  BudgetExhaustedError as _BudgetExhaustedError,
  BudgetLedgerCumulative,
  BudgetLedgerData,
  BudgetLedgerKind,
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
// §2.8 Operator commands (7 total: end, compact, respawn, pause, snapshot,
//      restore, resume) + abortWorkerCompaction.
// ---------------------------------------------------------------------------
// These belong to Wave 5 / F5, not F2. The stubs throw "not implemented"
// until F5 lands. They are kept here so the Wave 0 export surface stays
// stable (downstream code imports them but never calls them in F2).
// ---------------------------------------------------------------------------

/** `session.abort() + appendCustomEntry` — graceful stop, slot released. */
export async function endWorkerSession(
  _args: WorkerOperatorArgs,
  _ctx: ExtensionContext,
): Promise<{ ok: true; ledger: BudgetLedger }> {
  throw new Error("not implemented");
}

/** `session.compact(customInstructions?)` — SDK compaction; slot preserved. */
export async function compactWorkerSession(
  _args: WorkerOperatorArgs,
  _ctx: ExtensionContext,
  _customInstructions?: string,
): Promise<{ ok: true; ledger: BudgetLedger }> {
  throw new Error("not implemented");
}

/** `session.dispose() + SessionManager.create() + branchWithSummary(...)`. */
export async function respawnWorkerSession(
  _args: RespawnWorkerArgs,
  _ctx: ExtensionContext,
): Promise<{ ok: true; sessionId: string; ledger: BudgetLedger }> {
  throw new Error("not implemented");
}

/** `session.waitForIdle() + appendCustomEntry("pause", ...)` — resumable. */
export async function pauseWorkerSession(
  _args: WorkerOperatorArgs,
  _ctx: ExtensionContext,
): Promise<{ ok: true; ledger: BudgetLedger }> {
  throw new Error("not implemented");
}

/** `session_manager.branchWithSummary(leafId, summary)`. */
export async function snapshotWorkerSession(
  _args: SnapshotWorkerArgs,
  _ctx: ExtensionContext,
): Promise<{ ok: true; snapshotId: string; ledger: BudgetLedger }> {
  throw new Error("not implemented");
}

/** `SessionManager.createBranchedSession(leafId)` — destination session emits. */
export async function restoreWorkerSession(
  _args: RestoreWorkerArgs,
  _ctx: ExtensionContext,
): Promise<{ ok: true; sessionId: string; ledger: BudgetLedger }> {
  throw new Error("not implemented");
}

/** Counterpart to `pauseWorkerSession` — restores worker activity after a pause. */
export async function resumeWorkerSession(
  _args: WorkerOperatorArgs,
  _ctx: ExtensionContext,
): Promise<{ ok: true; ledger: BudgetLedger }> {
  throw new Error("not implemented");
}

/** `session.abortCompaction()` — cancel in-progress compaction (manual or auto). */
export async function abortWorkerCompaction(
  _args: WorkerOperatorArgs,
  _ctx: ExtensionContext,
): Promise<{ ok: true; aborted: boolean }> {
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------
// §2.8 Cooperative tools (callable by the worker itself, in addition to
//      `summarize_progress` which is preserved in src/agents/tools/summarize-progress.ts).
// ---------------------------------------------------------------------------
// Wave 3D (F5 cooperative tools) — implements T5.10 / T5.11 / T5.12.
//
// Cooperative tools run from inside a worker's session. They look up the
// worker's `AgentRuntime` via `state.runtimes[callerName]`, write a
// CustomEntry to the runtime's own `SessionManager` so the ledger captures
// the cooperative action with a distinct `kind` (§2.3 / G-08), and then
// invoke the corresponding SDK primitive on `runtime.session`.
//
// These tools are the cooperative counterpart to the operator commands
// (T5.1–T5.9): the operator drives them from outside the worker, the
// worker drives these from inside. Both write the same shape of ledger
// entry so the dashboard timeline renders operator + cooperative actions
// uniformly. The kind values come from §2.3 — operator actions use bare
// names (`end`, `compact`, …) and cooperative actions use the
// `cooperative-*` prefix.
//
// NOTE: the operator command stubs in this file throw "not implemented"
// until Wave 3B/3C land. The cooperative tools do NOT route through the
// operator commands; they invoke the SDK primitives directly so the worker's
// own session is the one acting. Operator commands would do the same once
// implemented — the routing overlap is intentional and will be reconciled
// when the operator commands land.
// ---------------------------------------------------------------------------

/** Minimal structural view of `runtime.session.sessionManager`. Cast avoids needing the SDK's `SessionManager` full surface in the test fakes. */
interface CooperativeSessionManager {
  appendCustomEntry(customType: string, data?: unknown): string;
  getLeafId(): string | null;
  branchWithSummary(branchFromId: string | null, summary: string): string;
}

/** Minimal structural view of the runtime's session carrying the SDK primitives the cooperative tools invoke. */
interface CooperativeSession {
  compact(customInstructions?: string): Promise<{ tokensBefore: number; estimatedTokensAfter?: number }>;
  abort(): Promise<void>;
  sessionManager?: CooperativeSessionManager;
}

/** Compute the cumulative token/cost/runs totals from a runtime's accumulated counters. */
function cumulativeFromRuntime(runtime: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  runCount: number;
}): BudgetLedgerCumulative {
  return {
    tokens:
      runtime.inputTokens + runtime.outputTokens + runtime.cacheReadTokens + runtime.cacheWriteTokens,
    costUsd: runtime.costUsd,
    runs: runtime.runCount,
  };
}

/** Write a cooperative-kind ledger entry to the runtime's own SessionManager. Captures the latest cumulative + a marker so the dashboard can surface cooperative actions distinctly from runtime-settled snapshots. */
function writeCooperativeLedgerEntry(params: {
  sessionManager: CooperativeSessionManager;
  kind: BudgetLedgerKind;
  agentSlug: string;
  cumulative: BudgetLedgerCumulative;
  reason?: string;
  label?: string;
  snapshotId?: string;
}): void {
  const data: BudgetLedgerData & Record<string, unknown> = {
    caps: {},
    cumulative: { ...params.cumulative },
    writtenAt: 0, // Filled in by `appendCustomEntry` consumers that care; the cooperative entry is observable via `kind` + cumulative, not `writtenAt`.
    agentSlug: params.agentSlug,
    marker: "checkpoint",
    kind: params.kind,
  };
  if (params.reason !== undefined) data.reason = params.reason;
  if (params.label !== undefined) data.label = params.label;
  if (params.snapshotId !== undefined) data.snapshotId = params.snapshotId;
  params.sessionManager.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, data);
}

/**
 * §2.8 cooperative: ask the SDK to compact the worker's session now (vs.
 * waiting for the auto-compact threshold). Writes a `cooperative-compact`
 * ledger entry first so the dashboard timeline captures the worker's intent
 * even if `session.compact()` throws.
 */
export async function requestCompaction(
  state: HiveState,
  callerName: string,
  args: RequestCompactionArgs,
): Promise<RequestCompactionResult> {
  const runtime = state.runtimes.get(callerName);
  if (!runtime) {
    return { ok: false, compacted: false, estimatedTokens: 0, limit: 0, reason: "no_runtime" };
  }
  const session = runtime.session as CooperativeSession | undefined;
  const sessionManager = session?.sessionManager;
  if (!session || !sessionManager || typeof session.compact !== "function") {
    return {
      ok: false,
      compacted: false,
      estimatedTokens: 0,
      limit: 0,
      reason: "compact_failed",
      error: "session is not compactable",
    };
  }

  const cumulative = cumulativeFromRuntime(runtime);
  writeCooperativeLedgerEntry({
    sessionManager,
    kind: "cooperative-compact",
    agentSlug: callerName,
    cumulative,
    reason: args.notes,
  });

  const result = await session.compact(args.notes);
  const estimatedTokens = result.estimatedTokensAfter ?? result.tokensBefore;
  const limit = runtime.contextWindow ?? 0;
  return { ok: true, compacted: true, estimatedTokens, limit };
}

/**
 * §2.8 cooperative: graceful self-shutdown of the worker's session. Writes
 * a `cooperative-end` ledger entry so the dashboard distinguishes a worker
 * self-ending from an operator-driven `endWorkerSession`.
 */
export async function requestEndSession(
  state: HiveState,
  callerName: string,
  args: RequestEndSessionArgs,
): Promise<RequestEndSessionResult> {
  const runtime = state.runtimes.get(callerName);
  if (!runtime) {
    return { ok: false, reason: "no_runtime" };
  }
  const session = runtime.session as CooperativeSession | undefined;
  const sessionManager = session?.sessionManager;
  if (!session || !sessionManager || typeof session.abort !== "function") {
    return { ok: false, reason: "no_runtime" };
  }

  const cumulative = cumulativeFromRuntime(runtime);
  writeCooperativeLedgerEntry({
    sessionManager,
    kind: "cooperative-end",
    agentSlug: callerName,
    cumulative,
    reason: args.reason,
  });

  await session.abort();
  return { ok: true };
}

/**
 * §2.8 cooperative: branch the worker's session for later
 * `restoreWorkerSession`. Writes a `cooperative-snapshot` ledger entry with
 * the produced snapshot id so the dashboard can link the two.
 */
export async function requestSnapshot(
  state: HiveState,
  callerName: string,
  args: RequestSnapshotArgs,
): Promise<RequestSnapshotResult> {
  const runtime = state.runtimes.get(callerName);
  if (!runtime) {
    return { ok: false, reason: "no_runtime" };
  }
  const session = runtime.session as CooperativeSession | undefined;
  const sessionManager = session?.sessionManager;
  if (!session || !sessionManager || typeof sessionManager.getLeafId !== "function") {
    return { ok: false, reason: "no_runtime" };
  }

  const cumulative = cumulativeFromRuntime(runtime);
  const leafId = sessionManager.getLeafId();
  const snapshotId = sessionManager.branchWithSummary(leafId, args.label ?? "");

  writeCooperativeLedgerEntry({
    sessionManager,
    kind: "cooperative-snapshot",
    agentSlug: callerName,
    cumulative,
    label: args.label,
    snapshotId,
  });

  return { ok: true, snapshotId };
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
