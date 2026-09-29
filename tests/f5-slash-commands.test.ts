/**
 * F5b — All 8 operator commands registered as Pi slash commands.
 *
 * The 8 operator commands are function-complete in `worker-tools.ts` and
 * dispatched by `invokeOperatorCommand` (in `operator-commands.ts`). The
 * integration surface for the operator (Pi slash commands) is in
 * `src/integration/commands.ts`. This file pins:
 *
 *   - All 8 commands are registered (`pi.registerCommand` was called for
 *     each `hive:worker-<name>` name).
 *   - Each command's handler accepts `<agent> [reason]` and forwards to
 *     `invokeOperatorCommand`.
 *   - The handler surfaces errors via `ctx.ui.notify` and never throws out
 *     of `pi.registerCommand`'s contract.
 *
 * Source: HANDOFF.md §"Order of operations" task 2 (Wire the F5 surface).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OPERATOR_COMMANDS } from "../src/engine/budget/operator-commands.ts";
import { registerCommands } from "../src/integration/commands.ts";

interface RegisteredCommand {
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

interface FakeExtensionAPI extends Pick<ExtensionAPI, "registerCommand"> {
  registered: Map<string, RegisteredCommand>;
  shortcuts: Map<string, unknown>;
  registerShortcut(key: unknown, spec: unknown): void;
}

function makeFakePi(): FakeExtensionAPI {
  const registered = new Map<string, RegisteredCommand>();
  const shortcuts = new Map<string, unknown>();
  return {
    registered,
    shortcuts,
    registerCommand(name: string, spec: { description: string; handler: RegisteredCommand["handler"] }) {
      registered.set(name, { description: spec.description, handler: spec.handler });
    },
    registerShortcut(_key: unknown, spec: unknown) {
      shortcuts.set("shortcut", spec);
    },
  };
}

function makeStateStub() {
  return {
    config: null,
    session: null,
    runtimes: new Map(),
    widgetCtx: null,
    activeRuns: 0,
    mode: "hive",
    normalToolNames: [],
    sddStatus: null,
    obsSeq: 0,
    onRuntimeUpdate: undefined,
    onRuntimeFinish: undefined,
    shuttingDown: false,
    pendingHiveCycleRestore: null,
    latestVerdicts: new Map(),
    workerQueue: [],
    budgetWarnings: undefined,
    progressNotes: undefined,
  } as unknown as Parameters<typeof registerCommands>[1];
}

test("F5b-slash: every operator command in OPERATOR_COMMANDS is registered as a /hive:worker-<name> command", () => {
  const pi = makeFakePi();
  const state = makeStateStub();
  registerCommands(pi as unknown as ExtensionAPI, state);
  for (const op of OPERATOR_COMMANDS) {
    const expectedName = `hive:worker-${op.name}`;
    assert.ok(
      pi.registered.has(expectedName),
      `expected ${expectedName} to be registered (registered: ${Array.from(pi.registered.keys()).join(", ")})`,
    );
    assert.match(pi.registered.get(expectedName)!.description, /<agent>/);
  }
});

test("F5b-slash: registered count matches OPERATOR_COMMANDS.length", () => {
  const pi = makeFakePi();
  const state = makeStateStub();
  registerCommands(pi as unknown as ExtensionAPI, state);
  const workerCommands = Array.from(pi.registered.keys()).filter((n) => n.startsWith("hive:worker-"));
  assert.equal(workerCommands.length, OPERATOR_COMMANDS.length);
});

test("F5b-slash: empty argument string surfaces a usage warning, not a thrown error", async () => {
  const pi = makeFakePi();
  const state = makeStateStub();
  registerCommands(pi as unknown as ExtensionAPI, state);
  const end = pi.registered.get("hive:worker-end");
  assert.ok(end);

  const notifications: Array<{ message: string; severity: string }> = [];
  const ctx = { hasUI: true, ui: { notify: (m: string, s: string) => notifications.push({ message: m, severity: s }) } };
  await end.handler("", ctx);
  assert.ok(
    notifications.some((n) => /Usage/.test(n.message)),
    "empty-args usage hint must surface via ui.notify",
  );
});

test("F5b-slash: unknown agent surfaces an OperatorCommandError, never a thrown error", async () => {
  const pi = makeFakePi();
  const state = makeStateStub();
  registerCommands(pi as unknown as ExtensionAPI, state);
  const compact = pi.registered.get("hive:worker-compact");
  assert.ok(compact);

  const notifications: Array<{ message: string; severity: string }> = [];
  const ctx = { hasUI: true, ui: { notify: (m: string, s: string) => notifications.push({ message: m, severity: s }) } };
  // Should NOT throw — the handler catches OperatorCommandError and surfaces it.
  await compact.handler("ghost-agent", ctx);
  assert.ok(
    notifications.some((n) => /unknown agent/i.test(n.message)),
    `unknown agent must surface as a ui.notify error (got: ${JSON.stringify(notifications)})`,
  );
});
