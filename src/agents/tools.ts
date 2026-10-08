import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext, ToolDefinition, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Theme, defineTool as definePiTool, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import { resolve } from "node:path";
import type { AgentType, HiveState, ReviewVerdictLevel } from "../core/types";
import {
  extractFinalAnswer,
  hexAnsi,
  safeRead,
  tailLines,
  truncateMiddle,
} from "../core/utils";
import { routeAgents } from "../engine/routing";
import { dispatchAgent } from "../engine/dispatch";
import { scheduleMentalModelDistillation } from "../engine/distiller";
import { renderHiveSddStatus, resolveHiveSddStatus } from "../engine/sdd";
import { currentChangeId } from "../engine/session";
import { emitHiveEvent } from "../engine/observability";
import * as openspec from "../engine/openspec";
import { agentRef, agentRoster, resolveRuntime } from "../engine/agent-lookup";
import { agentSlug } from "../core/utils";
import { budgetRemaining, effectiveWorkerGovernance } from "../engine/budget/policy";
import { queueOperatorCommand } from "../engine/budget/operator-command-queue";
import { resolveWorkerBudgetPolicy } from "../engine/budget/strategy";

type ToolUpdate = AgentToolUpdateCallback<object>;
// Replaced the local `ToolRenderOptions` shape with the SDK's
// `ToolRenderResultOptions` so the renderer surface stays in sync with pi.
// The SDK pins `expanded` and `isPartial` as required booleans (the local
// shape had both optional, which let `renderResult` be called with an unset
// `isPartial` flag and pass through silently).
type ToolRenderOptions = ToolRenderResultOptions;

// Pi infers a tool's details shape from the first return branch. Hive tools
// intentionally return several bounded detail variants, so widen details to a
// JSON-like record while preserving each TypeBox parameter schema.
function defineTool<TParams extends TSchema>(
  tool: ToolDefinition<TParams, object>,
) {
  return definePiTool(tool);
}

// Structural Component shape. Avoid importing pi-tui's `Component` type: its
// barrel re-exports it with a `.ts` specifier that tsc (moduleResolution
// "Bundler") cannot resolve, so `import { type Component }` fails to typecheck.
type ToolRenderComponent = { render: (width: number) => string[]; invalidate: () => void };

function emptyToolRender(): ToolRenderComponent {
  return { render: () => [], invalidate() {} };
}

function boundedToolRender(lines: string[] | (() => string[]), ellipsis: string): ToolRenderComponent {
  return {
    invalidate() {},
    render(width: number): string[] {
      const safeWidth = Math.max(0, width - 2);
      if (safeWidth <= 0) return [];
      const rendered = typeof lines === "function" ? lines() : lines;
      return rendered.map((line) => truncateToWidth(line, safeWidth, ellipsis));
    },
  };
}

function boundedPositiveInteger(value: unknown, fallback: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(max, Math.floor(number)) : fallback;
}

function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "?";
  if (count < 1000) return Math.round(count).toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatContextFill(row: { contextPct?: number; contextTokens?: number; contextWindow?: number }): string {
  const pct = Number(row.contextPct);
  const pctText = Number.isFinite(pct) ? `${pct.toFixed(1)}%` : "?";
  const tokens = Number(row.contextTokens);
  const window = Number(row.contextWindow);
  const tokenText = Number.isFinite(tokens) && Number.isFinite(window) && window > 0
    ? ` (${formatTokens(tokens)}/${formatTokens(window)})`
    : Number.isFinite(window) && window > 0
      ? ` (of ${formatTokens(window)})`
      : "";
  return `${pctText}${tokenText}`;
}

function contextAdvice(contextPct?: number): "resume-ok" | "consider-fresh" | "fresh-recommended" {
  const pct = Number(contextPct);
  if (!Number.isFinite(pct)) return "resume-ok";
  if (pct >= 85) return "fresh-recommended";
  if (pct >= 75) return "consider-fresh";
  return "resume-ok";
}

