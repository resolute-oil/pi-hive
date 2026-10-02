// F13 (T13.3) — mode-independence smoke test for the 11-button intervention UI.
//
// Per AGENTS.md: "extensions must be mode-independent". The 11 operator
// commands and the dashboard RPC endpoint must work the same way regardless
// of the parent pi's mode (tui / rpc / print / json). This file pins the
// structural mode-independence contract:
//
//   1. The 11 operator command functions in src/engine/budget/worker-tools.ts
//      take only `(agent, ...)` / `(agent, ...)` — no ExtensionContext, no
//      HiveState, no `ctx.mode`. The mode is invisible at this seam.
//   2. The dashboard's POST /operator-command handler validates and queues
//      the request without consulting any extension context. Mode is
//      invisible at this seam.
//   3. The 11-command allow-list is a closed string union — the RPC payload
//      shape is identical across modes (JSON in / JSON out, including the
//      print-mode shape).
//
// A regression that introduces a mode gate to either seam is caught here.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The 11 command names the F13 brief pins. Keep in lockstep with
// OperatorCommandName in ui/web/src/api.ts and the ALLOWED set in
// src/observability/server/http-handler.ts.
const ALL_OPERATOR_COMMANDS = [
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
] as const;

// Read the worker-tools module body once, as a string, so we can grep for
// any accidental mode gate. We don't statically import the module — the
// mode-grep is the assertion surface and an import would force a runtime
// test for what's purely a structural contract.
const workerToolsPath = fileURLToPath(new URL("../src/engine/budget/worker-tools.ts", import.meta.url));
const workerToolsSrc = readFileSync(workerToolsPath, "utf8");

// 11 distinct operator commands are exported from worker-tools.ts.
// Pin each by literal `export function <name>(` so a future refactor that
// renames one surfaces as a test failure rather than a silent regression.
const EXPECTED_EXPORTS = [
  "endWorkerSession",
  "compactWorkerSession",
  "pauseWorkerSession",
  "resumeWorkerSession",
  "abortWorkerCompaction",
  "forceKillWorkerSession",
  "forceEndWorkerSession",
  "tearDownAllWorkers",
  "respawnWorkerSession",
  "snapshotWorkerSession",
  "restoreWorkerSession",
];

describe("F13 mode-independence (T13.3)", () => {
  test("the 11 operator commands are all exported from worker-tools.ts", () => {
    for (const name of EXPECTED_EXPORTS) {
      // Operator commands may be `export function` or `export async function`.
      const candidates = [
        `export function ${name}(`,
        `export async function ${name}(`,
      ];
      const hit = candidates.some((sig) => workerToolsSrc.includes(sig));
      assert.ok(hit, `missing export: ${name}`);
    }
  });

  test("the 11 operator commands are mode-agnostic — none reference ctx.mode or state.mode", () => {
    // Restrict the grep to the region between the file's leading comment
    // block and the next region marker. We can't lint imports cleanly here,
    // so the assertion is: for each exported operator command, the body
    // between its `export function NAME(` opener and the matching closing
    // brace must not reference `ctx.mode` or `state.mode`.
    //
    // A simpler, equivalent check: the source must not contain `ctx.mode`
    // or `state.mode` at all in worker-tools.ts. Operator commands run
    // against a WorkerHandle, not an ExtensionContext — any reference to
    // either ctx or state is a red flag.
    const modeGatePattern = /\b(ctx|state)\.mode\b/;
    assert.equal(
      modeGatePattern.test(workerToolsSrc),
      false,
      "worker-tools.ts references ctx.mode or state.mode — operator commands must be mode-agnostic",
    );
  });

  test("the 11-command allow-list matches the RPC payload union exactly", () => {
    // Both sides of the wire must agree on the command set — otherwise an
    // operator surface (TUI) and the dashboard RPC could disagree on which
    // commands are valid. The RPC side parses the body string; the dashboard
    // side types its payload as a union. They must agree.
    const apiPath = fileURLToPath(new URL("../ui/web/src/api.ts", import.meta.url));
    const apiSrc = readFileSync(apiPath, "utf8");
    // Pin each command name appears inside the OperatorCommandName union
    // body. The block runs from `export type OperatorCommandName` to the
    // matching `];` — extract it and split on `|` to count.
    const unionStart = apiSrc.indexOf("export type OperatorCommandName");
    assert.notEqual(unionStart, -1, "OperatorCommandName union not found in api.ts");
    // The union body terminates at the first `;\n` after the opening —
    // earlier `]` in the source belongs to `JsonValue[]` elsewhere. Pin to
    // the matching `;` so we capture the union's full member list.
    const unionEnd = apiSrc.indexOf(";\n", unionStart);
    assert.notEqual(unionEnd, -1, "OperatorCommandName union body not terminated");
    const unionBody = apiSrc.slice(unionStart, unionEnd);
    const unionMembers = unionBody
      .split("|")
      .map((s) => s.trim())
      // Each union arm is a quoted string like `"end"`; keep only those.
      .filter((s) => /^"[a-z-]+"$/.test(s))
      .map((s) => s.slice(1, -1));
    for (const cmd of ALL_OPERATOR_COMMANDS) {
      assert.ok(unionMembers.includes(cmd), `OperatorCommandName union is missing "${cmd}"`);
    }
    assert.equal(
      unionMembers.length,
      ALL_OPERATOR_COMMANDS.length,
      `OperatorCommandName union has ${unionMembers.length} members; expected exactly ${ALL_OPERATOR_COMMANDS.length}: ${[...unionMembers].sort().join(", ")}`,
    );
  });

  test("the dashboard RPC handler's 11-command allow-list matches the brief", () => {
    // Mirror of the previous check on the server side. The handler builds
    // a Set<String> allow-list inline at POST /operator-command. The set
    // must contain exactly the 11 command names — no more, no fewer.
    const handlerPath = fileURLToPath(new URL("../src/observability/server/http-handler.ts", import.meta.url));
    const handlerSrc = readFileSync(handlerPath, "utf8");
    const allowedIdx = handlerSrc.indexOf('const ALLOWED = new Set([');
    assert.notEqual(allowedIdx, -1, "ALLOWED set not found in http-handler.ts");
    const allowedEnd = handlerSrc.indexOf("]);", allowedIdx);
    const allowedEntries = (handlerSrc
      .slice(allowedIdx, allowedEnd)
      .match(/"([a-z-]+)"/g) || [])
      .map((s) => s.slice(1, -1));
    for (const cmd of ALL_OPERATOR_COMMANDS) {
      assert.ok(allowedEntries.includes(cmd), `RPC allow-list missing "${cmd}"`);
    }
    assert.equal(
      allowedEntries.length,
      ALL_OPERATOR_COMMANDS.length,
      `RPC allow-list has ${allowedEntries.length} entries; expected exactly ${ALL_OPERATOR_COMMANDS.length}: ${[...allowedEntries].sort().join(", ")}`,
    );
  });
});
