import assert from "node:assert/strict";
import { test } from "node:test";
import { registerAlwaysOnCommands } from "../src/integration/commands.ts";

// `/hive:version` is config-independent: it reads git metadata from the
// extension's own source directory, so projects without a hive can still
// run it. `index.ts` calls `registerAlwaysOnCommands` before the config
// gate, so this test pins that registration does not require `state` or
// `CommandDeps` and exposes a callable handler.

test("registerAlwaysOnCommands registers /hive:version with a callable handler", () => {
  const commands = new Map<string, any>();
  const pi = {
    registerCommand(name: string, command: any) { commands.set(name, command); },
  } as any;

  registerAlwaysOnCommands(pi);

  assert.ok(commands.has("hive:version"), "expected /hive:version to be registered unconditionally");
  const registered = commands.get("hive:version");
  assert.equal(typeof registered.handler, "function", "expected a callable handler so the diagnostic can run");
  assert.match(
    registered.description,
    /git SHA/,
    "expected the description to mention git SHA so the user-facing contract is pinned",
  );
});
