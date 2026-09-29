/**
 * F5c — Dashboard RPC stub for operator commands.
 *
 * The dashboard daemon (`src/observability/server/`) is a separate process
 * from the Pi session. Operator commands need access to the live session's
 * `HiveState.runtimes` map, which the daemon does not have. To avoid
 * introducing a new bidirectional bridge architecture in v2, this surface
 * is implemented as a minimal stub:
 *
 *   POST /api/operator/<commandName>
 *     body: { agent: string, reason?: string }
 *     response: 501 { ok: false, status: "not_implemented", commandName,
 *                     description, agent }
 *
 * The route validates the command name against `OPERATOR_COMMANDS` and the
 * body shape, returning 400 on validation failure and 501 on a valid request.
 * This pins the surface for future session-bridge work (F13 dashboard UI).
 *
 * Source: HANDOFF.md §"Order of operations" task 2 (Wire the F5 surface).
 * User decision (steering): option A — minimal stub with 501 envelope.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { OPERATOR_COMMANDS } from "../src/engine/budget/operator-commands.ts";
import { handleOperatorRpc } from "../src/observability/server/operator-rpc.ts";

test("F5c-rpc: handleOperatorRpc returns 501 with structured envelope for a valid request", async () => {
  const response = await handleOperatorRpc("end", { agent: "test-worker", reason: "manual stop" });
  assert.equal(response.status, 501);
  const body = await response.json() as {
    ok: boolean;
    status: string;
    commandName: string;
    description: string;
    agent: string;
    reason?: string;
  };
  assert.equal(body.ok, false);
  assert.equal(body.status, "not_implemented");
  assert.equal(body.commandName, "end");
  assert.equal(body.agent, "test-worker");
  assert.equal(body.reason, "manual stop");
  // Description comes from OPERATOR_COMMANDS metadata.
  const meta = OPERATOR_COMMANDS.find((c) => c.name === "end");
  assert.ok(meta);
  assert.equal(body.description, meta.description);
});

test("F5c-rpc: handleOperatorRpc returns 400 for an unknown command name", async () => {
  const response = await handleOperatorRpc("delete-everything", { agent: "test-worker" });
  assert.equal(response.status, 400);
  const body = await response.json() as { ok: boolean; error: string; validCommands: string[] };
  assert.equal(body.ok, false);
  assert.match(body.error, /unknown operator command/i);
  assert.deepEqual(body.validCommands, OPERATOR_COMMANDS.map((c) => c.name));
});

test("F5c-rpc: handleOperatorRpc returns 400 when agent field is missing", async () => {
  const response = await handleOperatorRpc("end", { reason: "missing agent" });
  assert.equal(response.status, 400);
  const body = await response.json() as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.match(body.error, /agent.*required/i);
});

test("F5c-rpc: handleOperatorRpc returns 400 when agent field is empty string", async () => {
  const response = await handleOperatorRpc("end", { agent: "" });
  assert.equal(response.status, 400);
  const body = await response.json() as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.match(body.error, /agent.*required/i);
});

test("F5c-rpc: all 8 operator commands are accepted (none return 400 for unknown)", async () => {
  for (const cmd of OPERATOR_COMMANDS) {
    const response = await handleOperatorRpc(cmd.name, { agent: "test-worker" });
    // Must be 501 (not_implemented), NOT 400 (unknown).
    assert.equal(
      response.status,
      501,
      `${cmd.name} must surface as 501 not_implemented, not ${response.status}`,
    );
  }
});

test("F5c-rpc: reason field is optional", async () => {
  const response = await handleOperatorRpc("end", { agent: "test-worker" });
  assert.equal(response.status, 501);
  const body = await response.json() as { reason?: string };
  assert.equal(body.reason, undefined);
});
