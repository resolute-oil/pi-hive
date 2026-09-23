import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildHiveTools } from "../src/agents/tools.ts";
import { createState } from "../src/engine/state.ts";
import type { HiveState } from "../src/core/types.ts";

// The hive_cycle_summary tool's execute signature, narrowed to the params
// shape the LLM sends and the result fields the tests read. Mirrors the
// SDK's ToolDefinition.execute signature; the test only invokes the four
// runtime-meaningful args (signal/onUpdate/ctx are no-ops for this tool),
// so the test passes `undefined` for those plus a stub ctx.
type HiveCycleSummaryParams = { summary: string };
type HiveCycleSummaryResult = {
  content: Array<{ type: string; text: string }>;
  details: unknown;
  isError?: boolean;
};
type HiveCycleSummaryExecute = (
  toolCallId: string,
  params: HiveCycleSummaryParams,
  signal: AbortSignal | undefined,
  onUpdate: ((update: unknown) => void) | undefined,
  ctx: ExtensionContext,
) => Promise<HiveCycleSummaryResult>;

// `buildHiveTools` only references `state.pi` lazily inside tool bodies; the
// hive_cycle_summary tool does not touch it. A stub is enough to satisfy the
// `createState` constructor.
function stubPi(): ExtensionAPI {
  return {} as unknown as ExtensionAPI;
}

function makeState(): HiveState {
  return createState(stubPi());
}

function getHiveCycleSummaryTool(state: HiveState) {
  const tools = buildHiveTools(state, "Orchestrator");
  const tool = tools.find((t) => t.name === "hive_cycle_summary");
  assert.ok(tool, "hive_cycle_summary tool should be registered");
  return tool;
}

// Stub ExtensionContext — the hive_cycle_summary tool does not read ctx, so
// an empty object satisfies the type. Cast once at the helper boundary.
const stubCtx = {} as unknown as ExtensionContext;

test("hive_cycle_summary stashes the LLM's summary into pendingHiveCycleRestore", async () => {
  const state = makeState();
  state.pendingHiveCycleRestore = { snapshotLeafId: "leaf-abc" };
  const tool = getHiveCycleSummaryTool(state);
  const beforeSummary = state.pendingHiveCycleRestore.summary;

  const result = await (tool.execute as HiveCycleSummaryExecute)(
    "call-1",
    { summary: "implemented login flow; reviewers green; next: smoke test" },
    undefined,
    undefined,
    stubCtx,
  );

  assert.equal(state.pendingHiveCycleRestore?.snapshotLeafId, "leaf-abc", "snapshotLeafId preserved");
  assert.notEqual(state.pendingHiveCycleRestore?.summary, beforeSummary, "summary changed");
  assert.equal(
    state.pendingHiveCycleRestore?.summary,
    "implemented login flow; reviewers green; next: smoke test",
  );
  assert.equal(result.isError, undefined, "success path has no isError field");
  assert.ok(Array.isArray(result.content) && result.content.length > 0, "returns content");
  assert.match(result.content[0].text, /Handoff summary recorded/);
});

test("hive_cycle_summary returns isError without mutating state when no pending restore", async () => {
  const state = makeState();
  // No pendingHiveCycleRestore set on purpose.
  assert.equal(state.pendingHiveCycleRestore, undefined);
  const tool = getHiveCycleSummaryTool(state);

  const result = await (tool.execute as HiveCycleSummaryExecute)(
    "call-2",
    { summary: "should be ignored" },
    undefined,
    undefined,
    stubCtx,
  );

  assert.equal(result.isError, true, "should flag isError");
  assert.equal(state.pendingHiveCycleRestore, undefined, "state must not be set");
  assert.match(result.content[0].text, /No pending hive cycle restore is active/);
});
