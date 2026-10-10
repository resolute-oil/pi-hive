/**
 * T5.7 — `summarize_progress` tool tests.
 *
 * Coverage (7 tests; 2 preserved + 5 new per the Wave 1D brief):
 *   Cycle 1 (2 preserved)
 *     1. notes-only: tool returns success and stores notes for operator follow-up
 *     2. notes + compact: under "compact" strategy, calls sessionManager.appendCustomMessageEntry
 *   Cycle 2 (1 new)
 *     3. no_runtime: tool returns isError when caller has no entry in state.runtimes
 *   Cycle 3 (1 new)
 *     4. over_cap: tool returns isError when estimated tokens exceed the cap
 *   Cycle 4 (1 new)
 *     5. compact_failed: tool returns isError when compact:true under default strategy
 *   Cycle 5 (1 new)
 *     6. signature shape: tool result carries {content, details, isError?, code?}
 *   Cycle 6 (1 new)
 *     7. signal propagation: aborted controller prevents appendCustomMessageEntry
 *
 * All execute() invocations go through the tool directly (no SDK harness),
 * matching the project's existing custom-tool test pattern (see
 * `tests/summary-capture-tool.test.ts`). The SDK ignores `isError: true` on
 * the return value in production, but the legacy contract — and the
 * Wave 1D spec — require the field, so the tests assert on it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSummarizeProgressTool } from "../src/agents/tools/summarize-progress.ts";
import type { AgentRuntime, AgentConfig, HiveState, WorkerGovernance } from "../src/core/types.ts";
import type { BudgetLedger } from "../src/engine/budget/ledger.ts";

// ---------------------------------------------------------------------------
// Stubs / fixtures.
// ---------------------------------------------------------------------------

interface FakeSessionManager {
  appendCustomMessageEntry: (
    customType: string,
    content: string,
    display: boolean,
    details?: unknown,
  ) => string;
  calls: Array<{ customType: string; content: string; display: boolean; details?: unknown }>;
}

function makeFakeSessionManager(): FakeSessionManager {
  const calls: FakeSessionManager["calls"] = [];
  return {
    calls,
    appendCustomMessageEntry(customType, content, display, details) {
      calls.push({ customType, content, display, details });
      return `entry-${calls.length}`;
    },
  };
}

interface FakeRuntimeOpts {
  /** Per-runtime strategy override; defaults to undefined (= "default"). */
  budgetStrategy?: "default" | "compact";
}

function makeRuntime(opts: FakeRuntimeOpts = {}): AgentRuntime {
  const sessionManager = makeFakeSessionManager();
  // AgentSession grew to a 200+-property object across pi-coding-agent
  // versions; the test only needs sessionManager. Cast through unknown
  // (mirrors the governance cast below) so the type-checker accepts the
  // stub without enumerating the full surface.
  const session = { sessionManager } as unknown as AgentSession;
  const governance: WorkerGovernance | undefined = opts.budgetStrategy
    ? ({ budgetStrategy: opts.budgetStrategy } as unknown as WorkerGovernance)
    : undefined;
  const config: AgentConfig = {
    name: "Test Worker",
    path: "/tmp/test-worker",
    slug: "test-worker",
    ...(governance ? { governance } : {}),
  };
  return {
    config,
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
    session,
  };
}

interface FakeLedgerOpts {
  /** What `snapshot(...)` should throw; defaults to "not implemented" stub style. */
  throwOnSnapshot?: Error;
}

function makeFakeLedger(opts: FakeLedgerOpts = {}): BudgetLedger & {
  snapshotCalls: Array<{ stats: unknown; policy: unknown; kind: string; signal?: AbortSignal }>;
} {
  const snapshotCalls: Array<{ stats: unknown; policy: unknown; kind: string; signal?: AbortSignal }> = [];
  const ledger = {
    snapshotCalls,
    snapshot(stats: unknown, policy: unknown, kind: string, signal?: AbortSignal) {
      if (opts.throwOnSnapshot) throw opts.throwOnSnapshot;
      snapshotCalls.push({ stats, policy, kind, signal });
    },
  } as unknown as BudgetLedger & { snapshotCalls: typeof snapshotCalls };
  return ledger;
}

function stubPi(): ExtensionAPI {
  return {} as unknown as ExtensionAPI;
}

