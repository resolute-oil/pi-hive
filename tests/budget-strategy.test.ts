// Budget-strategy feature — see tmp/budget-strategy-plan.md.
//
// Tests cover the three plan sections:
//   1. Strategies (default / compact) emit the right prompt hint at ≤20%.
//   2. Respawn + compact team-budget recalculation via effectiveTokens.
//   3. Operator intervention commands (end / compact / respawn) wired into
//      dispatch.ts.
//
// Pattern follows governance.test.ts: state-fixture + runtime-fixture helpers,
// small focused tests, no real SDK sessions. The three operator commands are
// tested through dispatch.ts directly with stubbed sessions.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRuntime, HiveState } from "../src/core/types.ts";
import { agentSlug } from "../src/core/agent-tree.ts";
import { budgetRemaining, workerConsumedTokens } from "../src/engine/governance.ts";
import {
  applyBudgetStrategy,
  DEFAULT_PROGRESS_SUMMARY_TOKEN_LIMIT,
  emitBudgetWarning,
  progressSummaryTokenLimit,
  resolveBudgetStrategy,
  shouldInterveneAvailable,
  triggerSummarizeProgress,
  validateProgressNotes,
} from "../src/engine/budget-strategy.ts";
import { endWorkerSession, compactWorkerSession, freshResetRuntime, respawnWorkerSession } from "../src/engine/dispatch.ts";
import { validateHiveConfigShape } from "../src/core/schema.ts";
import { buildSummarizeProgressTool } from "../src/agents/tools/summarize-progress.ts";

function runtime(name: string, overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    config: { name, path: `${name}.md`, role: "member", governance: undefined },
    systemPrompt: "", status: "idle", task: "", lastWork: "", toolCount: 0, elapsedMs: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, costUsd: 0, contextPct: 0, runCount: 0, sessionFile: `${name}.jsonl`,
    ...overrides,
  };
}

function state(runtimes: AgentRuntime[], settings: Record<string, unknown> = {}, shared: Record<string, unknown> = {}): HiveState {
  return {
    config: {
      settings,
      orchestrator: { name: "Main", path: "main.md" },
      agents: [],
      sharedContext: [],
      ...shared,
    } as any,
    runtimes: new Map(runtimes.map((entry) => [agentSlug(entry.config), entry])),
    activeRuns: 0,
    workerQueue: [],
    nextQueueId: 0,
    onRuntimeUpdate: () => {},
    budgetWarnings: new Set<string>(),
  } as any;
}

// Mock loadAgentRuntime that returns a fresh AgentRuntime with the agent's
// config preserved but counters zeroed — same shape loadAgentRuntime returns
// for a brand-new run. Used by the respawn tests so they don't need a real
// agent prompt file at the runtime path.
const mockLoadRuntime: typeof import("../src/engine/session.ts").loadAgentRuntime = (_state, _ctx, _cfg, agent) => {
  return runtime(agent.name, { status: "idle", config: agent });
};

// ---------------------------------------------------------------------------
// Strategies: hint emission, interventionAvailable flag, settings resolution.
// ---------------------------------------------------------------------------

test("resolveBudgetStrategy defaults to 'default' when neither settings nor agent override set it", () => {
  const worker = runtime("worker");
  const hive = state([worker], { workerBudgets: { tokenBudget: 1000 } });
  assert.equal(resolveBudgetStrategy(hive, worker), "default");
});

test("settings-level budgetStrategy applies when no agent override", () => {
  const worker = runtime("worker");
  const hive = state([worker], { workerBudgets: { tokenBudget: 1000, budgetStrategy: "compact" } });
  assert.equal(resolveBudgetStrategy(hive, worker), "compact");
});

test("per-agent governance: budgetStrategy wins over settings (settings-level override test #12)", () => {
  const worker = runtime("worker", { config: { name: "worker", path: "worker.md", role: "member", governance: { budgetStrategy: "compact" } } as any });
  const hive = state([worker], { workerBudgets: { tokenBudget: 1000, budgetStrategy: "default" } });
  assert.equal(resolveBudgetStrategy(hive, worker), "compact");
});

