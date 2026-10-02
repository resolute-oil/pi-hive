// Wave 7 F13 production-wiring fix — `installBudgetEventHooks` must
// emit `budget_warning` and `budget_exhausted` to the PARENT's
// observability log (via `emitHiveEvent`). The dashboard server only
// ingests the parent's telemetry log via `addSource(telemetry_log)`
// (runtime.ts:114); the per-worker `sessionManager.appendCustomMessageEntry`
// path that the F1-F13 design relied on is invisible to the dashboard
// because the dashboard never subscribes to the worker's session.jsonl.
//
// The regression-prevention test: invoke the real
// `installBudgetEventHooks` against a real `HiveState` whose
// `session.observabilityLog` points at a temp file, fire a
// `message_end` that crosses the 20% warning threshold, then read
// the parent's observability log and assert the `budget_warning`
// event is there with the right payload. Without the Wave 7 fix the
// file is empty.
//
// This test would have caught the F1-F13 audit's Blocker 1. Existing
// reducer tests inject synthetic events directly, so they cannot
// catch a missing emit — only an end-to-end test that exercises the
// production emit path can.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession, SessionStats } from "@earendil-works/pi-coding-agent";
import type { BudgetLedger } from "../src/engine/budget/ledger.ts";
import type { HiveState } from "../src/core/types.ts";
import { installBudgetEventHooks } from "../src/engine/budget/events.ts";

type Listener = (event: any) => void;

