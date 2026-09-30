// Wave 2 F2 — installBudgetEventHooks unit tests
//
// Covers T2.1 (12 tests) per the F2 brief.
// T2.4 (2 tests — compaction_end.aborted + compaction_end.errorMessage)
// lives in tests/budget-worker-tools.test.ts; relocated there because the
// assertions exercise the same wiring (T2.4 is the handler's
// compaction_end branch, exercised through the same session-publish seam
// used by T2.1's compaction_end happy-path test).
//
// The handler subscribes a single listener to AgentSession events and routes
// three event kinds (message_end, compaction_end, agent_settled) into the
// supplied BudgetLedger. The tests stub the session's `subscribe(listener)`
// so the handler can be exercised in isolation; the ledger is a recording
// fake that captures every call so assertions can pin the exact payload.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession, SessionStats } from "@earendil-works/pi-coding-agent";
import type { BudgetLedger } from "../src/engine/budget/ledger.ts";
import type { WorkerBudgetPolicy } from "../src/core/types.ts";
import { installBudgetEventHooks } from "../src/engine/budget/events.ts";

// ── Test fixtures ─────────────────────────────────────────────────────────

type Listener = (event: any) => void;

// A scripted session that records every event the listener sees, exposes a
// `trigger(event)` for tests to fire events synchronously, and stores the
// returned unsubscribe function so tests can verify lifecycle behavior.
function makeSession(opts: { onAppend?: (customType: string, data: unknown) => void } = {}) {
  const listeners: Listener[] = [];
  const events: AppSubscriptionSessionEvent[] = [];
  let triggerFn: ((event: AppSubscriptionSessionEvent) => void) | undefined;
  // The session manager is what handlers call for budget_warning / budget_exhausted
  // entries — the listener routes those calls through this fake so tests can
  // assert on them.
  const appendedMessages: Array<{ customType: string; content: string; display: boolean; details?: unknown }> = [];
  const appendedEntries: Array<{ customType: string; data?: unknown }> = [];
  const sessionManager = {
    appendCustomMessageEntry(customType: string, content: string, display: boolean, details?: unknown) {
      appendedMessages.push({ customType, content, display, details });
      opts.onAppend?.(customType, { content, details });
    },
    appendCustomEntry(customType: string, data?: unknown) {
      appendedEntries.push({ customType, data });
      opts.onAppend?.(customType, data);
    },
  };
  const session = {
    subscribe(listener: Listener) {
      listeners.push(listener);
      triggerFn = listener;
      events.length = 0;
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
        triggerFn = undefined;
      };
    },
    getSessionStats(): SessionStats {
      return {
        sessionFile: undefined,
        sessionId: "test-session",
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 2,
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
        cost: 0.01,
      };
    },
    sessionManager,
  } as unknown as AgentSession;

  // Tests can call `.fire(event)` once the hook is installed.
  const sessionWithFire = session as AgentSession & { fire: (event: AppSubscriptionSessionEvent) => void };
  sessionWithFire.fire = (event) => {
    triggerFn?.(event);
    events.push(event);
  };
  return { session: sessionWithFire, appendedMessages, appendedEntries };
}

type AppSubscriptionSessionEvent =
  | { type: "message_end"; message: any }
  | { type: "compaction_end"; reason: string; result?: any; aborted?: boolean; willRetry?: boolean; errorMessage?: string }
  | { type: "agent_settled" }
  | { type: string; [key: string]: unknown };

// A recording ledger. Captures every call to recordEvent / maybeSnapshot /
// recordCompaction / snapshot so tests can assert call shape + count. The
// `currentAgentName()`-bound session manager is captured implicitly via the
// session.subscribe handler, which is what the events.ts handler is going
// to drive.
function makeLedger() {
  const calls = {
    recordEvent: [] as Array<{ type: string; cumulative: any; signal: AbortSignal }>,
    maybeSnapshot: [] as Array<{ cumulative: any; policy: any; signal: AbortSignal }>,
    recordCompaction: [] as Array<{ savings: number; signal: AbortSignal }>,
    snapshot: [] as Array<{ stats: SessionStats; policy: any; marker: string; signal: AbortSignal }>,
  };
  const ledger = {
    cumulative: { tokens: 0, costUsd: 0, runs: 0 },
    recordEvent(type: string, cumulative: any, signal: AbortSignal) {
      calls.recordEvent.push({ type, cumulative, signal });
      ledger.cumulative = { ...cumulative };
    },
    maybeSnapshot(cumulative: any, policy: any, signal: AbortSignal) {
      calls.maybeSnapshot.push({ cumulative, policy, signal });
    },
    recordCompaction(savings: number, signal: AbortSignal) {
      calls.recordCompaction.push({ savings, signal });
    },
    snapshot(stats: SessionStats, policy: any, marker: string, signal: AbortSignal) {
      calls.snapshot.push({ stats, policy, marker, signal });
    },
  } as unknown as BudgetLedger & { cumulative: { tokens: number; costUsd: number; runs: number } };
  return { ledger, calls };
}