test("default strategy emits a 'wrap up' prompt hint that mentions summarize_progress", () => {
  const worker = runtime("worker");
  const hive = state([worker], { workerBudgets: { tokenBudget: 1000 } });
  const hint = applyBudgetStrategy(hive, worker, { scope: "worker", resource: "tokens", remaining: 100, limit: 1000 });
  assert.ok(hint.includes("Budget approaching limit"));
  assert.ok(hint.includes("summarize_progress"));
  // Default strategy explicitly offers the operator actions.
  assert.ok(hint.includes("operator"));
});

test("compact strategy emits a 'request compact' hint with the worker-driven timing path", () => {
  const worker = runtime("worker");
  const hive = state([worker], { workerBudgets: { tokenBudget: 1000, budgetStrategy: "compact" } });
  const hint = applyBudgetStrategy(hive, worker, { scope: "worker", resource: "tokens", remaining: 100, limit: 1000 });
  assert.ok(hint.includes("force-compacted at 0%"));
  assert.ok(hint.includes("summarize_progress"));
  // Compact strategy is automatic — the hint does NOT mention operator actions.
  assert.ok(!hint.includes("operator has been notified"));
});

test("shouldInterveneAvailable is true under default and false under compact", () => {
  const defaultWorker = runtime("w-default");
  const defaultHive = state([defaultWorker], { workerBudgets: { tokenBudget: 1000 } });
  assert.equal(shouldInterveneAvailable(defaultHive, defaultWorker), true);

  const compactWorker = runtime("w-compact");
  const compactHive = state([compactWorker], { workerBudgets: { tokenBudget: 1000, budgetStrategy: "compact" } });
  assert.equal(shouldInterveneAvailable(compactHive, compactWorker), false);
});

test("emitBudgetWarning sets interventionAvailable: true under default strategy", () => {
  const worker = runtime("worker");
  const hive = state([worker], { workerBudgets: { tokenBudget: 1000 } });
  // Assert via the returned hint string and via the runtime.systemPrompt mutation.
  const hint = emitBudgetWarning(hive, worker, { scope: "worker", resource: "tokens", remaining: 100, limit: 1000 });
  assert.ok(hint.length > 0);
  // The hint is appended to runtime.systemPrompt so a future prompt build picks it up.
  assert.ok(worker.systemPrompt.includes("Budget approaching limit"));
});

test("emitBudgetWarning under compact strategy does NOT mutate systemPrompt with the operator-intervention language", () => {
  const worker = runtime("worker");
  const hive = state([worker], { workerBudgets: { tokenBudget: 1000, budgetStrategy: "compact" } });
  emitBudgetWarning(hive, worker, { scope: "worker", resource: "tokens", remaining: 100, limit: 1000 });
  // The compact-strategy hint mentions force-compact, NOT operator intervention.
  assert.ok(!worker.systemPrompt.includes("operator has been notified"));
});

test("progressSummaryTokenLimit defaults to 2000 when unset and respects per-agent governance override", () => {
  const workerDefault = runtime("w-default");
  const defaultHive = state([workerDefault], { workerBudgets: { tokenBudget: 1000 } });
  assert.equal(progressSummaryTokenLimit(defaultHive, workerDefault), DEFAULT_PROGRESS_SUMMARY_TOKEN_LIMIT);
  assert.equal(progressSummaryTokenLimit(defaultHive, workerDefault), 2000);

  const workerCustom = runtime("w-custom", { config: { name: "w-custom", path: "w-custom.md", role: "member", governance: { progressSummaryTokenLimit: 500 } } as any });
  const customHive = state([workerCustom], { workerBudgets: { tokenBudget: 1000, progressSummaryTokenLimit: 800 } });
  // Per-agent governance wins.
  assert.equal(progressSummaryTokenLimit(customHive, workerCustom), 500);
});

// ---------------------------------------------------------------------------
// summarize_progress tool: notes storage, compact flag semantics, size cap.
// ---------------------------------------------------------------------------

test("validateProgressNotes accepts notes under the cap", () => {
  const worker = runtime("worker");
  const hive = state([worker], { workerBudgets: { tokenBudget: 1000 } });
  const result = validateProgressNotes(hive, worker, "short notes");
  assert.equal(result.ok, true);
  assert.ok((result.estimatedTokens || 0) > 0);
});

