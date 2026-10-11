import { type AgentSession, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { TYPE_SCOPED_TOOL_NAMES } from "../core/constants";
// U2: per-delegation domain override needs a UUID for `delegationId`
// (paired grant/revoke audit trail) and a sha256 digest for
// `staticReference` (records which static config the override layered
// onto so an auditor can detect drift post-hoc — see design §4.8 / R8).
import { createHash, randomUUID } from "node:crypto";
import type { AgentRuntime, DomainScope, HiveState, OverrideEntry } from "../core/types";
import {
  modelFrom,
  normalizeWorkerTools,
  agentSlug,
} from "../core/utils";
import { logRecord } from "./state";
import { currentAgentName, currentChangeId, currentDelegationDepth } from "./session";
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
import { effectiveWorkerGovernance } from "./budget/policy";
import { checkReservedPath } from "./reserved-paths";
import { WorkerRunLifecycle } from "./worker-lifecycle";
import { modelKey, resolveModel, type ResolvedModel } from "./model-resolution";
import { delegateAgent as delegateAgentFn, BudgetExhaustedError, type DelegateAgentThinkingLevel, registerWorkerHandleForProduction, unregisterWorkerHandleForProduction, bindReloadAgentConfigState } from "./budget/worker-tools";
import { buildWorkerOnlyTools, populateWorkerOnlyBindings } from "./budget/worker-only-tools";
import { wireDispatchSubscription, makeDispatchStreamState } from "./dispatch-subscribe";
import { emitDelegationEnd } from "./dispatch-end";
import { runPromptAndFinalize } from "./dispatch-lifecycle";

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
    // percent is null right after compaction until a new assistant response
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
//
// U2 widening: `domainOverride` is the per-call write grant forwarded from
// the `delegate_agent` tool surface. The five rejection predicates below
// run ONLY when the override is non-empty (the empty-array case is R12
// "explicit no override" and must not trigger any validator branch).
// Each predicate emits a structured `preflightResult` tuple on rejection;
// dispatch short-circuits above the snapshot/grant block, so no grant
// event fires and the static config is untouched.
function preflightCheck(opts: {
  state: HiveState;
  ctx: ExtensionContext;
  agentName: string;
  agentSlug: string;
  runtime: AgentRuntime;
  caller: string;
  task: string;
  isReadOnly?: boolean;
  domainOverride?: OverrideEntry[];
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
  // U2 validator branch: per-delegation domain override (R6, R11, R10,
  // R9, R14, R15). Five rejection predicates, all-or-nothing (the first
  // rejection wins so the audit log shows the most specific failure).
  // Empty / undefined override is R12 "no override" and skips this branch
  // entirely. On rejection: short-circuit with a structured result tuple
  // that names both the call site parameter (`isReadOnly` / path / entry)
  // AND the rejection reason — the orchestrator's `delegate_agent`
  // surface surfaces this verbatim per R6.
  const override = opts.domainOverride;
  if (override && override.length > 0) {
    // R9: isReadOnly + write. A read-only delegation cannot grant writes.
    // Named first so the rejection message names both params.
    if (isReadOnly === true) {
      const hasWrite = override.some((entry) => entry.upsert || entry.delete);
      if (hasWrite) {
        return { output: `Delegation blocked: domain_override is incompatible with isReadOnly=true. isReadOnly=true forbids write entries (upsert/delete). Drop the write entries or pass isReadOnly=false.`, exitCode: 1, elapsed: 0 };
      }
    }
    // R11: reviewer-typed workers may not be granted writes. The type
    // policy already blocks reviewer mutations at the tool layer; the
    // override cannot loosen that fence.
    if (runtime.config.agentType === "reviewer") {
      const hasWrite = override.some((entry) => entry.upsert || entry.delete);
      if (hasWrite) {
        return { output: `Delegation blocked: domain_override cannot grant writes to reviewer-typed worker "${runtime.config.name}" (agent-type reviewer is read-only by type policy).`, exitCode: 1, elapsed: 0 };
      }
    }
    // R10: reserved-path entry. Every entry's `path` runs through the
    // same `checkReservedPath` predicate `enforceDomainForTool` uses at
    // every tool call, so the override cannot loosen the reserved-paths
    // fence.
    for (const entry of override) {
      const reservedDecision = checkReservedPath(ctx.cwd, entry.path, "upsert", {
        secretPaths: state.config?.settings.secretPaths,
        // The path was passed at the tool surface; the worker will need
        // CREATE authority so allowMissing mirrors `enforceDomainForTool`'s
        // upsert call.
        allowMissing: true,
      });
      if (!reservedDecision.ok) {
        return { output: `Delegation blocked: domain_override entry "${entry.path}" targets reserved path: ${reservedDecision.reason}. The override cannot loosen the reserved-paths fence.`, exitCode: 1, elapsed: 0 };
      }
    }
    // Hoisted from R14/R15 below: both predicates need the resolved
    // governance object, so compute once at the top of the override
    // branch and reuse. `effectiveWorkerGovernance` reads from the
    // merged runtime + state config; calling it twice would duplicate
    // that work for no benefit.
    const governance = effectiveWorkerGovernance(state, runtime);
    // R14: budget expansion. If the merged scope would grant writes that
    // exceed the worker's static `tokenBudget`/`costBudgetUsd`/`maxRuns`
    // caps, reject. The static budget is the floor; the override cannot
    // multiply the worker's lifetime spend ceiling. We compare on a
    // structural basis — if any override entry grants `upsert` or
    // `delete` on a path OUTSIDE the worker's static domain upsert set,
    // the override expands write scope, which the budget cap may not
    // have anticipated. Cap tightening (shrinking the cap below current
    // spend) is also caught: if the override widens writes, the effective
    // spend ceiling is unchanged but the worker's authority surface is
    // bigger — reject to surface the inconsistency.
    // FIXME: this is a STRUCTURAL fingerprint guardrail, not a real cost
    // check. The predicate rejects purely on "expanded write scope" +
    // "structural path-set" — it does NOT compare estimated tool-token
    // consumption against `state.config.settings.workerBudgets`. A real
    // budget-expansion check would have to model per-call tool-token cost
    // against the worker's configured `tokenBudget` / `costBudgetUsd` /
    // `maxRuns` to detect that the override multiplies the spend ceiling.
    // That modeling is out of scope for this PR; the structural check is
    // a coarse-grained fence that catches the obvious widen-write-while-
    // raise-cap pattern without claiming to be a sound budget verifier.
    // Limitation, made explicit: an orchestrator that legitimately wants
    // to grant `tokenBudget: 100_000` on a path NOT in the worker's
    // static upsert set will be blocked here, even though the override
    // does not actually inflate the configured budget. The check treats
    // budget-presence + write-expansion as a single rejection event so
    // static config can't drift into "wider writes, same ceiling" without
    // surfacing the inconsistency at dispatch time.
    const staticUpsertPaths = new Set((runtime.config.domain || []).filter((scope) => scope.upsert || scope.delete).map((scope) => scope.path));
    const expandedPaths = override.filter((entry) => (entry.upsert || entry.delete) && !staticUpsertPaths.has(entry.path));
    if (expandedPaths.length > 0 && (governance.tokenBudget !== undefined || governance.costBudgetUsd !== undefined || governance.maxRuns !== undefined)) {
      return { output: `Delegation blocked: domain_override expands write scope beyond ${runtime.config.name}'s static budget (token/cost/run caps). The override cannot raise the worker's spend ceiling.`, exitCode: 1, elapsed: 0 };
    }
    // R15: depth-cap. The `delegateAgent` budget path enforces
    // `currentDelegationDepth() + 1 > policy.worker.depth.cap` inside the
    // inner `delegateAgentFn` (which throws BudgetExhaustedError). Mirror
    // the check here so the pre-flight rejection message is the canonical
    // "delegation blocked" shape, not the budget-exhausted shape. Reuses
    // the hoisted `governance` local from R14.
    const depthCap = governance.maxDelegationDepth;
    if (depthCap !== undefined && currentDelegationDepth() + 1 > depthCap) {
      return { output: `Delegation blocked: domain_override cannot exceed the worker delegation depth cap (${depthCap}). Current depth is ${currentDelegationDepth()}.`, exitCode: 1, elapsed: 0 };
    }
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
  resolvedModelKey: string;
  model: string;
  tools: string;
  thinking: string;
}): void {
  const { state, runtime, caller, task, resolvedModelKey, model, tools, thinking } = opts;
  logRecord(state, { from: caller, to: runtime.config.name, type: "delegation", message: task });
  addHiveActivity(state, { kind: "delegation_start", parent: caller, agent: runtime.config.name, status: "running", text: task });
  emitHiveEvent(state, "delegation_start", {
    from: caller,
    to: runtime.config.name,
    task,
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
  // Setup-failure path: the session was never created, so no SessionStats
  // overwrite happened. The runtime's lifetime counters are unchanged from
  // whatever the prior run left them at; pass them as priorLifetime so the
  // emitted delta is 0 (no new spend occurred during setup failure).
  await emitDelegationEnd({
    state, runtime, caller, task, ctx, output, errorMessage, exitCode,
    streamState: makeDispatchStreamState(), sdkCounts: undefined,
    tokenBudgetScope: effectiveWorkerGovernance(state, runtime).tokenBudgetScope ?? "all",
    priorLifetime: {
      inputTokens: runtime.inputTokens,
      outputTokens: runtime.outputTokens,
      cacheReadTokens: runtime.cacheReadTokens,
      cacheWriteTokens: runtime.cacheWriteTokens,
      reasoningTokens: runtime.reasoningTokens,
      costUsd: runtime.costUsd,
    },
  });
  return { output, exitCode, elapsed: runtime.elapsedMs };
}

// Coerce to a finite number or undefined. Unlike `Number(x) || undefined`, this
// preserves a legitimate 0 (a real delayMs/tokensAfter of 0 is meaningful; only
// NaN/absent should drop to undefined). Mirrors the Number.isFinite guards used

// Session factory seam (L1): defaults to the real createAgentSession, but a test
// can inject a scripted AgentSession to drive dispatchAgent end-to-end without a
// live model. Kept as the last optional param so existing callers are unchanged.
export type CreateAgentSession = typeof createAgentSession;

export function resolveWorkerSkillPaths(cwd: string, refs: unknown[] = []): string[] {
  return normalizeWorkerSkillPaths(refs)
    .map((path, index): { path: string; allowOutside: boolean } => {
      const raw = refs[index] as { allowOutsideProject?: unknown; path?: { allowOutsideProject?: unknown } } | undefined;
      const allowOutside = raw?.allowOutsideProject === true || raw?.path?.allowOutsideProject === true;
      return { path, allowOutside };
    })
    .flatMap(({ path, allowOutside }) => {
      const safe = resolveConfiguredPath(cwd, path, allowOutside);
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
  state: HiveState, agentName: string, task: string, ctx: ExtensionContext,
  createSession: CreateAgentSession = createAgentSession,
  abortSignal?: AbortSignal,
  isReadOnly?: boolean,
  // U2: forward the per-call write grant from the `delegate_agent` tool
  // surface. This parameter is the load-bearing input to the snapshot/
  // merge/grant/revoke lifecycle that runs around every dispatch. Empty
  // or undefined is R12 "no override" — the validator branch is skipped,
  // no grant event fires, the static config is untouched. The body uses
  // it to (a) thread it into preflightCheck (so R10/R11/R9/R14/R15
  // rejection predicates see it) and (b) layer it onto runtime.config.domain
  // for the merged scope the worker enforces against for the call's
  // lifetime.
  domainOverride?: OverrideEntry[],
): Promise<{ output: string; exitCode: number; elapsed: number }> {
  if (!state.config || !state.session) throw new Error("hive is not initialized");
  const caller = currentAgentName();
  const runtime = resolveRuntime(state, agentName);
  if (!runtime) {
    const available = agentRoster(state);
    return { output: `Unknown agent "${agentName}". Available: ${available}`, exitCode: 1, elapsed: 0 };
  }
  // Config reloads are an explicit operator action now (T13.0). The legacy
  // boolean parameter (T13.0 sunset) used to call reloadAgentConfig() here
  // AND archive the prior session; both paths are gone. The "edit the
  // agent's .md and re-delegate" workflow is preserved by the new
  // `hive_reload_agent_config` operator command, and a clean session
  // restart is the operator's respawnWorkerSession button. delegate_agent
  // always resumes now.
  // Pre-flight guards (plan/hive gating, OpenSpec change gate, delegation
  // permission, already-running guard). Returns a result tuple that the
  // caller short-circuits with, or undefined to fall through to the slot
  // acquisition below.
  const preflightResult = preflightCheck({
    state, ctx, agentName, agentSlug: agentSlug(runtime.config), runtime, caller, task, isReadOnly, domainOverride,
  });
  if (preflightResult) return preflightResult;
  // ── U2: per-delegation domain override snapshot/grant (R4, R5, R7, R8) ──
  // The override is a per-call write grant captured at the `delegate_agent`
  // tool surface and merged onto `runtime.config.domain` for the
  // delegation's lifetime. Empty / undefined override is R12 ("no
  // override") — the snapshot/grant block is skipped entirely, no grant
  // event fires, and `state.activeOverrides` is never set, so downstream
  // enforcement reads the static config unchanged.
  //
  // KTD4 plumbing: `state.activeOverrides` is the merged scope that
  // `enforceDomainForTool` reads at every tool call (via U3); this
  // override branch is the SOLE writer of that field. Nested
  // delegations (AE8) save the outer scope on entry and restore it on
  // inner revoke, so the parent's merged-scope view is intact for the
  // parent's remaining tool turns after the child returns. The first
  // entry (no parent grant) snapshots `undefined` and restores
  // `undefined`, preserving the prior post-grant cleanup.
  //
  // Q8 lock: `staticReference` is a sha256 digest of `runtime.config.domain`
  // captured at GRANT TIME only. The auditor's job is to recompute
  // against the recorded value to detect that the override layered onto a
  // different static config than expected.
  const override = domainOverride;
  const overrideActive = Array.isArray(override) && override.length > 0;
  let delegationId: string | undefined;
  let staticReference: string | undefined;
  // Holds the prior value of `state.activeOverrides` (parent's grant
  // when nested, `undefined` otherwise) so the R5 restore in the
  // finally block hands the KTD4 plumbing back rather than blanking
  // it. Declared up here so the override branch can set it and the
  // outer finally block can read it (the override branch closes
  // before the `try` block opens).
  let savedActiveOverrides: typeof state.activeOverrides;
  if (overrideActive) {
    delegationId = randomUUID();
    const staticDomain = (runtime.config.domain || []) as DomainScope[];
    // Deep-clone the static config (so the worker session sees its own
    // copy, not a shared mutation target) and append each override entry
    // as a new `DomainScope` row. `read: true` honors Q1's
    // read-preservation invariant: the override is a write grant, but
    // the merged scope row also exposes reads on the same path so the
    // worker's tool-call enforcement (which reads via `domainAllows` →
    // scope[capability]) sees a consistent shape.
    const mergedScope: DomainScope[] = staticDomain.map((scope) => ({ ...scope }));
    for (const entry of override as OverrideEntry[]) {
      // `OverrideEntrySchema` declares `upsert` and `delete` as
      // non-optional `Type.Boolean()` (see src/tools/delegate_agent.ts),
      // so typebox validation guarantees booleans by the time we
      // reach this loop — no `Boolean()` coercion needed.
      const row: DomainScope = {
        path: entry.path,
        read: true,
        upsert: entry.upsert,
        delete: entry.delete,
      };
      if (entry.include) row.include = entry.include;
      if (entry.exclude) row.exclude = entry.exclude;
      mergedScope.push(row);
    }
    staticReference = createHash("sha256")
      .update(JSON.stringify(staticDomain))
      .digest("hex");
    // Save the prior value (parent's grant when nested, `undefined`
    // otherwise) so nested dispatchers restore the outer scope on
    // revoke rather than blanking it. See the KTD4 plumbing comment
    // above and AE8 for the round-trip. The local lives at function
    // scope (with the other `let`s above) so the finally block can
    // see it regardless of which block declared it.
    savedActiveOverrides = state.activeOverrides;
    state.activeOverrides = {
      delegationId,
      worker: agentSlug(runtime.config),
      mergedScope,
      staticReference,
    };
    // R8 grant event. `dispatcherRole` is locked as `"orchestrator"` —
    // the project's persona types (see TelemetryAgentRole in
    // src/shared/telemetry.ts) are orchestrator / lead / member; the
    // design's plan registered `"orchestrator" | "operations"` but
    // `operations` is not a recognized role in this codebase, so
    // `"orchestrator"` is the safe fallback for any caller. U4 may
    // revisit when the role hierarchy grows.
    emitHiveEvent(state, "domain_override.granted", {
      delegationId,
      dispatcher: currentAgentName(),
      dispatcherRole: "orchestrator",
      worker: agentSlug(runtime.config),
      changeId: currentChangeId() ?? null,
      grantedAt: new Date().toISOString(),
      overrideEntries: override,
      staticReference,
    }, caller);
  }
  // ── U2: failure-state locals for the body-wrap finally block ──────────
  // `errorMessage` and `abortedByParent` were already function-scope
  // locals for the inner catches to mutate; U2 extends the set with
  // `budgetExhausted` / `queueCancelled` / `crashed` so the finally
  // block can map each termination path to the union's six reasons
  // exactly. All three are declared OUTSIDE the `try` so they're
  // visible from `finally`. `savedActiveOverrides` lives up next to
  // `delegationId` / `staticReference` (see comment there) so the
  // override branch can set it before the `try` opens.
  let errorMessage: string | undefined;
  let abortedByParent = false;
  let budgetExhausted = false;
  let queueCancelled = false;
  let crashed = false;
  try {
    // `delegationDepth` is captured here (inside the body wrap) so the
    // existing runPromptAndFinalize plumbing can read it. The constant
    // value depends on `currentDelegationDepth()`, which is the depth
    // BEFORE entering this call.
    const delegationDepth = currentDelegationDepth() + 1;
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
    // U2: any slot-acquisition failure maps to `queue-cancelled` so the
    // revoke event's `terminationReason` discriminates between this
    // pre-worker-start failure and post-spawn terminations.
    queueCancelled = true;
    return { output: reason, exitCode: 1, elapsed: 0 };
  }
  // Resolved at dispatch time and threaded through runPromptAndFinalize +
  // emitDelegationEnd. The per-run delta path that consumed this scope was
  // removed by §1.1 (per-run baselines gone; lifetime totals from
  // getSessionStats are the single source of truth), but the seam is kept
  // so downstream callers (and the F2 test seam) can still inspect it.
  const tokenBudgetScope = effectiveWorkerGovernance(state, runtime).tokenBudgetScope ?? "all";
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
  // Fix #3: capture whether a prior transcript exists so this dispatch can
  // decide whether to pass the assembled worker context (new session) or the
  // lean task (resume). The legacy archive-and-reset block used to live
  // here; the clean-slate workflow is now an explicit operator command
  // (respawnWorkerSession) and no session is destroyed by a normal
  // delegate_agent call.
  const sessionFileExisted = existsSync(runtime.sessionFile);

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
  // createAgentSession only calls reload() when it creates its own resource
  // loader (sdk.js). When a loader is supplied by the caller, the SDK skips
  // reload, leaving extensionsResult empty (constructor default). Without
  // reload the extensionFactories never run, runner.hasHandlers("tool_call")
  // is false, beforeToolCall short-circuits, and domain enforcement is silently
  // bypassed for every worker tool call. Call reload() here so the factory
  // registers the tool_call handler before the session starts.
  const workerLoader = workerResourceLoader(state, ctx.cwd, runtime.config.name, skillPathsForGate);
  await workerLoader.reload();
  // T13.0 — bind the live state + ctx to the reload-config operator command
  // so the F13 dashboard's "reload config" button can resolve the runtime by
  // agent name. The unbind happens on session shutdown (no session-scoped
  // teardown here — the reload-config command is read-only against the
  // runtime and the state stays bound for the life of the process).
  bindReloadAgentConfigState(state, ctx);

  let delegateResult: Awaited<ReturnType<typeof delegateAgentFn>> | undefined;
  try {
    delegateResult = await delegateAgentFn(
      state,
      runtime.config.name,
      task,
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
      // U2: surface `budget-exhausted` to the body-wrap finally so the
      // revoke event discriminates this from a generic error
      // (`errorMessage` is NOT set on this path — the catch returns
      // immediately without falling through to `errorMessage = ...`).
      budgetExhausted = true;
      releaseWorkerSlot(state);
      // Record the rejection on the runtime so the
      // hive_explain_rejection LLM tool can answer "why was my
      // delegation refused" without re-running the pre-flight
      // gate. The `at` field lets the tool warn about stale
      // rejections. Cleared on the next successful delegation
      // (post-success status flip below).
      runtime.lastRejection = {
        reason: error.reason,
        scope: error.scope,
        resource: error.resource,
        remaining: error.remaining,
        limit: error.limit,
        at: new Date().toISOString(),
      };
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
  // Clear the prior rejection — a new delegation has started,
  // so the hive_explain_rejection tool should report a fresh
  // observation. The next delegation that fails will repopulate
  // this field in the BudgetExhaustedError catch.
  delete runtime.lastRejection;
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
    state, runtime, caller, task, resolvedModelKey, model, tools, thinking,
  });

  // Tick elapsedMs + live context fill + dashboard snapshot every 1s so the
  // dashboard's live view stays current for the duration of the worker run.
  // The helper itself is defined at the top of this module; .unref() so the
  // timer never holds the Node event loop open after the run ends.
  runtime.timer = startElapsedTimer(state, runtime);
  runtime.timer.unref?.();

  // Non-budget session event subscription: streaming text, tool telemetry,
  // retry, compaction telemetry, agent_end text fallback, per-message
  // identity tracking. Extracted to src/engine/dispatch-subscribe.ts. The
  // dispatch.ts ≤600 LOC refactor target was relaxed once wave-4 extraction
  // of hook/path-state helpers shifted the cost-benefit calculus; this module
  // currently sits at 725 LOC (deliberately, per the wave-4 brief). Budget
  // paths (warning at 20%, abort at 0%, recordCompaction) live in
  // installBudgetEventHooks and are installed separately (T2.1).
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
  //
  // Capture the prior lifetime totals BEFORE the prompt runs so the
  // per-message reasoning accumulation that happens during the prompt is
  // NOT included in prior. The §1.1 removal of `runStart*` from
  // AgentRuntime moved this capture out of the runtime and into the
  // dispatch flow; reasoning is the only counter not covered by
  // SessionStats, so it must be captured pre-prompt to produce a correct
  // per-run reasoning delta.
  const priorLifetime = {
    inputTokens: Number(runtime.inputTokens) || 0,
    outputTokens: Number(runtime.outputTokens) || 0,
    cacheReadTokens: Number(runtime.cacheReadTokens) || 0,
    cacheWriteTokens: Number(runtime.cacheWriteTokens) || 0,
    reasoningTokens: Number(runtime.reasoningTokens) || 0,
    costUsd: Number(runtime.costUsd) || 0,
  };
  try {
    const finalOutcome = await runPromptAndFinalize({
      state,
      runtime,
      session,
      streamState,
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
      priorLifetime,
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
  } catch (error) {
    // U2 outer catch: marks the dispatch as `crashed` so the finally
    // below maps this termination to `"crash"`. The re-throw preserves
    // existing dispatch semantics — the caller (the `delegate_agent`
    // tool surface) sees the throw via the standard tool-error path.
    // Inner catches (the delegateAgentFn try and the
    // runPromptAndFinalize try above) already convert most throws
    // into a returned `{output, exitCode: 1}` shape via
    // `emitSetupFailure` / the dispatch-lifecycle catch, so this
    // catch fires only on throws that escape both — the truly
    // unhandled paths the design calls out as "crash".
    crashed = true;
    throw error;
  } finally {
    // U2 revoke + KTD4 clear. Runs on every termination path of
    // `dispatchAgent` (return, error, abort, budget-exhausted,
    // queue-cancelled, crash). Skipped entirely when no override was
    // granted (R12: empty/undefined override => no grant event => no
    // revoke). The `delegationId` and `caller` captures close over
    // the function-scope locals declared above so the audit payload
    // matches the grant event one-for-one.
    if (overrideActive && delegationId) {
      // Order of predicates is significant: most-specific first.
      //   1. `crashed`        — outer catch fired, no inner conversion
      //   2. `budgetExhausted`— BudgetExhaustedError caught above
      //   3. `queueCancelled` — slot acquisition didn't return "acquired"
      //   4. `abortedByParent` — parent signal tripped; checked BEFORE
      //                         `errorMessage` because abort paths
      //                         also set `errorMessage` to an abort-
      //                         related message inside
      //                         runPromptAndFinalize.
      //   5. `errorMessage`   — any post-grant error path
      //   6. default           — `"return"` (clean finish)
      let terminationReason: "return" | "error" | "abort" | "crash" | "budget-exhausted" | "queue-cancelled";
      if (crashed) {
        terminationReason = "crash";
      } else if (budgetExhausted) {
        terminationReason = "budget-exhausted";
      } else if (queueCancelled) {
        terminationReason = "queue-cancelled";
      } else if (abortedByParent) {
        terminationReason = "abort";
      } else if (errorMessage || runtime.status === "error") {
        // `errorMessage` (function-scope) carries the setup-failure
        // signals (delegateAgentFn catch + partial-session branch).
        // `runtime.status === "error"` is the post-prompt signal set
        // by `runPromptAndFinalize` after it catches a thrown prompt
        // (its OWN `errorMessage` local in dispatch-lifecycle.ts is
        // NOT visible here). Either indicates a non-clean
        // termination that isn't an abort/budget/queue event.
        terminationReason = "error";
      } else {
        terminationReason = "return";
      }
      emitHiveEvent(state, "domain_override.revoked", {
        delegationId,
        revokedAt: new Date().toISOString(),
        terminationReason,
      }, caller);
      // R5 restore: hand the KTD4 plumbing back to whatever held it
      // at grant time — `undefined` for a top-level dispatcher, the
      // parent's merged-scope view for a nested child. Save/restore
      // keeps the parent's authority surface intact across nested
      // dispatch, so the parent's remaining tool turns after the child
      // returns see the correct merged scope. See AE8's
      // parent-scope-restore captures.
      state.activeOverrides = savedActiveOverrides;
    }
  }
}

