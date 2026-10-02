import { type AgentSession, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { TYPE_SCOPED_TOOL_NAMES } from "../core/constants";
import type { AgentRuntime, HiveState } from "../core/types";
import {
  boundedDiagnostics,
  modelFrom,
  normalizeWorkerTools,
  safeJson,
  agentSlug,
  textFromMessage,
  textOfResult,
  truncateMiddle,
  extractUsage,
} from "../core/utils";
import { logRecord } from "./state";
import { currentAgentName, currentChangeId, currentDelegationDepth, reloadAgentConfig } from "./session";
import { canDelegateTo } from "./domain";
import { buildWorkerPrompt } from "./prompts";
import { emitHiveEvent, runtimeSummary, writeHiveStateSnapshot } from "./observability";
import { buildHiveTools } from "../agents/tools";
import { normalizeWorkerSkillPaths, workerResourceLoader } from "./worker-extension";
import { isExecutionGateOpen, isAwaitingHumanApproval, type AgentReviewVerdict } from "./openspec";
import { ARTIFACT_ORDER, type ArtifactId } from "../shared/openspec-artifacts";
import { agentRoster, resolveRuntime } from "./agent-lookup";
import { addHiveActivity } from "../ui/tui/activity";
import { resolveConfiguredPath } from "../core/safe-path";
import { acquireWorkerSlot, releaseWorkerSlot } from "./worker-queue";
import { effectiveWorkerGovernance } from "./budget/remaining";
import { WorkerRunLifecycle } from "./worker-lifecycle";
import { modelKey, resolveModel, type ResolvedModel } from "./model-resolution";
import { delegateAgent as delegateAgentFn, BudgetExhaustedError, type DelegateAgentThinkingLevel, registerWorkerHandleForProduction, unregisterWorkerHandleForProduction } from "./budget/worker-tools";
import { buildWorkerOnlyTools, populateWorkerOnlyBindings } from "./budget/worker-only-tools";
import { installBudgetEventHooks } from "./budget/events";
import { wireDispatchSubscription, makeDispatchStreamState } from "./dispatch-subscribe";
import { emitDelegationEnd } from "./dispatch-end";
import { runPromptAndFinalize } from "./dispatch-lifecycle";

// Dashboard activity should show reviewer/worker conclusions without confusing
// middle elision in normal cases. Keep a high hard cap to avoid unbounded shared
// telemetry rows if an agent accidentally returns a huge dump.
const DELEGATION_EVENT_MESSAGE_LIMIT = 64_000;

export function publishRuntimeUpdate(state: HiveState) {
  state.onRuntimeUpdate?.(state);
}

// Tick elapsedMs + live context fill + dashboard snapshot every 1s so the
// status modal stays live without polling. In-process since Wave 2: workers
// run inside the same process as the orchestrator, so nested delegations
// already mutate state.runtimes directly — no mirroring required.
// Extracted from dispatchAgent so dispatch.ts stays under the ≤600 LOC
// refactor target.
function startElapsedTimer(state: HiveState, runtime: AgentRuntime): NodeJS.Timeout {
  return setInterval(() => {
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
}

// Pre-flight guards (plan/hive gating, OpenSpec change gate, delegation
// permission, already-running guard). Returns a result tuple that
// dispatchAgent either short-circuits with or falls through to the
// slot acquisition below. Extracted from dispatchAgent so dispatch.ts
// stays under the ≤600 LOC refactor target.
function preflightCheck(opts: {
  state: HiveState;
  ctx: ExtensionContext;
  agentName: string;
  agentSlug: string;
  runtime: AgentRuntime;
  caller: string;
  task: string;
  isReadOnly?: boolean;
}): { output: string; exitCode: number; elapsed: number } | undefined {
  const { state, ctx, runtime, caller, task, isReadOnly } = opts;
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
  const permission = canDelegateTo(state, caller, opts.agentSlug, isReadOnly);
  if (!permission.ok) {
    return { output: `Delegation blocked: ${permission.reason}`, exitCode: 1, elapsed: 0 };
  }
  if (runtime.status === "running") {
    return { output: `${runtime.config.name} is already running.`, exitCode: 1, elapsed: runtime.elapsedMs };
  }
  return undefined;
}

// Emit the run-start telemetry block: logRecord + delegation_start activity +
// delegation_start event + snapshot. Extracted from dispatchAgent so
// dispatch.ts stays under the ≤600 LOC refactor target.
function emitDelegationStart(opts: {
  state: HiveState;
  runtime: AgentRuntime;
  caller: string;
  task: string;
  fresh: boolean;
  resolvedModelKey: string;
  model: string;
  tools: string;
  thinking: string;
}): void {
  const { state, runtime, caller, task, fresh, resolvedModelKey, model, tools, thinking } = opts;
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
}

// Emit the standard setup-failure terminal telemetry block and return the
// shape the orchestrator expects. The two setup-failure branches inside
// dispatchAgent (delegateResult falsy, delegateResult.kind === "partial")
// differ only in which cleanup they run BEFORE this emit; the emit itself
// is identical. Extracted so dispatch.ts stays under the ≤600 LOC refactor
// target.
async function emitSetupFailure(opts: {
  state: HiveState;
  runtime: AgentRuntime;
  caller: string;
  task: string;
  ctx: ExtensionContext;
  errorMessage: string | undefined;
}): Promise<{ output: string; exitCode: number; elapsed: number }> {
  const { state, runtime, caller, task, ctx, errorMessage } = opts;
  runtime.elapsedMs = runtime.startedAt ? Date.now() - runtime.startedAt : 0;
  const exitCode = 1;
  const output = errorMessage || "[no output]";
  runtime.lastWork = output.split("\n").filter((line) => line.trim()).pop() || runtime.status;
  await emitDelegationEnd({
    state, runtime, caller, task, ctx, output, errorMessage, exitCode,
    streamState: makeDispatchStreamState(), sdkCounts: undefined,
    tokenBudgetScope: effectiveWorkerGovernance(state, runtime).tokenBudgetScope ?? "all",
  });
  return { output, exitCode, elapsed: runtime.elapsedMs };
}

// Coerce to a finite number or undefined. Unlike `Number(x) || undefined`, this
// preserves a legitimate 0 (a real delayMs/tokensAfter of 0 is meaningful; only
// NaN/absent should drop to undefined). Mirrors the Number.isFinite guards used
// on the SessionStats overwrite below. Guards null/undefined FIRST (R3-2.5) so an
// absent field stays undefined rather than coercing to Number(null) === 0.
function finiteOrUndef(x: unknown): number | undefined {
  if (x == null) return undefined;
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

// Move an agent's current session log aside to a numbered archive so a fresh run
// can start clean without losing the prior run's transcript. "<slug>.jsonl"
// becomes "<slug>.run-<N>.jsonl" with N the next free index. Returns silently if
// there is nothing to archive.
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

const ARTIFACT_REVISION_MARKERS = /\b(revise|revision|fix|address|correct|update|rewrite|repair|failed review|review failed|rejected|denied|blocker|blocking)\b/i;

const ARTIFACT_TARGET_MARKERS: Record<ArtifactId, RegExp> = {
  proposal: /\bproposal(?:\.md)?\b|proposal artifact|proposal gate/i,
  design: /\bdesign(?:\.md)?\b|design artifact|design gate/i,
  specs: /\bspecs?(?:\/\*\*\/\*\.md| artifact| gate)?\b|specs\/|spec\.md/i,
  tasks: /\btasks(?:\.md)?\b|tasks artifact|tasks gate/i,
};

export function isPendingArtifactRevisionTask(task: string, pending: ArtifactId): boolean {
  if (!ARTIFACT_REVISION_MARKERS.test(task)) return false;
  if (/\bauthor the next artifact\b/i.test(task)) return false;
  return ARTIFACT_TARGET_MARKERS[pending].test(task);
}

export function inferChangeIdFromReviewTask(task: string): string | null {
  const pathMatch = task.match(/openspec\/changes\/([a-z0-9]+(?:-[a-z0-9]+)*)\//i);
  if (pathMatch) return pathMatch[1];
  const quotedMatch = task.match(/OpenSpec change [`"]([a-z0-9]+(?:-[a-z0-9]+)*)[`"]|change [`"]([a-z0-9]+(?:-[a-z0-9]+)*)[`"]|change\s+([a-z0-9]+(?:-[a-z0-9]+)*)\b/i);
  return quotedMatch?.[1] || quotedMatch?.[2] || quotedMatch?.[3] || null;
}

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

export function inferArtifactFromReviewTask(task: string): ArtifactId | null {
  // Prefer the explicit review target. Review prompts often contain negative
  // scope clauses like "Do not consider design/specs/tasks"; a plain keyword
  // scan would otherwise tag a proposal review as tasks/specs/design.
  const explicit = task.match(/\breview\s+only\s+the\s+(proposal|design|specs?|requirements|tasks)\s+(?:artifact|gate)\b/i);
  if (explicit) {
    const target = explicit[1].toLowerCase();
    return target.startsWith("spec") || target === "requirements" ? "specs" : (target as ArtifactId);
  }

  const pathMatch = task.match(/openspec\/changes\/[^\s`'"]+\/((?:proposal|design|tasks)\.md|specs\/[^\s`'"]+|specs\/\*\*\/\*\.md)/i);
  if (pathMatch) return pathMatch[1].startsWith("specs/") ? "specs" : (pathMatch[1].replace(/\.md$/i, "") as ArtifactId);

  const positiveText = task
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((sentence) => !/\bdo not\b|\bdon't\b|\bno\s+(?:design|specs|tasks|proposal)\b/i.test(sentence))
    .join("\n");
  let best: { id: ArtifactId; index: number } | null = null;
  for (const id of ARTIFACT_ORDER) {
    const match = positiveText.match(ARTIFACT_TARGET_MARKERS[id]);
    if (match?.index != null && (!best || match.index < best.index)) best = { id, index: match.index };
  }
  return best?.id ?? null;
}

export function inferReviewVerdict(output: string): Exclude<AgentReviewVerdict, null> | null {
  const text = output.trim();
  const match = text.match(/^\s*(?:#{1,6}\s*)?(?:verdict\s*[:—-]\s*)?(PASS|GREEN|YELLOW|FAIL|RED)\b/i);
  const verdict = match?.[1]?.toLowerCase();
  if (verdict === "pass" || verdict === "green") return "green";
  if (verdict === "yellow") return "yellow";
  if (verdict === "fail" || verdict === "red") return "red";
  return null;
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
  // Pre-flight guards (plan/hive gating, OpenSpec change gate, delegation
  // permission, already-running guard). Returns a result tuple that the
  // caller short-circuits with, or undefined to fall through to the slot
  // acquisition below.
  const preflightResult = preflightCheck({
    state, ctx, agentName, agentSlug: agentSlug(runtime.config), runtime, caller, task, isReadOnly,
  });
  if (preflightResult) return preflightResult;
  const delegationDepth = currentDelegationDepth() + 1;
  // The error/abort bookkeeping has to live at function scope so the
  // setup-failure catch (inside the delegateAgent try below) can mutate
  // errorMessage and still see it from the cleanup tail at the bottom of
  // the function.
  let errorMessage: string | undefined;
  let abortedByParent = false;
  let sdkCounts: { toolCalls?: number; toolResults?: number; userMessages?: number; assistantMessages?: number } | undefined;
  // Budget pre-flight (Wave 2 fixup): delegateAgent now owns the budget gate
  // (resolveWorkerBudgetPolicy → BudgetLedger.restore → checkBudgetPolicy),
  // the depth-cap (T2.3), and the installBudgetEventHooks wiring. The
  // dispatcher no longer reads checkDispatchBudgets directly — the legacy
  // gate was the source of the "no business logic remains" brief violation.
  // The depthFn closure wires currentDelegationDepth() into the new path so
  // the cap actually fires in production (per Wave 2 review Blocker 2). The
  // session-manager factory (`createSession` seam) is passed through to
  // delegateAgent via internals so the 565-test seam continues to drive
  // AgentSession creation from tests/*.test.ts without a code split.
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
  // Governance accounting is monotonic even when fresh=true archives the SDK
  // transcript and resets its session-lifetime counters. The budget tracks
  // either input+output only or the full token total, depending on the
  // configured scope; default "all" preserves the legacy behavior.
  const tokenBudgetScope = effectiveWorkerGovernance(state, runtime).tokenBudgetScope ?? "all";
  runtime.governanceTokens ??= tokenBudgetScope === "input_output"
    ? runtime.inputTokens + runtime.outputTokens
    : runtime.inputTokens + runtime.outputTokens + runtime.cacheReadTokens + runtime.cacheWriteTokens + runtime.reasoningTokens;
  runtime.governanceCostUsd ??= runtime.costUsd;
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
  // TS I11: typed ResolvedModel (was `any`), explicit catch that captures
  // the resolution error in a sibling variable so the dispatcher surfaces a
  // structured "Cannot resolve model" message rather than swallowing the
  // cause silently.
  let resolvedModel: ResolvedModel | undefined;
  let resolveModelError: string | undefined;
  try {
    resolvedModel = resolveModel(ctx, model);
  } catch (error) {
    resolveModelError = error instanceof Error ? error.message : String(error);
    resolvedModel = undefined;
  }
  if (!resolvedModel) {
    runtime.status = "error";
    releaseWorkerSlot(state);
    const reason = resolveModelError ? ` (${resolveModelError})` : "";
    return { output: `Cannot resolve model "${model}" for ${runtime.config.name}${reason}.`, exitCode: 1, elapsed: 0 };
  }

  // Wave 2 fixup — delegateAgent owns the budget pre-flight + session creation
  // + installBudgetEventHooks. Per the brief's HARD gate "no business logic
  // remains in dispatch.ts", the legacy checkDispatchBudgets call is gone; the
  // new path throws BudgetExhaustedError per Pi docs §2, which we catch and
  // convert to the legacy {output, exitCode: 1} shape for the delegate_agent
  // tool caller (backward compat). depthFn wires currentDelegationDepth() into
  // the new path so the depth-cap (T2.3) actually fires in production (per
  // Wave 2 review Blocker 2). The createSession seam is passed through via
  // internals so the 565-test AgentSession factory keeps working.
  const toolNamesForGate = tools.split(",").map((t) => t.trim()).filter(Boolean);
  const hiveToolsForGate = buildHiveTools(state, runtime.config.name).filter((t) => toolNamesForGate.includes(t.name) || TYPE_SCOPED_TOOL_NAMES.has(t.name));

  // Wave 3.5 wiring (Gap 1, Gap 2): build the per-worker-only tool set
  // (summarize_progress + 3 cooperative tools) and union their names
  // into the `tools` array passed to the session. The SDK silently drops
  // a customTool whose name is missing from `tools`, so the union is
  // mandatory. The wrappers use deferred bindings — the SDK's
  // session.customTools list is fixed at creation time, so we register
  // wrappers that close over a binding object populated AFTER
  // delegateAgent returns `kind: "ready"`. The full rationale lives in
  // src/engine/budget/worker-only-tools.ts.
  const { tools: workerOnlyTools, bindings: workerOnlyBindings } = buildWorkerOnlyTools(state, runtime.config.name);
  const allToolNamesForGate = dispatchToolNames(toolNamesForGate, [...hiveToolsForGate, ...workerOnlyTools]);
  const skillPathsForGate = resolveWorkerSkillPaths(ctx.cwd, runtime.config.skills as unknown[]);
  const sessionManager = SessionManager.open(runtime.sessionFile);
  // createAgentSession only calls reload() when it creates its own resource
  // loader (sdk.js). When a loader is supplied by the caller, the SDK skips
  // reload, leaving extensionsResult empty (constructor default). Without
  // reload the extensionFactories never run, runner.hasHandlers("tool_call")
  // is false, beforeToolCall short-circuits, and domain enforcement is silently
  // bypassed for every worker tool call. Call reload() here so the factory
  // registers the tool_call handler before the session starts.
  const workerLoader = workerResourceLoader(state, ctx.cwd, runtime.config.name, skillPathsForGate);
  await workerLoader.reload();

  let delegateResult: Awaited<ReturnType<typeof delegateAgentFn>> | undefined;
  try {
    delegateResult = await delegateAgentFn(
      state,
      runtime.config.name,
      task,
      { fresh },
      ctx,
      {
        depthFn: () => currentDelegationDepth(),
        model: resolvedModel,
        // `thinking` is a free-form string from frontmatter; the SDK's
        // ThinkingLevel is a union. Cast at the boundary rather than
        // forcing an unknown value into the seam. The factory below
        // accepts the union-typed string.
        thinkingLevel: thinking as DelegateAgentThinkingLevel | undefined,
        tools: allToolNamesForGate,
        customTools: [...hiveToolsForGate, ...workerOnlyTools],
        resourceLoader: workerLoader,
        // Production-side seam: the dispatcher's createSession is what every
        // test in tests/dispatch-usage.test.ts injects. delegateAgent routes
        // through this when provided; otherwise it falls back to
        // SessionManager.toAgentSession(). The SDK's createAgentSession
        // signature is structurally compatible with our seam's
        // CreateSessionOptions (same fields, different type aliases for
        // Model/ThinkingLevel); the cast lives here at the production
        // wiring site, not inside the seam — TS I13.
        createSession: createSession as never,
      },
    );
  } catch (error: any) {
    if (error instanceof BudgetExhaustedError) {
      // Budget pre-flight refused — emit budget_exhausted and return the
      // legacy {output, exitCode: 1} shape so the delegate_agent tool caller
      // gets a failed tool result per Pi docs §2.
      releaseWorkerSlot(state);
      emitHiveEvent(state, "budget_exhausted", {
        agent: runtime.config.name,
        resource: error.resource,
        scope: error.scope,
        remaining: error.remaining,
      }, caller);
      return { output: `Delegation blocked: ${error.message}`, exitCode: 1, elapsed: 0 };
    }
    // Setup failure (e.g. installBudgetEventHooks's session.subscribe throws
    // — the budget listener subscribes the session). Mirror the legacy
    // behavior: set errorMessage, mark runtime.status="error", and fall
    // through to the post-delegationEnd cleanup path so the partial
    // session gets aborted/disposed and the terminal telemetry event lands
    // with the caught error message.
    errorMessage = error?.message || String(error);
    runtime.status = "error";
    releaseWorkerSlot(state);
    // Recover the partial session (if delegateAgent got that far before
    // the throw — installBudgetEventHooks wires the budget listener via
    // session.subscribe, which can throw on a test seam). delegateAgent
    // returns kind: "partial" so the dispatcher can still call
    // abort/dispose via the lifecycle close path. The existing setup-
    // failure test in tests/dispatch-usage.test.ts asserts aborted=1,
    // disposed=1.
    delegateResult = undefined;
  }

  // Setup-failure fast path. We need TWO lifecycles: an early one for the
  // setup-failure path (created before runController exists, with a
  // placeholder signal — session.abort is only called via the explicit
  // `partial.abort?.()` below, not via signal listening), and the
  // runController-backed one for the normal run path (created after
  // runController below). The early one is replaced by the late one in the
  // normal-flow block before session.prompt runs.
  let lifecycle = new WorkerRunLifecycle(state, runtime, new AbortController().signal);

  // First fast path: delegateAgent returned nothing (caught a
  // non-BudgetExhaustedError and has no partial session to hand off). Emit
  // terminal telemetry and return without touching runtime.status="running"
  // — the catch above already set the "error" status. Partial-session
  // reaping is handled in the next block.
  if (!delegateResult) {
    return await emitSetupFailure({ state, runtime, caller, task, ctx, errorMessage });
  }
  // Partial-session branch: delegateAgent's installBudgetEventHooks.subscribe
  // threw AFTER the session was created. The setup-failure path returns
  // kind: "partial" with the session for cleanup, plus the original error
  // so we can surface it as the worker's errorMessage. Reap it
  // (abort + dispose) via the lifecycle close path; the setup-failure
  // test in tests/dispatch-usage.test.ts asserts aborted=1, disposed=1.
  if (delegateResult.kind === "partial") {
    errorMessage = (delegateResult.error as Error | undefined)?.message ?? String(delegateResult.error ?? "");
    runtime.status = "error";
    lifecycle.attachSession(delegateResult.session);
    // lifecycle.close reaps the partial session via abort + dispose. The
    // slot was already released in the catch; releaseWorkerSlot's Math.max
    // guard makes the second release a no-op.
    await lifecycle.close(true);
    return await emitSetupFailure({ state, runtime, caller, task, ctx, errorMessage });
  }

  // Wave 3.5 wiring (Gap 1, Gap 2): populate the deferred bindings now
  // that delegateAgent settled `kind: "ready"` and the session + ledger
  // + policy are available. The four ToolDefinitions registered as part of
  // customTools read from these on execute(). We populate before the
  // `runtime.status = "running"` mutation so any error here fails with
  // `runtime.status = "error"` (defensive parity with the partial-session
  // branch above — a binding-mutation throw is not expected but the
  // shape is symmetric).
  populateWorkerOnlyBindings(
    workerOnlyBindings,
    delegateResult.session,
    delegateResult.ledger,
    delegateResult.policy,
  );

  // Wave 3.5 wiring (Gap 3): register the worker handle so the 11 operator
  // commands (forceKillWorkerSession, forceEndWorkerSession, endWorkerSession,
  // etc.) can find the session by agent name. Before this, the operator
  // commands threw `notImpl(agent)` because the Map was never populated.
  // Registration happens HERE — after delegateAgent settled
  // `kind: "ready"`, before `runtime.status = "running"` mutates state.
  // The Map is the contract between this dispatcher and the operator-command
  // surface (F13 dashboard + RPC); the test seam
  // __registerHandle / __unregisterHandle in worker-tools.ts stays for
  // the budget-eol test suite.
  registerWorkerHandleForProduction({
    agent: runtime.config.name,
    session: delegateResult.session,
    controller: delegateResult.controller,
    sessionManager: delegateResult.sessionManager,
    ledger: delegateResult.ledger,
    policy: delegateResult.policy,
  });

  const resolvedModelKey = modelKey(resolvedModel, model);

  runtime.status = "running";
  runtime.task = task;
  runtime.lastWork = task;
  runtime.toolCount = 0;
  runtime.elapsedMs = 0;
  runtime.runCount++;
  runtime.startedAt = Date.now();
  // timeoutMs is the one budget-shaped field still consumed from
  // effectiveWorkerGovernance rather than from resolveWorkerBudgetPolicy —
  // WorkerBudgetPolicy models caps (token/cost/runs/depth), not concurrency
  // timeouts. tokenBudgetScope was migrated to the policy resolver earlier
  // and is read once at line 394 above; the rest of the budget-tier fields
  // are already policy-only at this point.
  const governance = effectiveWorkerGovernance(state, runtime);
  const runController = new AbortController();
  let timedOut = false;
  const abortFromParent = () => runController.abort(abortSignal?.reason);
  if (abortSignal?.aborted) abortFromParent();
  else abortSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = governance.timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    runController.abort(new Error(`Worker timeout after ${governance.timeoutMs}ms`));
  }, governance.timeoutMs);
  timeout?.unref?.();
  // Replace the placeholder lifecycle (created earlier for setup-failure
  // handling) with one wired to runController.signal. Both abort paths now
  // route through lifecycle.watchParentAbort → abortWorker → session.abort():
  //   - parent abort:    abortSignal → abortFromParent → runController.abort
  //   - per-run timeout: setTimeout → runController.abort
  // The placeholder lifecycle's session/unsubscribe state carries forward
  // (we re-attach below) so setup-failure handling keeps working.
  lifecycle = new WorkerRunLifecycle(state, runtime, runController.signal);
  // TOK/S baselines (J8/Decision 4): lifetime token counts at run start so the UI
  // divides the *per-run output* delta by *per-run* elapsedMs — not lifetime
  // tokens by per-run elapsed.
  runtime.runStartInputTokens = runtime.inputTokens;
  runtime.runStartOutputTokens = runtime.outputTokens;
  // Full baselines so delegation_end can emit per-run deltas for every token
  // dimension + cost (Decision 1), not just the two TOK/S needs.
  runtime.runStartCacheReadTokens = runtime.cacheReadTokens;
  runtime.runStartCacheWriteTokens = runtime.cacheWriteTokens;
  runtime.runStartReasoningTokens = runtime.reasoningTokens;
  runtime.runStartCostUsd = runtime.costUsd;

  const streamState = makeDispatchStreamState();
  // delegateAgent has already opened the session and installed the budget
  // event hooks; the dispatcher just threads it through the rest of the
  // run-lifecycle orchestration (abort wiring, telemetry subscribe, prompt,
  // session-stats overwrite, delegation_end emit). The discriminated
  // union narrowed to "ready" by the partial-session branch above, so
  // `session` is the fully-typed AgentSession (TS I15 — no more `any`).
  const session: AgentSession = delegateResult.session;
  // Always attach the session to the lifecycle so the cleanup tail
  // (lifecycle.close) reaps abort + dispose on it.
  lifecycle.attachSession(session);

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

  emitDelegationStart({
    state, runtime, caller, task, fresh, resolvedModelKey, model, tools, thinking,
  });

  // Tick elapsedMs + live context fill + dashboard snapshot every 1s so the
  // dashboard's live view stays fresh for the duration of the worker run.
  // The helper itself is defined at the top of this module; .unref() so the
  // timer never holds the Node event loop open after the run ends.
  runtime.timer = startElapsedTimer(state, runtime);
  runtime.timer.unref?.();

  // Non-budget session event subscription: streaming text, tool telemetry,
  // retry, compaction telemetry, agent_end text fallback, per-message
  // identity tracking. Extracted to src/engine/dispatch-subscribe.ts so this
  // module stays under the ≤600 LOC refactor target. Budget paths (warning at
  // 20%, abort at 0%, recordCompaction) live in installBudgetEventHooks and
  // are installed separately (T2.1).
  const unsubscribe = wireDispatchSubscription(state, runtime, session, streamState, runController);
  lifecycle.attachSubscription(unsubscribe);


  // Wave 3.5 wiring (Gap 3 unregister half): runPromptAndFinalize reaps
  // the session via lifecycle.close (abort + dispose) before returning,
  // so the handle is no longer addressable. Unregister it here so the
  // operator-command surface sees a clean slate for the next dispatch.
  // The brief's "ensure unregister is called in the endWorkerSession
  // path" is satisfied by this block — the dispatcher's normal end-of-
  // run IS the endWorkerSession path in production (operator-initiated
  // endWorkerSession itself preserves the handle for resume, which is
  // intentional and matches the documented "no dispose (operator may
  // resume)" contract).
  try {
    const finalOutcome = await runPromptAndFinalize({
      state,
      runtime,
      session,
      streamState,
      fresh,
      task,
      ctx,
      caller,
      prompt,
      delegationDepth,
      sessionFileExisted,
      lifecycle,
      timeout,
      abortSignal,
      abortFromParent,
      getAbortedByParent: () => abortedByParent,
      getTimedOut: () => timedOut,
      governanceTimeoutMs: governance.timeoutMs,
      tokenBudgetScope,
    });
    unregisterWorkerHandleForProduction(runtime.config.name);
    return finalOutcome;
  } catch (error) {
    // Even on the abnormal path, unregister so the operator-command
    // surface doesn't leak handles for crashed workers. The
    // registerWorkerHandle call above already happened on the ready
    // path; the Map entry is otherwise unreachable.
    unregisterWorkerHandleForProduction(runtime.config.name);
    throw error;
  }
}