function makeState(opts: { runtime?: AgentRuntime; budgetStrategy?: "default" | "compact" } = {}): HiveState {
  const state: HiveState = {
    pi: stubPi(),
    config: null,
    session: null,
    runtimes: new Map(),
    widgetCtx: null,
    activeRuns: 0,
    mode: "hive",
    normalToolNames: [],
    sddStatus: null,
    obsSeq: 0,
  };
  if (opts.runtime) {
    state.runtimes.set("test-worker", opts.runtime);
  }
  if (opts.budgetStrategy) {
    state.config = {
      orchestrator: { name: "Orchestrator", path: "/tmp/orchestrator" },
      agents: [],
      sharedContext: [],
      settings: {
        subagentOutputLimit: 12000,
        defaultTools: "",
        distiller: { enabled: false, model: "test-model", conversationLines: 100 },
        workerBudgets: { budgetStrategy: opts.budgetStrategy } as unknown as WorkerGovernance,
      },
    } as unknown as HiveState["config"];
  }
  return state;
}

const stubCtx = {} as unknown as ExtensionContext;
const CALLER = "test-worker";

async function invoke(
  state: HiveState,
  ledger: BudgetLedger,
  args: { notes: string; compact?: boolean },
  signal: AbortSignal | undefined = new AbortController().signal,
) {
  const tool = buildSummarizeProgressTool(state, CALLER, ledger);
  return (tool.execute as (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown; isError?: boolean }>)(
    "call-id",
    args,
    signal,
    undefined,
    stubCtx,
  );
}

// ---------------------------------------------------------------------------
// Cycle 1 (preserved): notes-only happy path.
// ---------------------------------------------------------------------------

test("summarize_progress({ notes }) returns success and stores notes on the worker", async () => {
  const state = makeState({ runtime: makeRuntime() });
  const ledger = makeFakeLedger();

  const result = await invoke(state, ledger, { notes: "wired up the ledger; tests green; next: dashboard" });

  assert.equal(result.isError, undefined, "happy path has no isError flag");
  assert.ok(Array.isArray(result.content) && result.content.length > 0, "returns content");
  assert.match(result.content[0].text, /summarize_progress/);
});

// ---------------------------------------------------------------------------
// Cycle 1 (preserved): notes + compact → sessionManager.appendCustomMessageEntry
// under the "compact" strategy.
// ---------------------------------------------------------------------------

test("summarize_progress({ notes, compact: true }) under compact strategy calls sessionManager.appendCustomMessageEntry", async () => {
  const runtime = makeRuntime({ budgetStrategy: "compact" });
  const state = makeState({ runtime });
  const ledger = makeFakeLedger();

  const notes = "wrap-up summary; injected via appendCustomMessageEntry";
  const result = await invoke(state, ledger, { notes, compact: true });

  assert.equal(result.isError, undefined, "compact strategy honors the flag");
  const calls = (runtime.session!.sessionManager as unknown as FakeSessionManager).calls;
  assert.equal(calls.length, 1, "exactly one appendCustomMessageEntry call");
  assert.equal(calls[0].customType, "progress_note");
  assert.equal(calls[0].content, notes);
  assert.equal(calls[0].display, false, "hidden from TUI");
});

// ---------------------------------------------------------------------------
// Cycle 2 (no_runtime): caller has no entry in state.runtimes.
// ---------------------------------------------------------------------------

test("summarize_progress returns no_runtime isError when caller has no runtime entry", async () => {
  const state = makeState();
  const ledger = makeFakeLedger();

  const result = await invoke(state, ledger, { notes: "should not be stored" });

  assert.equal(result.isError, true, "no_runtime surfaces as isError");
  const details = result.details as { ok: boolean; reason: string; caller: string };
  assert.equal(details.ok, false);
  assert.equal(details.reason, "no_runtime");
  assert.equal(details.caller, CALLER);
  assert.match(result.content[0].text, /no runtime/);
});

// ---------------------------------------------------------------------------
// Cycle 3 (over_cap): estimated tokens exceed the cap.
// ---------------------------------------------------------------------------

test("summarize_progress returns over_cap isError when notes exceed the 2000-token cap", async () => {
  const state = makeState({ runtime: makeRuntime() });
  const ledger = makeFakeLedger();

  // 8001 chars ≈ 2001 tokens at 4 chars/token.
  const oversized = "x".repeat(8001);
  const result = await invoke(state, ledger, { notes: oversized });

  assert.equal(result.isError, true, "over_cap surfaces as isError");
  const details = result.details as { ok: boolean; reason: string; estimatedTokens: number; limit: number };
  assert.equal(details.ok, false);
  assert.equal(details.reason, "over_cap");
  assert.equal(details.limit, 2000);
  assert.equal(details.estimatedTokens, Math.ceil(8001 / 4));
  assert.match(result.content[0].text, /exceed the 2000-token cap/);
});

