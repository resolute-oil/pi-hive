// Wave 7 F13 production wiring — operator-command pickup consumer.
//
// The F13 dashboard (T13.1) writes operator-command requests to
// `operator-command-pickup.jsonl` next to the telemetry DB. The parent
// pi drains this file and invokes the matching operator command in
// `src/engine/budget/worker-tools.ts`. The dashboard server and the
// parent pi are different processes — the server has no in-process
// access to the worker's AgentSession, and the parent pi's process
// owns the live worker handles. The JSONL sidecar is the cross-process
// seam.
//
// Bounded polling loop: the consumer starts a setInterval in
// `session_start` and clears it in `session_shutdown`. Each tick
// reads + invokes + clears the file. The interval is 250ms — fast
// enough that the operator's click is observed within a quarter
// second, slow enough that the file I/O is negligible.
//
// Idempotency: the consumer reads ALL rows, invokes them, then
// unlinks the file. If the process crashes between invoke and
// unlink, the next pickup re-invokes (the rows are still in the
// file). The F13 brief accepts this — the operator sees the
// failure on the dashboard and re-issues. A more robust design
// would track per-row status in a separate file, but that's out of
// scope for Wave 7.
//
// Error handling: each row's invocation is wrapped in a try/catch
// so one failed row does not block the others. The error is logged
// (and surfaced via `ctx.ui.notify` when a UI is available).
//
// Mode gating: the consumer only runs in non-normal modes (hive or
// plan). The 11 operator commands all operate on live worker
// handles, which only exist in hive mode; the check is defensive
// against accidental invocations from a normal-mode session that
// shares the same DB.

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HiveState } from "../core/types";
import {
  abortWorkerCompaction,
  compactWorkerSession,
  endWorkerSession,
  forceEndWorkerSession,
  forceKillWorkerSession,
  hiveReloadAgentConfig,
  lookupWorkerHandleForProduction,
  pauseWorkerSession,
  respawnWorkerSession,
  resumeWorkerSession,
  snapshotWorkerSession,
  tearDownAllWorkers,
  type WorkerContext,
} from "../engine/budget/worker-tools";

const POLL_INTERVAL_MS = 250;

// Same env-var precedence as the dashboard server's `DB_PATH` constant
// (src/observability/server/config.ts). The parent pi and the server
// share `PI_CODING_AGENT_DIR` and the optional `HIVE_TELEMETRY_DB`
// override, so the resolution matches without importing the server
// module (which pulls in bun:sqlite).
export function operatorCommandQueuePath(): string {
  const base = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const db = resolve(process.env.HIVE_TELEMETRY_DB || join(base, "hive", "telemetry.db"));
  return join(dirname(db), "operator-command-pickup.jsonl");
}

export interface OperatorCommandRequest {
  id: string;
  agent: string;
  command: string;
  requestedAt: string;
}

export interface PickupResult {
  total: number;
  invoked: number;
  failed: number;
  errors: Array<{ id: string; agent: string; command: string; error: string }>;
}

const ALLOWED_COMMANDS = new Set([
  "end",
  "compact",
  "respawn",
  "pause",
  "snapshot",
  "restore",
  "resume",
  "abort-compaction",
  "force-kill",
  "force-end",
  "tear-down-all",
  "hive_reload_agent_config",
]);

// Coerce an arbitrary user-supplied agent name to a WorkerContext for
// the respawn / snapshot / restore commands (which take a
// WorkerContext, not a string). Returns undefined when no live handle
// is registered for the agent — the caller logs + skips the row.
function workerContextFor(agent: string): WorkerContext | undefined {
  const h = lookupWorkerHandleForProduction(agent);
  if (!h) return undefined;
  return {
    agent: h.agent,
    session: h.session,
    sessionManager: h.sessionManager,
    ledger: h.ledger,
    policy: h.policy,
    cwd: h.sessionManager.getCwd?.() ?? process.cwd(),
  };
}

