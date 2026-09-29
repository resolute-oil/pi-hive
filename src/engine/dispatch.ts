import { type ExtensionContext, type ToolDefinition, SessionManager } from "@earendil-works/pi-coding-agent";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { TYPE_SCOPED_TOOL_NAMES } from "../core/constants";
import type { AgentRuntime, HiveState } from "../core/types";
import { modelFrom, normalizeWorkerTools, agentSlug, truncateMiddle } from "../core/utils";
import { logRecord } from "./state";
import { currentAgentName, currentChangeId, currentDelegationDepth, reloadAgentConfig, runAsAgent, runAtDelegationDepth, runWithChange } from "./session";
import { canDelegateTo } from "./domain";
import { buildWorkerPrompt } from "./prompts";
import { emitHiveEvent, runtimeSummary, writeHiveStateSnapshot } from "./observability";
import { buildHiveTools } from "../agents/tools";
import { normalizeWorkerSkillPaths, workerResourceLoader } from "./worker-extension";
import { isExecutionGateOpen, isAwaitingHumanApproval } from "./openspec";
import { agentRoster, resolveRuntime } from "./agent-lookup";
import { addHiveActivity } from "../ui/tui/activity";
import { resolveConfiguredPath } from "../core/safe-path";
import { acquireWorkerSlot, releaseWorkerSlot } from "./worker-queue";
import { WorkerRunLifecycle } from "./worker-lifecycle";
import { persistReviewerVerdict } from "./reviewer-verdict";
import { createWorkerSubscriptionHandler, type WorkerSubscriptionState } from "./worker-subscription";
import { applySessionStatsToRuntime } from "./runtime-stats";
import { emitDelegationEnd } from "./delegation-end";
import { isPendingArtifactRevisionTask } from "./dispatch-helpers";
import { modelKey, resolveModel } from "./model-resolution";
import { BUDGET_EXHAUSTED_ERROR_NAME, buildBudgetExhaustedEnvelope, runBudgetPreflight, createBudgetAwareSession } from "./budget/worker-tools";
// Hard cap to keep shared telemetry rows from blowing up on accidental
// multi-hundred-KB worker dumps. 64 KB is high enough that normal review
// verdicts are not middle-elided in the web UI.
const DELEGATION_EVENT_MESSAGE_LIMIT = 64_000;

function publishRuntimeUpdate(state: HiveState) {
  state.onRuntimeUpdate?.(state);
}

// Archive the current session log to a numbered run file so a fresh run can
// start clean without losing the prior run's transcript.
function archivePriorRun(sessionFile: string) {
  const dir = dirname(sessionFile);
  const base = basename(sessionFile, ".jsonl"); // e.g. "core-tester"
  let existing: string[] = [];
  try { existing = readdirSync(dir); } catch { /* dir may not exist */ }
  const re = new RegExp(`^${base}\\.run-(\\d+)\\.jsonl$`);
  let max = 0;
  for (const f of existing) { const m = f.match(re); if (m) max = Math.max(max, Number(m[1])); }
  const archive = join(dir, `${base}.run-${max + 1}.jsonl`);
  renameSync(sessionFile, archive);
}

// Session factory seam (L1): defaults to the real createAgentSession, but a test
// can inject a scripted AgentSession to drive dispatchAgent end-to-end without a
// live model. Kept as the last optional param so existing callers are unchanged.
export type CreateAgentSession = typeof createAgentSession;

export function resolveWorkerSkillPaths(cwd: string, refs: unknown[] = []): string[] {
  return normalizeWorkerSkillPaths(refs).flatMap((skillPath, index) => {
    const raw = refs[index] as any;
    const allowOutside = raw?.allowOutsideProject === true || raw?.path?.allowOutsideProject === true;
    const safe = resolveConfiguredPath(cwd, skillPath, allowOutside);
    return safe ? [safe.canonicalPath] : [];
  });
}

// Re-export the artifact/verdict-inference helpers from dispatch-helpers.ts so
// existing callers (`tests/dispatch-usage.test.ts`, etc.) keep compiling
// without churn. Behavior is byte-identical to the pre-extraction versions.
export {
  inferArtifactFromReviewTask,
  inferChangeIdFromReviewTask,
  inferReviewVerdict,
  isPendingArtifactRevisionTask,
} from "./dispatch-helpers";

