// Regression test for the bug where type-scoped tools (e.g.
// submit_review_verdict) reach buildHiveTools and survive the
// dispatch.ts:417 filter, but never appear in the function-definitions
// block because the Pi SDK treats `tools` as authoritative — a
// customTool whose name isn't in `tools` is silently dropped.
//
// Pre-fix behavior: a reviewer with `tools: [read, grep, find, ls, bash,
// team_conversation]` in frontmatter would have submit_review_verdict
// in customTools but missing from `tools`, so the SDK's function-
// definitions block at session start did not contain it. The reviewer
// could read its .md instruction ("the tool is auto-injected") but
// couldn't actually call the tool.
//
// Post-fix behavior: `dispatchToolNames(toolNames, hiveTools)` unions the
// agent's enumerated `tools:` list with the names of type-scoped tools
// buildHiveTools emitted, so the union is what reaches the SDK's `tools:`
// parameter.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildHiveTools } from "../src/agents/tools.ts";
import { dispatchToolNames } from "../src/engine/dispatch.ts";
import { TYPE_SCOPED_TOOL_NAMES } from "../src/core/constants.ts";
import type { AgentRuntime, HiveState } from "../src/core/types.ts";

function runtime(name: string, extra: Partial<AgentRuntime["config"]> = {}): AgentRuntime {
  return {
    config: { name, path: `${name}.md`, role: "member", routingTags: [], domain: [], ...extra },
    systemPrompt: "", status: "idle", task: "", lastWork: "", toolCount: 0, elapsedMs: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, contextPct: 0, runCount: 0, sessionFile: "",
  };
}

function stateWith(runtimes: AgentRuntime[]): HiveState {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-dispatch-scoping-"));
  return {
    pi: {} as any, config: { orchestrator: { name: "Orchestrator", path: "o.md" }, agents: [], sharedContext: [], settings: { subagentOutputLimit: 100, defaultTools: "read, grep, find, ls", maxParallel: 1, distiller: { enabled: false, model: "", conversationLines: 10 } } },
    session: { sessionId: "s1", sessionDir: dir, conversationLog: join(dir, "c.jsonl"), observabilityLog: join(dir, "e.jsonl") },
    runtimes: new Map(runtimes.map((entry) => [entry.config.name.toLowerCase(), entry])),
    widgetCtx: null, activeRuns: 0, mode: "hive", normalToolNames: [],
    sddStatus: null, obsSeq: 0,
    latestVerdicts: new Map(),
  };
}

// Mirrors the production chain in dispatch.ts:413-417: split the agent's
// enumerated `tools:` config into names, then filter buildHiveTools' output
// down to "in toolNames OR in TYPE_SCOPED_TOOL_NAMES". The bug being fixed
// is in what happens to this filtered list before createSession.
function dispatchFilter(toolNames: string[], hiveTools: ReturnType<typeof buildHiveTools>): typeof hiveTools {
  return hiveTools.filter((t) => toolNames.includes(t.name) || TYPE_SCOPED_TOOL_NAMES.has(t.name));
}

test("submit_review_verdict survives the full chain even when not in the reviewer's enumerated tools", () => {
  const state = stateWith([runtime("Reviewer", { agentType: "reviewer" })]);
  // The reviewer's enumerated `tools:` list — matches the .md frontmatter the
  // user reported. Critically, submit_review_verdict is NOT in this list.
  const toolNames = ["read", "grep", "find", "ls", "bash", "team_conversation"];

  const hiveTools = buildHiveTools(state, "Reviewer");
  // Sanity: buildHiveTools DOES emit submit_review_verdict for a reviewer.
  assert.ok(
    hiveTools.some((t) => t.name === "submit_review_verdict"),
    "buildHiveTools must emit submit_review_verdict for a reviewer (regression on existing buildHiveTools test)",
  );

  const kept = dispatchFilter(toolNames, hiveTools);
  // The filter at dispatch.ts:417 keeps submit_review_verdict because it's
  // in TYPE_SCOPED_TOOL_NAMES.
  assert.ok(
    kept.some((t) => t.name === "submit_review_verdict"),
    "dispatch.ts:417 filter must keep type-scoped tools",
  );

  // The bug: previously `createSession` was called with `tools: toolNames`,
  // which dropped submit_review_verdict because the SDK uses `tools` as the
  // authoritative list. Post-fix: the union reaches the SDK.
  const allToolNames = dispatchToolNames(toolNames, kept);
  assert.ok(
    allToolNames.includes("submit_review_verdict"),
    "dispatchToolNames must union type-scoped tools into the SDK's `tools` parameter",
  );
  // The enumerated list is preserved (deduplicated).
  for (const name of toolNames) {
    assert.ok(allToolNames.includes(name), `allToolNames must preserve enumerated tool: ${name}`);
  }
});

test("plan_new / plan_select / plan_task_complete reach the SDK for leads", () => {
  const state = stateWith([runtime("Lead", { agentType: "lead" })]);
  const toolNames = ["read", "grep", "find", "ls"]; // no plan_* tools enumerated

  const hiveTools = buildHiveTools(state, "Lead");
  for (const plan of ["plan_new", "plan_select", "plan_task_complete"]) {
    assert.ok(
      hiveTools.some((t) => t.name === plan),
      `buildHiveTools must emit ${plan} for a lead`,
    );
  }

  const kept = dispatchFilter(toolNames, hiveTools);
  for (const plan of ["plan_new", "plan_select", "plan_task_complete"]) {
    assert.ok(
      kept.some((t) => t.name === plan),
      `dispatch.ts:417 filter must keep ${plan}`,
    );
  }

  const allToolNames = dispatchToolNames(toolNames, kept);
  for (const plan of ["plan_new", "plan_select", "plan_task_complete"]) {
    assert.ok(
      allToolNames.includes(plan),
      `dispatchToolNames must union ${plan} into the SDK's tools`,
    );
  }
});

test("dispatchToolNames deduplicates and preserves order from the agent's enumerated list", () => {
  const toolNames = ["read", "grep", "bash", "team_conversation"];
  const hiveTools: Array<{ name: string }> = [
    { name: "team_conversation" }, // already in toolNames — must dedupe
    { name: "submit_review_verdict" }, // new — must be appended
    { name: "submit_review_verdict" }, // duplicate of itself — must dedupe
  ];
  const result = dispatchToolNames(toolNames, hiveTools);
  assert.deepEqual(result, ["read", "grep", "bash", "team_conversation", "submit_review_verdict"]);
});

test("dispatchToolNames leaves an agent that doesn't qualify for any type-scoped tools alone", () => {
  // A coder: not a reviewer, not a lead. No type-scoped tools are emitted
  // by buildHiveTools for them, so the union should equal toolNames.
  const state = stateWith([runtime("Coder", { agentType: "coder" })]);
  const toolNames = ["read", "grep", "bash"];
  const hiveTools = buildHiveTools(state, "Coder");
  const kept = dispatchFilter(toolNames, hiveTools);
  const allToolNames = dispatchToolNames(toolNames, kept);
  // No type-scoped names should be added because buildHiveTools didn't emit any.
  for (const scoped of TYPE_SCOPED_TOOL_NAMES) {
    assert.ok(!allToolNames.includes(scoped), `coder should not get type-scoped tool: ${scoped}`);
  }
  // The enumerated tools are still preserved.
  for (const name of toolNames) {
    assert.ok(allToolNames.includes(name), `allToolNames must preserve enumerated tool: ${name}`);
  }
});