function makeScriptedSession(opts: {
  tokens: number;
  cost?: number;
  sessionId: string;
}) {
  const listeners: Listener[] = [];
  const appendedMessages: Array<{ customType: string; details?: unknown }> = [];
  const appendedEntries: Array<{ customType: string; data?: unknown }> = [];
  const sessionManager = {
    appendCustomMessageEntry(customType: string, _content: string, _display: boolean, details?: unknown) {
      appendedMessages.push({ customType, details });
    },
    appendCustomEntry(customType: string, data?: unknown) {
      appendedEntries.push({ customType, data });
    },
  };
  const session: any = {
    sessionId: opts.sessionId,
    subscribe(listener: Listener) {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
    getSessionStats(): SessionStats {
      return {
        sessionFile: undefined,
        sessionId: opts.sessionId,
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 2,
        tokens: { input: opts.tokens, output: 0, cacheRead: 0, cacheWrite: 0, total: opts.tokens },
        cost: opts.cost ?? 0.01,
      };
    },
    sessionManager,
  };
  (session as any).fire = (event: any) => {
    for (const l of listeners) l(event);
  };
  return { session: session as AgentSession & { fire: (event: any) => void }, appendedMessages, appendedEntries };
}

function makeStubLedger(agentName: string): BudgetLedger {
  return {
    cumulative: { tokens: 0, costUsd: 0, runs: 0 },
    recordEvent: () => {},
    maybeSnapshot: () => {},
    recordCompaction: () => {},
    snapshot: () => {},
    agentName,
  } as unknown as BudgetLedger;
}

function makeHiveState(observabilityLog: string): HiveState {
  // Minimal state surface that `emitHiveEvent` reads:
  //   - state.session (must be present)
  //   - state.mode (must NOT be "normal" — we use "hive")
  //   - state.config?.settings?.telemetry?.enabled (defaults to "enabled" when absent)
  //   - state.widgetCtx?.cwd (used for project identity; not required)
  //   - state.obsSeq (incremented on each emit; init to 0)
  return {
    session: {
      sessionId: "parent-session-id",
      sessionDir: join(observabilityLog, ".."),
      conversationLog: join(observabilityLog, "..", "conversation.jsonl"),
      observabilityLog,
    },
    mode: "hive",
    config: {
      orchestrator: { name: "Orchestrator", path: "o.md" },
      agents: [],
      sharedContext: [],
      settings: {
        subagentOutputLimit: 100,
        defaultTools: "read",
        distiller: { enabled: false, model: "", conversationLines: 10 },
        // Telemetry defaults to enabled when the field is absent.
      },
    },
    obsSeq: 0,
  } as unknown as HiveState;
}

function readEmittedEvents(logPath: string): any[] {
  const text = readFileSync(logPath, "utf8");
  return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

// ── Test 1: budget_warning reaches the parent's observability log ──────

test("Wave 7 F13: installBudgetEventHooks emits `budget_warning` to the parent's observability log when threshold crosses", () => {
  // Setup: parent session with a real observability log file; install
  // the budget event hooks against it (production wiring — state
  // is supplied); fire a message_end that pushes the cumulative
  // tokens past the 20% warning threshold. The parent log must
  // contain a `budget_warning` HiveTelemetryEvent.
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-f13-telemetry-"));
  const observabilityLog = join(dir, "observability.jsonl");
  const state = makeHiveState(observabilityLog);

  // Worker session with cumulative=160 / cap=200 → 20% remaining →
  // crosses the 20% warning threshold → warning emits.
  const { session, appendedMessages } = makeScriptedSession({ tokens: 160, sessionId: "worker-session-id-1" });

  installBudgetEventHooks(
    session,
    makeStubLedger("Builder"),
    { worker: { tokens: { cap: 200 } }, team: {} },
    new AbortController(),
    state,
    "Builder",
  );

  session.fire({ type: "message_end", message: { usage: {} as any, role: "assistant" } });

  // Per-worker custom entry path is unchanged (legacy write to the
  // worker's session.jsonl — kept for backward compatibility even
  // though the dashboard does not read it).
  assert.equal(appendedMessages.length, 1, "worker session.jsonl still receives the CustomMessageEntry (legacy path)");
  assert.equal(appendedMessages[0].customType, "budget_warning");

  // Production wiring: the parent's observability log must also
  // contain a budget_warning event. The dashboard server reads this
  // log via `addSource(telemetry_log)`; the worker's session.jsonl
  // is NOT read.
  const events = readEmittedEvents(observabilityLog);
  const warning = events.find((e) => e.type === "budget_warning");
  assert.ok(warning, "parent observability log contains a `budget_warning` event (production wiring for F13)");
  assert.equal(warning.actor, "Builder", "actor is the worker's display name");
  assert.equal(warning.session_id, "parent-session-id", "event's session_id is the parent's (emitHiveEvent semantics)");
  assert.equal(warning.payload.interventionAvailable, true, "interventionAvailable=true under the default strategy");
  assert.equal(warning.payload.scope, "worker");
  assert.equal(warning.payload.resource, "tokens");
  assert.equal(warning.payload.remaining, 200 - 160);
  assert.equal(warning.payload.cap, 200);
  // The worker's session id is threaded through the payload so the
  // dashboard reducer can key per-worker (multiple workers can share
  // a parent session).
  assert.equal(warning.payload.session_id, "worker-session-id-1", "payload.session_id is the worker's session id (dashboard reducer key)");
});

// ── Test 2: regression — without state, no parent log entry ────────────

test("Wave 7 F13 regression guard: without `state`, installBudgetEventHooks does NOT emit to a parent log (legacy test seam is preserved)", () => {
  // The existing test suite (~41 sites in budget-events.test.ts) calls
  // installBudgetEventHooks with only 4 args and expects the worker
  // custom entry path to work without an observability log side
  // effect. This test pins that contract: a parent log file exists
  // (so any emit would be observable) but `state` is undefined, so
  // the log stays empty.
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-f13-telemetry-regression-"));
  const observabilityLog = join(dir, "observability.jsonl");

  const { session, appendedMessages } = makeScriptedSession({ tokens: 160, sessionId: "worker-session-id-2" });

  installBudgetEventHooks(
    session,
    makeStubLedger("Builder"),
    { worker: { tokens: { cap: 200 } }, team: {} },
    new AbortController(),
    // state intentionally omitted — tests that don't want a real
    // emit must keep working.
  );

  session.fire({ type: "message_end", message: { usage: {} as any, role: "assistant" } });

  assert.equal(appendedMessages.length, 1, "worker custom entry path still works without state");
  // Read the file defensively — `readFileSync` on a non-existent file
  // throws. The file may or may not exist; we only care that no
  // `budget_warning` was emitted to the parent log.
  let events: any[] = [];
  try {
    events = readEmittedEvents(observabilityLog);
  } catch {
    events = [];
  }
  const warning = events.find((e) => e.type === "budget_warning");
  assert.equal(warning, undefined, "no parent log emit when state is undefined (legacy test contract preserved)");
});

// ── Test 3: budget_exhausted reaches the parent's observability log ───

test("Wave 7 F13: installBudgetEventHooks emits `budget_exhausted` to the parent's observability log at 0% remaining (default strategy)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-f13-telemetry-exhausted-"));
  const observabilityLog = join(dir, "observability.jsonl");
  const state = makeHiveState(observabilityLog);

  // 200/200 = 100% used → 0% remaining → exhausted (default strategy aborts).
  const { session, appendedEntries } = makeScriptedSession({ tokens: 200, sessionId: "worker-session-id-3" });
  const controller = new AbortController();

  installBudgetEventHooks(
    session,
    makeStubLedger("Builder"),
    { worker: { tokens: { cap: 200 } }, team: {} },
    controller,
    state,
    "Builder",
  );

  session.fire({ type: "message_end", message: { usage: {} as any, role: "assistant" } });

  assert.equal(controller.signal.aborted, true, "controller aborted at 0% remaining (default strategy)");

  const events = readEmittedEvents(observabilityLog);
  const exhausted = events.find((e) => e.type === "budget_exhausted");
  assert.ok(exhausted, "parent observability log contains a `budget_exhausted` event");
  assert.equal(exhausted.actor, "Builder");
  assert.equal(exhausted.payload.scope, "worker");
  assert.equal(exhausted.payload.resource, "tokens");
  assert.equal(exhausted.payload.remaining, 0);
  assert.equal(exhausted.payload.cap, 200);
  assert.equal(exhausted.payload.session_id, "worker-session-id-3");

  // Per-worker custom entry path is also preserved.
  const localExhausted = appendedEntries.find((e) => e.customType === "budget_exhausted");
  assert.ok(localExhausted, "worker's session.jsonl also receives the CustomEntry (legacy path)");
});