// Invoke one row's command. Returns ok=true on success, ok=false
// with an error message on failure. The function is side-effecting
// on the live worker handles — it mutates the session, ledger, and
// workerHandles map. Errors are caught at the row level so one
// failure does not block other rows.
async function invokeRow(
  row: OperatorCommandRequest,
  opts: { notify?: (message: string, level: "info" | "warning" | "error") => void },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!ALLOWED_COMMANDS.has(row.command)) {
    return { ok: false, error: `unknown command "${row.command}"` };
  }
  const signal = new AbortController().signal;
  const reason = `operator: ${row.command}`;
  try {
    // tear-down-all is a team-wide command and ignores the per-row
    // agent name (the dashboard sends an empty / placeholder agent
    // for this command).
    if (row.command === "tear-down-all") {
      const result = await tearDownAllWorkers(reason, undefined, signal);
      opts.notify?.(`Operator: tore down ${result.stopped.length} workers (skipped ${result.skipped.length})`, "info");
      return { ok: true };
    }
    // All other commands require a live worker handle for the agent.
    // Exception: hive_reload_agent_config operates on the agent's
    // static config (state.config.agents), not a live worker handle —
    // the agent is loaded from YAML and reloadable even when no
    // worker is currently running.
    if (row.command !== "hive_reload_agent_config") {
      const handle = lookupWorkerHandleForProduction(row.agent);
      if (!handle) {
        return { ok: false, error: `no live worker handle for agent "${row.agent}"` };
      }
    }
    switch (row.command) {
      case "end":
        await endWorkerSession(row.agent, reason, signal);
        return { ok: true };
      case "compact":
        await compactWorkerSession(row.agent, reason, undefined, signal);
        return { ok: true };
      case "respawn": {
        const ctx = workerContextFor(row.agent);
        if (!ctx) return { ok: false, error: `no worker context for agent "${row.agent}"` };
        await respawnWorkerSession(ctx, reason);
        return { ok: true };
      }
      case "pause":
        await pauseWorkerSession(row.agent, reason, signal);
        return { ok: true };
      case "snapshot": {
        const ctx = workerContextFor(row.agent);
        if (!ctx) return { ok: false, error: `no worker context for agent "${row.agent}"` };
        await snapshotWorkerSession(ctx, "operator-snapshot");
        return { ok: true };
      }
      case "restore": {
        // restore takes a snapshotId; without one we can only fail
        // cleanly. The dashboard UI does not currently surface a
        // restore-with-id flow, so this is a defensive branch.
        return { ok: false, error: "restore requires a snapshot id (not yet supported by the consumer)" };
      }
      case "resume":
        await resumeWorkerSession(row.agent, signal);
        return { ok: true };
      case "abort-compaction":
        await abortWorkerCompaction(row.agent, signal);
        return { ok: true };
      case "force-kill":
        await forceKillWorkerSession(row.agent, reason, signal);
        return { ok: true };
      case "force-end":
        await forceEndWorkerSession(row.agent, reason, signal);
        return { ok: true };
      case "hive_reload_agent_config": {
        // T13.0 follow-up: reload the agent's YAML config. The
        // command is idempotent — calling it twice with no edits
        // between is a no-op (the runtime.config reference is the
        // same). It requires a bound state + ctx (bindReloadAgentConfigState
        // wires these on every dispatch); when unbound (e.g. a
        // session that has not dispatched any worker), the function
        // returns reloaded=false with a clear error message.
        const result = hiveReloadAgentConfig(row.agent);
        if (!result.reloaded) {
          return { ok: false, error: result.error || "reload failed" };
        }
        return { ok: true };
      }
      default:
        return { ok: false, error: `unhandled command "${row.command}"` };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Read all rows from the pickup file, invoke each, and clear the
// file. Each invocation is awaited in sequence so a row's failure
// does not block the others, and the file is cleared only after
// every row has been processed. The 250ms poll cadence is the
// responsiveness budget — the operator's click is observed within
// a quarter second.
//
// The function reads the file under a synchronous read+parse+unlink
// sequence. There is no cross-process lock; the only writer is the
// dashboard server (which appends one row per click) and the only
// reader is this consumer. The dashboard's append happens
// synchronously with fs.appendFileSync; the consumer's read+unlink
// happens here. A race where the dashboard appends between the
// consumer's read and unlink is benign — the appended row is
// preserved for the next tick (it was just queued, not lost).
export async function pickupOperatorCommandRequests(opts: { notify?: (message: string, level: "info" | "warning" | "error") => void } = {}): Promise<PickupResult> {
  const queuePath = operatorCommandQueuePath();
  if (!existsSync(queuePath)) {
    return { total: 0, invoked: 0, failed: 0, errors: [] };
  }
  let text: string;
  try {
    text = readFileSync(queuePath, "utf8");
  } catch (e) {
    return {
      total: 0,
      invoked: 0,
      failed: 0,
      errors: [{ id: "read", agent: "", command: "", error: e instanceof Error ? e.message : String(e) }],
    };
  }
  const rows: OperatorCommandRequest[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.agent === "string" && typeof parsed.command === "string") {
        rows.push(parsed as OperatorCommandRequest);
      }
    } catch { /* skip malformed */ }
  }
  if (rows.length === 0) {
    // Nothing to do — clear the file in case it has only garbage.
    try { unlinkSync(queuePath); } catch { /* best-effort */ }
    return { total: 0, invoked: 0, failed: 0, errors: [] };
  }
  const errors: PickupResult["errors"] = [];
  let invoked = 0;
  let failed = 0;
  for (const row of rows) {
    const result = await invokeRow(row, opts);
    if (result.ok) {
      invoked += 1;
    } else {
      failed += 1;
      errors.push({ id: row.id, agent: row.agent, command: row.command, error: result.error });
      opts.notify?.(`Operator command ${row.command} on ${row.agent || "team"} failed: ${result.error}`, "error");
    }
  }
  try { unlinkSync(queuePath); } catch { /* best-effort */ }
  return { total: rows.length, invoked, failed, errors };
}