// Re-export the delegation-end telemetry emitter so the post-`prompt` block
// in dispatchAgent doesn't carry the full ~80-line payload assembly.
export { emitDelegationEnd } from "./delegation-end";

// Union the agent's enumerated `tools:` list with the names of any
// type-scoped tools `buildHiveTools` emitted. The Pi SDK treats `tools` as
// authoritative for the function-definitions block — a customTool whose
// name isn't in `tools` is silently dropped from the model's view even
// though its implementation is in customTools. Without this union, a
// type-scoped tool the agent didn't enumerate (e.g. submit_review_verdict on
// a reviewer whose frontmatter only lists read/grep/find/ls/bash/
// team_conversation) never reaches the function-definitions block. Exported
// so the regression test can pin the behavior without spinning up the SDK.
export function dispatchToolNames(toolNames: string[], hiveTools: ReadonlyArray<ToolDefinition | { name: string }>): string[] {
  return Array.from(new Set([...toolNames, ...hiveTools.map((t) => t.name)]));
}

export async function dispatchAgent(
  state: HiveState, agentName: string, task: string, ctx: ExtensionContext, fresh = false,
  createSession: CreateAgentSession = createAgentSession,
  abortSignal?: AbortSignal,
  isReadOnly?: boolean,
): Promise<{ output: string; exitCode: number; elapsed: number }> {
  if (!state.config || !state.session) throw new Error("hive is not initialized");
  const caller = currentAgentName();
  const runtime = resolveRuntime(state, agentName);
  if (!runtime) {
    const available = agentRoster(state);
    return { output: `Unknown agent "${agentName}". Available: ${available}`, exitCode: 1, elapsed: 0 };
  }
  // fresh=true reloads the worker's config from YAML so edits to the agent's
  // .md or hive-config.yaml since session_start take effect. Without this,
  // runtime.config (domain, tools, model, governance, agentType, …) stays
  // frozen at session_start and the "I edited the .md and re-delegated"
  // workflow silently uses the old grant — see the dispatch.ts fresh archive
  // block below for the conversation-continuity side of the same flag.
  //
  // Reload happens here, before the plan-mode / hive-mode / budget / prompt
  // captures, so every guard and the worker's actual run see the fresh
  // values. Best-effort: a YAML re-parse failure leaves the runtime as-is
  // (and the frozen config is still valid; the user can restart the session).
  if (fresh) {
    reloadAgentConfig(state, ctx, runtime);
  }
  // Plan mode delegates to planners, leads, AND reviewers (Phase 5.1 decision):
  // reviewers give plan-phase feedback but stay read-only on files via the type
  // matrix, so they are safe to run during planning. coder/tester remain blocked
  // (they mutate; that needs an approved plan + hive/execute mode).
  if (state.mode === "plan" && !["planner", "lead", "reviewer"].includes(runtime.config.agentType || "")) {
    return { output: `Delegation blocked: plan mode may only delegate to planners, leads, or reviewers; ${runtime.config.name} is agent-type "${runtime.config.agentType || "unknown"}". Switch to hive mode or use /hive:execute after tasks approval for execution.`, exitCode: 1, elapsed: 0 };
  }
  // Hard per-artifact planning stop: once a planner has authored an artifact and
  // it is awaiting the human's review, the pipeline HALTS — no planner may author
  // the next artifact until the human approves the pending one in the review UI.
  // Reviewers still run. If an agent review finds defects before the human has
  // decided, allow an explicit same-artifact revision task instead of forcing a
  // pointless human reject/deny round-trip.
  if (state.mode === "plan" && runtime.config.agentType === "planner") {
    const changeId = currentChangeId() || state.activeChangeId || "";
    const pending = changeId ? isAwaitingHumanApproval(ctx.cwd, changeId) : null;
    if (pending && !isPendingArtifactRevisionTask(task, pending)) {
      return { output: `Delegation blocked: the "${pending}" artifact for change "${changeId}" is authored and awaiting human review in the dashboard. The planning pipeline holds until it is approved (or denied for revision). Ask the human to review it at the Plans tab; reviewers may still run.`, exitCode: 1, elapsed: 0 };
    }
  }
  if (state.mode === "hive" && (runtime.config.agentType === "coder" || runtime.config.agentType === "tester")) {
    const changeId = currentChangeId() || state.activeChangeId || "";
    if (!changeId || !isExecutionGateOpen(ctx.cwd, changeId)) {
      return { output: `Delegation blocked: execution agents require an approved plan. Draft the OpenSpec change in plan mode (/opsx-propose), get the tasks artifact approved in the review UI, then run /hive:execute <change-id>. Active change: ${changeId || "none"}.`, exitCode: 1, elapsed: 0 };
    }
  }
  const permission = canDelegateTo(state, caller, agentSlug(runtime.config), isReadOnly);
  if (!permission.ok) {
    return { output: `Delegation blocked: ${permission.reason}`, exitCode: 1, elapsed: 0 };
  }
  if (runtime.status === "running") {
    return { output: `${runtime.config.name} is already running.`, exitCode: 1, elapsed: runtime.elapsedMs };
  }
  const delegationDepth = currentDelegationDepth() + 1;
  // Wave 2 / F2 — new budget pre-flight via `runBudgetPreflight`. Honors
  // the new F6 nested `budgets:` shape (per-agent + per-worker/per-team
  // settings). Throws `BudgetExhaustedError` on block; translated to the
  // existing `{ output, exitCode: 1 }` envelope so the tool harness keeps
  // its contract.
  try {
    await runBudgetPreflight(state, agentName, ctx);
  } catch (error: any) {
    if (error?.name === BUDGET_EXHAUSTED_ERROR_NAME) {
      emitHiveEvent(state, "budget_exhausted", {
        agent: runtime.config.name,
        resource: error.resource,
        scope: error.scope,
      }, caller);
      return buildBudgetExhaustedEnvelope(error);
    }
    throw error;
  }
  const willQueue = state.config.settings.maxParallel !== undefined
    && state.activeRuns >= state.config.settings.maxParallel
    && state.config.settings.queueSize !== undefined;
  const slotPromise = acquireWorkerSlot(state, abortSignal);
  if (willQueue) emitHiveEvent(state, "queue_update", { workerQueue: state.workerQueue?.length || 0, agent: runtime.config.name, phase: "queued" }, caller);
  const slot = await slotPromise;
  if (willQueue) emitHiveEvent(state, "queue_update", { workerQueue: state.workerQueue?.length || 0, agent: runtime.config.name, phase: slot }, caller);
  if (slot !== "acquired") {
    const reason = slot === "parallel"
      ? `Max parallel agent runs reached (${state.config.settings.maxParallel}); configure queue-size to enable fair waiting.`
      : slot === "queue-full"
        ? `Worker queue is full (${state.config.settings.queueSize}).`
        : "Delegation cancelled while waiting for a worker slot.";
    return { output: reason, exitCode: 1, elapsed: 0 };
  }
  // A queued request can become stale while waiting: another request may have
  // started the same worker or consumed its remaining budget.
  if ((runtime.status as AgentRuntime["status"]) === "running") {
    releaseWorkerSlot(state);
    return { output: `${runtime.config.name} is already running.`, exitCode: 1, elapsed: runtime.elapsedMs };
  }
  // Re-run the budget pre-flight after slot acquisition. Another delegation
  // (or a ledger write from a settled worker) may have drained the budget
  // while we were queued; the pre-flight must run against the current
  // branch, not the snapshot we read above.
  try {
    await runBudgetPreflight(state, agentName, ctx);
  } catch (error: any) {
    releaseWorkerSlot(state);
    if (error?.name === BUDGET_EXHAUSTED_ERROR_NAME) {
      emitHiveEvent(state, "budget_exhausted", {
        agent: runtime.config.name,
        resource: error.resource,
        scope: error.scope,
      }, caller);
      return buildBudgetExhaustedEnvelope(error);
    }
    throw error;
  }

  let prompt: string;
  try {
    prompt = buildWorkerPrompt(state, ctx, runtime, task);
  } catch (error: any) {
    releaseWorkerSlot(state);
    return { output: `Cannot prepare ${runtime.config.name}: ${error?.message || String(error)}`, exitCode: 1, elapsed: 0 };
  }
  const model = modelFrom(ctx, runtime.config.model);
  const tools = normalizeWorkerTools(runtime.config.tools, state.config.settings.defaultTools);
  const thinking = runtime.config.thinking!;
  // Fix #3: capture whether a prior transcript exists BEFORE the archive step.
  // This determines whether this dispatch is a new session (no prior transcript)
  // or a resume (existing transcript the SDK will replay on prompt()). The value
  // is used below to decide which input to pass to session.prompt(): the full
  // assembled worker context (new/fresh) or the lean task alone (resume).
  const sessionFileExisted = existsSync(runtime.sessionFile);
  // fresh=true starts this agent's conversation clean. Rather than DELETE the
  // prior session (which would lose the transcript of earlier runs while their
  // token/cost still count), ARCHIVE it to a numbered run file so the dashboard
  // can show every run. The live sessionFile always holds the current run.
  //
  // Archiving means end-of-run getSessionStats() covers ONLY the fresh session
  // (the prior transcript is no longer attached), so runtime.* will be overwritten
  // with just-this-run totals — but the run-start baselines below would still hold
  // the prior lifetime aggregates, making `runOnly − priorLifetime` go negative and
  // silently clamp to 0 (the fresh-archive under-count). Reset the lifetime
  // counters to 0 here so the baselines captured below are 0 and the per-run delta
  // equals the fresh session's real usage.
  if (fresh && existsSync(runtime.sessionFile)) {
    try {
      archivePriorRun(runtime.sessionFile);
      runtime.inputTokens = 0;
      runtime.outputTokens = 0;
      runtime.cacheReadTokens = 0;
      runtime.cacheWriteTokens = 0;
      runtime.reasoningTokens = 0;
      runtime.costUsd = 0;
    } catch { /* noop */ }
  }

  // Resolve the model FIRST, before mutating any per-run state. This is the
  // J4/Decision-5 reorder (the session is the only authoritative source of
  // getAvailableThinkingLevels(), so it must exist before delegation_start), and
  // it also means an unresolvable model aborts cleanly: no run-start field —
  // runCount, startedAt, elapsedMs, the token baselines — is touched for a run
  // that never happens (M-misc), so the previous run's stats stay intact.
  let resolvedModel: any;
  try { resolvedModel = resolveModel(ctx, model); } catch { resolvedModel = undefined; }
  if (!resolvedModel) {
    runtime.status = "error";
    releaseWorkerSlot(state);
    return { output: `Cannot resolve model "${model}" for ${runtime.config.name}.`, exitCode: 1, elapsed: 0 };
  }

  const resolvedModelKey = modelKey(resolvedModel, model);

  runtime.status = "running";
  runtime.task = task;
  runtime.lastWork = task;
  runtime.toolCount = 0;
  runtime.elapsedMs = 0;
  runtime.runCount++;
  runtime.startedAt = Date.now();
  // Wave 5 / F9 — the legacy `WorkerGovernance.timeoutMs` per-worker
  // timeout was removed by Wave 1B's hard cutover (G-16). The `timeout`
  // mechanism that used to live here is gone along with the dead
  // `governance` local.
  const runController = new AbortController();
  const abortFromParent = () => runController.abort(abortSignal?.reason);
  if (abortSignal?.aborted) abortFromParent();
  else abortSignal?.addEventListener("abort", abortFromParent, { once: true });
  const lifecycle = new WorkerRunLifecycle(state, runtime, runController.signal);
  // Run-start baselines (J8/Decision 4 + Decision 1): capture the current
  // lifetime counters as the per-run baseline so `delegation_end` can
  // subtract them and emit per-run deltas.
  runtime.runStartInputTokens = runtime.inputTokens;
  runtime.runStartOutputTokens = runtime.outputTokens;
  runtime.runStartCacheReadTokens = runtime.cacheReadTokens;
  runtime.runStartCacheWriteTokens = runtime.cacheWriteTokens;
  runtime.runStartReasoningTokens = runtime.reasoningTokens;
  runtime.runStartCostUsd = runtime.costUsd;

  const chunks: string[] = [];
  // The streaming snapshot is now tracked exclusively on `sub.streamedSnapshot`
  // (see WorkerSubscriptionState). The post-extraction dispatchAgent reads
  // it from the WorkerSubscriptionState object the handler updates.
  let session: any;
  let abortedByParent = false;
  let errorMessage: string | undefined;
  const modelsSeen = new Set<string>();
  const providersSeen = new Set<string>();
  const apisSeen = new Set<string>();
  let firstResponseId: string | undefined;
  let lastResponseId: string | undefined;
  const diagnostics: Array<{ type?: string; message?: string }> = [];
  const MAX_DIAGNOSTICS = 20;
  let lastStopReason: string | undefined;
  const toolStartedAt = new Map<string, number>();
  let lastRetryMaxAttempts: number | undefined;
  let sdkCounts: { toolCalls?: number; toolResults?: number; userMessages?: number; assistantMessages?: number } | undefined;

  // Wave 5 / F9 — declared at function scope so the post-`finally` output
  // computation below can read sub.streamedSnapshot. The handler updates
  // sub.streamedSnapshot on every `message_update` event; the local
  // `streamedSnapshot` string above is the pre-extraction backward-compat
  // shadow that the worker-subscription handler no longer touches.
  const sub: WorkerSubscriptionState = {
    chunks,
    streamedSnapshot: "",
    toolStartedAt: new Map<string, number>(),
    providersSeen,
    apisSeen,
    modelsSeen,
    firstResponseId,
    lastResponseId,
    diagnostics,
    lastRetryMaxAttempts,
    sdkCounts,
    lastStopReason,
  };

  try {
  const toolNames = tools.split(",").map((t) => t.trim()).filter(Boolean);
  // Type-scoped tools (e.g. submit_review_verdict) are granted by agent type,
  // not the tools list, so keep them even when the agent does not enumerate
  // them. buildHiveTools only emits them for the eligible type.
  const hiveTools = buildHiveTools(state, runtime.config.name).filter((t) => toolNames.includes(t.name) || TYPE_SCOPED_TOOL_NAMES.has(t.name));
  // The SDK treats `tools` as authoritative for the function-definitions
  // block — a customTool whose name isn't in `tools` is silently dropped from
  // the model's view, even though its implementation is in customTools.
  // Without this union, a type-scoped tool the agent didn't enumerate (e.g.
  // submit_review_verdict on a reviewer whose frontmatter only lists read/grep/
  // find/ls/bash/team_conversation) never reaches the function-definitions
  // block. The agent's prompt claims the tool is auto-injected; this is the
  // half of that contract that lived only in the comment until now.
  const allToolNames = dispatchToolNames(toolNames, hiveTools);
  const skillPaths = resolveWorkerSkillPaths(ctx.cwd, runtime.config.skills as unknown[]);

  // F2 spine: `createBudgetAwareSession` runs the budget pre-flight, opens
  // the worker's SessionManager, restores the ledger, creates the
  // AgentSession (via the F9 wiring dep below), installs the budget event
  // hooks, and wires the F3 tool_call guard. The F5 ledger-dependent
  // worker-only tools (cooperative tools + summarize_progress) are merged
  // into customTools by the createSession closure AFTER BudgetLedger.restore
  // — the closure receives the freshly-restored ledger and builds the
  // extended tool set.
  await createBudgetAwareSession(
    state,
    runtime.config.name,
    { fresh },
    ctx,
    {
      sessionManagerFactory: () => SessionManager.open(runtime.sessionFile),
      createSession: async (opts) => {
        // F9 wiring: the production createSession adds the resolved model,
        // scoped tools, customTools (with the F5 hiveToolsWithLedger merge),
        // and the reloaded worker resource loader.
        const workerLoader = workerResourceLoader(state, ctx.cwd, runtime.config.name, skillPaths);
        await workerLoader.reload();
        const extendedTools = opts.ledger
          ? buildHiveTools(state, runtime.config.name, opts.ledger).filter(
              (t) => !hiveTools.some((existing) => existing.name === t.name)
                && (toolNames.includes(t.name) || TYPE_SCOPED_TOOL_NAMES.has(t.name)),
            )
          : [];
        return createSession({
          cwd: ctx.cwd,
          model: resolvedModel,
          modelRegistry: (ctx as any).modelRegistry,
          thinkingLevel: thinking as any,
          tools: allToolNames,
          customTools: [...hiveTools, ...extendedTools],
          sessionManager: opts.sessionManager,
          resourceLoader: workerLoader,
        });
      },
      installWorkerHooks: true,
      currentDelegationDepth: () => delegationDepth,
      // Lifecycle-attach-before-subscribe: a throw from
      // installBudgetEventHooks (e.g. session.subscribe(...) rejects) leaves
      // the lifecycle owning the partially-created session, so the finally
      // block's lifecycle.close(failed=true) aborts and disposes it.
      onSessionCreated: (created, sm) => {
        session = created;
        lifecycle.attachSession(session);
        void sm; // sessionManager is captured in the closure above; nothing else to do
      },
    },
  );

  const abortWorker = (): void => {
    abortedByParent = true;
    runtime.lastWork = "cancelling";
    addHiveActivity(state, { kind: "delegation_end", parent: caller, agent: runtime.config.name, status: "error", text: "cancel requested" });
    void session.abort?.().catch((): undefined => undefined);
  };
  lifecycle.watchParentAbort(abortWorker);

  // Authoritative per-model thinking levels for this worker's effective model.
  // This is the SDK's own answer — no ModelRegistry plumbing needed (A10).
  try {
    const levels = session.getAvailableThinkingLevels?.();
    if (Array.isArray(levels) && levels.length) runtime.thinkingLevels = levels.map(String);
  } catch { /* capability probe is best-effort */ }

  logRecord(state, { from: caller, to: runtime.config.name, type: "delegation", message: task });
  addHiveActivity(state, { kind: "delegation_start", parent: caller, agent: runtime.config.name, status: "running", text: task });
  emitHiveEvent(state, "delegation_start", {
    from: caller,
    to: runtime.config.name,
    task,
    fresh,
    // Store the effective model key, not the raw config value (which may be
    // "inherit") or the full SDK object, so telemetry stays JSON/SQLite-safe.
    model: resolvedModelKey,
    configuredModel: model,
    tools,
    thinking,
    // Authoritative per-model thinking levels, captured from the session created
    // above (A10). Now populated on the FIRST run too (J4); the topology_nodes
    // sidecar fills in from this.
    thinkingLevels: runtime.thinkingLevels,
    runtime: runtimeSummary(state, runtime),
  }, caller);
  publishRuntimeUpdate(state);
  writeHiveStateSnapshot(state);

  // Every nesting level shares one process and one state.runtimes Map now, so
  // a nested delegation already mutates the same AgentRuntime the top-level
  // status modal reads directly — no cross-process mirroring needed. This
  // timer keeps elapsedMs ticking and polls the live context-window fill via
  // runtime.session (assigned above) — the same underlying data
  // ctx.getContextUsage() exposes for the top-level session's own TUI footer,
  // now readable per-worker since it's in-process.
  runtime.timer = setInterval(() => {
    runtime.elapsedMs = runtime.startedAt ? Date.now() - runtime.startedAt : runtime.elapsedMs;
    // percent is null right after compaction until a fresh assistant response
    // provides usage data again — keep the last known value rather than
    // flashing to 0 during that transient window.
    const usage = runtime.session?.getContextUsage?.();
    if (usage?.percent != null) runtime.contextPct = usage.percent;
    // Phase 4.7: keep raw tokens/contextWindow too, not just the percent.
    if (usage?.tokens != null) runtime.contextTokens = usage.tokens;
    if (usage?.contextWindow != null) runtime.contextWindow = usage.contextWindow;
    publishRuntimeUpdate(state);
    writeHiveStateSnapshot(state);
  }, 1000);
  runtime.timer.unref?.();

  // Distinct actual models seen across this run's assistant messages (A3).
  // Per-message identity the SDK exposes on AssistantMessage (Item 9 / R3-1.4):
  // `.provider`, `.api`, `.responseId?`, `.diagnostics?` all ride the same
  // message_end object. Capture the distinct providers/apis, the first+last
  // responseId (bookends of the run), and a bounded set of diagnostics.
  // toolCallId → startedAt, for per-call durationMs (A4). Bounded by in-flight
  // calls: deleted on tool_execution_end. Retry metadata is retained only for
  // this reserved run and cleared by the outer lifecycle cleanup.
  // `sub` is declared at function scope above so the post-`finally` output
  // computation can read sub.streamedSnapshot.
  const handleEvent = createWorkerSubscriptionHandler({
    state,
    runtime,
    sub,
    publishRuntimeUpdate,
    maxDiagnostics: MAX_DIAGNOSTICS,
  });
  const unsubscribe = session.subscribe(handleEvent);
  lifecycle.attachSubscription(unsubscribe);

  try {
    // Scoped so currentAgentName() resolves to this worker for everything
    // causally downstream of prompt() — subscribed event handlers, tool
    // execute() calls (including a nested delegate_agent recursing into
    // dispatchAgent again), and enforceDomainForTool's lookup. Workers can run
    // concurrently now that there's no process boundary between them, so this
    // can no longer be a shared/global value (see currentAgentStorage in
    // session.ts) — each concurrent call gets its own isolated context.
    //
    // prompt() throws synchronously for pre-acceptance failures (no model, no
    // API key); a failure mid-run instead surfaces via session.state.errorMessage.
    //
    // The active change-id is scoped alongside the agent name so the worker's
    // plan/review tools resolve currentChangeId()
    // to the selected change. A nested delegation inherits the caller's change-id
    // unless a more specific one is set. state.activeChangeId is the persistent
    // selection; currentChangeId() carries an already-scoped value into nesting.
    const scopedChangeId = currentChangeId() ?? state.activeChangeId;
    if (abortedByParent) throw new Error("aborted");
    // Fix #3: inject the assembled worker context on new/fresh session starts.
    // fresh=true always starts clean (prior transcript archived above, if any).
    // A first-ever session for this agent (no prior transcript file) also needs
    // the full context so shared_context and the domain boundary reach the worker.
    // Resumed sessions (fresh=false, existing transcript) receive the lean task
    // only — pi-hive's native transcript persistence already carries the context
    // forward, so re-injecting would duplicate it on every resumed delegation.
    // Deliberate non-goal: distiller re-injection into resumed workers (P4).
    const isNewSession = fresh || !sessionFileExisted;
    await runAtDelegationDepth(delegationDepth, () => runAsAgent(runtime.config.name, () => runWithChange(scopedChangeId, () => session.prompt(isNewSession ? prompt : task))));
    errorMessage = abortedByParent
      ? "aborted"
      : state.shuttingDown
        ? "aborted during session shutdown"
        : session.state.errorMessage;
    // The 1s timer polls this too, but relying on it alone can miss the final,
    // most accurate reading if the last tick landed moments before completion.
    // Refresh the raw tokens/window alongside the percent (Phase 4.7) so the
    // final snapshot carries the last context fill, not just its percentage.
    const finalUsage = session.getContextUsage?.();
    if (finalUsage?.percent != null) runtime.contextPct = finalUsage.percent;
    if (finalUsage?.tokens != null) runtime.contextTokens = finalUsage.tokens;
    if (finalUsage?.contextWindow != null) runtime.contextWindow = finalUsage.contextWindow;
  } catch (error: any) {
    errorMessage = error?.message || String(error);
  }

  // Authoritative usage: overwrite the incremental live-display counters with
  // the SDK's session-lifetime aggregate (includes cache splits). This kills
  // the double-count and any accumulation drift in one move (Decision 1). If
  // stats throws, the incremental values already on the runtime are kept.
  // Item 9: SessionStats also carries authoritative message/tool counts —
  // preferred over the hand-tallied toolCount so the numbers match the SDK's own.
  try {
    sdkCounts = applySessionStatsToRuntime(session, runtime);
  } catch { /* keep incremental values if stats is unavailable */ }

  } catch (error: any) {
    errorMessage = errorMessage || error?.message || String(error);
  } finally {
    toolStartedAt.clear();
    abortSignal?.removeEventListener("abort", abortFromParent);
    await lifecycle.close(Boolean(errorMessage));
    runtime.elapsedMs = runtime.startedAt ? Date.now() - runtime.startedAt : runtime.elapsedMs;
    runtime.status = errorMessage ? "error" : "done";
  }
  const exitCode = errorMessage ? 1 : 0;

  const output = chunks.join("").trim() || sub.streamedSnapshot.trim() || errorMessage || "[no output]";
  runtime.lastWork = output.split("\n").filter((line) => line.trim()).pop() || runtime.status;
  // The shared log keeps a bounded copy of the result for the dashboard. The
  // cap is intentionally high enough that normal review verdicts are not
  // middle-elided in the web UI, while still protecting the shared telemetry log
  // from accidental multi-hundred-KB rows.
  const completionMessage = truncateMiddle(output, DELEGATION_EVENT_MESSAGE_LIMIT);
  const completion = {
    from: runtime.config.name,
    // The real delegation parent: the ALS caller (A6). For top-level
    // delegations this resolves to "Orchestrator"; nested lead→member
    // delegations now record the truthful parent instead of a hardcoded root.
    to: caller,
    type: runtime.status,
    message: completionMessage,
    costUsd: runtime.costUsd,
    inputTokens: runtime.inputTokens,
    outputTokens: runtime.outputTokens,
    elapsedMs: runtime.elapsedMs,
  };
  logRecord(state, completion);
  addHiveActivity(state, { kind: "delegation_end", parent: caller, agent: runtime.config.name, status: runtime.status, text: `${runtime.status} in ${Math.round(runtime.elapsedMs / 1000)}s${runtime.toolCount ? ` · ${runtime.toolCount} tools` : ""}` });
  // Per-run deltas (Decision 1): runtime.* now hold session-lifetime aggregates
  // (overwritten from getSessionStats above), so a re-run agent's runtime would
  // make SUM() over delegations double-count. Subtract the run-start baseline so
  // each delegation_end row records only what THIS run consumed. Clamp at 0 in
  // case the SDK's lifetime total ever regresses across a compaction — and as a
  // last-resort guard for the fresh-archive path (where the baselines are reset to
  // 0 above precisely so this clamp is NOT what saves the delta from going negative).
  const nonneg = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  const delta = {
    inputTokens: nonneg(runtime.inputTokens - (runtime.runStartInputTokens ?? 0)),
    outputTokens: nonneg(runtime.outputTokens - (runtime.runStartOutputTokens ?? 0)),
    cacheReadTokens: nonneg(runtime.cacheReadTokens - (runtime.runStartCacheReadTokens ?? 0)),
    cacheWriteTokens: nonneg(runtime.cacheWriteTokens - (runtime.runStartCacheWriteTokens ?? 0)),
    reasoningTokens: nonneg(runtime.reasoningTokens - (runtime.runStartReasoningTokens ?? 0)),
    costUsd: nonneg(runtime.costUsd - (runtime.runStartCostUsd ?? 0)),
  };
  // Wave 3A / T4.2 + Wave 5 / F9 — the legacy `governanceTokens` /
  // `governanceCostUsd` accumulation that used to live here is gone.
  // `installBudgetEventHooks` (F2 spine) is the sole finalization path; on
  // `agent_settled` the ledger writes a `marker: "checkpoint"` CustomEntry
  // and that is the canonical record of end-of-run spend. The runtime
  // fields were removed from the `AgentRuntime` type and from this file
  // when `governance.ts` was deleted.
  if (runtime.config.agentType === "reviewer") {
    await persistReviewerVerdict(ctx, state, runtime, task, output, caller);
  }

  emitDelegationEnd({
    state,
    runtime,
    output,
    exitCode,
    errorMessage,
    caller,
    lastStopReason,
    modelsSeen,
    providersSeen,
    apisSeen,
    firstResponseId,
    lastResponseId,
    diagnostics,
    sdkCounts,
    delta,
    messageLimit: DELEGATION_EVENT_MESSAGE_LIMIT,
  });
  state.onRuntimeFinish?.(runtime, ctx);
  return { output, exitCode, elapsed: runtime.elapsedMs };
}
