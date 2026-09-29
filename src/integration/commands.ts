import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { HiveState } from "../core/types";
import { applyMode, cycleMode } from "../ui/tui/widget";
import { renderHiveDoctor } from "../engine/doctor";
import { dashboardUrl, ensureDashboard, readDaemonToken, stopDashboard } from "../engine/dashboard";
import * as openspec from "../engine/openspec";
import { truncateMiddle } from "../core/utils";
import { invokeOperatorCommand, OPERATOR_COMMANDS, OperatorCommandError, type OperatorCommandName } from "../engine/budget/operator-commands";

/**
 * Render an operator command result envelope into a short TUI notification.
 * The dispatch is a tagged union; we surface the most relevant id per
 * command shape.
 */
function renderOperatorResult(result: import("../engine/budget/operator-commands").OperatorCommandEnvelope, agent: string): string {
  // RestoreWorkerOutcome is a discriminated union (ok / isError).
  if ("isError" in result && result.isError) {
    return `restore ${agent}: ${result.reason}`;
  }
  if ("oldSessionId" in result && "newSessionId" in result) {
    return `respawn ${agent}: old=${result.oldSessionId}, new=${result.newSessionId}`;
  }
  if ("branchPath" in result) {
    return `snapshot ${agent}: branch=${result.branchPath ?? "?"}, session=${result.sessionId}`;
  }
  if ("sessionId" in result) {
    return `ok ${agent}: session=${result.sessionId}`;
  }
  return `ok ${agent}`;
}

function listChangeIds(cwd: string, api: typeof openspec): string[] {
  return api.listChanges(cwd).map((c) => c.name);
}

const EXTENSION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Module-level capture of the most recent ExtensionCommandContext. Event handlers
// receive ExtensionContext only (no `navigateTree` / `waitForIdle`), so the wider
// type is not directly available to them; this stash exposes those methods via
// `getCommandCtx()`. Mirrors pi-context's `pendingCommandContext` pattern. Cleared
// on `session_shutdown` (handled in hooks.ts) so a stale ctx from a previous
// session cannot leak into a new one.
let commandCtx: ExtensionCommandContext | null = null;
export function getCommandCtx(): ExtensionCommandContext | null {
  return commandCtx;
}
export function clearCommandCtx(): void {
  commandCtx = null;
}
/**
 * Set the captured ExtensionCommandContext. Symmetric counterpart to
 * {@link getCommandCtx} and {@link clearCommandCtx}; called by every
 * command handler to stash its context, and by tests that need to inject
 * a fake context for handler invocations without going through a real
 * command handler.
 */
export function setCommandCtx(ctx: ExtensionCommandContext | null): void {
  commandCtx = ctx;
}

export interface CommandDeps {
  openspec: typeof openspec;
  ensureDashboard: typeof ensureDashboard;
  stopDashboard: typeof stopDashboard;
  dashboardUrl: typeof dashboardUrl;
  readDaemonToken: typeof readDaemonToken;
  fetch: typeof globalThis.fetch;
}

const defaultCommandDeps: CommandDeps = {
  openspec,
  ensureDashboard,
  stopDashboard,
  dashboardUrl,
  readDaemonToken,
  fetch: globalThis.fetch.bind(globalThis),
};

