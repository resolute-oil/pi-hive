// Wave 0 contract stub — Slice 5 + 6: 11 operator commands + 3 cooperative tools
//
// Operator commands (slice 5) are NOT agent-callable; they are invoked from the
// operator surface (TUI, RPC, dashboard) per the refactor plan §2.8. Each
// command writes a ledger snapshot with marker "checkpoint" and a unique
// `kind` value (end / compact / respawn / pause / snapshot / restore / resume
// / compact-aborted / force-kill / force-end / tear-down-all). Wave 1 will
// implement them on top of session.abort()/compact()/dispose() and
// SessionManager.create()/continueRecent().
//
// Cooperative tools (slice 6) ARE agent-callable: a worker can call them to
// suggest end-of-life actions. They are routed through the same ledger write
// path with a `cooperative-*` kind prefix so the dashboard can distinguish
// agent-initiated vs operator-initiated shutdowns.
//
// Region markers (per `04-refactor-plan.md` §11.5): Wave 3's four parallel
// agents (3A, 3B, 3C, 3D) each fill in the functions inside their region.
// 3A does not edit this file (it touches F3+F4 elsewhere); 3B / 3C / 3D own
// the three regions below. The markers are pure comments — no runtime cost.

import type { AgentSession, ExtensionContext, SessionManager, SessionStats, ToolDefinition, ResourceLoader, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { SessionManager as SessionManagerClass, createAgentSession } from "@earendil-works/pi-coding-agent";

// Local structural aliases for SDK peer types that are not re-exported
// from the main `@earendil-works/pi-coding-agent` index. The SDK pulls
// these from `@earendil-works/pi-ai/compat` (Model) and
// `@earendil-works/pi-agent-core` (ThinkingLevel); the project's
// Bundler-resolution tsc can't reach those transitive peers without
// adding them as direct deps. The aliases match the SDK's shape well
// enough that callers (the dispatcher's createSession factory) pass
// through without `as unknown as` casts — the structural assignment
// narrows the seam.
export type DelegateAgentModel<TApi = unknown> = { provider: string; id: string; [key: string]: unknown };
export type DelegateAgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
import type { BudgetLedger } from "./ledger";
import { BudgetLedger as BudgetLedgerClass } from "./ledger";
import { resolveWorkerBudgetPolicy as resolveWorkerBudgetPolicyFn } from "./strategy";
import { checkBudgetPolicy as checkBudgetPolicyFn } from "./policy";
import { installBudgetEventHooks as installBudgetEventHooksFn } from "./events";
import type { BudgetBlock, BudgetLedgerKind, HiveState, WorkerBudgetPolicy } from "../../core/types";
import type { BudgetLedgerEntry } from "../../core/types";

// ── BudgetExhaustedError ──────────────────────────────────────────────────
//
// Per `04-refactor-plan.md` §2.4 + `pi-sdk-session-api.md`: throwing produces
// a failed tool result; returning an object does not mark it as an error.
// `delegateAgent` throws this when the pre-flight gate refuses, so the
// dispatcher's caller sees the error through the standard tool-error path.

export class BudgetExhaustedError extends Error {
  readonly reason: string;
  readonly scope: BudgetBlock["scope"];
  readonly resource: BudgetBlock["resource"];
  readonly remaining: BudgetBlock["remaining"];
  readonly limit: BudgetBlock["limit"];

  constructor(block: BudgetBlock) {
    super(block.reason);
    this.name = "BudgetExhaustedError";
    this.reason = block.reason;
    this.scope = block.scope;
    this.resource = block.resource;
    this.remaining = block.remaining;
    this.limit = block.limit;
  }
}

// ── DelegateAgent internals (test seam) ───────────────────────────────────
//
// The pre-flight gate (resolveWorkerBudgetPolicy → BudgetLedger.restore →
// checkBudgetPolicy) is composed of pure functions plus one async restore.
// In production `delegateAgent` uses the real implementations; tests inject
// stubs through this seam so each path can be exercised in isolation without
// a live session tree.

export interface DelegateAgentInternals {
  resolveWorkerBudgetPolicy: typeof resolveWorkerBudgetPolicyFn;
  restoreLedger: typeof BudgetLedgerClass.restore;
  checkBudgetPolicy: typeof checkBudgetPolicyFn;
  installBudgetEventHooks: typeof installBudgetEventHooksFn;
  sessionManagerCreate: (cwd: string) => SessionManager;
  sessionManagerContinueRecent: (cwd: string) => SessionManager;
  // Production-side seam: when supplied, delegateAgent uses it to create the
  // AgentSession instead of going through SessionManager.create()/continueRecent()
  // .toAgentSession(). The dispatcher passes the existing CreateAgentSession
  // through so the test seam in dispatch.ts keeps working — tests stub this
  // hook and the dispatcher does not need its own session-factory code.
  // Signature mirrors createAgentSession from the SDK; parameters are
  // typed (not `unknown`) so downstream `as unknown as never` casts at the
  // dispatch site become unnecessary (TS I4 / TS I13 fixup).
  createSession?: (opts: CreateSessionOptions) => Promise<{ session: AgentSession }>;
}

export interface CreateSessionOptions {
  cwd: string;
  model: DelegateAgentModel<unknown>;
  thinkingLevel: DelegateAgentThinkingLevel;
  tools: string[];
  customTools: ToolDefinition[];
  sessionManager: SessionManager;
  resourceLoader: ResourceLoader;
}

const defaultInternals: DelegateAgentInternals = {
  resolveWorkerBudgetPolicy: resolveWorkerBudgetPolicyFn,
  restoreLedger: BudgetLedgerClass.restore,
  checkBudgetPolicy: checkBudgetPolicyFn,
  installBudgetEventHooks: installBudgetEventHooksFn,
  sessionManagerCreate: (cwd) => SessionManagerClass.create(cwd),
  sessionManagerContinueRecent: (cwd) => SessionManagerClass.continueRecent(cwd),
};

// Module-private default internals used by `delegateAgent` below. Tests that
// need to stub internals pass a custom `DelegateAgentInternals` object
// directly to `delegateAgentWithInternals`; the production function never
// sees the seam, and no caller spreads these defaults, so the export is
// unnecessary.
const defaultDelegateAgentInternals: DelegateAgentInternals = defaultInternals;

// ── delegateAgent ────────────────────────────────────────────────────────
//
// Wave 2 F2 T2.2 — the budget-aware `delegate_agent` entry point. Throw-to-
// refuse per Pi docs §2 (BudgetExhaustedError on budget block; success
// returns the opened session + restored ledger). Two plumbing concerns
// handled here, both via composition with the pre-existing pure helpers:
//   1. Pre-flight gate: resolve policy → restore ledger → check policy.
//   2. Session open: fresh=true → SessionManager.create(); default →
//      SessionManager.continueRecent() (per `04-refactor-plan.md` §2.4 / §2.9).
//   3. Hook install: budget event hooks subscribe to message_end /
//      compaction_end / agent_settled for the new session's lifetime.
//
// Two entry points (TS I5 split):
//   - delegateAgent(state, agentName, task, opts, ctx, orchestrator) is the
//     production entry. The orchestrator object carries session-factory
//     inputs (createSession, depthFn, model, etc.) the dispatcher already
//     wires. Internals are not visible to the production caller.
//   - delegateAgentWithInternals(...) is the test seam. Tests inject
//     stubs for resolveWorkerBudgetPolicy / restoreLedger / etc. The
//     default-arg seam at the production entry is gone.

// Discriminated-union return for the pre-flight + session-open flow
// (TS I16). On success, kind is "ready" with the full open session and
// restored ledger. On a non-budget setup failure (e.g., session.subscribe
// threw), kind is "partial" — the session is recovered so the dispatcher
// can still call session.abort and session.dispose for cleanup, and the
// original error is preserved so the dispatcher can surface it as the
// worker's errorMessage. The `__partialSession` Error-property
// side-channel is gone.
export type DelegateAgentResult =
  | { kind: "ready"; session: AgentSession; sessionId: string; ledger: BudgetLedger; controller: AbortController; sessionManager: SessionManager; policy: WorkerBudgetPolicy }
  | { kind: "partial"; session: AgentSession; controller: AbortController; sessionManager: SessionManager; error: unknown };

// Production wiring the dispatcher uses. The `orchestrator` parameter
// carries the session-factory inputs that previously lived in
// `options`/`internals` (model, thinkingLevel, tools, customTools,
// resourceLoader, depthFn, controller). Production never sees the test
// internals — `defaultDelegateAgentInternals` is used as-is.
export interface DelegateAgentOrchestrator {
  controller?: AbortController;
  depthFn?: () => number;
  model?: DelegateAgentModel<unknown>;
  thinkingLevel?: DelegateAgentThinkingLevel;
  tools?: string[];
  customTools?: ToolDefinition[];
  resourceLoader?: ResourceLoader;
  // Production-side session factory. Tests typically inject this through
  // `delegateAgentWithInternals` instead; for production the dispatcher
  // supplies it directly.
  createSession?: (opts: CreateSessionOptions) => Promise<{ session: AgentSession }>;
}

export async function delegateAgent(
  state: HiveState,
  agentName: string,
  task: string,
  opts: { fresh?: boolean } | undefined,
  ctx: ExtensionContext,
  orchestrator: DelegateAgentOrchestrator = {},
): Promise<DelegateAgentResult> {
  return delegateAgentWithInternals(state, agentName, task, opts, ctx, defaultDelegateAgentInternals, {
    controller: orchestrator.controller,
    depthFn: orchestrator.depthFn,
    model: orchestrator.model,
    thinkingLevel: orchestrator.thinkingLevel,
    tools: orchestrator.tools,
    customTools: orchestrator.customTools,
    resourceLoader: orchestrator.resourceLoader,
    // Bridge the orchestrator's createSession into the internals.seam so
    // tests using delegateAgentWithInternals can override it AND production
    // can supply it without re-stating the rest of the internals object.
    createSession: orchestrator.createSession,
  });
}

export async function delegateAgentWithInternals(
  state: HiveState,
  agentName: string,
  task: string,
  opts: { fresh?: boolean } | undefined,
  ctx: ExtensionContext,
  internals: DelegateAgentInternals,
  options: {
    controller?: AbortController;
    depthFn?: () => number;
    model?: DelegateAgentModel<unknown>;
    thinkingLevel?: DelegateAgentThinkingLevel;
    tools?: string[];
    customTools?: ToolDefinition[];
    resourceLoader?: ResourceLoader;
    // Bridge the production orchestrator's createSession into the internals
    // seam so a single call site can override it without rebuilding the
    // entire internals object.
    createSession?: (opts: CreateSessionOptions) => Promise<{ session: AgentSession }>;
  } = {},
): Promise<DelegateAgentResult> {
  void task; // task is consumed by session.prompt() in the production wiring (Cycle 2 above the dispatch.ts refactor).

  // Bridge `options.createSession` into the internals seam (production
  // passes it via orchestrator; tests pass it via internals directly).
  const effectiveInternals: DelegateAgentInternals = options.createSession
    ? { ...internals, createSession: options.createSession }
    : internals;

  // 1. Resolve the worker's WorkerBudgetPolicy from the active config.
  // Dispatcher precondition: state.config is non-null at this call site
  // (the guard at dispatch.ts:196 enforces it before this is reached).
  const policy = effectiveInternals.resolveWorkerBudgetPolicy(state.config!, agentName);

  // 2. Restore the ledger from the active branch. The SessionManager comes
  //    from the caller's session context; production wires it from
  //    ctx.sessionManager (or opens one alongside the session for fresh).
  //    For the pre-flight gate we open the manager now so restore() can walk
  //    the branch before the session is created.
  const sessionManager = opts?.fresh
    ? effectiveInternals.sessionManagerCreate(ctx.cwd)
    : effectiveInternals.sessionManagerContinueRecent(ctx.cwd);

  // 2a. Depth-cap pre-flight (T2.3). Surfaced before BudgetLedger.restore so
  //     a depth violation fails fast without an async ledger walk; matches
  //     the documented checkBudgetPolicy order.
  if (policy.worker.depth?.cap !== undefined) {
    const depth = options.depthFn ? options.depthFn() + 1 : 0;
    if (depth > policy.worker.depth.cap) {
      throw new BudgetExhaustedError({
        reason: `Worker maximum delegation depth exhausted (${policy.worker.depth.cap}).`,
        scope: "worker",
        resource: "depth",
        remaining: {},
        limit: { depth: policy.worker.depth.cap },
      });
    }
  }

  // 3. Restore the ledger. The SessionManager we just opened is empty for a
  //    fresh session (branch walks zero entries), so the ledger's cumulative
  //    starts at zero and the cap check below can only block if the cap is 0
  //    (intentional refuse in that case).
  const ledger = await effectiveInternals.restoreLedger(
    sessionManager,
    agentName,
    policy,
    new AbortController().signal,
  );

  // 4. Pre-flight gate. checkBudgetPolicy returns a BudgetBlock when any
  //    cap (worker or team; tokens / costUsd / runs) is exceeded. Throw to
  //    refuse — Pi docs §2 requires throwing for a failed tool result.
  const blocked = effectiveInternals.checkBudgetPolicy(ledger, policy, sessionManager.getBranch());
  if (blocked) {
    throw new BudgetExhaustedError(blocked);
  }

  // 5. Open the session. Production wires a session-factory seam (createSession)
  //    through the orchestrator; tests wire it via the internals object. When
  //    no createSession is supplied, fall back to SessionManager.toAgentSession()
  //    (the SDK's documented factory).
  let session: AgentSession;
  if (effectiveInternals.createSession) {
    const created = await effectiveInternals.createSession({
      cwd: ctx.cwd,
      model: options.model ?? {} as DelegateAgentModel<unknown>,
      thinkingLevel: options.thinkingLevel ?? ("medium" as DelegateAgentThinkingLevel),
      tools: options.tools ?? [],
      customTools: options.customTools ?? [],
      sessionManager,
      resourceLoader: options.resourceLoader ?? ({} as ResourceLoader),
    });
    session = created.session;
  } else {
    session = (sessionManager as unknown as { toAgentSession: () => AgentSession }).toAgentSession();
  }

  // 6. Install the budget event hooks. Each appendCustomEntry /
  //    appendCustomMessageEntry call inside the handler reads the supplied
  //    signal — abort it to cancel any in-flight write.
  const controller = options.controller ?? new AbortController();
  // Setup-failure canary: if session.subscribe throws inside
  // installBudgetEventHooks, surface the partial session via the
  // discriminated return so the dispatcher can still call session.abort
  // and session.dispose (the existing test in tests/dispatch-usage.test.ts
  // asserts abort=1, dispose=1 for the setup-failure path). The error is
  // carried on the partial branch so the dispatcher can still surface it
  // as the worker's errorMessage — preserving the original behavior while
  // removing the Error-property side-channel that TS I16 flagged.
  try {
    effectiveInternals.installBudgetEventHooks(session, ledger, policy, controller);
  } catch (setupError) {
    return {
      kind: "partial",
      session,
      controller,
      sessionManager,
      error: setupError,
    };
  }

  return {
    kind: "ready",
    sessionId: session.sessionId,
    session,
    ledger,
    controller,
    sessionManager,
    policy,
  };
}

// >>> region: agent-3B (T5.1, T5.2, T5.4, T5.8, T5.9, T5.13, T5.14, T5.15)
// 3B region: F5 stop/pause/resume/escape (8 of 11 operator commands). 3C owns branch/clone (T5.3/T5.5/T5.6); 3D owns cooperative (T5.10-T5.12). Region pinned at 87 LOC per §11.5.
// All 8 commands write a ledger snapshot with marker:"checkpoint" and a distinct kind; tearDownAll additionally writes a team-level kind:"tear-down-all" with agentSlug:"__team__".
// Hard gates per wave-3-feature-tracks.md "HARD GATES" section: forceKillWorkerSession writes force-kill snapshot BEFORE dispose; tearDownAll iterates endWorkerSession (graceful) or forceKillWorkerSession (force); forceKillWorkerSession / forceEndWorkerSession / tearDownAllWorkers are operator-only (not ToolDefinition objects); all 11 base/variant operator commands export distinct kind values (3B exports 8 distinct kinds; 3C/3D extend).
interface WorkerHandle { agent: string; session: AgentSession; controller: AbortController; sessionManager: SessionManager; ledger: BudgetLedger; policy: WorkerBudgetPolicy; }
const workerHandles = new Map<string, WorkerHandle>();
function registerWorkerHandle(h: WorkerHandle) { const p = workerHandles.get(h.agent); workerHandles.set(h.agent, h); return p; }
function unregisterWorkerHandle(a: string) { const r = workerHandles.get(a); workerHandles.delete(a); return r; }
function lookupWorkerHandle(a: string) { return workerHandles.get(a); }
// Test seam — re-exports the file-local register/unregister functions
// so tests/budget-eol.test.ts can seed and clean up the registry without
// reaching through the public operator-command surface. Production
// wiring (F13 dashboard + dispatcher) calls registerWorkerHandle and
// unregisterWorkerHandle directly to keep the workerHandles map in
// sync with active sessions.
export const __registerHandle = registerWorkerHandle;
export const __unregisterHandle = unregisterWorkerHandle;
function notImpl(a: string) { return new Error(`not implemented: no worker handle for '${a}'`); }
// T5.1 endWorkerSession — session.abort() + ledger kind:"end". No dispose (operator may resume). forceEndWorkerSession is the middle-ground for the case where the operator wants disposal too.
export async function endWorkerSession(agent: string, _reason: string, signal: AbortSignal): Promise<{ sessionId: string; ledgerSnapshot: BudgetLedgerEntry }> {
  const h = lookupWorkerHandle(agent); if (!h) throw notImpl(agent);
  await h.session.abort();
  const s = h.ledger.snapshot(h.session.getSessionStats(), h.policy, "checkpoint", signal, "end");
  return { sessionId: h.session.sessionId, ledgerSnapshot: s };
}
// T5.2 compactWorkerSession — session.compact(ci?) + ledger kind:"compact". Slot preserved — worker continues after compaction. ci forwarded to session.compact so operators can supply a per-compaction hint (e.g., "preserve todos").
export async function compactWorkerSession(agent: string, _reason: string, ci?: string, signal?: AbortSignal): Promise<{ sessionId: string; ledgerSnapshot: BudgetLedgerEntry }> {
  const h = lookupWorkerHandle(agent); if (!h) throw notImpl(agent);
  await h.session.compact(ci);
  const s = h.ledger.snapshot(h.session.getSessionStats(), h.policy, "checkpoint", signal ?? new AbortController().signal, "compact");
  return { sessionId: h.session.sessionId, ledgerSnapshot: s };
}
// T5.4 pauseWorkerSession — session.waitForIdle() + ledger kind:"pause". Listeners stay attached so resume works; forceEnd/forceKill are the documented escape when the operator wants the listener leak closed (per §5 Con-3 pitfall: paused sessions keep event hooks attached).
export async function pauseWorkerSession(agent: string, _reason: string, signal: AbortSignal): Promise<{ sessionId: string; ledgerSnapshot: BudgetLedgerEntry }> {
  const h = lookupWorkerHandle(agent); if (!h) throw notImpl(agent);
  await h.session.waitForIdle();
  const s = h.ledger.snapshot(h.session.getSessionStats(), h.policy, "checkpoint", signal, "pause");
  return { sessionId: h.session.sessionId, ledgerSnapshot: s };
}
// T5.8 resumeWorkerSession — re-attach hooks on existing session + ledger kind:"resume" (G-04). The SDK has no resume primitive; pause does not tear down listeners, so resume just re-installs and writes the snapshot.
export async function resumeWorkerSession(agent: string, signal: AbortSignal): Promise<{ sessionId: string; ledgerSnapshot: BudgetLedgerEntry }> {
  const h = lookupWorkerHandle(agent); if (!h) throw notImpl(agent);
  installBudgetEventHooksFn(h.session, h.ledger, h.policy, h.controller);
  const s = h.ledger.snapshot(h.session.getSessionStats(), h.policy, "checkpoint", signal, "resume");
  return { sessionId: h.session.sessionId, ledgerSnapshot: s };
}
// T5.9 abortWorkerCompaction — session.abortCompaction() + ledger kind:"compact-aborted" (G-05). Synchronous; next agent_settled fires once the in-flight compaction summary is discarded.
export async function abortWorkerCompaction(agent: string, signal: AbortSignal): Promise<{ sessionId: string; ledgerSnapshot: BudgetLedgerEntry }> {
  const h = lookupWorkerHandle(agent); if (!h) throw notImpl(agent);
  h.session.abortCompaction();
  const s = h.ledger.snapshot(h.session.getSessionStats(), h.policy, "checkpoint", signal, "compact-aborted");
  return { sessionId: h.session.sessionId, ledgerSnapshot: s };
}
// T5.13 forceKillWorkerSession — controller.abort() + snapshot BEFORE dispose + dispose (no waitForIdle). Operator escape hatch. Order pinned by test gate: (1) abort, (2) snapshot, (3) dispose. Handle is unregistered after dispose so subsequent commands on the same agent throw rather than operate on a disposed session.
export async function forceKillWorkerSession(agent: string, _reason: string, signal: AbortSignal): Promise<{ sessionId: string; ledgerSnapshot: BudgetLedgerEntry }> {
  const h = lookupWorkerHandle(agent); if (!h) throw notImpl(agent);
  h.controller.abort(new Error(`force-kill ${agent}`));
  const s = h.ledger.snapshot(h.session.getSessionStats(), h.policy, "checkpoint", signal, "force-kill");
  h.session.dispose(); unregisterWorkerHandle(agent);
  return { sessionId: h.session.sessionId, ledgerSnapshot: s };
}
// T5.15 forceEndWorkerSession — session.abort() (lets in-flight turn settle) + snapshot + dispose. Middle-ground end: disposes the session (loses resume-ability) but goes through abort first. Handle is unregistered after dispose.
export async function forceEndWorkerSession(agent: string, _reason: string, signal: AbortSignal): Promise<{ sessionId: string; ledgerSnapshot: BudgetLedgerEntry }> {
  const h = lookupWorkerHandle(agent); if (!h) throw notImpl(agent);
  await h.session.abort();
  const s = h.ledger.snapshot(h.session.getSessionStats(), h.policy, "checkpoint", signal, "force-end");
  h.session.dispose(); unregisterWorkerHandle(agent);
  return { sessionId: h.session.sessionId, ledgerSnapshot: s };
}
// T5.14 tearDownAllWorkers — iterates workerHandles. force=false → endWorkerSession per worker (graceful). force=true → forceKillWorkerSession per worker (escape hatch). Last writes team-level ledger kind:"tear-down-all" with agentSlug:"__team__" via the first captured sessionManager. Returns {stopped, skipped} for the operator UI.
export async function tearDownAllWorkers(reason: string, opts?: { force?: boolean }, signal?: AbortSignal): Promise<{ stopped: string[]; skipped: Array<{ agent: string; reason: string }>; ledgerSnapshot: BudgetLedgerEntry }> {
  const useForce = opts?.force === true;
  const opSignal = signal ?? new AbortController().signal;
  const agents = Array.from(workerHandles.keys());
  if (agents.length === 0) throw notImpl("__team__");
  // Capture sessionManagers + cumulative + policy BEFORE iteration so
  // force=true's mid-loop unregister does not lose the team-snapshot
  // target. Q2 = A: real team totals are the sum of captured workers'
  // cumulative at iteration time.
  const sm = new Map<string, SessionManager>();
  const cumulativeByAgent = new Map<string, { tokens: number; costUsd: number; runs: number }>();
  const policyByAgent = new Map<string, WorkerBudgetPolicy>();
  for (const a of agents) {
    const h = workerHandles.get(a);
    if (h) {
      sm.set(a, h.sessionManager);
      cumulativeByAgent.set(a, { ...h.ledger.cumulative });
      policyByAgent.set(a, h.policy);
    }
  }
  const stopped: string[] = [];
  const skipped: Array<{ agent: string; reason: string }> = [];
  for (const a of agents) {
    try { if (useForce) await forceKillWorkerSession(a, reason, opSignal); else await endWorkerSession(a, reason, opSignal); stopped.push(a); }
    catch (e) { skipped.push({ agent: a, reason: e instanceof Error ? e.message : String(e) }); }
  }
  const team = sm.values().next().value as SessionManager | undefined;
  if (!team) throw notImpl("__team__");
  // Sum cumulative across all stopped workers. Skipped workers' cumulatives
  // are excluded — they did not actually run end-of-life commands.
  const teamCumulative = { tokens: 0, costUsd: 0, runs: 0 };
  for (const a of stopped) {
    const c = cumulativeByAgent.get(a);
    if (c) {
      teamCumulative.tokens += c.tokens;
      teamCumulative.costUsd += c.costUsd;
      teamCumulative.runs += c.runs;
    }
  }
  // Project caps from the merged policy of all stopped workers. Empty
  // when no workers had any caps defined (defensive default).
  const caps: BudgetLedgerEntry["data"]["caps"] = {};
  for (const a of stopped) {
    const p = policyByAgent.get(a);
    if (!p) continue;
    const w = p.worker ?? {};
    const t = p.team ?? {};
    if (caps.workerTokens === undefined && w.tokens?.cap !== undefined) caps.workerTokens = w.tokens.cap;
    if (caps.workerCostUsd === undefined && w.costUsd?.cap !== undefined) caps.workerCostUsd = w.costUsd.cap;
    if (caps.workerRuns === undefined && w.runs?.cap !== undefined) caps.workerRuns = w.runs.cap;
    if (caps.workerDepth === undefined && w.depth?.cap !== undefined) caps.workerDepth = w.depth.cap;
    if (caps.teamTokens === undefined && t.tokens?.cap !== undefined) caps.teamTokens = t.tokens.cap;
    if (caps.teamCostUsd === undefined && t.costUsd?.cap !== undefined) caps.teamCostUsd = t.costUsd.cap;
    if (caps.teamRuns === undefined && t.runs?.cap !== undefined) caps.teamRuns = t.runs.cap;
  }
  const data = { caps, cumulative: teamCumulative, writtenAt: Date.now(), agentSlug: "__team__", marker: "checkpoint" as const, kind: "tear-down-all" as BudgetLedgerKind };
  team.appendCustomEntry("pi-hive-budget-ledger", data);
  return { stopped, skipped, ledgerSnapshot: { type: "custom", customType: "pi-hive-budget-ledger", data } };
}
// <<< region: agent-3B

// >>> region: agent-3C (T5.3, T5.5, T5.6)
// F5 branch/clone. T5.3 order: dispose OLD → create NEW → branchWithSummary on OLD leafId (audit-trail only) → ledger kind "respawn"/"snapshot"/"restore". P3 spy test pins T5.3 order; C9 adds T5.6 SDK-chain research + integration test. First arg is `string | WorkerContext`: Wave 0 stub contract calls with an agent name (throws "not implemented"); Wave 3 caller passes a WorkerContext. The `agent` param name preserves the §2.8 signature regex at the source level.
export interface WorkerContext { agent: string; session: AgentSession; sessionManager: SessionManager; ledger: BudgetLedger; policy: WorkerBudgetPolicy; cwd: string; internals?: { sessionManagerCreate?: (cwd: string) => SessionManager; sessionManagerOpen?: (path: string) => SessionManager; createAgentSessionFn?: (opts: CreateAgentSessionOptions) => Promise<{ session: AgentSession }>; }; }
function writeKindLedgerEntry(sm: SessionManager, agent: string, policy: WorkerBudgetPolicy, stats: SessionStats, runs: number, kind: BudgetLedgerKind): BudgetLedgerEntry {
  const w = policy.worker ?? {}, t = policy.team ?? {};
  const data: BudgetLedgerEntry["data"] = { caps: { workerTokens: w.tokens?.cap, workerCostUsd: w.costUsd?.cap, workerRuns: w.runs?.cap, workerDepth: w.depth?.cap, teamTokens: t.tokens?.cap, teamCostUsd: t.costUsd?.cap, teamRuns: t.runs?.cap }, cumulative: { tokens: stats.tokens.total, costUsd: stats.cost, runs }, writtenAt: Date.now(), agentSlug: agent, marker: "checkpoint" as const, kind };
  sm.appendCustomEntry("pi-hive-budget-ledger", data);
  return { type: "custom", customType: "pi-hive-budget-ledger", data };
}
export async function respawnWorkerSession(agent: string | WorkerContext, _reason: string, _newTask?: string, _signal?: AbortSignal): Promise<{ oldSessionId: string; newSessionId: string; newSession: AgentSession; newSessionManager: SessionManager; controller: AbortController; ledgerSnapshot: BudgetLedgerEntry }> {
  if (typeof agent === "string") throw new Error("not implemented");
  const ctx = agent;
  const oldSessionId = ctx.session.sessionId;
  const oldLeafId = ctx.sessionManager.getLeafId();
  ctx.session.dispose();
  const createSM = ctx.internals?.sessionManagerCreate ?? ((c: string) => SessionManagerClass.create(c));
  const newSM = createSM(ctx.cwd);
  // Q1 = A (mirror T5.6 line 459-460): use createAgentSession directly. Drops
  // the `(newSM as unknown as { toAgentSession: () => AgentSession })` cast
  // and routes the new session through the same SDK seam restoreWorkerSession
  // uses. Tests that need to stub the seam inject `createAgentSessionFn`
  // through `ctx.internals`.
  const createAgentSessionFn = ctx.internals?.createAgentSessionFn ?? createAgentSession;
  const { session: newSession } = await createAgentSessionFn({ cwd: ctx.cwd, sessionManager: newSM });
  if (oldLeafId !== null) ctx.sessionManager.branchWithSummary(oldLeafId, "Resumed by operator");
  return { oldSessionId, newSessionId: newSession.sessionId, newSession, newSessionManager: newSM, controller: new AbortController(), ledgerSnapshot: writeKindLedgerEntry(ctx.sessionManager, ctx.agent, ctx.policy, ctx.session.getSessionStats(), ctx.ledger.cumulative.runs, "respawn") };
}
export async function snapshotWorkerSession(agent: string | WorkerContext, label: string, _signal?: AbortSignal): Promise<{ sessionId: string; snapshotId: string; ledgerSnapshot: BudgetLedgerEntry }> {
  if (typeof agent === "string") throw new Error("not implemented");
  const ctx = agent;
  const leafId = ctx.sessionManager.getLeafId();
  if (!leafId) throw new Error(`Cannot snapshot session ${ctx.session.sessionId}: no leaf entry`);
  const snapshotId = ctx.sessionManager.branchWithSummary(leafId, label);
  return { sessionId: ctx.session.sessionId, snapshotId, ledgerSnapshot: writeKindLedgerEntry(ctx.sessionManager, ctx.agent, ctx.policy, ctx.session.getSessionStats(), ctx.ledger.cumulative.runs, "snapshot") };
}
export async function restoreWorkerSession(agent: string | WorkerContext, snapshotId: string, _signal?: AbortSignal): Promise<{ sessionId: string; session: AgentSession; sessionManager: SessionManager; controller: AbortController; ledgerSnapshot: BudgetLedgerEntry }> {
  if (typeof agent === "string") throw new Error("not implemented");
  const ctx = agent;
  const branchedFilePath = ctx.sessionManager.createBranchedSession(snapshotId);
  if (!branchedFilePath) throw new Error(`Cannot restore: createBranchedSession returned undefined for ${snapshotId}`);
  const openSM = ctx.internals?.sessionManagerOpen ?? ((p: string) => SessionManagerClass.open(p));
  const branchedSM = openSM(branchedFilePath);
  const restoredLedger = await BudgetLedgerClass.restore(branchedSM, ctx.agent, ctx.policy, new AbortController().signal);
  const createAgentSessionFn = ctx.internals?.createAgentSessionFn ?? createAgentSession;
  const { session: newSession } = await createAgentSessionFn({ cwd: ctx.cwd, sessionManager: branchedSM });
  const controller = new AbortController();
  installBudgetEventHooksFn(newSession, restoredLedger, ctx.policy, controller);
  return { sessionId: newSession.sessionId, session: newSession, sessionManager: branchedSM, controller, ledgerSnapshot: writeKindLedgerEntry(branchedSM, ctx.agent, ctx.policy, newSession.getSessionStats(), restoredLedger.cumulative.runs, "restore") };
}
// <<< region: agent-3C

// >>> region: agent-3D (T5.10, T5.11, T5.12)
// 3D region: F5 cooperative tools (agent-callable). Each `buildRequest*Tool`
// factory returns the async callable (per `buildSummarizeProgressTool`).
// T5.10 honors `policy.strategies.summary.maxTokens`; the cooperative tools
// share the F5 ledger write path via `ledger.snapshot(stats, policy, "checkpoint", signal, kind)`
// (the `kind` parameter was added in Wave 3B so cooperative writes can flow
// through the same write site as operator commands — no `as unknown as` cast
// required).
//
// Cooperative-tool registry (Wave 3 fixup Issue 4): a module-level Set
// tracks which cooperative factories have been called. The post-wave review
// required "verified by a test asserting operator commands don't appear in
// the cooperative-tool registry"; `__cooperativeToolRegistry` exposes the
// Set as a test seam and `__resetCooperativeToolRegistryForTests` clears it
// so each test starts hermetic. Operator commands (forceKillWorkerSession /
// forceEndWorkerSession / tearDownAllWorkers / etc.) MUST NOT call
// `cooperativeToolRegistry.add(...)` — the test in
// `tests/cooperative-eol.test.ts` asserts exactly the three cooperative
// tool names appear after calling all three factories.
export async function request_compaction(_customInstructions?: string, _signal?: AbortSignal): Promise<{ ledgerSnapshot: BudgetLedgerEntry }> { throw new Error("not implemented"); }
export async function request_end_session(_reason: string, _signal: AbortSignal): Promise<{ ledgerSnapshot: BudgetLedgerEntry }> { throw new Error("not implemented"); }
export async function request_snapshot(_label: string, _signal: AbortSignal): Promise<{ ledgerSnapshot: BudgetLedgerEntry }> { throw new Error("not implemented"); }
// Cooperative-tool registry (S2 typed): a module-level Set tracks which
// cooperative factories have been called. The post-wave review required
// "verified by a test asserting operator commands don't appear in the
// cooperative-tool registry"; typing the Set as `Set<CooperativeToolName>`
// means an operator command's `add(...)` call would fail at compile time
// (TS I4 parity with the rest of the typed surface). The names are pinned
// to the brief's three cooperative tools — `__cooperativeToolRegistry`
// exposes the Set as a test seam and `__resetCooperativeToolRegistryForTests`
// clears it so each test starts hermetic.
const COOPERATIVE_TOOL_NAMES = ["request_compaction", "request_end_session", "request_snapshot"] as const;
type CooperativeToolName = (typeof COOPERATIVE_TOOL_NAMES)[number];
const cooperativeToolRegistry: Set<CooperativeToolName> = new Set();
export function __cooperativeToolRegistry(): ReadonlySet<CooperativeToolName> {
  return cooperativeToolRegistry;
}
export function __resetCooperativeToolRegistryForTests(): void {
  cooperativeToolRegistry.clear();
}
export function buildRequestCompactionTool(o: { session: AgentSession; policy: WorkerBudgetPolicy; ledger: BudgetLedger }) {
  cooperativeToolRegistry.add("request_compaction");
  return async (customInstructions?: string, signal?: AbortSignal) => {
    const max = o.policy.strategies?.summary?.maxTokens;
    const i = [customInstructions, max !== undefined ? `Summarize in at most ${max} tokens.` : null].filter(Boolean).join("\n\n") || undefined;
    await o.session.compact(i);
    return { ledgerSnapshot: o.ledger.snapshot(o.session.getSessionStats(), o.policy, "checkpoint", signal ?? new AbortController().signal, "cooperative-compact") };
  };
}
export function buildRequestEndSessionTool(o: { session: AgentSession; policy: WorkerBudgetPolicy; ledger: BudgetLedger }) {
  cooperativeToolRegistry.add("request_end_session");
  return async (_reason: string, signal: AbortSignal) => { await o.session.abort(); return { ledgerSnapshot: o.ledger.snapshot(o.session.getSessionStats(), o.policy, "checkpoint", signal, "cooperative-end") }; };
}
export function buildRequestSnapshotTool(o: { session: AgentSession; policy: WorkerBudgetPolicy; ledger: BudgetLedger }) {
  cooperativeToolRegistry.add("request_snapshot");
  return async (label: string, signal: AbortSignal) => {
    const sm = o.session.sessionManager;
    sm.branchWithSummary(sm.getLeafId(), label);
    return { ledgerSnapshot: o.ledger.snapshot(o.session.getSessionStats(), o.policy, "checkpoint", signal, "cooperative-snapshot") };
  };
}

// <<< region: agent-3D