// ── Test 4: budget_exhausted under compact strategy reaches the parent log ─

test("Wave 7 F13: installBudgetEventHooks emits `budget_exhausted` to the parent log under the compact strategy (with action: 'compact')", () => {
  // The compact strategy auto-recovers, so the controller is NOT
  // aborted, but the dashboard still wants to see the threshold
  // crossing. The F13 dashboard shows an "auto-compacting" state
  // in the UI, which is driven by the budget_exhausted event with
  // action: "compact" in the payload. Pin that the parent log
  // receives the same shape.
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-f13-telemetry-compact-"));
  const observabilityLog = join(dir, "observability.jsonl");
  const state = makeHiveState(observabilityLog);

  const { session } = makeScriptedSession({ tokens: 200, sessionId: "worker-session-id-4" });
  const controller = new AbortController();

  installBudgetEventHooks(
    session,
    makeStubLedger("Builder"),
    {
      worker: { tokens: { cap: 200 } },
      team: {},
      strategies: {
        onApproachingLimit: { action: "wrap-up", threshold: 0.20, hint: "" },
        onExhaustion: { action: "compact" },
        summary: { maxTokens: 1000 },
      },
    },
    controller,
    state,
    "Builder",
  );

  session.fire({ type: "message_end", message: { usage: {} as any, role: "assistant" } });

  assert.equal(controller.signal.aborted, false, "controller NOT aborted under compact strategy");

  const events = readEmittedEvents(observabilityLog);
  const exhausted = events.find((e) => e.type === "budget_exhausted");
  assert.ok(exhausted, "parent observability log contains a `budget_exhausted` event under compact strategy");
  assert.equal(exhausted.payload.action, "compact", "exhausted marker carries action: compact");
  assert.equal(exhausted.payload.session_id, "worker-session-id-4");
});

// ── Test 5: dedup — only one emit per worker despite multiple events ───

test("Wave 7 F13: dedup — only ONE `budget_warning` reaches the parent log across 100 message_end events past the threshold", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-f13-telemetry-dedup-"));
  const observabilityLog = join(dir, "observability.jsonl");
  const state = makeHiveState(observabilityLog);

  const { session } = makeScriptedSession({ tokens: 90, sessionId: "worker-session-id-5" });

  installBudgetEventHooks(
    session,
    makeStubLedger("Builder"),
    { worker: { tokens: { cap: 100 } }, team: {} },
    new AbortController(),
    state,
    "Builder",
  );

  for (let i = 0; i < 100; i++) {
    session.fire({ type: "message_end", message: { usage: {} as any, role: "assistant" } });
  }

  const events = readEmittedEvents(observabilityLog);
  const warnings = events.filter((e) => e.type === "budget_warning");
  assert.equal(warnings.length, 1, "dedup: exactly ONE `budget_warning` across 100 message_end events past the threshold");
});