// Builds pi-hive's shared and type-scoped custom tools as reusable ToolDefinition objects
// (defineTool() does no registration — it's a pure identity/typing wrapper).
// The SAME definitions are used for the orchestrator's own pi.registerTool()
// call and for every worker AgentSession's customTools, so tool behavior never
// diverges between "the orchestrator's delegate_agent" and "a worker's own
// delegate_agent" (nested delegation intentionally grants workers this tool
// too — see normalizeWorkerTools's comment in core/normalize.ts).
export function buildHiveTools(state: HiveState, callerName: string): ToolDefinition[] {
  // Render an agent's name in ITS OWN configured color (matching the status
  // modal), falling back to the theme accent if no/invalid hex is configured.
  const agentColored = (name: string, theme: Theme): string => {
    const runtime = resolveRuntime(state, name);
    const color = runtime?.config.color;
    return hexAnsi(color, runtime?.config.name || name) || theme.fg("accent", runtime?.config.name || name);
  };

  const callerRuntime = resolveRuntime(state, callerName);
  // The visible main session's tools are registered before config/runtimes are
  // loaded, and its configured name may be "Plan Main" / "Hive Main" rather
  // than the legacy literal "Orchestrator". Treat that registered top-level
  // tool set as a lead so plan lifecycle tools are available in plan mode.
  const callerType: AgentType | undefined = callerRuntime?.config.agentType || (callerName === "Orchestrator" ? "lead" : undefined);

  const baseTools: ToolDefinition[] = [
    defineTool({
    name: "route_agent",
    label: "Route Agent",
    description: "Score the configured hive agents for a task and recommend who should handle it before delegation.",
    parameters: Type.Object({
      task: Type.String({ description: "The user's task or subtask to route." }),
      limit: Type.Optional(Type.Number({ description: "Maximum number of recommended agents to return." })),
    }),
    async execute(_toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: AgentToolUpdateCallback | undefined, ctx?: ExtensionContext) {
      const { task, limit } = params as { task: string; limit?: number };
      const recommendations = routeAgents(state, task, boundedPositiveInteger(limit, 5, 10), ctx?.cwd);
      const text = recommendations.length
        ? recommendations.map((entry, index) => `${index + 1}. ${entry.slug} — ${entry.name}${entry.group ? ` (${entry.group})` : ""} — score ${entry.score}${entry.reasons.length ? ` — ${entry.reasons.join(", ")}` : ""}`).join("\n")
        : "No strong route found. Delegate to the team lead whose consultWhen best matches, or ask the user to clarify scope.";
      return { content: [{ type: "text", text }], details: { task, recommendations } };
    },
  }),

  defineTool({
    name: "team_status",
    label: "Team Status",
    description: "Return the current hive session, log path, active workers, per-agent state, and context-window fill so leads can decide whether to resume a worker's session or trigger a clean restart from the operator surface.",
    parameters: Type.Object({}),
    async execute() {
      const rows = Array.from(state.runtimes.values()).map((runtime) => ({
        agent: agentRef(runtime),
        name: runtime.config.name,
        group: runtime.config.groupName || "Orchestration",
        status: runtime.status,
        runs: runtime.runCount,
        task: runtime.task,
        lastWork: runtime.lastWork,
        costUsd: runtime.costUsd,
        // Show the same number the budget tracks. Under the default "all"
        // scope this includes cache reads/writes and reasoning; under
        // tokenBudgetScope: "input_output" it's the input/output total only.
        tokens: effectiveWorkerGovernance(state, runtime).tokenBudgetScope === "input_output"
          ? runtime.inputTokens + runtime.outputTokens
          : runtime.inputTokens + runtime.outputTokens + runtime.cacheReadTokens + runtime.cacheWriteTokens + runtime.reasoningTokens,
        contextPct: runtime.contextPct,
        contextTokens: runtime.contextTokens,
        contextWindow: runtime.contextWindow,
        contextAdvice: contextAdvice(runtime.contextPct),
        budgetRemaining: budgetRemaining(state, runtime),
      }));
      const verdicts = Array.from((state.latestVerdicts || new Map()).values());
      const verdictLines = verdicts.length
        ? ["", "latest verdicts:", ...verdicts.map((v) => `- ${v.changeId}: ${v.verdict.toUpperCase()} by ${v.reviewer}${v.verdict === "red" && v.blockers.length ? ` — ${v.blockers.length} blocker(s)` : v.verdict === "yellow" && v.concerns.length ? ` — ${v.concerns.length} concern(s)` : ""}${v.summary ? ` — ${v.summary.slice(0, 120)}` : ""}`)]
        : [];
      const text = [
        `session: ${state.session?.sessionId || "not initialized"}`,
        `conversation: ${state.session?.conversationLog || "n/a"}`,
        `active_runs: ${state.activeRuns}`,
        `queued_runs: ${state.workerQueue?.length || 0}`,
        "",
        ...rows.map((row) => `- ${row.agent} [${row.group}] ${row.status}, runs=${row.runs}, ctx=${formatContextFill(row)} ${row.contextAdvice}, tokens=${row.tokens}, cost=$${row.costUsd.toFixed(3)}${Object.values(row.budgetRemaining.worker).some((value) => value !== undefined) ? `, remaining=${JSON.stringify(row.budgetRemaining.worker)}` : ""}${row.task ? ` — ${row.task.slice(0, 120)}` : ""}`),
        ...verdictLines,
      ].join("\n");
      return { content: [{ type: "text", text }], details: { session: state.session, activeRuns: state.activeRuns, queuedRuns: state.workerQueue?.length || 0, agents: rows, verdicts } };
    },
  }),

  defineTool({
    name: "delegate_agent",
    label: "Delegate Agent",
    description: "Delegate a focused task to one configured hive agent and receive its answer. Use this for all substantive work. The agent RESUMES its prior session by default (it remembers earlier work — ideal for a review→fix loop). To start a clean slate, dispatch the agent from the operator surface instead (e.g. the dashboard's respawn button) or call hive_reload_agent_config first if you only need to pick up new .md / hive-config.yaml edits.",
    parameters: Type.Object({
      agent: Type.String({ description: "Configured agent name (one of your delegation targets)." }),
      task: Type.String({ description: "Focused task for that agent. Include the exact question and expected output." }),
      isReadOnly: Type.Optional(Type.Boolean({ description: "Restrict delegation to direct reports only. Set false when the delegation is for a write-capable target you want to keep tree-bound (e.g. forcing operations-routed tasks to the operations lead rather than a coder). Default (omitted or true) preserves the type-based widening for read-only inspection delegations." })),
    }),
    async execute(_toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: ToolUpdate | undefined, ctx: ExtensionContext) {
      const p = (params || {}) as { agent?: string; task?: string; isReadOnly?: boolean };
      const agent = String(p.agent || "").trim();
      const task = String(p.task || "").trim();
      const isReadOnly = p.isReadOnly;
      if (!agent || !task) {
        const available = agentRoster(state);
        const missing = [!agent ? "agent" : "", !task ? "task" : ""].filter(Boolean).join(" and ");
        return {
          content: [{ type: "text", text: `delegate_agent requires ${missing}. Call it as {"agent":"<one of: ${available}>","task":"<focused task and expected output>"}.` }],
          details: { ok: false, status: "error", reason: "missing parameters", missing, available },
        };
      }
      onUpdate?.({ content: [{ type: "text", text: `Delegating to ${agent}${isReadOnly === false ? " (read-only restricted)" : ""}...` }], details: { agent, task, status: "running" } });
      const result = await dispatchAgent(state, agent, task, ctx, undefined, signal, isReadOnly);
      // Fire-and-forget memory distillation on success. Non-blocking: the
      // worker's answer returns immediately; the distiller reads a snapshot, so
      // re-delegating the same agent never races it.
      if (result.exitCode === 0) {
        const distillRuntime = resolveRuntime(state, agent);
        if (distillRuntime) void scheduleMentalModelDistillation(state, ctx, distillRuntime);
      }
      const limit = state.config?.settings.subagentOutputLimit || 12_000;
      const finalAnswer = extractFinalAnswer(result.output);
      const output = truncateMiddle(finalAnswer || result.output, limit);
      return {
        content: [{ type: "text", text: `[${agent}] ${result.exitCode === 0 ? "done" : "error"} in ${Math.round(result.elapsed / 1000)}s${finalAnswer ? " — final_answer extracted" : ""}\n\n${output}` }],
        details: { agent, task, status: result.exitCode === 0 ? "done" : "error", elapsed: result.elapsed, exitCode: result.exitCode, finalAnswer, outputPreview: output },
      };
    },
    renderCall(args: unknown, theme: Theme) {
      const a = (args || {}) as { agent?: string; task?: string; isReadOnly?: boolean };
      const agent = a.agent || "?";
      const task = String(a.task || "");
      // Surface any flag the caller explicitly set, using `hasOwnProperty` so
      // explicit `false` values still render. The default is
      // `isReadOnly: true` (typed-specialist widening allowed), but rendering
      // `isReadOnly=false` keeps the call line unambiguous and prevents the
      // orchestrator from claiming a flag was passed when only the words
      // "config reload" appeared in the task body. The bracketed suffix is
      // dim-styled so it stays secondary to the agent name on the same line.
      // The historical `delegate_agent` clean-session parameter is gone —
      // use the operator surface (respawn / reload-config buttons) for
      // that.
      const flagParts: string[] = [];
      if (Object.prototype.hasOwnProperty.call(a, "isReadOnly")) flagParts.push(`isReadOnly=${a.isReadOnly}`);
      const header = theme.fg("toolTitle", theme.bold("delegate_agent ")) +
        agentColored(agent, theme) +
        (flagParts.length ? theme.fg("dim", ` [${flagParts.join(", ")}]`) : "");
      // Show the full prompt across multiple rows (one per newline-separated
      // line) so multi-line prompts are readable. Per-line truncation to
      // terminal width is mandatory — pi's TUI throws uncaughtException when
      // a rendered line exceeds the visible width, so unbounded lines from a
      // long smoke-test prompt (e.g. 2809 chars on a single line) crash the
      // session. `boundedToolRender` calls truncateToWidth() per line and
      // appends an ellipsis when clipping.
      const dim = (line: string) => theme.fg("dim", line);
      const lines = task
        ? [header, ...task.split(/\r?\n/).map(dim)]
        : [header];
      return boundedToolRender(lines, theme.fg("dim", "…"));
    },
    renderResult(result: any, options: ToolRenderOptions, theme: Theme) {
      const details = (result.details || {}) as { agent?: string; status?: string; elapsed?: number; outputPreview?: string };
      const agent = details.agent || "agent";
      // While a delegation is running, the persistent Hive activity widget is
      // the single source of live progress. Rendering "working..." for every
      // nested delegate_agent call creates the repeated rows seen above the
      // editor, so keep the tool call line but suppress this interim result row.
      if (options.isPartial) return emptyToolRender();
      const ok = details.status === "done";
      const header = theme.fg(ok ? "success" : "error", `${ok ? "✓" : "✗"} `) + agentColored(agent, theme) + theme.fg("dim", ` ${Math.round((details?.elapsed || 0) / 1000)}s`);
      if (options.expanded && details?.outputPreview) {
        const preview = theme.fg("muted", truncateMiddle(details.outputPreview, 4000));
        return boundedToolRender([header, preview], theme.fg("dim", "…"));
      }
      return boundedToolRender([header], theme.fg("dim", "…"));
    },
  }),

  defineTool({
    name: "team_conversation",
    label: "Team Conversation",
    description: "Read one agent's own session transcript (clean — just that agent's work, e.g. to inspect what a reviewer found). You MUST name the agent: this tool is intentionally scoped per-agent. The shared interleaved team log is not readable this way because it is unbounded and would flood your context.",
    parameters: Type.Object({
      agent: Type.String({ description: "REQUIRED. Agent name (e.g. 'Security Reviewer'). Reads that agent's own session transcript." }),
      lines: Type.Optional(Type.Number({ description: "Number of JSONL lines from the tail to read (default 80, max 1000)." })),
    }),
    async execute(_toolCallId: string, params: unknown) {
      if (!state.session) return { content: [{ type: "text", text: "hive session not initialized" }], details: { ok: false } };
      // `params: unknown` is the SDK boundary; the schema-derived shape
      // carries the field types (`agent: string`, `lines?: number`) so the
      // execute body stops reaching for `(params as any).field`.
      const teamParams = params as { agent?: string; lines?: number };
      const lines = boundedPositiveInteger(teamParams.lines, 80, 1000);
      const agentName = String(teamParams.agent || "").trim();
      // Scoped-only: an empty agent (including a lines-only call) is rejected.
      // Reading the shared log dumped its entire interleaved tail — individual
      // records embed full agent outputs, so an 80-line tail could be >500KB and
      // blow up the caller's context. Per-agent transcripts are bounded.
      if (!agentName) {
        const available = agentRoster(state);
        return { content: [{ type: "text", text: `team_conversation requires an 'agent' slug or name. Pass one of: ${available}.` }], details: { ok: false } };
      }
      const runtime = resolveRuntime(state, agentName);
      if (!runtime) {
        const available = agentRoster(state);
        return { content: [{ type: "text", text: `Unknown agent "${agentName}". Available: ${available}` }], details: { ok: false } };
      }
      const limit = state.config?.settings.subagentOutputLimit || 12_000;
      const text = truncateMiddle(tailLines(safeRead(runtime.sessionFile), lines), limit);
      return { content: [{ type: "text", text: text || `${runtime.config.name} has no session transcript yet.` }], details: { ok: true, agent: agentSlug(runtime.config), name: runtime.config.name, lines } };
    },
  }),

  defineTool({
    name: "hive_sdd_status",
    label: "Hive SDD Status",
    description: "Inspect OpenSpec/SDD status for this project and show the recommended hive phase routing.",
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: unknown, _signal: AbortSignal | undefined, _onUpdate: ToolUpdate | undefined, ctx: ExtensionContext) {
      const status = resolveHiveSddStatus(state, ctx.cwd);
      state.sddStatus = status;
      return { content: [{ type: "text", text: renderHiveSddStatus(status) }], details: status };
    },
  }),

  // hive_cycle_summary — captures the LLM's handoff summary during a
  // hive→normal (or plan→normal) transition. Set on
  // state.pendingHiveCycleRestore by applyMode when there is a baseline;
  // cleared by the agent_settled handler after branching. Calling outside a
  // hive handoff returns isError without mutating state — pi-context's
  // canonical pattern. Not gated by mode (always available), since the LLM
  // must be able to call it during the follow-up turn.
  defineTool({
    name: "hive_cycle_summary",
    label: "Hive Cycle Summary",
    description: "Call this with a concise summary of the hive or plan-mode work you just completed. pi-hive will branch the conversation at this point so the user can continue in normal mode without re-reading the hive-mode tail. Call only when explicitly asked (e.g., immediately after exiting hive or plan mode).",
    parameters: Type.Object({
      summary: Type.String({
        description: "Concise handoff summary of the work done in hive/plan mode. Restore current task/state, decisions/constraints, important side effects (changed files, processes, remote state), validation status, and explicit next step. If no work was done, pass an empty string.",
      }),
    }),
    async execute(_toolCallId, params) {
      const summary = String((params as { summary: string }).summary ?? "");
      if (!state.pendingHiveCycleRestore) {
        return {
          content: [{
            type: "text",
            text: "No pending hive cycle restore is active. This tool should only be called immediately after exiting hive or plan mode.",
          }],
          details: {},
          isError: true,
        };
      }
      state.pendingHiveCycleRestore.summary = summary;
      return {
        content: [{
          type: "text",
          text: `Handoff summary recorded (${summary.length} chars). pi-hive will branch the conversation on the next agent_settled event.`,
        }],
        details: {},
      };
    },
  }),

  ];

  // Type-scoped tools. These are granted by AGENT TYPE (not the tools list), so
  // they are appended here only for the eligible type and are kept through
  // dispatch's tools-list filter (see TYPE_SCOPED_TOOL_NAMES).
  const typeScopedTools: ToolDefinition[] = [];

  // submit_review_verdict — reviewer-only by construction. Non-reviewers never
  // see it, so there is no runtime-rejection path.
  if (callerType === "reviewer") {
    typeScopedTools.push(defineTool({
      name: "submit_review_verdict",
      label: "Submit Review Verdict",
      description: "Submit your FINAL structured review verdict (red/yellow/green). green = clean approval; yellow = approve with non-blocking concerns (proceed, surface them); red = blocked, list blockers. Reviewers MUST call this before their final answer; do not put the verdict only in chat text.",
      parameters: Type.Object({
        verdict: Type.Union([Type.Literal("red"), Type.Literal("yellow"), Type.Literal("green")], { description: "red = blocked (populate blockers); yellow = approve with non-blocking concerns; green = clean approval." }),
        summary: Type.String({ description: "One- or two-sentence summary of the review conclusion." }),
        evidence: Type.Optional(Type.Array(Type.String(), { description: "What was checked / commands run / files inspected." })),
        concerns: Type.Optional(Type.Array(Type.String(), { description: "Yellow: non-blocking follow-ups to surface to the human." })),
        blockers: Type.Optional(Type.Array(Type.String(), { description: "Red: must-fix items before proceeding." })),
        changeId: Type.Optional(Type.String({ description: "The change-id under review. Defaults to the active change if one is set." })),
        artifact: Type.Optional(Type.String({ description: "The OpenSpec artifact under review, e.g. proposal.md, design.md, specs/**/*.md, or tasks.md. Required for OpenSpec plan-review gates." })),
      }),
      async execute(_toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: ToolUpdate | undefined, ctx: ExtensionContext) {
        const p = params as { verdict: ReviewVerdictLevel; summary: string; evidence?: string[]; concerns?: string[]; blockers?: string[]; changeId?: string; artifact?: string };
        const changeId = (p.changeId?.trim() || currentChangeId() || state.activeChangeId || "").trim();
        const evidence = p.evidence || [];
        const concerns = p.concerns || [];
        const blockers = p.blockers || [];
        // Persist content-bound automated review authority before publishing
        // telemetry or in-memory state. The queue covers the complete
        // validation/read/write window and shares a key with built-in writes.
        if (changeId && p.artifact?.trim()) {
          const artifact = p.artifact.trim();
          const recordPath = openspec.approvalRecordPath(ctx.cwd, changeId, artifact, "automated-review");
          if (!recordPath) throw new Error(`Invalid automated review target: ${changeId}/${artifact}`);
          await withFileMutationQueue(recordPath, async () => {
            openspec.setAgentReviewVerdict(ctx.cwd, changeId, artifact, p.verdict, callerName);
          });
        }
        // Emit only after authoritative persistence succeeds. The dashboard
        // materializes this event into plan_verdicts for display.
        emitHiveEvent(state, "review_verdict", { changeId, reviewer: callerName, verdict: p.verdict, summary: p.summary, evidence, concerns, blockers }, callerName);
        if (changeId) {
          (state.latestVerdicts ||= new Map()).set(changeId, {
            changeId, reviewer: callerName, verdict: p.verdict, summary: p.summary,
            evidence, concerns, blockers, createdAt: new Date().toISOString(),
          });
        }
        const scope = changeId ? `change "${changeId}"` : "the current session (no active change-id)";
        const detail = p.verdict === "red" ? `${blockers.length} blocker(s)` : p.verdict === "yellow" ? `${concerns.length} concern(s)` : "clean";
        return {
          content: [{ type: "text", text: `Verdict recorded for ${scope}: ${p.verdict.toUpperCase()} — ${detail}. ${p.summary}` }],
          details: { ok: true, changeId, verdict: p.verdict, evidence, concerns, blockers },
        };
      },
    }));
  }

  // Plan lifecycle tools. Available to leads (incl. the orchestrator), who
  // select/create an OpenSpec change and then delegate planners under it.
  // Approval is NOT a chat tool anymore: each artifact is approved in the
  // dashboard's plan-review UI (the review IS the gate). Approving the tasks
  // artifact opens the execution gate.
  if (callerType === "lead") {
    typeScopedTools.push(defineTool({
      name: "plan_new",
      label: "New Plan",
      description: "Scaffold a new OpenSpec change under openspec/changes/<change-id>/ and make it the active change. Then use /opsx-propose (or delegate a planner) to author proposal/design/specs/tasks artifacts into it.",
      parameters: Type.Object({
        title: Type.String({ description: "Human title for the change (also used to derive the kebab change-id)." }),
      }),
      async execute(_toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: ToolUpdate | undefined, ctx: ExtensionContext) {
        const { title } = params as { title: string };
        if (!openspec.isAvailable()) {
          return { content: [{ type: "text", text: "OpenSpec CLI is not installed, so no plan store is available. Install @fission-ai/openspec to author plans." }], details: { ok: false, reason: "openspec unavailable" } };
        }
        const requestedChangeId = openspec.toChangeId(title);
        if (state.activeChangeId && openspec.changeExists(ctx.cwd, state.activeChangeId) && state.activeChangeId !== requestedChangeId) {
          return {
            content: [{
              type: "text",
              text: `This planning session already has active change "${state.activeChangeId}". Continue that plan and put related slices inside it. To intentionally switch, use plan_select(changeId). Do not create a second plan from the same session unless the user explicitly asks to switch scope.`,
            }],
            details: { ok: false, activeChangeId: state.activeChangeId, requestedChangeId },
          };
        }
        const result = await withFileMutationQueue(resolve(ctx.cwd, "openspec", "changes", requestedChangeId), async () => {
          openspec.ensureInit(ctx.cwd);
          return openspec.newChange(ctx.cwd, title);
        });
        if (!result) {
          return { content: [{ type: "text", text: `Could not create change from "${title}". Ensure the derived id is valid kebab-case and OpenSpec is initialized.` }], details: { ok: false } };
        }
        state.activeChangeId = result.changeId;
        const note = result.created ? "created" : "already existed";
        return { content: [{ type: "text", text: `OpenSpec change "${result.changeId}" ${note} and is now the active change (openspec/changes/${result.changeId}/). Author its proposal → design/specs → tasks via /opsx-propose; spec deltas go in specs/<capability>/spec.md (capability slug, not the change-id repeated). Keep this session focused on this change.` }], details: { ok: true, ...result } };
      },
    }));

    typeScopedTools.push(defineTool({
      name: "plan_task_complete",
      label: "Complete Plan Task",
      description: "Record one executed tasks.md checkbox as complete without mutating the human-approved OpenSpec artifact. The record is bound to the exact approved tasks hash and requires implementation evidence.",
      parameters: Type.Object({
        taskId: Type.String({ description: "Task identifier from a tasks.md checkbox, for example 1.1 or api-tests." }),
        evidence: Type.String({ description: "Concrete implementation/test evidence supporting completion." }),
        changeId: Type.Optional(Type.String({ description: "OpenSpec change-id. Defaults to the active change." })),
      }),
      async execute(_toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: ToolUpdate | undefined, ctx: ExtensionContext) {
        const p = params as { taskId: string; evidence: string; changeId?: string };
        const changeId = String(p.changeId || state.activeChangeId || currentChangeId() || "").trim();
        const taskId = String(p.taskId || "").trim();
        const recordPath = openspec.executionTaskRecordPath(ctx.cwd, changeId, taskId);
        if (!recordPath) throw new Error(`Invalid execution task target: ${changeId}/${taskId}`);
        const progress = await withFileMutationQueue(recordPath, async () =>
          openspec.markExecutionTaskComplete(ctx.cwd, changeId, taskId, callerName, String(p.evidence || "")));
        return {
          content: [{ type: "text", text: `Recorded task ${progress.taskId} complete for change "${changeId}". The approved tasks.md was not modified.` }],
          details: { ok: true, changeId, progress },
        };
      },
    }));

    typeScopedTools.push(defineTool({
      name: "plan_select",
      label: "Select Plan",
      description: "Set the active OpenSpec change by change-id (must exist under openspec/changes/). With no argument, lists available changes.",
      parameters: Type.Object({
        changeId: Type.Optional(Type.String({ description: "The change-id to activate. Omit to list available changes." })),
      }),
      async execute(_toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: ToolUpdate | undefined, ctx: ExtensionContext) {
        // Schema-derived shape: `changeId?: string`. Replaces `(params as any).changeId`
        // so the SDK boundary is the only cast.
        const planParams = params as { changeId?: string };
        const changeId = String(planParams.changeId || "").trim();
        const available = openspec.listChanges(ctx.cwd).map((c) => c.name);
        if (!changeId) {
          const list = available.length ? available.map((id) => `- ${id}${state.activeChangeId === id ? " (active)" : ""}`).join("\n") : "(none)";
          return { content: [{ type: "text", text: `Available OpenSpec changes:\n${list}` }], details: { ok: true, available, active: state.activeChangeId } };
        }
        if (!openspec.changeExists(ctx.cwd, changeId)) {
          return { content: [{ type: "text", text: `No change "${changeId}" under openspec/changes/. Available: ${available.join(", ") || "none"}. Use plan_new to create one.` }], details: { ok: false, available } };
        }
        state.activeChangeId = changeId;
        const detail = openspec.changeDetail(ctx.cwd, changeId);
        const next = detail?.nextReady ? ` (next artifact: ${detail.nextReady})` : "";
        return { content: [{ type: "text", text: `Active change set to "${changeId}"${next}.` }], details: { ok: true, changeId, detail } };
      },
    }));
  }

  // ── LLM tool gap (Wave `refactor/llm-tool-gap`) ────────────────────────
  // The 12 operator command tools. Each one writes a row to
  // `operator-command-pickup.jsonl` (the same file the dashboard's
  // 11-button UI uses). The parent pi's pickup consumer
  // (`src/integration/operator-pickup.ts`) drains the file on a
  // 250ms tick and invokes the matching engine function. The LLM
  // tool is thin: validate input against the same allow-list the
  // HTTP handler enforces, write a row, return success. The
  // command is async (the model does not wait for the actual
  // operator action to complete).
  //
  // Gated to `callerType === "lead"` so only the orchestrator (and
  // any other `agentType: "lead"` agent) sees these tools. Workers
  // typed {coder, tester, reviewer, planner} do NOT get them — they
  // have their own cooperative tools (request_compaction,
  // request_end_session, request_snapshot) for self-call.
  if (callerType === "lead") {
    // Shared schema for tools that take a single worker name. Some
    // commands (tear-down-all) omit the agent; the optional
    // description tells the LLM to pass an empty/missing agent
    // for team-wide commands. The roster is summarized in the
    // system prompt so the LLM can pick a valid name without
    // guessing.
    const workerNameSchema = Type.String({ description: "Configured agent name (the same identifier used by delegate_agent and team_status). Must be in the configured roster." });

    // Shared execute body: validate the agent is configured, write
    // the row, return success. Mirrors the dashboard HTTP handler's
    // validation order: command in allow-list, agent name present
    // and within the 120-char limit, then the write. The LLM
    // gets a clear "no such agent" message before the row is
    // queued so model-side retries are informed.
    const executeOperatorCommand = (command: string, agent: string | undefined, summary: string) => {
      const trimmed = String(agent || "").trim();
      const requestedAt = new Date().toISOString();
      const result = queueOperatorCommand(state, trimmed, command, requestedAt);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `${summary} failed: ${result.error}` }],
          details: { ok: false, status: "rejected", command, agent: trimmed, error: result.error },
          isError: true,
        };
      }
      return {
        content: [{
          type: "text" as const,
          text: `${summary} queued at ${result.requestedAt}. The parent pi's pickup consumer will invoke the operator command within ~250ms. The action is async — check team_status or the dashboard for the resulting state.`,
        }],
        details: { ok: true, status: "queued", command, agent: trimmed, requestedAt: result.requestedAt },
      };
    };

    typeScopedTools.push(defineTool({
      name: "hive_end_worker",
      label: "End Worker Session",
      description: "End a worker's current session cleanly. The session is archived (recoverable via restore) but the agent becomes idle. Use when a worker has finished its task and you want to free it for re-dispatch, or when a long-running session has produced its final answer. Prefer this over force_end_worker — force_end is the operator escape hatch for stuck sessions.",
      parameters: Type.Object({ agent: workerNameSchema }),
      async execute(_id, params) {
        return executeOperatorCommand("end", (params as { agent?: string }).agent, "End worker session");
      },
    }));

    typeScopedTools.push(defineTool({
      name: "hive_compact_worker",
      label: "Compact Worker Session",
      description: "Trigger a session-compaction pass on a worker's current session. The session is summarized, older turns are dropped, and the worker's context window is reclaimed. Use when a worker's contextPct is high but you want to keep the session alive (vs respawn which starts fresh). Honors policy.strategies.summary.maxTokens if configured.",
      parameters: Type.Object({ agent: workerNameSchema }),
      async execute(_id, params) {
        return executeOperatorCommand("compact", (params as { agent?: string }).agent, "Compact worker session");
      },
    }));

    typeScopedTools.push(defineTool({
      name: "hive_respawn_worker",
      label: "Respawn Worker",
      description: "Discard the worker's current session and start fresh. The prior session is archived (recoverable via restore). Use when a worker has accumulated context you want to reset, when the previous session is no longer useful, or when you want a clean slate before a new task. This is the LLM-side equivalent of the dashboard's respawn button.",
      parameters: Type.Object({ agent: workerNameSchema }),
      async execute(_id, params) {
        return executeOperatorCommand("respawn", (params as { agent?: string }).agent, "Respawn worker");
      },
    }));

    typeScopedTools.push(defineTool({
      name: "hive_pause_worker",
      label: "Pause Worker",
      description: "Pause a worker's session without ending it. The worker stops processing new tasks but its session is preserved. Use when a worker is mid-delegation and you need to halt further work (e.g. before a config change, before a bug fix lands). Pair with hive_resume_worker to continue.",
      parameters: Type.Object({ agent: workerNameSchema }),
      async execute(_id, params) {
        return executeOperatorCommand("pause", (params as { agent?: string }).agent, "Pause worker");
      },
    }));

    typeScopedTools.push(defineTool({
      name: "hive_snapshot_worker",
      label: "Snapshot Worker Session",
      description: "Take a labeled snapshot of a worker's current session. The snapshot is branchable — future restore calls can return to this point. Use before risky changes (e.g. before respawn or compact) so you have a fallback. Snapshots are persisted to the worker's session file.",
      parameters: Type.Object({ agent: workerNameSchema }),
      async execute(_id, params) {
        return executeOperatorCommand("snapshot", (params as { agent?: string }).agent, "Snapshot worker session");
      },
    }));

    typeScopedTools.push(defineTool({
      name: "hive_restore_worker",
      label: "Restore Worker Session",
      description: "Restore a worker's session from a prior snapshot. Currently the LLM-side path does not surface a snapshot-id flow (the consumer rejects restores without a snapshot id); the dashboard's restore button is the supported path. Provided here for symmetry with the other operator commands; the call will fail with a clear error until the consumer gains a snapshot-id input.",
      parameters: Type.Object({ agent: workerNameSchema }),
      async execute(_id, params) {
        return executeOperatorCommand("restore", (params as { agent?: string }).agent, "Restore worker session");
      },
    }));

    typeScopedTools.push(defineTool({
      name: "hive_resume_worker",
      label: "Resume Worker",
      description: "Resume a paused worker. The worker re-enters the active queue and can take new tasks. Use after a hive_pause_worker to continue a halted session, or after config changes that required the worker to be off the queue.",
      parameters: Type.Object({ agent: workerNameSchema }),
      async execute(_id, params) {
        return executeOperatorCommand("resume", (params as { agent?: string }).agent, "Resume worker");
      },
    }));

    typeScopedTools.push(defineTool({
      name: "hive_abort_compaction",
      label: "Abort Worker Compaction",
      description: "Abort an in-flight compaction on a worker. Use when a compaction is hung or producing bad summaries and you want to keep the un-compacted session. Pair with hive_respawn_worker if you want a fresh start instead of an aborted one.",
      parameters: Type.Object({ agent: workerNameSchema }),
      async execute(_id, params) {
        return executeOperatorCommand("abort-compaction", (params as { agent?: string }).agent, "Abort worker compaction");
      },
    }));

    typeScopedTools.push(defineTool({
      name: "hive_force_kill_worker",
      label: "Force Kill Worker",
      description: "Operator escape hatch: forcibly kill a stuck worker. The session is disposed, the worker handle is unregistered, and the worker becomes unavailable until a new dispatch re-creates the handle. Use ONLY when the worker is unresponsive and normal end/pause paths are not working. Prefer hive_force_end_worker when possible (it preserves the handle for re-dispatch).",
      parameters: Type.Object({ agent: workerNameSchema }),
      async execute(_id, params) {
        return executeOperatorCommand("force-kill", (params as { agent?: string }).agent, "Force kill worker");
      },
    }));

    typeScopedTools.push(defineTool({
      name: "hive_force_end_worker",
      label: "Force End Worker",
      description: "Force-end a worker's session when normal end is not working. Unlike force_kill, the worker handle is preserved (the next dispatch can re-mount it). Use as a stronger end when a worker is hung but you want to keep the agent's handle around.",
      parameters: Type.Object({ agent: workerNameSchema }),
      async execute(_id, params) {
        return executeOperatorCommand("force-end", (params as { agent?: string }).agent, "Force end worker");
      },
    }));

    typeScopedTools.push(defineTool({
      name: "hive_tear_down_all",
      label: "Tear Down All Workers",
      description: "Tear down ALL live workers in one operator command. Each worker's session is ended (non-forced). Use at the end of a hive cycle when you want a clean exit, or when the team is over-budget and you want to halt everything. The team is the orchestrator's runtimes map; this is the operator's 'shutdown everything' button.",
      parameters: Type.Object({}),
      async execute(_id, _params) {
        // tear-down-all ignores the per-row agent; the consumer
        // iterates the workerHandles map. Pass empty string as
        // the agent — validateCommand allows this for
        // tear-down-all.
        return executeOperatorCommand("tear-down-all", "", "Tear down all workers");
      },
    }));

    typeScopedTools.push(defineTool({
      name: "hive_reload_agent_config",
      label: "Reload Agent Config",
      description: "Reload an agent's YAML config from disk (.pi/hive/agents/<slug>.md and the team's hive-config.yaml). The next delegate_agent call sees the updated runtime.config (domain, tools, model, governance, agentType, ...). Use after editing an agent's .md file or its governance block in hive-config.yaml. The T13.0 sunset removed the legacy `fresh` parameter on delegate_agent, so this is the only path to pick up config edits without restarting the orchestrator. The command is idempotent — calling it twice with no edits between is a no-op.",
      parameters: Type.Object({ agent: workerNameSchema }),
      async execute(_id, params) {
        return executeOperatorCommand("hive_reload_agent_config", (params as { agent?: string }).agent, "Reload agent config");
      },
    }));

    // ── Introspection tools (LLM tool gap, should-have) ───────────
    // These are the "read" half of the operator surface: the
    // orchestrator LLM needs to know what policy is in effect and
    // why a delegation was rejected, not just the cap values from
    // team_status. Both are gated to leads (orchestrators) so
    // workers do not see them — the policy surface includes
    // per-team cap information that is meant for the lead only.

    typeScopedTools.push(defineTool({
      name: "hive_read_policy",
      label: "Read Effective Policy",
      description: "Read the effective budget policy for an agent (or the team-wide defaults when no agent is given). Returns the resolved WorkerBudgetPolicy — tokens / costUsd / runs / depth caps and the strategies block (onApproachingLimit.threshold, onExhaustion.action, summary.maxTokens). Use this when you want to know what the pre-flight gate will enforce BEFORE you delegate, especially after editing an agent's .md or hive-config.yaml. The agent argument is optional: omit it to see the team-wide defaults.",
      parameters: Type.Object({
        agent: Type.Optional(Type.String({ description: "Configured agent name. Omit to read the team-wide defaults from settings.budgets." })),
      }),
      async execute(_id, params) {
        if (!state.config) return { content: [{ type: "text" as const, text: "hive is not configured" }], details: { ok: false } };
        const agentParam = String((params as { agent?: string }).agent || "").trim();
        if (!agentParam) {
          // Team defaults: read global budgets (no per-agent merge).
          const strategies = state.config.settings?.budgets?.strategies;
          const policy = resolveWorkerBudgetPolicy(state.config, "__team__");
          return {
            content: [{ type: "text" as const, text: `Team-wide budget policy (settings.budgets):\n\n${JSON.stringify({ policy, strategies }, null, 2)}` }],
            details: { ok: true, agent: null, policy, strategies },
          };
        }
        const runtime = resolveRuntime(state, agentParam);
        if (!runtime) {
          return { content: [{ type: "text" as const, text: `Unknown agent "${agentParam}". Available: ${agentRoster(state)}.` }], details: { ok: false } };
        }
        // The resolver keys by exact config.name; use the runtime's
        // canonical name so a per-agent override applies regardless
        // of how the LLM spelled the agent (slug vs display name).
        const policy = resolveWorkerBudgetPolicy(state.config, runtime.config.name);
        const strategies = state.config.settings?.budgets?.strategies;
        const text = JSON.stringify({ agent: runtime.config.name, policy, strategies }, null, 2);
        return {
          content: [{ type: "text" as const, text: `Effective policy for ${runtime.config.name}:\n\n${text}` }],
          details: { ok: true, agent: runtime.config.name, policy, strategies },
        };
      },
    }));

    typeScopedTools.push(defineTool({
      name: "hive_explain_rejection",
      label: "Explain Last Rejection",
      description: "Return the reason the pre-flight gate last refused a delegation for the given agent. The dispatcher records the BudgetExhaustedError on the agent's runtime when delegate_agent is blocked (worker/team cap exceeded). Use this when delegate_agent returns a failed result and you want a structured explanation (scope, resource, remaining, limit, timestamp) so you can decide between respawn / compact / force-kill / re-delegation. Returns a clear 'no rejection recorded' message when the agent has not been refused since the last successful delegation.",
      parameters: Type.Object({ agent: workerNameSchema }),
      async execute(_id, params) {
        const agent = String((params as { agent?: string }).agent || "").trim();
        if (!agent) return { content: [{ type: "text" as const, text: "agent is required" }], details: { ok: false } };
        const runtime = resolveRuntime(state, agent);
        if (!runtime) {
          return { content: [{ type: "text" as const, text: `Unknown agent "${agent}". Available: ${agentRoster(state)}.` }], details: { ok: false } };
        }
        const rejection = runtime.lastRejection;
        if (!rejection) {
          return {
            content: [{ type: "text" as const, text: `No pre-flight rejection recorded for ${agent} since the last successful delegation. The agent is currently delegatable.` }],
            details: { ok: true, agent, rejection: null },
          };
        }
        const ageMs = Date.now() - Date.parse(rejection.at);
        const ageLabel = ageMs < 60_000 ? `${Math.round(ageMs / 1000)}s ago` : `${Math.round(ageMs / 60_000)}m ago`;
        const text = `Last pre-flight rejection for ${agent} (${ageLabel}, at ${rejection.at}):\n\n` +
          `- reason: ${rejection.reason}\n` +
          `- scope: ${rejection.scope}\n` +
          `- resource: ${rejection.resource}\n` +
          `- remaining: ${JSON.stringify(rejection.remaining)}\n` +
          `- limit: ${JSON.stringify(rejection.limit)}`;
        return {
          content: [{ type: "text" as const, text }],
          details: { ok: true, agent, rejection, ageMs },
        };
      },
    }));
  }

  return [...baseTools, ...typeScopedTools];
}

export function registerTools(pi: ExtensionAPI, state: HiveState) {
  for (const tool of buildHiveTools(state, "Orchestrator")) pi.registerTool(tool);
}