// ---------------------------------------------------------------------------
// Cycle 4 (compact_failed): compact:true under default strategy.
// ---------------------------------------------------------------------------

test("summarize_progress returns compact_failed isError under default strategy when compact is requested", async () => {
  const state = makeState({ runtime: makeRuntime() });
  const ledger = makeFakeLedger();

  const result = await invoke(state, ledger, { notes: "wrap up; request compact", compact: true });

  assert.equal(result.isError, true, "compact_failed surfaces as isError");
  const details = result.details as { ok: boolean; reason: string; strategy: string; compactRequested: boolean };
  assert.equal(details.ok, false);
  assert.equal(details.reason, "compact_failed");
  assert.equal(details.strategy, "default");
  assert.equal(details.compactRequested, true);
  assert.match(result.content[0].text, /under "default" strategy/);
  // Under non-compact strategy, appendCustomMessageEntry must NOT be called.
  const runtime = state.runtimes.get(CALLER);
  assert.equal(
    (runtime!.session!.sessionManager as unknown as FakeSessionManager).calls.length,
    0,
    "no appendCustomMessageEntry under default strategy",
  );
});

// ---------------------------------------------------------------------------
// Cycle 5 (signature shape): every result carries content + details, error
// results carry isError + a code in {"no_runtime", "over_cap", "compact_failed"}.
// ---------------------------------------------------------------------------

test("summarize_progress result shape is { content, details, isError?, code? } with the documented failure codes", async () => {
  const state1 = makeState(); // no_runtime path
  const ledger1 = makeFakeLedger();
  const noRuntime = await invoke(state1, ledger1, { notes: "x" });
  const noRuntimeDetails = noRuntime.details as { reason?: string; code?: string };
  assert.ok(Array.isArray(noRuntime.content) && noRuntime.content.length > 0, "content array present");
  assert.equal(noRuntime.content[0].type, "text");
  assert.equal(typeof noRuntime.content[0].text, "string");
  assert.equal(noRuntime.isError, true);
  const noRuntimeCode = noRuntimeDetails.code ?? noRuntimeDetails.reason;
  assert.equal(noRuntimeCode, "no_runtime", "no_runtime surfaces as the documented code");

  const state2 = makeState({ runtime: makeRuntime() });
  const ledger2 = makeFakeLedger();
  const overCap = await invoke(state2, ledger2, { notes: "x".repeat(8001) });
  const overCapDetails = overCap.details as { reason?: string; code?: string };
  assert.equal(overCap.isError, true);
  assert.equal(overCapDetails.code ?? overCapDetails.reason, "over_cap");

  const state3 = makeState({ runtime: makeRuntime() });
  const ledger3 = makeFakeLedger();
  const compactFailed = await invoke(state3, ledger3, { notes: "wrap up", compact: true });
  const compactFailedDetails = compactFailed.details as { reason?: string; code?: string };
  assert.equal(compactFailed.isError, true);
  assert.equal(compactFailedDetails.code ?? compactFailedDetails.reason, "compact_failed");

  // Happy path: no isError, no code.
  const state4 = makeState({ runtime: makeRuntime() });
  const ledger4 = makeFakeLedger();
  const ok = await invoke(state4, ledger4, { notes: "fine" });
  assert.equal(ok.isError, undefined, "happy path omits isError");
  const okDetails = ok.details as { reason?: string; code?: string };
  assert.equal(okDetails.reason, undefined, "happy path omits reason");
  assert.equal(okDetails.code, undefined, "happy path omits code");
});

// ---------------------------------------------------------------------------
// Cycle 6 (signal propagation): aborted controller skips appendCustomMessageEntry.
// ---------------------------------------------------------------------------

test("summarize_progress does not call appendCustomMessageEntry when the abort signal is already aborted", async () => {
  const runtime = makeRuntime({ budgetStrategy: "compact" });
  const state = makeState({ runtime });
  const ledger = makeFakeLedger();

  const controller = new AbortController();
  controller.abort();

  await invoke(state, ledger, { notes: "should not be written", compact: true }, controller.signal);

  const calls = (runtime.session!.sessionManager as unknown as FakeSessionManager).calls;
  assert.equal(calls.length, 0, "aborted signal prevents appendCustomMessageEntry");
});