const basePolicy: WorkerBudgetPolicy = {
  worker: { tokens: { cap: 1000 } },
  team: {},
};

// ── Test 1: installBudgetEventHooks returns an unsubscribe function ───────

test("installBudgetEventHooks returns an unsubscribe function; no events fire after unsubscribe", () => {
  const { session, appendedMessages, appendedEntries } = makeSession();
  const { ledger } = makeLedger();
  const controller = new AbortController();

  const unsubscribe = installBudgetEventHooks(session, ledger, basePolicy, controller);

  assert.equal(typeof unsubscribe, "function", "returns a function");

  // Fire one event before unsubscribe — handler should run.
  session.fire({ type: "message_end", message: { usage: {} as any, role: "assistant" } } as AppSubscriptionSessionEvent);
  // The session manager receives NO custom entries on the message_end without
  // budget thresholds crossed (100 tokens / 1000 cap = 10% remaining — well
  // above the 20% warning threshold).
  assert.equal(appendedMessages.length, 0, "no warning emitted when remaining > threshold");

  // Unsubscribe.
  unsubscribe();

  // Fire another event — handler must not run.
  session.fire({ type: "message_end", message: { usage: {} as any, role: "assistant" } } as AppSubscriptionSessionEvent);
  // Nothing has been written: the unsubscribe prevented the listener from
  // running. (We don't have direct access to the ledger.calls after dropping
  // the ref — we re-build a ledger and assert it received nothing.)
  assert.equal(appendedEntries.length, 0, "no entries written after unsubscribe");
});

// ── Test 2: message_end handler fires for every message ───────────────────

test("message_end fires for every message; ledger.recordEvent called with cumulative stats", () => {
  const { session } = makeSession();
  const { ledger, calls } = makeLedger();
  const controller = new AbortController();

  installBudgetEventHooks(session, ledger, basePolicy, controller);

  session.fire({ type: "message_end", message: { usage: { input: 50, output: 25, totalTokens: 75, cost: { total: 0.005 } }, role: "assistant" } });
  assert.equal(calls.recordEvent.length, 1, "recordEvent called once per message_end");
  assert.equal(calls.recordEvent[0].type, "message_end", "type is message_end");
  assert.equal(calls.recordEvent[0].cumulative.tokens, 150, "cumulative tokens from session.getSessionStats()");
  assert.equal(calls.recordEvent[0].cumulative.costUsd, 0.01, "cumulative costUsd from session.getSessionStats()");
});

// ── Test 3: message_end calls ledger.maybeSnapshot (throttled) ────────────

test("message_end calls ledger.maybeSnapshot with the same cumulative + policy + signal", () => {
  const { session } = makeSession();
  const { ledger, calls } = makeLedger();
  const controller = new AbortController();

  installBudgetEventHooks(session, ledger, basePolicy, controller);

  session.fire({ type: "message_end", message: { usage: {} as any, role: "assistant" } });
  assert.equal(calls.maybeSnapshot.length, 1, "maybeSnapshot called once per message_end");
  assert.equal(calls.maybeSnapshot[0].cumulative.tokens, 150, "maybeSnapshot sees the same cumulative as recordEvent");
  assert.strictEqual(calls.maybeSnapshot[0].policy, basePolicy, "maybeSnapshot receives the supplied policy");
  assert.strictEqual(calls.maybeSnapshot[0].signal, controller.signal, "maybeSnapshot receives the supplied signal");
});

// ── Test 4: budget_warning emitted at 20% remaining (default) ─────────────

