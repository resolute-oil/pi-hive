import type { ExtensionAPI, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { AgentConfig, HiveState } from "../core/types";
import { agentSlug, boundedDiagnostics, clip, configuredChildAgents, extractUsage, textFromMessage, truncateMiddle } from "../core/utils";
import { logRecord } from "../engine/state";
import { reloadTeam } from "../engine/session";
import { buildOrchestratorPrompt } from "../agents/prompts";
import { applyMode, captureNormalTools, installHeader, updateWidget } from "../ui/tui/widget";
import { clearHiveActivityWidget } from "../ui/tui/activity";
import { resolveHiveSddStatus } from "../engine/sdd";
import { ensureDashboard, killOwnedDashboardOnQuit } from "../engine/dashboard";
import { resolveRuntime } from "../engine/agent-lookup";
import { emitHiveEvent, writeHiveStateSnapshot } from "../engine/observability";
import { registerOrchestratorTelemetryListeners } from "../engine/telemetry-listeners";
import { resolveConfiguredPath } from "../core/safe-path";
import { cancelWorkerQueue } from "../engine/worker-queue";
import { clearCommandCtx, getCommandCtx } from "./commands";
import { startOperatorCommandPickup, stopOperatorCommandPickup } from "./operator-pickup";

const EXTENSION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Snapshot/restore handoff for the hive→normal mode switch. Mirrors the shape
// of pi-context's `context_compact` flow (branchWithSummary + branch reset +
// navigateTree in an event handler) — pi-context is the pattern reference but
// is NOT a runtime dependency here; only public Pi SDK APIs are used and no
// code is copied from pi-context.
//
// Failure policy (per design Q8): retry once with an empty summary, then fall
// back to best-effort (log + UI notify, no rethrow). The mode switch itself
// has already succeeded by the time this fires.
export async function handleAgentSettledForHiveRestore(state: HiveState): Promise<void> {
  const pending = state.pendingHiveCycleRestore;
  if (!pending) return;

  // Capture-and-clear immediately so a re-entry (next agent_settled) sees an
  // empty field and bails out — without this, a retried restore could fire
  // twice on the same cycle.
  state.pendingHiveCycleRestore = undefined;

  const commandCtx = getCommandCtx();
  if (!commandCtx) {
    console.warn("[pi-hive] agent_settled: no ExtensionCommandContext captured; hive→normal history restore skipped.");
    return;
  }

  const sm = commandCtx.sessionManager as SessionManager;
  const snapshotLeafId = pending.snapshotLeafId;
  const summary = pending.summary ?? "";

  // First attempt.
  try {
    await commandCtx.waitForIdle();
    const nid = sm.branchWithSummary(snapshotLeafId, summary);
    sm.branch(snapshotLeafId);
    const result = await commandCtx.navigateTree(nid, { summarize: false });
    if (result.cancelled) throw new Error("navigateTree cancelled");
    state.pi.sendMessage(
      {
        customType: "pi-hive-mode-switch",
        content: "Hive cycle summary complete. Your previous hive-mode work has been collapsed to the summary you provided. Continue from this state in normal mode.",
        display: false,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    return;
  } catch (_err1) {
    // First failure — fall through to retry.
  }

  // Retry with empty summary.
  try {
    await commandCtx.waitForIdle();
    const nid = sm.branchWithSummary(snapshotLeafId, "");
    sm.branch(snapshotLeafId);
    const result = await commandCtx.navigateTree(nid, { summarize: false });
    if (result.cancelled) throw new Error("navigateTree cancelled");
    state.pi.sendMessage(
      {
        customType: "pi-hive-mode-switch",
        content: "Hive cycle summary complete (with empty summary fallback). Continue from this state in normal mode.",
        display: false,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    return;
  } catch (err2) {
    const message = "Hive→normal history restore failed; continuing in normal mode without restoring prior context.";
    console.warn(`[pi-hive] ${message}`, err2);
    if (commandCtx.hasUI) commandCtx.ui.notify(message, "warning");
    // Don't rethrow — mode switch already succeeded.
  }
}

export function registerHooks(pi: ExtensionAPI, state: HiveState) {
  // Debounced snapshot write so orchestrator-only conversations (no delegations)
  // still reach hive-state.json (J5). Delegations trigger their own snapshot in
  // dispatch.ts; this covers turns where the orchestrator works alone. NOT
  // telemetry-related, stays in hooks.ts; the telemetry listener module owns
  // its own snapshot-on-status-change write via setOrchestratorStatus.
  let orchestratorSnapshotTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleOrchestratorSnapshot = () => {
    if (orchestratorSnapshotTimer) return;
    orchestratorSnapshotTimer = setTimeout(() => {
      orchestratorSnapshotTimer = undefined;
      try { writeHiveStateSnapshot(state); } catch { /* best-effort */ }
    }, 2000);
    orchestratorSnapshotTimer.unref?.();
  };

  // The 12 simple orchestrator telemetry listeners + the shared
  // orchestratorToolStartedAt / turnStartedAt Maps + setOrchestratorStatus
  // live in `engine/telemetry-listeners.ts`. The returned handle is invoked
  // from `session_shutdown` below to release the Maps and tear down the
  // registered listeners — same leak-prevention as the inline .clear()
  // calls the original hooks.ts owned.
  const telemetryListeners = registerOrchestratorTelemetryListeners(pi, state);

  pi.on("before_agent_start", async (event, _ctx: ExtensionContext) => {
    if (!state.config || state.mode === "normal") return;
    const planMode = state.mode === "plan";
    const catalog = state.config.agents.map((root) => {
      const lines: string[] = [];
      const renderCatalogAgent = (agent: AgentConfig, depth: number) => {
        const runtime = resolveRuntime(state, agent.slug || agent.name);
        const agentConfig = runtime?.config || agent;
        const tags = agentConfig.routingTags?.length ? ` [${agentConfig.routingTags.join(", ")}]` : "";
        const indent = "  ".repeat(depth);
        lines.push(`${indent}- ${agentSlug(agentConfig)} — ${agentConfig.name}${tags}: ${agentConfig.consultWhen || "team work"}`);
        for (const child of configuredChildAgents(agent)) renderCatalogAgent(child, depth + 1);
      };
      configuredChildAgents(root).forEach((child) => renderCatalogAgent(child, 1));
      return `## ${root.name}\n- ${agentSlug(root)} — ${root.name}${root.routingTags?.length ? ` [${root.routingTags.join(", ")}]` : ""}: ${root.consultWhen || "team work"}\n${lines.join("\n")}`;
    }).join("\n\n");

    const planBlock = planMode
      ? `# Plan mode — you are the main session of the PLANNING team
You are running as the visible main session in PLAN mode. Your job is to produce a COMPLETE OpenSpec change for the requested work, not to implement it. You have NO file-writing tools in this mode — you delegate. Drive the planning team to author the change under \`openspec/changes/<change-id>/\` in dependency order: proposal → design/specs → tasks, using the /opsx-* commands OpenSpec installs. Spec deltas must follow OpenSpec's path convention: \`specs/<capability>/spec.md\` inside the change (use the capability name, not the change-id again; do not create a bare \`spec.md\` or \`specs/spec.md\`). Use plan_new to scaffold/select a change and delegate to planners (and reviewers, for plan-phase feedback) for each artifact.

When scope or requirements are ambiguous, use ask_user to interrogate the human BEFORE writing artifacts — do not guess. The ask_user tool is provided by the optional pi-ask-user peer dep and supports multi-choice options (with title/description per option), freeform input, optional comments, and a configurable timeout. Pass a short context summary via the \`context\` field so the user can answer without scrolling back. If the response is dismissed or the dialog times out, the tool returns null and you should record a clearly-stated assumption, proceed, and flag the assumption for the user to confirm later.

Each finished artifact is reviewed in the dashboard's plan-review UI; approving the tasks artifact opens the execution gate. Do NOT write or modify any files yourself in this mode — that is execution, which happens in hive mode. The end result of plan mode is an approved, validated tasks.md; then the user switches to hive mode (or runs /hive:execute) to build it.

`
      : "";

    return {
      systemPrompt: `${event.systemPrompt}

# ${planMode ? "Hive plan mode" : "Hive orchestrator mode"}
${planBlock}${buildOrchestratorPrompt(state, _ctx)}

Use route_agent when the best specialist is not obvious, delegate to specialists with delegate_agent (including typed specialists like coder/tester/reviewer/planner for read-only inspections — not only team leads), then synthesize their findings.
When calling delegate_agent, ALWAYS provide both required arguments: {"agent":"<exact name from the roster below>","task":"<focused task, paths, and expected output>"}. Never call delegate_agent with {} or omit task/agent.
Use team_status to inspect live team state and team_conversation(agent: "<name>") to read one specific agent's own transcript. When stable lessons should be preserved, ask the relevant specialist to update its own mental model.
Keep delegations focused and include enough context for the worker to act independently.

Available ${planMode ? "planners" : "agents"}:
${catalog}`,
    };
  });

  pi.on("message_end", async (event, ctx: ExtensionContext) => {
    if (event.message.role === "assistant") {
      // Phase 4.3: capture the MAIN session's live context-window fill, mirroring
      // the per-worker poll in dispatch.ts. tokens is null right after compaction
      // until the next response, so keep the last known percent rather than
      // flashing to 0.
      try {
        const usage = ctx.getContextUsage();
        if (usage && state.orchestratorRuntime) {
          if (usage.percent != null) state.orchestratorRuntime.contextPct = usage.percent;
          if (usage.tokens != null) state.orchestratorRuntime.tokens = usage.tokens;
          if (usage.contextWindow != null) state.orchestratorRuntime.contextWindow = usage.contextWindow;
        }
      } catch { /* capability probe is best-effort */ }
    }
    // This hook is registered once, on the orchestrator's own pi: ExtensionAPI
    // — workers run as separate in-process AgentSessions (see dispatchAgent)
    // that never load pi-hive's extension hooks, so this handler structurally
    // never fires for worker output. It only ever sees the orchestrator's own
    // messages. Each worker keeps its own full transcript in agents/<slug>.jsonl
    // (read it via team_conversation(agent)) — unbounded worker output (a
    // mental-model YAML can be hundreds of KB) never reaches the shared log.
    if (state.mode === "normal") return;
    const message = event.message;
    const role = message?.role;
    if (!role || role === "toolResult") return;
    // Accumulate the orchestrator's own usage/cost so the main session gets the
    // same token/cost observability workers have (A5).
    if (role === "assistant" && message?.usage && state.orchestratorRuntime) {
      const u = extractUsage(message.usage);
      const orch = state.orchestratorRuntime;
      orch.inputTokens += u.input;
      orch.outputTokens += u.output;
      if (orch.startedAt) orch.elapsedMs = Date.now() - orch.startedAt;
      orch.cacheReadTokens += u.cacheRead;
      orch.cacheWriteTokens += u.cacheWrite;
      orch.reasoningTokens += u.reasoning;
      orch.costUsd += u.cost;
      // J5: persist a snapshot so a delegation-free conversation's orchestrator
      // usage still lands in hive-state.json. Debounced to avoid a write per
      // message during a burst.
      scheduleOrchestratorSnapshot();
    }
    // Phase 4.2: an orchestrator turn that errors or hits a length stop must be
    // visible. Emit a compact orchestrator_message event carrying the SDK's
    // stop_reason / error / model / per-message usage — previously reduced to
    // just {text, truncated} on assistant_message. Only for assistant turns
    // (user turns have no usage/stop_reason).
    if (role === "assistant" && (message?.stopReason || message?.errorMessage || message?.usage)) {
      const u = message?.usage ? extractUsage(message.usage) : undefined;
      emitHiveEvent(state, "orchestrator_message", {
        agent: "Orchestrator",
        stopReason: message?.stopReason ? String(message.stopReason) : undefined,
        errorMessage: message?.errorMessage ? truncateMiddle(String(message.errorMessage), 500) : undefined,
        // W1.6: keep BOTH the requested model and the ground-truth served model.
        // Collapsing them (`model || responseModel`) hid provider fallbacks/routing
        // where the served model differs from the one asked for. `model` stays the
        // requested field for back-compat; `responseModel` is the authoritative
        // served model.
        model: message?.model || message?.responseModel,
        responseModel: message?.responseModel ? String(message.responseModel) : undefined,
        // Item 9 / R3-1.4: the per-message identity the SDK's AssistantMessage
        // exposes — provider, api, responseId, and bounded diagnostics — all on this
        // same message object. (Round 2 captured none of these behind a comment that
        // wrongly claimed they didn't exist.)
        provider: message?.provider ? String(message.provider) : undefined,
        api: message?.api ? String(message.api) : undefined,
        responseId: message?.responseId ? String(message.responseId) : undefined,
        diagnostics: boundedDiagnostics(message?.diagnostics),
        usage: u ? { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, reasoning: u.reasoning, cost: u.cost } : undefined,
      }, "Orchestrator");
    }
    const text = textFromMessage(message).trim();
    if (!text) return;
    const from = role === "user" ? "User" : role === "assistant" ? "Orchestrator" : role;
    logRecord(state, { from, type: role, message: text });
    const clipped = clip(text, 8000);
    emitHiveEvent(state, role === "user" ? "user_message" : "assistant_message", { text: clipped.text, truncated: clipped.truncated }, from);
  });

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    state.shuttingDown = false;
    const lifecycleGeneration = state.lifecycleGeneration = (state.lifecycleGeneration || 0) + 1;
    state.widgetCtx = ctx;
    // Capture the ModelRegistry from the full session_start ctx — the reliable
    // handle. The mode-switch ctx that used to feed emitModelCatalog could lack
    // it, leaving model_versions empty and the topology dial without pillars.
    state.modelRegistry = ctx.modelRegistry;
    state.onRuntimeUpdate = () => updateWidget(state);
    state.onRuntimeFinish = (runtime, finishCtx) => {
      if (finishCtx.hasUI) finishCtx.ui.notify(`${runtime.config.name} ${runtime.status} in ${Math.round(runtime.elapsedMs / 1000)}s`, runtime.status === "done" ? "info" : "error");
    };
    try {
      reloadTeam(state, ctx);
      state.sddStatus = resolveHiveSddStatus(state, ctx.cwd);
      logRecord(state, { from: "System", type: "system", message: "Session started" });
      captureNormalTools(state);
      applyMode(state, ctx, "normal", { notify: false });
      // Ensure the shared, global telemetry dashboard daemon is running. This
      // hook only fires for hive-opted-in projects (the extension registers
      // nothing otherwise), so the opt-in gate is satisfied. Fire-and-forget and
      // Bun-gated: the first hive session with Bun starts the daemon, later
      // sessions adopt the running one. No browser tab opens automatically — the
      // header shows the URL. It is NOT torn down on session shutdown (shared).
      const telemetry = state.config?.settings?.telemetry;
      const dashboardStartup = telemetry?.enabled !== false && telemetry?.dashboardAutoStart !== false
        ? ensureDashboard(state, ctx, EXTENSION_ROOT, { open: false })
        : Promise.resolve({ running: false, url: "", adopted: false, spawned: false });
      void dashboardStartup.then((result) => {
        // The async health-check/spawn may finish after session_shutdown. Ignore
        // that stale completion instead of reinstalling UI on a dead session.
        if (state.shuttingDown || state.lifecycleGeneration !== lifecycleGeneration) {
          state.obsServer = undefined;
          return;
        }
        if (result.running && ctx.mode === "tui") installHeader(state, ctx);
      }).catch(() => { /* best-effort; the dashboard is optional */ });
      const missingSkills = Array.from(state.runtimes.values()).flatMap((runtime) =>
        (runtime.config.skills || [])
          .filter((ref) => !resolveConfiguredPath(ctx.cwd, ref.path, ref.allowOutsideProject === true))
          .map((ref) => `${runtime.config.name}: ${ref.path}`),
      );
      const missing = missingSkills.length ? `\nMissing configured skills: ${missingSkills.slice(0, 5).join(", ")}${missingSkills.length > 5 ? "..." : ""}` : "";
      if (ctx.hasUI) ctx.ui.notify(`Hive loaded: ${state.runtimes.size} agents in normal mode\nUse /hive:toggle or Ctrl+Alt+T to switch to orchestrator mode.${missing}`, missingSkills.length ? "warning" : "info");
      // F13 production wiring (Wave 7): start the operator-command
      // pickup loop. The dashboard server queues `operator-command`
      // requests in a sidecar JSONL; this consumer drains it and
      // invokes the matching operator command on the live worker
      // handles. Per AGENTS.md: long-lived processes must be started
      // from a session hook (NOT the extension factory) and torn
      // down on session_shutdown (done below).
      startOperatorCommandPickup(state, ctx);
    } catch (error: unknown) {
      // H5: on a config-load failure, force the session back to plain-Pi normal
      // mode so it is never left with hive tools registered but unconfigured.
      // Best-effort — capture whatever the current tool set is and restore it.
      try {
        state.mode = "normal";
        captureNormalTools(state);
        applyMode(state, ctx, "normal", { notify: false });
      } catch { /* nothing more we can do; the notify below tells the user */ }
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) ctx.ui.notify(`Hive failed to load: ${message}`, "error");
    }
  });

  // Snapshot/restore branching fires after the LLM's follow-up turn fully
  // settles. The named handler is exported for todo 007's integration tests.
  pi.on("agent_settled", async () => {
    await handleAgentSettledForHiveRestore(state);
  });

  pi.on("session_shutdown", async (event, ctx: ExtensionContext) => {
    state.shuttingDown = true;
    state.lifecycleGeneration = (state.lifecycleGeneration || 0) + 1;
    // Drop any captured ExtensionCommandContext — without this, a stale ctx
    // from the previous session could leak into the new one.
    clearCommandCtx();
    // F13 production wiring (Wave 7): stop the operator-command
    // pickup loop. AGENTS.md: session-owned processes must be torn
    // down on session shutdown. A stale timer would keep polling
    // the file and (worst case) double-invoke a command after the
    // session that issued it is gone.
    stopOperatorCommandPickup();
    if (orchestratorSnapshotTimer) clearTimeout(orchestratorSnapshotTimer);
    orchestratorSnapshotTimer = undefined;
    // Release the orchestrator's in-flight tracking Maps and tear down
    // every SDK-registered listener. The previous inline `.clear()`
    // calls lived at this exact site; both the Maps and the listener
    // registration now live in `engine/telemetry-listeners.ts`, so a
    // single `dispose()` covers both halves of the leak fix.
    telemetryListeners.dispose();
    cancelWorkerQueue(state);
    for (const runtime of state.runtimes.values()) {
      if (runtime.timer) clearInterval(runtime.timer);
      runtime.timer = undefined;
      if (runtime.session) {
        try { void Promise.resolve(runtime.session.abort?.()).catch((): void => undefined); } catch { /* noop */ }
        try { runtime.session.dispose(); } catch { /* noop */ }
        runtime.session = undefined;
      }
    }
    // Distillers are tracked separately from worker runtimes. Abort their
    // in-memory sessions and give their promises a bounded chance to settle;
    // their write guard also refuses any completion after shuttingDown is set.
    for (const session of state.backgroundDistillerSessions || []) {
      try { void Promise.resolve(session.abort?.()).catch((): void => undefined); } catch { /* noop */ }
      try { session.dispose?.(); } catch { /* noop */ }
    }
    const background = [...(state.backgroundTasks || [])];
    if (background.length) {
      await Promise.race([
        Promise.allSettled(background),
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
    state.backgroundDistillerSessions?.clear();
    state.backgroundTasks?.clear();
    state.distillQueues?.clear();
    // The telemetry dashboard is owned by the session that spawned it.
    // On a `quit` (user exiting pi), kill it — this matches the
    // `/hive:observe closes when pi closes` expectation. For other
    // shutdown reasons (`reload`, `new`, `resume`, `fork`) the daemon
    // is intentionally shared so the next session can adopt it.
    //
    // We only kill if THIS session's `ensureDashboard` call spawned the
    // daemon (`adopted === false`). When this session adopted an
    // existing daemon owned by another session, we leave it running.
    //
    // Multi-session note: a user who opens /hive:observe from two pi
    // windows loses the dashboard when the first window quits — that
    // window IS the spawner from its perspective. Accepted tradeoff;
    // the surviving session can re-run /hive:observe if needed.
    await killOwnedDashboardOnQuit(state, event.reason);
    state.obsServer = undefined;
    if (state.dashboardActionTimer) clearInterval(state.dashboardActionTimer);
    state.dashboardActionTimer = undefined;
    state.dashboardActionOffset = undefined;
    state.onRuntimeUpdate = undefined;
    state.onRuntimeFinish = undefined;
    if (ctx.mode === "tui") {
      ctx.ui.setHeader(undefined);
      ctx.ui.setWidget("hive-tree", undefined);
      clearHiveActivityWidget(state);
    }
    if (ctx.hasUI) {
      ctx.ui.setStatus("hive", undefined);
      if (ctx.mode === "tui") ctx.ui.setWorkingVisible(true);
    }
  });
}
