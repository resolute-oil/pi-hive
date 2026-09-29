/**
 * T5.7 — `summarize_progress` tool tests.
 *
 * Coverage (7 tests; 2 preserved + 5 new):
 *   1. preserves: notes stored on state.progressNotes under default strategy.
 *   2. preserves: success result echoes the stored notes back to the caller.
 *   3. new: `compact: true` calls `session.sessionManager.appendCustomMessageEntry`.
 *   4. new: `no_runtime` returns isError when caller has no runtime entry.
 *   5. new: `over_cap` returns isError when notes exceed the 2000-token cap.
 *   6. new: `compact_failed` returns isError when `compact: true` under default strategy.
 *   7. new: ledger is updated with the `progress_notes` kind entry.
 *
 * All execute() invocations go through the tool directly (no SDK harness),
 * matching the project's existing custom-tool test pattern (see
 * `tests/summary-capture-tool.test.ts`). The SDK ignores `isError: true`
 * on the return value in production, but the legacy contract — and the
 * Wave 1D spec — require the field, so the tests assert on it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSummarizeProgressTool, type SummarizeProgressFailureReason } from "../src/agents/tools/summarize-progress.ts";
import type { AgentRuntime, AgentConfig, HiveState } from "../src/core/types.ts";
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

interface FakeSession {
  sessionManager: FakeSessionManager;
}

interface FakeRuntimeOpts {
  /** Per-runtime strategy override; defaults to undefined (= "default"). */
  budgetStrategy?: "default" | "compact";
}

function makeRuntime(_opts: FakeRuntimeOpts = {}): AgentRuntime {
  const sessionManager = makeFakeSessionManager();
  const session: FakeSession = { sessionManager };
  // Wave 5 / F9 — the legacy `WorkerGovernance.budgetStrategy` was removed
  // along with the rest of the legacy budget shape. `budgetStrategy` here
  // is accepted as a no-op so callers can keep the same fixture shape; the
  // tool now always resolves `"default"`.
  const config: AgentConfig = {
    name: "Test Worker",
    path: "/tmp/test-worker",
    slug: "test-worker",
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
      },
    } as unknown as HiveState["config"];
  }
  return state;
}

// Cast helper — the wave 0 contract does not yet expose `progressNotes` on
// HiveState. The tool installs it lazily via an internal cast; the tests
// read it back the same way.
function readProgressNotes(state: HiveState): Record<string, string> | undefined {
  return (state as unknown as { progressNotes?: Record<string, string> }).progressNotes;
}

const stubCtx = {} as unknown as ExtensionContext;
const CALLER = "test-worker";
const stubSignal = new AbortController().signal;

async function invoke(
  state: HiveState,
  ledger: BudgetLedger,
  args: { notes: string; compact?: boolean },
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
    stubSignal,
    undefined,
    stubCtx,
  );
}

// ---------------------------------------------------------------------------
// 1. preserved: notes stored on state.progressNotes under default strategy.
// ---------------------------------------------------------------------------

test("summarize_progress stores notes on state.progressNotes under default strategy", async () => {
  const state = makeState({ runtime: makeRuntime() });
  const ledger = makeFakeLedger();

  const result = await invoke(state, ledger, { notes: "wired up the ledger; tests green; next: dashboard" });

  assert.equal(result.isError, undefined, "success path has no isError flag");
  const notes = readProgressNotes(state);
  assert.ok(notes, "state.progressNotes is populated");
  assert.equal(notes?.[CALLER], "wired up the ledger; tests green; next: dashboard");
});

// ---------------------------------------------------------------------------
// 2. preserved: success result echoes the stored notes back to the caller.
// ---------------------------------------------------------------------------