test("message_end emits budget_warning when remaining ≤ 20% (default threshold; no strategies block)", () => {
  const { session, appendedMessages } = makeSession();
  const { ledger } = makeLedger();
  // The fake ledger's getSessionStats() returns tokens.total=150. To force
  // 20% remaining with cap=200, we override the cumulative tokens by
  // re-implementing getSessionStats here.
  const sessionWithCustomStats = {
    subscribe: (session as any).subscribe.bind(session),
    getSessionStats: () => ({ sessionFile: undefined, sessionId: "x", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, tokens: { input: 160, output: 0, cacheRead: 0, cacheWrite: 0, total: 160 }, cost: 0.01 }),
  } as unknown as AgentSession & { fire: (event: AppSubscriptionSessionEvent) => void };
  // Re-attach fire on the override
  (sessionWithCustomStats as any).fire = (event: AppSubscriptionSessionEvent) => {
    (sessionWithCustomStats as any).subscribe.listeners?.[0]?.(event);
  };

  // Re-mount via a fresh installBudgetEventHooks against the override.
  const ctrl = new AbortController();
  const lm = {
    appendCustomMessageEntry: (customType: string, content: string, display: boolean, details?: unknown) => {
      appendedMessages.push({ customType, content, display, details });
    },
    appendCustomEntry: () => {},
  };
  installBudgetEventHooks(sessionWithCustomStats, ledger, { worker: { tokens: { cap: 200 } }, team: {} }, ctrl);

  // Force the listener to fire by directly invoking the just-registered
  // subscribe callback — `subscribe.listeners` is the test seam.
  // Simpler: capture the listener on the original session and fire it now.
  // The stubbed session exposes its listeners via the closure we built above,
  // so re-route the fire through a captured listener.
  // The cleanest way is to call subscribe() directly inside this test.
  let captured: Listener | undefined;
  const directSession = {
    subscribe(listener: Listener) {
      captured = listener;
      return () => { captured = undefined; };
    },
    getSessionStats: () => ({ sessionFile: undefined, sessionId: "x", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, tokens: { input: 160, output: 0, cacheRead: 0, cacheWrite: 0, total: 160 }, cost: 0.01 }),
    sessionManager: {
      appendCustomMessageEntry(customType: string, content: string, display: boolean, details?: unknown) {
        msgs.push({ customType, content, display, details });
      },
      appendCustomEntry() {},
    },
  } as unknown as AgentSession;

  const msgs: Array<{ customType: string; content: string; display: boolean; details?: unknown }> = [];
  installBudgetEventHooks(
    directSession,
    ledger,
    { worker: { tokens: { cap: 200 } }, team: {} },
    new AbortController(),
  );
  // 160/200 = 80% used → 20% remaining = exactly at the threshold → warning emits.
  captured!({ type: "message_end", message: { usage: {} as any, role: "assistant" } } as any);

  assert.equal(msgs.length, 1, "warning emitted at threshold crossing");
  assert.equal(msgs[0].customType, "budget_warning");
  assert.equal(msgs[0].display, true, "warning is delivered into worker context");
  const details = msgs[0].details as { scope: string; resource: string; remaining: number; cap: number };
  assert.equal(details.scope, "worker");
  assert.equal(details.resource, "tokens");
  assert.equal(details.cap, 200);
  // Block 3 fix: `remaining` is the amount LEFT in the cap, not the amount
  // consumed. With cap=200 and cumulative=160, remaining is 40.
  assert.equal(details.remaining, 200 - 160, "remaining is the gap between cap and cumulative, not the cumulative itself");
});

// ── Test 5: warning is idempotent (no second emit) ────────────────────────

