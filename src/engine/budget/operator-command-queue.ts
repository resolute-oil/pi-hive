// LLM tool gap (Wave `refactor/llm-tool-gap`) — Node-safe operator-command
// queue helper.
//
// The dashboard server's `writeOperatorCommandRequest`
// (`src/observability/server/db.ts`) and the parent pi's pickup consumer
// (`src/integration/operator-pickup.ts`) both speak the same
// `operator-command-pickup.jsonl` shape. The LLM-callable operator command
// tools in `src/agents/tools.ts` need the SAME producer side so the
// existing consumer drains them unchanged. But `db.ts` is bun-only
// (`bun:sqlite`) and the LLM tools run in the orchestrator's parent pi
// (a Node process). This file is the Node-safe producer that mirrors the
// dashboard's writer: same path resolution, same row shape, same 12-command
// allow-list, same mode-0o600 file mode.
//
// The dashboard's `writeOperatorCommandRequest` is functionally equivalent;
// the two writers share the file but never the in-process state, so the
// appends are sequenced by the OS. The pickup consumer drains whichever
// rows it finds — origin is invisible to it. A future consolidation (move
// `writeOperatorCommandRequest` to this file) is straightforward but out of
// scope here.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveRuntime } from "../agent-lookup";
import type { HiveState } from "../../core/types";

// Same env-var precedence as the dashboard server's `DB_PATH` constant
// (`src/observability/server/config.ts`) and the parent pi's
// `operatorCommandQueuePath` (`src/integration/operator-pickup.ts`). All
// three resolve to `<hive-dir>/operator-command-pickup.jsonl`.
export function operatorCommandQueuePath(): string {
  const base = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const db = resolve(process.env.HIVE_TELEMETRY_DB || join(base, "hive", "telemetry.db"));
  return join(dirname(db), "operator-command-pickup.jsonl");
}

// 12-command allow-list. Mirrors the consumer's ALLOWED_COMMANDS
// (`src/integration/operator-pickup.ts:95`) and the dashboard HTTP
// handler's ALLOWED set (`src/observability/server/http-handler.ts:172`).
// Single source of truth lives here for the LLM-side validation; the
// consumer's allow-list is a defense-in-depth check.
export const OPERATOR_COMMAND_NAMES = [
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
] as const;

export type OperatorCommandName = (typeof OPERATOR_COMMAND_NAMES)[number];

const ALLOWED_COMMANDS: ReadonlySet<OperatorCommandName> = new Set(OPERATOR_COMMAND_NAMES);

// Row shape written to the JSONL. Identical to
// `OperatorCommandRequest` in `src/observability/server/db.ts` and
// `src/integration/operator-pickup.ts`.
export interface OperatorCommandRequest {
  id: string;
  agent: string;
  command: string;
  requestedAt: string;
}

export interface QueueOperatorCommandResult {
  ok: boolean;
  requestedAt?: string;
  error?: string;
}

// Validate a candidate (agent, command) pair against the LLM-side
// allow-list and the team's configured roster.
//
// `state` is the orchestrator's HiveState. We check against
// `state.config.agents` (the configured roster) rather than
// `state.runtimes` (currently-mounted runtimes) because the LLM
// tool's job is to fail fast at the tool layer for an obviously
// bogus name; the consumer's "no live worker handle" check is the
// second-layer defense for a valid name whose worker is not yet
// mounted.
//
// `tear-down-all` is a team-wide command and accepts an empty
// `agent` (matching the dashboard's behavior).
// `hive_reload_agent_config` accepts any agent in the configured
// roster (the command operates on YAML config, not a live handle).
function validateCommand(
  state: HiveState,
  agent: string,
  command: string,
): { ok: true } | { ok: false; error: string } {
  if (!ALLOWED_COMMANDS.has(command as OperatorCommandName)) {
    return { ok: false, error: `unknown command "${command}"` };
  }
  if (command === "tear-down-all") return { ok: true };
  const trimmed = String(agent || "").trim();
  if (!trimmed) return { ok: false, error: "agent required" };
  if (trimmed.length > 120) return { ok: false, error: "agent name too long" };
  // Roster check: must be a configured agent. The consumer will
  // additionally verify a live handle exists (except for
  // hive_reload_agent_config). This catches typos at the LLM
  // boundary so the model gets a clear "no such agent" error
  // before the row is queued.
  if (!state.config) return { ok: false, error: "hive is not configured" };
  if (!resolveRuntime(state, trimmed)) {
    return { ok: false, error: `unknown agent "${trimmed}" (not in the configured roster)` };
  }
  return { ok: true };
}

// Append one operator-command row to the pickup JSONL. Returns
// `{ok: true, requestedAt}` on success. The pickup consumer drains
// the file on its 250ms tick.
//
// Mirrors the dashboard's `writeOperatorCommandRequest`: random id
// (`<ms>-<random>`), the requestedAt timestamp the caller supplies
// (so tests can pin it), and an appendFileSync under 0o600. The
// directory is created at 0o700 if missing (matches the dashboard
// server's mkdir).
export function writeOperatorCommandRequest(input: { agent: string; command: string; requestedAt: string }): { ok: boolean; error?: string; requestedAt: string } {
  try {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const row: OperatorCommandRequest = { id, ...input };
    const queuePath = operatorCommandQueuePath();
    mkdirSync(dirname(queuePath), { recursive: true, mode: 0o700 });
    appendFileSync(queuePath, JSON.stringify(row) + "\n", { mode: 0o600 });
    return { ok: true, requestedAt: input.requestedAt };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message, requestedAt: input.requestedAt };
  }
}

// One-stop helper: validate the (agent, command) pair against the
// LLM allow-list + roster, then write a row to the pickup JSONL.
// Returns a structured result so the LLM tool handler can format
// the error for the model without re-doing the validation.
export function queueOperatorCommand(
  state: HiveState,
  agent: string,
  command: string,
  requestedAt: string = new Date().toISOString(),
): QueueOperatorCommandResult {
  const validation = validateCommand(state, agent, command);
  if (!validation.ok) return { ok: false, error: validation.error };
  const result = writeOperatorCommandRequest({ agent: String(agent || "").trim(), command, requestedAt });
  if (!result.ok) return { ok: false, error: result.error || "failed to queue operator command" };
  return { ok: true, requestedAt: result.requestedAt };
}

// Test seam: read the queue file's full contents. Mirrors the
// `readOperatorCommandRequests` API in `db.ts`. Returns an empty
// array when the file does not exist.
export function readOperatorCommandQueue(): OperatorCommandRequest[] {
  const queuePath = operatorCommandQueuePath();
  if (!existsSync(queuePath)) return [];
  try {
    const text = readFileSync(queuePath, "utf8");
    const out: OperatorCommandRequest[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as OperatorCommandRequest); } catch { /* skip malformed */ }
    }
    return out;
  } catch {
    return [];
  }
}
