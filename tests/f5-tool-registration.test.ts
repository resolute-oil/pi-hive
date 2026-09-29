/**
 * F5 — Cooperative tools + summarize_progress registered in buildHiveTools.
 *
 * The 3 cooperative tools (`request_compaction`, `request_end_session`,
 * `request_snapshot`) and the `summarize_progress` tool exist as standalone
 * functions but were never registered in `buildHiveTools`. Without
 * registration, workers cannot call them — they have zero production callers
 * (per the F5 wiring gap in HANDOFF.md).
 *
 * Source of truth:
 *   docs/reviews/28-09-2026-budget-review/04-refactor-plan.md §2.8 (cooperative
 *   tools) + §2.13 C5 (structured strategies; required for summarize_progress
 *   to honor `compact: true`).
 *
 * Coverage:
 *   - `buildHiveTools` returns a ToolDefinition for each cooperative tool
 *     when called for a worker caller.
 *   - The cooperative tool execute body calls the underlying
 *     `requestCompaction` / `requestEndSession` / `requestSnapshot` and
 *     surfaces the result.
 *   - `buildHiveTools` returns `summarize_progress` when called with a
 *     non-null ledger (worker case); absent when called for the orchestrator
 *     (orchestrator has no worker ledger).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentRuntime, HiveState } from "../src/core/types.ts";
import type { BudgetLedger } from "../src/engine/budget/ledger.ts";
import { buildHiveTools } from "../src/agents/tools.ts";

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function makeFakeState(workerName = "test-worker"): HiveState {
  return {
    pi: {} as ExtensionAPI,
    config: {
      orchestrator: { name: "Orchestrator", path: "/tmp/orchestrator" },
      agents: [{ name: workerName, path: `/tmp/${workerName}` }],
      sharedContext: [],
      settings: {
        subagentOutputLimit: 12000,
        defaultTools: "",
        distiller: { enabled: false, model: "test-model", conversationLines: 100 },
        budgets: {
          strategies: {
            onApproachingLimit: { action: "wrap-up" },
            onExhaustion: { action: "compact" },
          },
        },
      },
    } as unknown as HiveState["config"],
    session: null,
    runtimes: new Map(),
    widgetCtx: null,
    activeRuns: 0,
    mode: "hive",
    normalToolNames: [],
    sddStatus: null,
    obsSeq: 0,
  };
}

function makeFakeRuntime(name: string): AgentRuntime {
  return {
    config: { name, path: `/tmp/${name}`, slug: name } as AgentConfig,
    systemPrompt: "",
    status: "running",
    task: "",
    lastWork: "",
    toolCount: 0,
    elapsedMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    contextPct: 0,
    runCount: 0,
    sessionFile: "",
  } as unknown as AgentRuntime;
}

function makeFakeLedger(): BudgetLedger {
  return {
    snapshot: () => {},
  } as unknown as BudgetLedger;
}

// ---------------------------------------------------------------------------
// Slice 1: Cooperative tools registered in buildHiveTools for workers.
// ---------------------------------------------------------------------------

test("F5a: buildHiveTools includes request_compaction, request_end_session, request_snapshot for workers", () => {
  const state = makeFakeState("test-worker");
  state.runtimes.set("test-worker", makeFakeRuntime("test-worker"));

  const tools = buildHiveTools(state, "test-worker", makeFakeLedger());
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("request_compaction"), "request_compaction must be registered for workers");
  assert.ok(names.includes("request_end_session"), "request_end_session must be registered for workers");
  assert.ok(names.includes("request_snapshot"), "request_snapshot must be registered for workers");
});

test("F5b: buildHiveTools does NOT include the cooperative tools for the orchestrator (no per-worker ledger)", () => {
  const state = makeFakeState("test-worker");
  // No runtime for "Orchestrator" — buildHiveTools falls back to lead type.
  const tools = buildHiveTools(state, "Orchestrator");
  const names = tools.map((t) => t.name);
  assert.ok(!names.includes("request_compaction"), "orchestrator should not have request_compaction");
  assert.ok(!names.includes("request_end_session"), "orchestrator should not have request_end_session");
  assert.ok(!names.includes("request_snapshot"), "orchestrator should not have request_snapshot");
});

// ---------------------------------------------------------------------------
// Slice 2: summarize_progress registered for workers (with ledger).
// ---------------------------------------------------------------------------

test("F5c: buildHiveTools includes summarize_progress when called with a non-null ledger", () => {
  const state = makeFakeState("test-worker");
  state.runtimes.set("test-worker", makeFakeRuntime("test-worker"));
  const tools = buildHiveTools(state, "test-worker", makeFakeLedger());
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("summarize_progress"), "summarize_progress must be registered for workers with a ledger");
});

test("F5d: buildHiveTools omits summarize_progress when no ledger is supplied", () => {
  const state = makeFakeState("test-worker");
  const tools = buildHiveTools(state, "test-worker");
  const names = tools.map((t) => t.name);
  assert.ok(!names.includes("summarize_progress"), "summarize_progress only registered when ledger is provided");
});

// ---------------------------------------------------------------------------
// Slice 3: Cooperative tool execute body surfaces results.
// ---------------------------------------------------------------------------

test("F5e: request_compaction execute body calls requestCompaction and surfaces no_runtime cleanly", async () => {
  const state = makeFakeState("test-worker");
  // No runtime entry for "test-worker" — cooperative path returns no_runtime.
  const tools = buildHiveTools(state, "test-worker", makeFakeLedger());
  const tool = tools.find((t) => t.name === "request_compaction");
  assert.ok(tool, "request_compaction tool must be present");
  const execute = tool.execute as (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ) => Promise<{ details: { ok: boolean; reason?: string } }>;
  const result = await execute("call-id", { notes: "wrap up" }, undefined, undefined, {} as ExtensionContext);
  assert.equal(result.details.ok, false);
  assert.equal(result.details.reason, "no_runtime");
});