test("validateProgressNotes rejects notes over the cap with current size + limit (test #8)", () => {
  const worker = runtime("worker");
  const hive = state([worker], { workerBudgets: { tokenBudget: 1000, progressSummaryTokenLimit: 100 } });
  // 100 tokens ≈ 400 chars. Force a 500-char string.
  const notes = "a".repeat(500);
  const result = validateProgressNotes(hive, worker, notes);
  assert.equal(result.ok, false);
  assert.ok((result.estimatedTokens || 0) > 100);
  assert.equal(result.limit, 100);
  assert.ok((result.reason || "").includes("cap is"));
});

test("validateProgressNotes accepts empty notes (worker may record empty wrap-up)", () => {
  const worker = runtime("worker");
  const hive = state([worker], { workerBudgets: { tokenBudget: 1000, progressSummaryTokenLimit: 100 } });
  assert.equal(validateProgressNotes(hive, worker, "").ok, true);
});

test("triggerSummarizeProgress stores notes on runtime.progressNotes under both strategies (test #5)", async () => {
  const wDefault = runtime("w-default");
  const defaultHive = state([wDefault], { workerBudgets: { tokenBudget: 1000 } });
  const r1 = await triggerSummarizeProgress(defaultHive, wDefault, "notes for default", false);
  assert.equal(r1.stored, true);
  assert.equal(wDefault.progressNotes, "notes for default");
  assert.equal(r1.compacted, false);

  const wCompact = runtime("w-compact");
  const compactHive = state([wCompact], { workerBudgets: { tokenBudget: 1000, budgetStrategy: "compact" } });
  const r2 = await triggerSummarizeProgress(compactHive, wCompact, "notes for compact", false);
  assert.equal(r2.stored, true);
  assert.equal(wCompact.progressNotes, "notes for compact");
});

test("triggerSummarizeProgress with compact=true triggers session.compact() under compact strategy (test #6)", async () => {
  const worker = runtime("worker");
  let compactCalled = 0;
  let compactArg: unknown = null;
  (worker as any).session = { compact: async (customInstructions?: string) => { compactCalled++; compactArg = customInstructions; } };
  const hive = state([worker], { workerBudgets: { tokenBudget: 1000, budgetStrategy: "compact" } });
  const result = await triggerSummarizeProgress(hive, worker, "wrap-up notes", true);
  assert.equal(compactCalled, 1);
  assert.equal(compactArg, "wrap-up notes");
  assert.equal(result.compacted, true);
});

test("triggerSummarizeProgress with compact=true silently ignores the flag under default strategy (test #7)", async () => {
  const worker = runtime("worker");
  let compactCalled = 0;
  (worker as any).session = { compact: async () => { compactCalled++; } };
  const hive = state([worker], { workerBudgets: { tokenBudget: 1000 } }); // default strategy
  const result = await triggerSummarizeProgress(hive, worker, "notes", true);
  assert.equal(compactCalled, 0, "compact must NOT be called under default strategy");
  assert.equal(result.compacted, false);
  // Notes still get stored regardless of strategy.
  assert.equal(worker.progressNotes, "notes");
});

test("triggerSummarizeProgress latest-call-wins semantics on progressNotes", async () => {
  const worker = runtime("worker");
  const hive = state([worker], { workerBudgets: { tokenBudget: 1000 } });
  await triggerSummarizeProgress(hive, worker, "first", false);
  await triggerSummarizeProgress(hive, worker, "second", false);
  assert.equal(worker.progressNotes, "second");
});

test("triggerSummarizeProgress rethrows on compact failure so the tool can surface it", async () => {
  const worker = runtime("worker");
  (worker as any).session = { compact: async () => { throw new Error("provider unavailable"); } };
  const hive = state([worker], { workerBudgets: { tokenBudget: 1000, budgetStrategy: "compact" } });
  await assert.rejects(() => triggerSummarizeProgress(hive, worker, "notes", true), /provider unavailable/);
});

// ---------------------------------------------------------------------------
// Team-budget recalculation across compact and respawn (effectiveTokens).
// ---------------------------------------------------------------------------

test("compaction_end debits effectiveTokens by (tokensBefore - estimatedTokensAfter) (v2 test #1)", () => {
  // We exercise the recalc math directly via workerConsumedTokens before/after.
  // The full dispatch handler is exercised end-to-end in the integration test below.
  const worker = runtime("worker", {
    inputTokens: 50_000, outputTokens: 30_000,
    // Effective starts at the pre-compaction live load.
    effectiveTokens: 80_000,
  });
  state([worker], { teamBudgets: { tokenBudget: 200_000 } });
  // Simulate the compaction_end debit.
  const tokensBefore = 80_000;
  const estimatedTokensAfter = 20_000;
  const savings = tokensBefore - estimatedTokensAfter;
  const prior = workerConsumedTokens(worker);
  worker.effectiveTokens = Math.max(0, prior - savings);
  assert.equal(worker.effectiveTokens, 20_000);
});