test("summarize_progress returns a success result that names the caller and reports the cap", async () => {
  const state = makeState({ runtime: makeRuntime() });
  const ledger = makeFakeLedger();

  const notes = "implemented T5.7; cap validation works; next: wire to UI";
  const result = await invoke(state, ledger, { notes });

  assert.equal(result.isError, undefined, "no isError on the happy path");
  assert.equal(result.content.length, 1);
  assert.match(result.content[0].text, /summarize_progress: stored/);
  assert.match(result.content[0].text, new RegExp(CALLER));
  const details = result.details as {
    ok: boolean;
    caller: string;
    stored: boolean;
    estimatedTokens: number;
    limit: number;
  };
  assert.equal(details.ok, true);
  assert.equal(details.caller, CALLER);
  assert.equal(details.stored, true);
  assert.equal(details.limit, 2000);
  assert.equal(details.estimatedTokens, Math.ceil(notes.length / 4));
});

// ---------------------------------------------------------------------------
// 3. REMOVED per F9 — `compact: true` calls
//    `session.sessionManager.appendCustomMessageEntry`.
// ---------------------------------------------------------------------------
// The structured `compact` budget strategy (§2.13 C5) is deferred to v3.
// Wave 5 / F9 removed the legacy `governance.budgetStrategy` /
// `settings.workerBudgets.budgetStrategy` reads that this test depended on
// (see `resolveStrategy` in src/agents/tools/summarize-progress.ts which now
// always returns `"default"`). The compact path will be re-introduced with
// the structured strategy config; for now, `compact: true` always returns
// `isError: true` with `reason: "compact_failed"`, which the
// `summarize_progress({ compact: true }) under default strategy` test
// below pins.

// ---------------------------------------------------------------------------
// 4. new: `no_runtime` returns isError without crashing.
// ---------------------------------------------------------------------------

test("summarize_progress returns no_runtime isError when caller has no runtime entry", async () => {
  // State with an empty runtimes map — callerName "test-worker" is missing.
  const state = makeState();
  const ledger = makeFakeLedger();

  const result = await invoke(state, ledger, { notes: "should not be stored" });

  assert.equal(result.isError, true, "no_runtime surfaces as isError");
  const details = result.details as { ok: boolean; reason: SummarizeProgressFailureReason; caller: string };
  assert.equal(details.ok, false);
  assert.equal(details.reason, "no_runtime");
  assert.equal(details.caller, CALLER);
  assert.match(result.content[0].text, /no runtime/);
  // No notes were stored — the runtime lookup is the first guard.
  assert.equal(readProgressNotes(state)?.[CALLER], undefined);
});

// ---------------------------------------------------------------------------
// 5. new: `over_cap` returns isError when notes exceed the 2000-token cap.
// ---------------------------------------------------------------------------

test("summarize_progress returns over_cap isError when notes exceed the 2000-token cap", async () => {
  const state = makeState({ runtime: makeRuntime() });
  const ledger = makeFakeLedger();

  // 8001 chars ≈ 2001 tokens at 4 chars/token.
  const oversized = "x".repeat(8001);
  const result = await invoke(state, ledger, { notes: oversized });

  assert.equal(result.isError, true, "over_cap surfaces as isError");
  const details = result.details as {
    ok: boolean;
    reason: SummarizeProgressFailureReason;
    estimatedTokens: number;
    limit: number;
  };
  assert.equal(details.ok, false);
  assert.equal(details.reason, "over_cap");
  assert.equal(details.limit, 2000);
  assert.equal(details.estimatedTokens, Math.ceil(8001 / 4));
  assert.ok(details.estimatedTokens > details.limit, "estimated tokens exceed cap");
  assert.match(result.content[0].text, /exceed the 2000-token cap/);
  // Notes are NOT stored when the cap is exceeded.
  assert.equal(readProgressNotes(state)?.[CALLER], undefined);
  // No ledger write either.
  assert.equal(ledger.snapshotCalls.length, 0, "over_cap does not write a ledger entry");
});

// ---------------------------------------------------------------------------
// 6. C5: under default strategy, `compact: true` flag is silently ignored.
// ---------------------------------------------------------------------------