export function registerCommands(pi: ExtensionAPI, state: HiveState, overrides: Partial<CommandDeps> = {}) {
  const deps: CommandDeps = { ...defaultCommandDeps, ...overrides };
  // Three explicit mode commands + a cycle key (normal → plan → hive → normal).
  pi.registerCommand("hive:normal", {
    description: "Switch to normal Pi chat (no hive, no enforcement)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => { setCommandCtx(ctx); await applyMode(state, ctx, "normal"); },
  });
  pi.registerCommand("hive:plan-mode", {
    description: "Switch to plan mode — planning team produces full specs",
    handler: async (_args: string, ctx: ExtensionCommandContext) => { setCommandCtx(ctx); await applyMode(state, ctx, "plan"); },
  });
  pi.registerCommand("hive", {
    description: "Switch to hive mode — execution team builds the specs",
    handler: async (_args: string, ctx: ExtensionCommandContext) => { setCommandCtx(ctx); await applyMode(state, ctx, "hive"); },
  });
  // Namespaced cycle command for the three modes.
  pi.registerCommand("hive:toggle", {
    description: "Cycle session mode: normal → plan → hive → normal",
    handler: async (_args: string, ctx: ExtensionCommandContext) => { setCommandCtx(ctx); cycleMode(state, ctx); },
  });

  pi.registerShortcut(Key.ctrlAlt("t"), {
    description: "Cycle session mode: normal → plan → hive → normal",
    handler: async (ctx: ExtensionContext) => cycleMode(state, ctx),
  });

  pi.registerCommand("hive:doctor", {
    description: "Run read-only pi-hive diagnostics for this workspace",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const result = renderHiveDoctor(state, ctx.cwd, EXTENSION_ROOT);
      if (ctx.hasUI) ctx.ui.notify(result.text, result.severity);
    },
  });

  // Show the running pi-hive source version (git SHA + branch + dirty
  // status) so users can verify the server picked up the latest commits
  // without restarting. The long-running `pi -e .` doesn't hot-reload
  // src/engine/* (HANDOFF pitfall #1), so after a code change the only
  // way to confirm a restart actually loaded the new code is to ask the
  // running process what its source SHA is — which is exactly what this
  // command does.
  pi.registerCommand("hive:version", {
    description: "Show the running pi-hive source version (git SHA + branch + dirty status)",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const { execFileSync } = await import("node:child_process");
      const git = (args: string[]): string =>
        execFileSync("git", args, { cwd: EXTENSION_ROOT, encoding: "utf8" }).trim();
      let message: string;
      try {
        const sha = git(["rev-parse", "HEAD"]);
        const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
        const status = git(["status", "--short"]);
        const dirty = status ? `dirty (${status.split("\n").length} files)` : "clean";
        const shortSha = sha.slice(0, 7);
        const branchDisplay = branch === "HEAD" ? `detached @ ${shortSha}` : branch;
        const subject = git(["log", "-1", "--format=%s"]);
        message = `pi-hive ${branchDisplay} @ ${shortSha} — ${dirty}\nLatest commit: ${subject}\nFull SHA: ${sha}`;
      } catch (e: any) {
        message = `pi-hive version check failed: ${e.message}. (Is this a git checkout, or a packaged install?)`;
      }
      if (ctx.hasUI) ctx.ui.notify(message, "info");
    },
  });

  pi.registerCommand("hive:execute", {
    description: "Execute a plan change's tasks.md through the hive (usage: /hive:execute <change-id>)",
    getArgumentCompletions: (prefix: string) => {
      const cwd = state.widgetCtx?.cwd || process.cwd();
      return listChangeIds(cwd, deps.openspec)
        .filter((id) => id.startsWith(prefix))
        .map((id) => ({ value: id, label: id }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      setCommandCtx(ctx);
      const changeId = args.trim().split(/\s+/)[0] || "";
      if (!changeId) {
        const available = listChangeIds(ctx.cwd, deps.openspec);
        if (ctx.hasUI) ctx.ui.notify(`Usage: /hive:execute <change-id>. Available: ${available.join(", ") || "none (create one first)"}`, "warning");
        return;
      }
      if (!deps.openspec.changeExists(ctx.cwd, changeId)) {
        if (ctx.hasUI) ctx.ui.notify(`No OpenSpec change "${changeId}" under openspec/changes/. Available: ${listChangeIds(ctx.cwd, deps.openspec).join(", ") || "none"}`, "error");
        return;
      }
      if (!deps.openspec.hasTasks(ctx.cwd, changeId)) {
        if (ctx.hasUI) ctx.ui.notify(`Change "${changeId}" has no tasks.md yet. Author the change (proposal → design/specs → tasks) via /opsx-propose first.`, "error");
        return;
      }
      if (!deps.openspec.isReadyToExecute(ctx.cwd, changeId)) {
        if (ctx.hasUI) ctx.ui.notify(`Change "${changeId}" is not ready: tasks.md must be authored and \`openspec validate\` must pass.`, "error");
        return;
      }
      if (!deps.openspec.isApprovedForExecution(ctx.cwd, changeId)) {
        if (ctx.hasUI) ctx.ui.notify(`Change "${changeId}" is not approved for execution yet. Current human approvals are required for proposal, design, specs, and tasks.`, "error");
        return;
      }
      // Select the change so delegations are scoped to it, ensure HIVE (execution)
      // mode is active, then drive execution via a user turn. The main session
      // reads the tasks and delegates to coder/tester leads.
      state.activeChangeId = changeId;
      // W1.5: the drain guard refuses a plan→hive switch while a planning worker is
      // still running. applyMode returns false then; proceeding would send the
      // "execute the plan" turn while still stuck in plan mode (fail-safe but
      // confusing — the turn would be blocked by the plan-mode delegation guard).
      // Abort with a clear message instead, including on headless (no-UI) sessions.
      if (state.mode !== "hive" && !applyMode(state, ctx, "hive", { notify: false })) {
        const msg = `Cannot execute "${changeId}": still in ${state.mode} mode because ${state.activeRuns} agent${state.activeRuns === 1 ? " is" : "s are"} running. Wait for the current work to finish, then re-run /hive:execute ${changeId}.`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else console.warn(`[pi-hive] ${msg}`);
        return;
      }
      const tasks = truncateMiddle(deps.openspec.readArtifact(ctx.cwd, changeId, "tasks.md"), 12_000);
      pi.sendUserMessage(
        `Execute the approved plan for change "${changeId}" (openspec/changes/${changeId}/). This is the active change; delegate each task to the appropriate coder/tester lead. After verifying a task's implementation evidence, call plan_task_complete with its checkbox ID and evidence. Do not edit tasks.md or any project files yourself.\n\n## tasks.md\n${tasks}`,
      );
      if (ctx.hasUI) ctx.ui.notify(`Executing plan "${changeId}" — driving the hive from tasks.md.`, "info");
    },
  });

  pi.registerCommand("hive:plan", {
    description: "List plan changes, or show the active one (usage: /hive:plan [change-id])",
    handler: async (args: string, ctx: ExtensionContext) => {
      const requested = args.trim().split(/\s+/)[0] || "";
      const available = listChangeIds(ctx.cwd, deps.openspec);
      if (requested) {
        if (!deps.openspec.changeExists(ctx.cwd, requested)) {
          if (ctx.hasUI) ctx.ui.notify(`No OpenSpec change "${requested}". Available: ${available.join(", ") || "none"}`, "error");
          return;
        }
        state.activeChangeId = requested;
        if (ctx.hasUI) ctx.ui.notify(`Active plan change set to "${requested}".`, "info");
        return;
      }
      const lines = available.length
        ? available.map((id) => `- ${id}${state.activeChangeId === id ? " (active)" : ""}${deps.openspec.hasTasks(ctx.cwd, id) ? " — tasks ready" : ""}`).join("\n")
        : "No OpenSpec changes yet. Ask the orchestrator to plan a change, or a lead to run plan_new.";
      if (ctx.hasUI) ctx.ui.notify(`OpenSpec changes under openspec/changes/:\n${lines}`, "info");
    },
  });

  pi.registerCommand("hive:observe", {
    description: "Restart and open the global pi-hive telemetry dashboard",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!state.session) {
        if (ctx.hasUI) ctx.ui.notify("Hive session is not initialized yet.", "error");
        return;
      }
      // Explicit command: force a clean restart and open the browser tab.
      const result = await deps.ensureDashboard(state, ctx, EXTENSION_ROOT, { open: true, forceRestart: true });
      if (!ctx.hasUI) return;
      if (result.running) ctx.ui.notify(`pi-hive telemetry restarted: ${result.url}`, "info");
      else ctx.ui.notify(result.bunMissing ? "Cannot start dashboard: Bun is not installed." : `Failed to start dashboard: ${result.error || "unknown error"}`, "error");
    },
  });

  pi.registerCommand("hive:observe-stop", {
    description: "Stop the global pi-hive telemetry dashboard",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const killed = await deps.stopDashboard(state);
      if (ctx.hasUI) ctx.ui.notify(killed.length ? `Stopped pi-hive telemetry dashboard (${killed.join(", ")})` : "No pi-hive telemetry dashboard was running.", "info");
    },
  });

  pi.registerCommand("hive:observe-prune", {
    description: "Prune telemetry older than <days> from the global dashboard (e.g. /hive:observe-prune 30)",
    handler: async (args: string, ctx: ExtensionContext) => {
      const days = Number(String(args || "").trim());
      if (!Number.isFinite(days) || days < 0) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /hive:observe-prune <days> (a non-negative number of days to retain).", "error");
        return;
      }
      try {
        // Goes through the daemon's auth-gated POST /prune using the shared
        // token file (Decision 2) — the same endpoint the Settings tab calls.
        const res = await deps.fetch(`${deps.dashboardUrl()}/prune`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${deps.readDaemonToken() || ""}` },
          body: JSON.stringify({ olderThanDays: days }),
        });
        if (!res.ok) {
          if (ctx.hasUI) ctx.ui.notify(`Prune failed (${res.status}). Is the dashboard running? Try /hive:observe.`, "error");
          return;
        }
        const body = await res.json() as { events: number; sessions: number };
        if (ctx.hasUI) ctx.ui.notify(`Pruned ${body.events} events and ${body.sessions} sessions older than ${days} day(s).`, "info");
      } catch (error: any) {
        if (ctx.hasUI) ctx.ui.notify(`Prune failed: ${error?.message || error}. Is the dashboard running?`, "error");
      }
    },
  });

  // F5b — operator commands as Pi slash commands. Each takes the agent name as
  // its first argument; the helper resolves the runtime + ledger + policy and
  // dispatches to the existing operator function. Errors surface via the
  // OperatorCommandError envelope (printed to the TUI).
  for (const op of OPERATOR_COMMANDS) {
    const cmdName = `hive:worker-${op.name}`;
    pi.registerCommand(cmdName, {
      description: `${op.description} (usage: /${cmdName} <agent> [reason])`,
      handler: async (args: string, ctx: ExtensionContext) => {
        const trimmed = args.trim();
        if (!trimmed) {
          if (ctx.hasUI) ctx.ui.notify(`Usage: /${cmdName} <agent> [reason]`, "warning");
          return;
        }
        const parts = trimmed.split(/\s+/);
        const agent = parts[0] ?? "";
        const rest = parts.slice(1);
        const reason = rest.join(" ").trim() || undefined;
        try {
          const result = await invokeOperatorCommand(
            state,
            op.name as OperatorCommandName,
            // RestoreWorkerArgs requires snapshotId; other commands ignore it.
            // Provide a placeholder so the union type compiles; restore
            // validates snapshotId explicitly inside `depsForRestore` and
            // throws OperatorCommandError if missing — so this default is
            // only reached when the operator name happens to be restore.
            { agent, reason, snapshotId: "" },
            ctx,
          );
          if (ctx.hasUI) {
            // Render the result envelope per command shape. The dispatch is
            // tagged-union; we surface the most relevant id field per command.
            const summary = renderOperatorResult(result, agent);
            ctx.ui.notify(summary, "info");
          }
        } catch (error) {
          if (error instanceof OperatorCommandError) {
            if (ctx.hasUI) ctx.ui.notify(`${op.name} ${agent}: ${error.message}`, "error");
          } else {
            throw error;
          }
        }
      },
    });
  }
}