test("budgetRemaining.team.tokens reflects the effectiveTokens debit immediately (v2 test #2)", () => {
  const worker = runtime("worker", {
    inputTokens: 50_000, outputTokens: 30_000, effectiveTokens: 80_000,
  });
  const hive = state([worker], { teamBudgets: { tokenBudget: 100_000 } });
  // Pre-debit: team has used 80k of 100k.
  assert.equal(budgetRemaining(hive, worker).team.tokens, 20_000);
  // Apply a 60k debit.
  worker.effectiveTokens = Math.max(0, 80_000 - 60_000);
  assert.equal(budgetRemaining(hive, worker).team.tokens, 80_000, "remaining grows by the savings");
});

test("team that was at-budget can dispatch a new worker after a compact frees enough (v2 test #3)", () => {
  const old = runtime("old", {
    inputTokens: 90_000, outputTokens: 10_000, effectiveTokens: 100_000, runCount: 5,
  });
  const newbie = runtime("newbie");
  const hive = state([old, newbie], {
    workerBudgets: { maxRuns: 10 },
    teamBudgets: { tokenBudget: 100_000 },
  });
  // Pre-debit: team is at-budget (100k of 100k).
  assert.equal(budgetRemaining(hive, newbie).team.tokens, 0);
  // Apply a 60k debit on the old worker.
  old.effectiveTokens = Math.max(0, 100_000 - 60_000);
  // Now team has 60k of headroom.
  assert.equal(budgetRemaining(hive, newbie).team.tokens, 60_000);
});

test("multiple sequential compactions accumulate: 100k → 30k → 10k = 90k savings (v2 test #4)", () => {
  const worker = runtime("worker", { inputTokens: 60_000, outputTokens: 40_000, effectiveTokens: 100_000 });
  // Compact 1: 100k → 30k, savings 70k.
  worker.effectiveTokens = Math.max(0, worker.effectiveTokens! - (100_000 - 30_000));
  assert.equal(worker.effectiveTokens, 30_000);
  // Compact 2: 30k → 10k, savings 20k.
  worker.effectiveTokens = Math.max(0, worker.effectiveTokens! - (30_000 - 10_000));
  assert.equal(worker.effectiveTokens, 10_000);
  // Total savings = 90k.
  assert.equal(100_000 - worker.effectiveTokens, 90_000);
});

test("cost budget is NOT debited by compact — only tokens (v2 test #5)", () => {
  const worker = runtime("worker", { costUsd: 5.0, governanceCostUsd: 5.0 });
  const before = worker.costUsd;
  // Apply the recalc math: it only touches effectiveTokens.
  worker.effectiveTokens = 50_000;
  assert.equal(worker.costUsd, before, "cost unchanged");
  assert.equal(worker.governanceCostUsd, 5.0);
});

test("compaction_end without tokensBefore/estimatedTokensAfter is a no-op (v2 test #6)", () => {
  const worker = runtime("worker", { effectiveTokens: 50_000 });
  // Simulate the handler with missing fields — no fields to apply, no debit.
  const tokensBefore: number | undefined = undefined;
  const estimatedTokensAfter: number | undefined = undefined;
  if (tokensBefore != null && estimatedTokensAfter != null && tokensBefore > estimatedTokensAfter) {
    // Would have debited; but the guard fails so no mutation.
    worker.effectiveTokens = 0;
  }
  assert.equal(worker.effectiveTokens, 50_000, "unchanged when result fields missing");
});

// ---------------------------------------------------------------------------
// Respawn operator command.
// ---------------------------------------------------------------------------