test("C5: summarize_progress silently ignores `compact: true` under default strategy (notes stored, no compact)", async () => {
  const state = makeState({ runtime: makeRuntime() }); // default strategy
  const ledger = makeFakeLedger();

  const result = await invoke(state, ledger, { notes: "wrap up; requested compact", compact: true });

  assert.equal(result.isError, undefined, "default strategy with compact: true returns success (silent ignore)");
  const details = result.details as {
    ok: boolean;
    reason?: SummarizeProgressFailureReason;
    compactRequested: boolean;
    compacted: boolean;
    strategy?: string;
  };
  assert.equal(details.ok, true);
  assert.equal(details.compactRequested, true);
  assert.equal(details.compacted, false, "default strategy does not trigger compact");
  assert.match(result.content[0].text, /compact flag ignored under "default" strategy/);
  // Notes were stored (the strategy check is downstream of the storage step).
  assert.equal(
    readProgressNotes(state)?.[CALLER],
    "wrap up; requested compact",
    "notes are stored even when compact: true is ignored",
  );
  // But appendCustomMessageEntry was NOT called — the default strategy does not honor compact.
  assert.equal(
    state.runtimes.get(CALLER)?.session.sessionManager.calls.length,
    0,
    "no appendCustomMessageEntry call under default strategy",
  );
  // Ledger still gets a progress_notes entry (notes were stored).
  assert.equal(ledger.snapshotCalls.length, 1, "ledger receives one progress_notes entry");
});

// ---------------------------------------------------------------------------
// 6b. C5: under compact strategy, `compact: true` actually triggers the compact.
// ---------------------------------------------------------------------------

test("C5: summarize_progress under compact strategy triggers appendCustomMessageEntry when compact: true", async () => {
  const state = makeState({ runtime: makeRuntime() });
  // Configure compact strategy (on-exhaustion.action === "compact").
  state.config = {
    orchestrator: { name: "Orchestrator", path: "/tmp/orchestrator" },
    agents: [],
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
  } as unknown as HiveState["config"];
  const ledger = makeFakeLedger();

  const result = await invoke(state, ledger, { notes: "compact now please", compact: true });

  assert.equal(result.isError, undefined, "compact strategy honors compact: true");
  const details = result.details as {
    ok: boolean;
    compactRequested: boolean;
    compacted: boolean;
    strategy?: string;
  };
  assert.equal(details.ok, true);
  assert.equal(details.compacted, true, "compact strategy triggers compact");
  assert.match(result.content[0].text, /compact honored/);
  // appendCustomMessageEntry was called exactly once.
  const sm = state.runtimes.get(CALLER)?.session.sessionManager as FakeSessionManager;
  assert.equal(sm.calls.length, 1, "appendCustomMessageEntry called once under compact strategy");
  assert.equal(sm.calls[0].customType, "progress_note");
  assert.equal(sm.calls[0].content, "compact now please");
  // Ledger also gets a progress_notes entry.
  assert.equal(ledger.snapshotCalls.length, 1, "ledger receives one progress_notes entry");
});

// ---------------------------------------------------------------------------
// 7. new: ledger is updated with the `progress_notes` kind entry.
// ---------------------------------------------------------------------------

test("summarize_progress writes a progress_notes kind entry to the ledger on success", async () => {
  const state = makeState({ runtime: makeRuntime() });
  const ledger = makeFakeLedger();

  const result = await invoke(state, ledger, { notes: "ready for review" });

  assert.equal(result.isError, undefined, "happy path produces no isError");
  assert.equal(ledger.snapshotCalls.length, 1, "exactly one ledger snapshot call");
  const call = ledger.snapshotCalls[0];
  assert.equal(call.kind, "progress_notes", "ledger entry is tagged with progress_notes kind");
  // The stub throws via the snapshot method; the cast inside the tool
  // admits "progress_notes" beyond the typed BudgetLedgerKind union.
  assert.equal(call.signal, stubSignal, "ledger write threads the abort signal");
});