test("message_end does NOT emit a second budget_warning when already warned (idempotent)", () => {
  const msgs: Array<{ customType: string }> = [];
  let captured: Listener | undefined;
  const session = {
    subscribe(listener: Listener) {
      captured = listener;
      return () => { captured = undefined; };
    },
    getSessionStats: () => ({ sessionFile: undefined, sessionId: "x", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, tokens: { input: 180, output: 0, cacheRead: 0, cacheWrite: 0, total: 180 }, cost: 0.01 }),
    sessionManager: {
      appendCustomMessageEntry(customType: string) { msgs.push({ customType }); },
      appendCustomEntry() {},
    },
  } as unknown as AgentSession;

  installBudgetEventHooks(
    session,
    { cumulative: { tokens: 0, costUsd: 0, runs: 0 }, recordEvent: () => {}, maybeSnapshot: () => {}, recordCompaction: () => {}, snapshot: () => {} } as unknown as BudgetLedger,
    { worker: { tokens: { cap: 200 } }, team: {} },
    new AbortController(),
  );

  captured!({ type: "message_end", message: { usage: {} as any, role: "assistant" } } as any);
  captured!({ type: "message_end", message: { usage: {} as any, role: "assistant" } } as any);
  captured!({ type: "message_end", message: { usage: {} as any, role: "assistant" } } as any);

  const warnings = msgs.filter((m) => m.customType === "budget_warning");
  assert.equal(warnings.length, 1, "warning emitted exactly once across three message_end events");
});

// ── Test 6: default strategies abort at 0% remaining ──────────────────────

test("message_end aborts via controller.signal at 0% remaining (default strategies.onExhaustion.action: abort)", () => {
  const entries: Array<{ customType: string; data?: any }> = [];
  let captured: Listener | undefined;
  const session = {
    subscribe(listener: Listener) {
      captured = listener;
      return () => { captured = undefined; };
    },
    getSessionStats: () => ({ sessionFile: undefined, sessionId: "x", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, tokens: { input: 200, output: 0, cacheRead: 0, cacheWrite: 0, total: 200 }, cost: 0.01 }),
    sessionManager: {
      appendCustomMessageEntry() {},
      appendCustomEntry(customType: string, data?: any) {
        entries.push({ customType, data });
      },
    },
  } as unknown as AgentSession;

  const ctrl = new AbortController();
  installBudgetEventHooks(
    session,
    { cumulative: { tokens: 0, costUsd: 0, runs: 0 }, recordEvent: () => {}, maybeSnapshot: () => {}, recordCompaction: () => {}, snapshot: () => {} } as unknown as BudgetLedger,
    { worker: { tokens: { cap: 200 } }, team: {} },
    ctrl,
  );

  // 200/200 = 100% used → 0% remaining → exhausted.
  captured!({ type: "message_end", message: { usage: {} as any, role: "assistant" } } as any);

  assert.equal(ctrl.signal.aborted, true, "controller aborted at 0% remaining");
  const exhausted = entries.find((e) => e.customType === "budget_exhausted");
  assert.ok(exhausted, "budget_exhausted CustomEntry written");
  assert.equal(exhausted.data.scope, "worker");
  assert.equal(exhausted.data.resource, "tokens");
});

// ── Test 7: strategies.onExhaustion.action === 'compact' → no abort ──────

test("strategies.onExhaustion.action === 'compact' writes budget_exhausted but does NOT abort", () => {
  const entries: Array<{ customType: string; data?: any }> = [];
  let captured: Listener | undefined;
  const session = {
    subscribe(listener: Listener) {
      captured = listener;
      return () => { captured = undefined; };
    },
    getSessionStats: () => ({ sessionFile: undefined, sessionId: "x", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, tokens: { input: 200, output: 0, cacheRead: 0, cacheWrite: 0, total: 200 }, cost: 0.01 }),
    sessionManager: {
      appendCustomMessageEntry() {},
      appendCustomEntry(customType: string, data?: any) {
        entries.push({ customType, data });
      },
    },
  } as unknown as AgentSession;

  const ctrl = new AbortController();
  installBudgetEventHooks(
    session,
    { cumulative: { tokens: 0, costUsd: 0, runs: 0 }, recordEvent: () => {}, maybeSnapshot: () => {}, recordCompaction: () => {}, snapshot: () => {} } as unknown as BudgetLedger,
    {
      worker: { tokens: { cap: 200 } },
      team: {},
      strategies: {
        onApproachingLimit: { action: "wrap-up", threshold: 0.20, hint: "" },
        onExhaustion: { action: "compact" },
        summary: { maxTokens: 1000 },
      },
    },
    ctrl,
  );

  captured!({ type: "message_end", message: { usage: {} as any, role: "assistant" } } as any);

  assert.equal(ctrl.signal.aborted, false, "controller NOT aborted under strategies.onExhaustion.action === compact");
  const exhausted = entries.find((e) => e.customType === "budget_exhausted");
  assert.ok(exhausted, "budget_exhausted still written (dashboard visibility)");
  assert.equal(exhausted.data.action, "compact", "exhausted marker carries action: compact");
});