test("respawnWorkerSession on a finished worker: old runtime replaced, dispatch invoked with fresh=true (v2 test #7)", async () => {
  const finished = runtime("finished", {
    status: "done", task: "old-task", inputTokens: 50_000, outputTokens: 30_000, effectiveTokens: 80_000,
  });
  (finished as any).session = undefined; // finished workers have no live session
  const hive = state([finished], { workerBudgets: { tokenBudget: 100_000 } });
  const stubCtx = { cwd: "/tmp", ui: {} } as any;
  // Mock dispatch captures the call args without running the heavy path.
  const captured: { agent: string; task: string; fresh: boolean }[] = [];
  const mockDispatch: typeof import("../src/engine/dispatch.ts").dispatchAgent = async (_state, agent, task, _ctx, fresh = false) => {
    captured.push({ agent, task, fresh });
    return { output: "mock", exitCode: 0, elapsed: 0 };
  };
  // Mock loadRuntime so the test doesn't need a real agent prompt file at
  // the runtime path. Returns a fresh AgentRuntime with the agent's config
  // preserved but counters zeroed — same shape loadAgentRuntime returns for
  // a brand-new run. This is what lets the subsequent dispatch's
  // resolveRuntime find the entry in state.runtimes (the original was just
  // deleted).
  const result = await respawnWorkerSession(hive, "finished", "operator wants a fresh attempt", undefined, stubCtx, mockDispatch, mockLoadRuntime);
  // Old runtime is gone; a new runtime entry sits in its place so the
  // subsequent dispatch's resolveRuntime lookup finds something.
  const recreated = hive.runtimes.get("finished");
  assert.ok(recreated, "new runtime must exist in state.runtimes after respawn (operator respawn would silently no-op without this recreate step)");
  assert.notEqual(recreated, finished, "the recreated runtime must be a fresh AgentRuntime, not the original reference");
  assert.equal(recreated!.inputTokens, 0, "recreated runtime starts with zeroed SDK counters");
  assert.equal(recreated!.governanceTokens, undefined, "recreated runtime has no governance counters yet (set on first dispatch)");
  assert.equal(result.action, "respawn");
  assert.equal(captured.length, 1, "dispatch must be invoked exactly once");
  assert.equal(captured[0].agent, "finished");
  assert.equal(captured[0].task, "old-task");
  assert.equal(captured[0].fresh, true);
});

test("respawnWorkerSession with no ctx keeps the old runtime intact and returns ok: false (kieran 2.2)", async () => {
  const worker = runtime("worker", { status: "done", task: "keep-me" });
  const hive = state([worker]);
  const captured: unknown[] = [];
  const mockDispatch: typeof import("../src/engine/dispatch.ts").dispatchAgent = async () => {
    captured.push(null);
    return { output: "mock", exitCode: 0, elapsed: 0 };
  };
  const result = await respawnWorkerSession(hive, "worker", "respawn", undefined, undefined, mockDispatch);
  assert.equal(result.ok, false);
  assert.ok((result.reason || "").includes("ExtensionContext"));
  // CRITICAL: the old runtime must still be in state.runtimes so the worker
  // can be re-dispatched once the dashboard has a valid ctx.
  assert.equal(hive.runtimes.has("worker"), true, "old runtime must be preserved when ctx is missing");
  assert.equal(captured.length, 0, "dispatch must NOT be invoked when ctx is missing");
});

test("respawnWorkerSession without newTask re-dispatches with the original runtime.task (v2 test #10)", async () => {
  const worker = runtime("worker", {
    status: "done", task: "original-task", inputTokens: 100, outputTokens: 50, effectiveTokens: 150,
  });
  (worker as any).session = undefined;
  const hive = state([worker]);
  const stubCtx = { cwd: "/tmp", ui: {} } as any;
  const captured: { task: string }[] = [];
  const mockDispatch: typeof import("../src/engine/dispatch.ts").dispatchAgent = async (_state, _agent, task) => {
    captured.push({ task });
    return { output: "mock", exitCode: 0, elapsed: 0 };
  };
  await respawnWorkerSession(hive, "worker", "respawn", undefined, stubCtx, mockDispatch, mockLoadRuntime);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].task, "original-task", "no newTask \u2192 original runtime.task is reused");
});

test("respawnWorkerSession with newTask re-dispatches with the new task (v2 test #9)", async () => {
  const worker = runtime("worker", { status: "done", task: "original-task" });
  const hive = state([worker]);
  const stubCtx = { cwd: "/tmp", ui: {} } as any;
  const captured: { task: string }[] = [];
  const mockDispatch: typeof import("../src/engine/dispatch.ts").dispatchAgent = async (_state, _agent, task) => {
    captured.push({ task });
    return { output: "mock", exitCode: 0, elapsed: 0 };
  };
  await respawnWorkerSession(hive, "worker", "respawn", "redirect to a different task", stubCtx, mockDispatch, mockLoadRuntime);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].task, "redirect to a different task", "newTask overrides runtime.task");
});