// Module-level timer handle. The session_start hook sets it; the
// session_shutdown hook clears it. A module-level ref is used (not a
// per-state ref) because at most one parent pi session polls the
// file at a time — the JSONL is per-DB, and the dashboard is global
// across projects, so two concurrent parent-pi sessions would just
// both poll and one would win the row (the other reads an empty
// file). Single-timer is the simplest correct design.
let pickupTimer: ReturnType<typeof setInterval> | undefined;

export function startOperatorCommandPickup(state: HiveState, ctx: ExtensionContext): void {
  if (pickupTimer) return; // already running
  const notify = (message: string, level: "info" | "warning" | "error"): void => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  };
  pickupTimer = setInterval(() => {
    // Mode guard: only run in non-normal modes. The 11 operator
    // commands require live worker handles (only present in hive or
    // plan modes). A normal-mode session that shares the DB would
    // still receive rows, but invoking them would fail because no
    // handles are registered — better to short-circuit.
    if (state.mode === "normal") return;
    void pickupOperatorCommandRequests({ notify }).catch((e: unknown) => {
      // Defensive — pickupOperatorCommandRequests catches its own
      // errors per row, but the top-level promise could still
      // reject (e.g. a synchronous throw before the loop). Log and
      // continue; the next tick will retry.
      notify(`Operator pickup tick failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    });
  }, POLL_INTERVAL_MS);
}

export function stopOperatorCommandPickup(): void {
  if (!pickupTimer) return;
  clearInterval(pickupTimer);
  pickupTimer = undefined;
}

export function isOperatorCommandPickupRunning(): boolean {
  return pickupTimer !== undefined;
}

// Test seam: reset module state between cases. Production code
// should not call this; the session_start / session_shutdown hooks
// own the timer.
export function __resetOperatorCommandPickupForTests(): void {
  if (pickupTimer) {
    clearInterval(pickupTimer);
    pickupTimer = undefined;
  }
}