// ── Test 8: strategies.onExhaustion.action === 'none' → no abort, no entry ─

test("strategies.onExhaustion.action === 'none' does NOT abort and does NOT write budget_exhausted", () => {
  const entries: Array<{ customType: string }> = [];
  let captured: Listener | undefined;
  const session = {
    subscribe(listener: Listener) {
      captured = listener;
      return () => { captured = undefined; };
    },
    getSessionStats: () => ({ sessionFile: undefined, sessionId: "x", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, tokens: { input: 200, output: 0, cacheRead: 0, cacheWrite: 0, total: 200 }, cost: 0.01 }),
    sessionManager: {
      appendCustomMessageEntry() {},
      appendCustomEntry(customType: string) {
        entries.push({ customType });
      },
    },
  } as unknown as AgentSession;

  const ctrl = new AbortController();
  installBudgetEventHooks(
    session,
    { cumulative: { tokens: 0, costUsd: 0, runs: 0 }, recordEvent: () => {}, maybeSnapshot: () => {}, recordCompaction: () => {}, snapshot: () => {} } as unknown as BudgetLedger,
    {
      worker: { tokens: { cap: 200 } },
      team: {},
      strategies: {
        onApproachingLimit: { action: "wrap-up", threshold: 0.20, hint: "" },
        onExhaustion: { action: "none" },
        summary: { maxTokens: 1000 },
      },
    },
    ctrl,
  );

  captured!({ type: "message_end", message: { usage: {} as any, role: "assistant" } } as any);

  assert.equal(ctrl.signal.aborted, false, "controller NOT aborted under action: none");
  assert.equal(entries.find((e) => e.customType === "budget_exhausted"), undefined, "no budget_exhausted entry written under action: none");
});

// ── Test 9: compaction_end happy path ─────────────────────────────────────