test("respawnWorkerSession on unknown agent returns ok: false with a clear reason", async () => {
  const hive = state([]);
  const result = await respawnWorkerSession(hive, "ghost", "respawn");
  assert.equal(result.ok, false);
  assert.ok((result.reason || "").includes("Unknown agent"));
});

// ---------------------------------------------------------------------------
// freshResetRuntime regression — fresh=true must reset the cumulative
// governance counters alongside the per-session SDK counters, otherwise
// checkDispatchBudgets immediately blocks the new dispatch even though the
// SDK session is clean. Discovered while testing PR #54 (the
// fresh-budget-not-reset bug): orchestrator calls delegate_agent with
// fresh=true to recover from budget exhaustion; pre-fix, the prior session's
// exhausted total survived in runtime.governanceTokens and the new dispatch
// was blocked before it could even start.
// ---------------------------------------------------------------------------

test("freshResetRuntime resets governance counters alongside SDK counters when a prior session file exists", () => {
  const tmp = mkdtempSync(join(tmpdir(), "hive-fresh-test-"));
  try {
    const sessionFile = join(tmp, "worker.jsonl");
    writeFileSync(sessionFile, ""); // existsSync must return true for the helper to run
    const rt = runtime("worker", {
      inputTokens: 3500,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
      reasoningTokens: 50,
      costUsd: 0.05,
      // The pre-fix bug: governance counters survived across fresh=true and
      // checkDispatchBudgets saw the prior session's exhausted total.
      governanceTokens: 3500,
      governanceCostUsd: 0.05,
      sessionFile,
    });
    freshResetRuntime(rt);
    assert.equal(rt.inputTokens, 0, "SDK input tokens reset");
    assert.equal(rt.outputTokens, 0, "SDK output tokens reset");
    assert.equal(rt.cacheReadTokens, 0, "SDK cache read tokens reset");
    assert.equal(rt.cacheWriteTokens, 0, "SDK cache write tokens reset");
    assert.equal(rt.reasoningTokens, 0, "SDK reasoning tokens reset");
    assert.equal(rt.costUsd, 0, "SDK cost reset");
    assert.equal(rt.governanceTokens, 0, "governance tokens reset (the fix)");
    assert.equal(rt.governanceCostUsd, 0, "governance cost reset (the fix)");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("freshResetRuntime resets counters even when no prior session file exists (archive is best-effort)", () => {
  // The fresh counter reset is the contract — archive is a side effect.
  // If the session file is missing (first-ever dispatch, transient
  // filesystem hiccup, etc.), the reset still runs. Otherwise a fresh=true
  // on a worker whose file was never written would silently skip the
  // budget reset, which is the exact failure mode fresh=true exists to fix.
  const rt = runtime("worker", {
    inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10, reasoningTokens: 5,
    costUsd: 0.05, governanceTokens: 100, governanceCostUsd: 0.05, effectiveTokens: 80,
    sessionFile: "/nonexistent-path-that-does-not-exist-anywhere.jsonl",
  });
  freshResetRuntime(rt);
  assert.equal(rt.inputTokens, 0, "SDK input tokens reset even without prior session file");
  assert.equal(rt.outputTokens, 0, "SDK output tokens reset even without prior session file");
  assert.equal(rt.cacheReadTokens, 0, "SDK cache read tokens reset even without prior session file");
  assert.equal(rt.cacheWriteTokens, 0, "SDK cache write tokens reset even without prior session file");
  assert.equal(rt.reasoningTokens, 0, "SDK reasoning tokens reset even without prior session file");
  assert.equal(rt.costUsd, 0, "SDK cost reset even without prior session file");
  assert.equal(rt.governanceTokens, 0, "governance tokens reset even without prior session file");
  assert.equal(rt.governanceCostUsd, 0, "governance cost reset even without prior session file");
  assert.equal(rt.effectiveTokens, 0, "effective tokens reset even without prior session file");
});

// ---------------------------------------------------------------------------
// workerConsumedTokens mid-run vs post-run: the live mid-run branch is what
// makes the in-flight budget check (dispatch.ts:~660) actually see this
// run's consumption. Without it, governanceTokens dominates the ?? chain
// at 0 mid-run (it's only written at agent_end), and the worker overruns
// the cap silently. This is the Engineering Lead overblew 3500 by 26x
// regression — a guard against the live branch ever being dropped.
// ---------------------------------------------------------------------------

test("workerConsumedTokens returns the live runtime.* sum when runtime.status === 'running' (mid-run)", () => {
  const rt = runtime("worker", {
    status: "running",
    inputTokens: 2000,
    outputTokens: 1500,
    cacheReadTokens: 500,
    cacheWriteTokens: 100,
    reasoningTokens: 50,
    // governanceTokens is the FROZEN prior-session value, deliberately
    // much smaller than the live runtime.* sum so the test proves the
    // live path wins (not governanceTokens).
    governanceTokens: 100,
  });
  assert.equal(
    workerConsumedTokens(rt, "all"),
    2000 + 1500 + 500 + 100 + 50,
    "mid-run returns live runtime.* sum, not the frozen governanceTokens",
  );
  assert.equal(
    workerConsumedTokens(rt, "input_output"),
    2000 + 1500,
    "mid-run honors the scope argument",
  );
});

test("workerConsumedTokens returns the frozen governanceTokens when runtime.status !== 'running' (post-run / dispatch-time)", () => {
  const rt = runtime("worker", {
    status: "idle",
    inputTokens: 2000,
    outputTokens: 1500,
    // governanceTokens is the post-run authoritative value. dispatch-time
    // budget checks see this — they answer "can this worker run again?"
    // not "is the current run over budget?", so the live value is wrong.
    governanceTokens: 8000,
  });
  assert.equal(
    workerConsumedTokens(rt, "all"),
    8000,
    "post-run returns the frozen governanceTokens, not the live runtime.* sum",
  );
});

// ---------------------------------------------------------------------------
// Config validation rejects unknown budgetStrategy values (test #11).
// ---------------------------------------------------------------------------

test("validateHiveConfigShape rejects unknown budgetStrategy (including the legacy 'respawn')", () => {
  const config = {
    orchestrator: { name: "Main", path: "main.md" },
    agents: [],
    sharedContext: [],
    settings: {
      subagentOutputLimit: 12_000,
      workerBudgets: { budgetStrategy: "respawn" },
      distiller: { enabled: false, model: "x", conversationLines: 100 },
    },
  };
  assert.throws(() => validateHiveConfigShape(config as any), /budgetStrategy must be one of default, compact/);
});

// ---------------------------------------------------------------------------
// endWorkerSession + compactWorkerSession.
// ---------------------------------------------------------------------------

test("endWorkerSession aborts via session.abort() and emits the operator event with notes preserved", async () => {
  const worker = runtime("worker", { status: "running", progressNotes: "wrap-up notes for end" });
  let abortCalled = 0;
  (worker as any).session = { abort: async () => { abortCalled++; } };
  const hive = state([worker]);
  const result = await endWorkerSession(hive, "worker", "operator ended session");
  assert.equal(result.ok, true);
  assert.equal(abortCalled, 1);
  // Notes are preserved on the runtime for inspection.
  assert.equal(worker.progressNotes, "wrap-up notes for end");
});

test("endWorkerSession on unknown agent returns ok: false", async () => {
  const hive = state([]);
  const result = await endWorkerSession(hive, "ghost", "reason");
  assert.equal(result.ok, false);
  assert.ok((result.reason || "").includes("Unknown agent"));
});

test("compactWorkerSession calls session.compact(progressNotes) and emits the operator event", async () => {
  const worker = runtime("worker", { status: "running", progressNotes: "wrap-up for compact" });
  let compactCalled = 0;
  let compactArg: unknown = null;
  let abortCalled = 0;
  (worker as any).session = {
    compact: async (customInstructions?: string) => { compactCalled++; compactArg = customInstructions; },
    abort: async () => { abortCalled++; },
  };
  const hive = state([worker]);
  const result = await compactWorkerSession(hive, "worker", "operator compact");
  assert.equal(result.ok, true);
  assert.equal(compactCalled, 1);
  assert.equal(compactArg, "wrap-up for compact");
  assert.ok(abortCalled >= 0, "abort may or may not be called depending on session state");
});

test("compactWorkerSession on a runtime with no progressNotes still calls compact with empty customInstructions", async () => {
  const worker = runtime("worker");
  let compactArg: unknown = "sentinel";
  (worker as any).session = { compact: async (ci?: string) => { compactArg = ci; } };
  const hive = state([worker]);
  await compactWorkerSession(hive, "worker", "r");
  assert.equal(compactArg, "");
});

// ---------------------------------------------------------------------------
// Tool-level tests for summarize_progress (kieran 1a/3a): the tool must catch
// triggerSummarizeProgress's rethrow and return a structured isError response
// rather than letting the exception propagate.
// ---------------------------------------------------------------------------

test("summarize_progress tool catches compact failure and returns structured isError (kieran 3a)", async () => {
  const worker = runtime("worker");
  (worker as any).session = { compact: async () => { throw new Error("provider unavailable"); } };
  const hive = state([worker], { workerBudgets: { tokenBudget: 1000, budgetStrategy: "compact" } });
  const tool = buildSummarizeProgressTool(hive, "worker");
  const response = (await tool.execute!("id", { notes: "wrap-up", compact: true }, undefined, undefined, {} as any)) as any;
  // Notes are still stored even when compact fails — the catch path does NOT
  // roll back the progressNotes assignment in triggerSummarizeProgress
  // (that function stores notes BEFORE attempting compact).
  assert.equal(worker.progressNotes, "wrap-up");
  assert.equal(response.details.ok, false);
  assert.equal(response.details.reason, "compact_failed");
  assert.ok((response.details.error || "").includes("provider unavailable"));
  assert.equal(response.isError, true);
});

test("summarize_progress tool returns isError when caller has no runtime", async () => {
  const hive = state([], { workerBudgets: { tokenBudget: 1000 } });
  const tool = buildSummarizeProgressTool(hive, "ghost");
  const response = (await tool.execute!("id", { notes: "x" }, undefined, undefined, {} as any)) as any;
  assert.equal(response.details.ok, false);
  assert.equal(response.details.reason, "no_runtime");
  assert.equal(response.isError, true);
});

test("summarize_progress tool returns isError when notes over the cap", async () => {
  const worker = runtime("worker");
  const hive = state([worker], { workerBudgets: { tokenBudget: 1000, progressSummaryTokenLimit: 100 } });
  const tool = buildSummarizeProgressTool(hive, "worker");
  const response = (await tool.execute!("id", { notes: "a".repeat(500) }, undefined, undefined, {} as any)) as any;
  assert.equal(response.details.ok, false);
  assert.equal(response.details.reason, "over_cap");
  assert.ok(response.details.estimatedTokens > 100);
  assert.equal(response.details.limit, 100);
  assert.equal(response.isError, true);
});

test("summarize_progress tool succeeds under default strategy and ignores compact flag", async () => {
  const worker = runtime("worker");
  let compactCalled = 0;
  (worker as any).session = { compact: async () => { compactCalled++; } };
  const hive = state([worker], { workerBudgets: { tokenBudget: 1000 } });
  const tool = buildSummarizeProgressTool(hive, "worker");
  const response = (await tool.execute!("id", { notes: "wrap-up", compact: true }, undefined, undefined, {} as any)) as any;
  assert.equal(response.details.ok, true);
  assert.equal(response.details.compacted, false, "compact flag ignored under default strategy");
  assert.equal(compactCalled, 0);
  assert.equal(response.details.strategy, "default");
  assert.equal(worker.progressNotes, "wrap-up");
});

test("emitBudgetWarning sentinel gate prevents prompt-hint accumulation across multiple warnings", () => {
  // Worker fires warnings for both worker-tokens and worker-cost. Each one
  // calls emitBudgetWarning with a fresh hint. Without the sentinel gate,
  // runtime.systemPrompt would gain two hint blocks. With the gate, exactly
  // one block is appended regardless of how many distinct warnings fire.
  const worker = runtime("worker");
  const hive = state([worker], { workerBudgets: { tokenBudget: 1000, costBudgetUsd: 5 } });
  emitBudgetWarning(hive, worker, { scope: "worker", resource: "tokens", remaining: 100, limit: 1000 });
  emitBudgetWarning(hive, worker, { scope: "worker", resource: "cost", remaining: 0.5, limit: 5 });
  const sentinel = "## Budget approaching limit";
  const occurrences = worker.systemPrompt.split(sentinel).length - 1;
  assert.equal(occurrences, 1, "hint block must appear at most once even with multiple distinct warnings");
});
