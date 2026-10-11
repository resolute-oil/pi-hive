/**
 * Hive orchestration extension for Pi.
 *
 * Installed globally and auto-discovered for every project, but it only
 * activates when the current project opts in by providing a
 * `.pi/hive/hive-config.yaml`. Without that file the extension registers
 * no tools, hooks, or team-aware commands. The one exception is
 * `/hive:version`, registered unconditionally because it only reads git
 * metadata from the extension's own source directory. That lets a project
 * that has not opted in still verify the extension is loaded.
 *
 * When active, it loads a hierarchical team from `.pi/hive/hive-config.yaml`,
 * gives the visible session only delegation/coordination tools (it routes,
 * never edits), renders a live team tree, and records a JSONL conversation log
 * across the orchestrator and workers.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HIVE_ROOT } from "./src/core/constants";


// The project opts in by configuring a hive. We check at load time (the
// extension module runs in the project's cwd) so projects without a hive
// skip every config-dependent module. `/hive:version` is registered above
// (before this gate) and stays available because it has no config dependency.
function projectHasHive(): boolean {
  return existsSync(join(process.cwd(), HIVE_ROOT, "hive-config.yaml"));
}

export default async function hiveExtension(pi: ExtensionAPI) {
  // `/hive:version` is config-independent: it reads git metadata from the
  // extension's own source directory, so it is useful even when the project
  // has not opted in. Load commands.ts and register it before the config
  // gate so the diagnostic is always available.
  const commandsModule = await import("./src/integration/commands");
  commandsModule.registerAlwaysOnCommands(pi);

  if (!projectHasHive()) return;

  const [stateModule, toolsModule, hooksModule] = await Promise.all([
    import("./src/engine/state"),
    import("./src/agents/tools"),
    import("./src/integration/hooks"),
  ]);

  const state = stateModule.createState(pi);
  toolsModule.registerTools(pi, state);
  commandsModule.registerCommands(pi, state);
  hooksModule.registerHooks(pi, state);
}