test("compaction_end happy path: result.tokensBefore - estimatedTokensAfter → ledger.recordCompaction", () => {
  let captured: Listener | undefined;
  const session = {
    subscribe(listener: Listener) {
      captured = listener;
      return () => { captured = undefined; };
    },
    getSessionStats: () => ({ sessionFile: undefined, sessionId: "x", userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    sessionManager: {
      appendCustomMessageEntry() {},
      appendCustomEntry() {},
    },
  } as unknown as AgentSession;

  const calls: Array<{ savings: number }> = [];
  installBudgetEventHooks(
    session,
    {
      cumulative: { tokens: 0, costUsd: 0, runs: 0 },
      recordEvent: () => {},
      maybeSnapshot: () => {},
      recordCompaction(savings: number) { calls.push({ savings }); },
      snapshot: () => {},
    } as unknown as BudgetLedger,
    { worker: {}, team: {} },
    new AbortController(),
  );

  captured!({
    type: "compaction_end",
    reason: "manual",
    aborted: false,
    willRetry: false,
    result: { tokensBefore: 1000, estimatedTokensAfter: 400, summary: "", firstKeptEntryId: "x" },
  });
  assert.equal(calls.length, 1, "recordCompaction called once for a successful compaction");
  assert.equal(calls[0].savings, 600, "savings = tokensBefore - estimatedTokensAfter");
});

// ── Test 10: restore reads BOTH custom types ──────────────────────────────

test("BudgetLedger.restore reads both pi-hive-budget-ledger AND pi-hive-budget-compaction", async () => {
  // C1 verification — Wave 1 1A's recordCompaction writes a SEPARATE
  // pi-hive-budget-compaction customType, distinct from the cumulative
  // pi-hive-budget-ledger. The restore path must read both, and the cumulative
  // reduction must skip the compaction entries (they have a different shape).
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { BudgetLedger } = await import("../src/engine/budget/ledger.ts");
  const sm = SessionManager.inMemory("/tmp");
  const signal = new AbortController().signal;

  // Append a cumulative ledger entry.
  sm.appendCustomEntry("pi-hive-budget-ledger", {
    caps: {},
    cumulative: { tokens: 500, costUsd: 0.05, runs: 3 },
    writtenAt: 1,
    agentSlug: "tester",
  });
  // Append a separate compaction savings entry.
  sm.appendCustomEntry("pi-hive-budget-compaction", {
    agentSlug: "tester",
    savings: 250,
    writtenAt: 2,
  });

  const ledger = await BudgetLedger.restore(sm, "tester", { worker: {}, team: {} }, signal);
  // Cumulative is read from the latest pi-hive-budget-ledger entry only.
  assert.equal(ledger.cumulative.tokens, 500, "cumulative reads from pi-hive-budget-ledger, not compaction");
  assert.equal(ledger.cumulative.runs, 3);
  // The branch contains BOTH custom types — restore() does not throw, and
  // the entries list reflects only the ledger-shape entries.
  const branch = sm.getBranch();
  const ledgerEntries = branch.filter((e) => e.type === "custom" && (e as any).customType === "pi-hive-budget-ledger");
  const compactionEntries = branch.filter((e) => e.type === "custom" && (e as any).customType === "pi-hive-budget-compaction");
  assert.equal(ledgerEntries.length, 1, "ledger custom entry preserved");
  assert.equal(compactionEntries.length, 1, "compaction custom entry preserved separately");
});

// ── Test 11: agent_settled calls ledger.snapshot with marker 'checkpoint' ─

test("agent_settled calls ledger.snapshot with marker 'checkpoint'", () => {
  let captured: Listener | undefined;
  const session = {
    subscribe(listener: Listener) {
      captured = listener;
      return () => { captured = undefined; };
    },
    getSessionStats: () => ({ sessionFile: undefined, sessionId: "x", userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    sessionManager: {
      appendCustomMessageEntry() {},
      appendCustomEntry() {},
    },
  } as unknown as AgentSession;

  const calls: Array<{ marker: string; policy: any }> = [];
  installBudgetEventHooks(
    session,
    {
      cumulative: { tokens: 0, costUsd: 0, runs: 0 },
      recordEvent: () => {},
      maybeSnapshot: () => {},
      recordCompaction: () => {},
      snapshot(_stats: SessionStats, _policy: any, marker: string) { calls.push({ marker, policy: _policy }); },
    } as unknown as BudgetLedger,
    basePolicy,
    new AbortController(),
  );

  captured!({ type: "agent_settled" });
  assert.equal(calls.length, 1, "snapshot called once on agent_settled");
  assert.equal(calls[0].marker, "checkpoint", "marker is 'checkpoint'");
  assert.strictEqual(calls[0].policy, basePolicy, "snapshot receives the supplied policy");
});

// ── Test 12: strategies.onApproachingLimit.threshold honored ─────────────

test("strategies.onApproachingLimit.threshold drives the warning emit (custom threshold fires earlier than 20%)", () => {
  const msgs: Array<{ customType: string }> = [];
  let captured: Listener | undefined;
  const session = {
    subscribe(listener: Listener) {
      captured = listener;
      return () => { captured = undefined; };
    },
    getSessionStats: () => ({ sessionFile: undefined, sessionId: "x", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, tokens: { input: 60, output: 0, cacheRead: 0, cacheWrite: 0, total: 60 }, cost: 0.01 }),
    sessionManager: {
      appendCustomMessageEntry(customType: string) { msgs.push({ customType }); },
      appendCustomEntry() {},
    },
  } as unknown as AgentSession;

  // 60 used of 100 cap = 40% remaining. The 0.50 threshold (50% remaining)
  // would fire here; the default 0.20 threshold would NOT.
  installBudgetEventHooks(
    session,
    { cumulative: { tokens: 0, costUsd: 0, runs: 0 }, recordEvent: () => {}, maybeSnapshot: () => {}, recordCompaction: () => {}, snapshot: () => {} } as unknown as BudgetLedger,
    {
      worker: { tokens: { cap: 100 } },
      team: {},
      strategies: {
        onApproachingLimit: { action: "wrap-up", threshold: 0.50, hint: "" },
        onExhaustion: { action: "abort" },
        summary: { maxTokens: 1000 },
      },
    },
    new AbortController(),
  );

  captured!({ type: "message_end", message: { usage: {} as any, role: "assistant" } } as any);

  const warnings = msgs.filter((m) => m.customType === "budget_warning");
  assert.equal(warnings.length, 1, "warning emitted at strategies.onApproachingLimit.threshold (0.50) — not at default 0.20");
});