/**
 * F5c — Dashboard RPC stub for operator commands.
 *
 * The dashboard daemon is a separate process from the Pi session. Operator
 * commands need access to the live `HiveState.runtimes` map (which lives in
 * the Pi process), so the RPC surface ships as a minimal stub: it validates
 * the request shape against `OPERATOR_COMMANDS` and returns 501 with a
 * structured envelope describing what would be invoked.
 *
 * When the F13 dashboard UI lands a bidirectional session-bridge, this
 * handler can be upgraded to actually dispatch to the session's
 * `invokeOperatorCommand`. The validation logic and envelope shape stay
 * unchanged so consumers don't break.
 *
 * Source: HANDOFF.md §"Order of operations" task 2 (Wire the F5 surface).
 * User steering decision (in-session): option A — minimal stub.
 */

import { OPERATOR_COMMANDS, type OperatorCommandName } from "../../engine/budget/operator-commands";

/**
 * Body shape accepted by the RPC route. Mirrors `WorkerOperatorArgs` from
 * `src/engine/budget/worker-tools.ts`. The `agent` field is required; the
 * `reason` field is forwarded to the operator function's `reason` slot.
 */
export interface OperatorRpcRequestBody {
  agent?: string;
  reason?: string;
}

/**
 * Validate the request body. Returns either an error response (400) or null
 * if the request is well-formed.
 */
function validateRequest(
  commandName: string,
  body: OperatorRpcRequestBody,
): { status: number; body: { ok: false; error: string; validCommands?: string[] } } | null {
  const meta = OPERATOR_COMMANDS.find((c) => c.name === commandName);
  if (!meta) {
    return {
      status: 400,
      body: {
        ok: false,
        error: `unknown operator command "${commandName}".`,
        validCommands: OPERATOR_COMMANDS.map((c) => c.name),
      },
    };
  }
  if (!body.agent || typeof body.agent !== "string" || body.agent.trim() === "") {
    return {
      status: 400,
      body: {
        ok: false,
        error: `agent is required for operator command "${commandName}".`,
      },
    };
  }
  return null;
}

/**
 * Handle an operator RPC request. Returns the HTTP response to send back
 * to the caller (the dashboard HTTP handler routes `POST /api/operator/:cmd`
 * to this function).
 *
 * @param commandName  Canonical operator command name (e.g. "end", "compact").
 * @param body         Parsed request body. See {@link OperatorRpcRequestBody}.
 * @returns Response object — status 501 on valid request (session-bridge
 *          not implemented), 400 on validation failure.
 */
export async function handleOperatorRpc(
  commandName: string,
  body: OperatorRpcRequestBody,
): Promise<Response> {
  const validationError = validateRequest(commandName, body);
  if (validationError) {
    return Response.json(validationError.body, { status: validationError.status });
  }
  // Type assertion: validated above — commandName is in OPERATOR_COMMANDS.
  const meta = OPERATOR_COMMANDS.find((c) => c.name === commandName) as {
    name: OperatorCommandName;
    description: string;
  };
  return Response.json(
    {
      ok: false,
      status: "not_implemented",
      commandName: meta.name,
      description: meta.description,
      agent: body.agent?.trim() ?? "",
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      note:
        "Dashboard RPC for operator commands requires a session-bridge to the running Pi " +
        "process (which holds the live HiveState.runtimes map). The bridge is deferred to F13 " +
        "dashboard UI work. Use the Pi slash commands (/hive:worker-end, /hive:worker-compact, " +
        "etc.) or invokeOperatorCommand in-process for now.",
    },
    { status: 501 },
  );
}
