// Wave 7.5 F13 fixup — row-lookup regression test.
//
// The F1-F13 audit caught a real bug that the F1-F13 plan-side audit
// missed: the Wave 7 reducer keying change at
// `ui/web/src/store/status.ts` made the map keyed by the worker's
// session id (`payload.session_id`), but the row builder at
// `ui/web/src/store/scoped-agents.ts:104` still looked up the flag
// by the parent's session id (`sess.session_id`). Every row's
// `interventionAvailable` was `undefined`, so the
// `OperatorCommands` compact-strategy gate never engaged.
//
// These tests exercise the FULL path the audit cared about:
// events → reducer (`buildInterventionBySession`) → store
// (`interventionBySession`) → row builder
// (`computeScopedAgents`) → row's `interventionAvailable` field.
// A reducer-only test would not have caught the original bug
// (the reducer is correct in isolation; the consumer was the
// problem). The reducer test in `critical.test.ts` proves the
// per-worker keying; the row-lookup test here proves the
// parent-side alias makes the consumer see the value.

import { beforeEach, describe, expect, test } from "vitest";
import { store } from "./index";
import { buildInterventionBySession } from "./status";
import { computeScopedAgents } from "./scoped-agents";
import type { HiveEvent, SessionView } from "../types";

function event(id: string, cursor: number | undefined, sessionId: string, type: string, payload: Record<string, any> = {}): HiveEvent {
  return { event_id: id, cursor, session_id: sessionId, seq: cursor || 0, ts: `2026-07-15T00:00:${String(cursor || 0).padStart(2, "0")}Z`, type, actor: "test", payload } as HiveEvent;
}

// Minimal SessionView shape that `computeScopedAgents` walks. Fields
// not read by the test (or the row builder) are stubbed with `as any`.
// Mirrors the pattern in `tabs/Agents.test.tsx`.
function makeSessionView(sessionId: string, childName: string): SessionView {
  return {
    session_id: sessionId,
    project_id: "p1",
    project: "p1",
    project_label: "p1",
    first_ts: "2024-01-01T00:00:00Z",
    last_ts: "2024-01-01T00:00:01Z",
    event_count: 0,
    live: false,
    running: 0,
    tokens: 0,
    cost: 0,
    cwds: ["/tmp"],
    cwd: "/tmp",
    agents: new Map(),
    topology: { orchestrator: { name: "Root", children: [{ name: childName }] }, agents: [] } as any,
    topologies: { active: "hive", hive: { orchestrator: { name: "Root", children: [{ name: childName }] }, agents: [] }, planning: undefined } as any,
  } as any;
}

beforeEach(() => {
  // Reset only the slices the row-lookup path reads. We don't
  // need to re-initialize the full HiveState — the rest of the
  // store is irrelevant for this path.
  store.setState({
    eventStatus: new Map(),
    interventionBySession: new Map(),
    now: Date.now(),
  } as any);
});

describe("scoped-agents row-lookup (Wave 7.5 F13 fixup)", () => {
  // The bug: a single worker (worker_a) running under parent session
  // `parent_sess` emits a budget_warning with `interventionAvailable: false`
  // (compact strategy). The reducer must make the value visible to
  // `computeScopedAgents`'s lookup at `sess.session_id` (= `parent_sess`).
  test("row's interventionAvailable is set to false when a worker emits interventionAvailable=false (compact strategy)", () => {
    const events: HiveEvent[] = [
      event("w1", 1, "parent_sess", "budget_warning", { scope: "worker", resource: "tokens", remaining: 200, cap: 1000, interventionAvailable: false, session_id: "worker_a" }),
    ];
    // Full path: events → reducer → store state.
    const interventionBySession = buildInterventionBySession(events);
    store.setState({ interventionBySession });
    // Build the row.
    const rows = computeScopedAgents([makeSessionView("parent_sess", "builder")]);
    // The orchestrator row AND the child row both look up
    // `sess.session_id` (the parent). The fix is for the parent-side
    // alias to make this lookup succeed. Without the fix, both rows
    // would have `interventionAvailable === undefined` and the
    // `OperatorCommands` compact-strategy gate would never engage.
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.interventionAvailable, `row "${row.name}" should pick up the worker's compact-strategy flag`).toBe(false);
    }
  });

  test("row's interventionAvailable is set to true when a worker emits interventionAvailable=true (default strategy)", () => {
    const events: HiveEvent[] = [
      event("w1", 1, "parent_sess", "budget_warning", { scope: "worker", resource: "tokens", remaining: 200, cap: 1000, interventionAvailable: true, session_id: "worker_a" }),
    ];
    const interventionBySession = buildInterventionBySession(events);
    store.setState({ interventionBySession });
    const rows = computeScopedAgents([makeSessionView("parent_sess", "builder")]);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.interventionAvailable, `row "${row.name}" should pick up the worker's default-strategy flag`).toBe(true);
    }
  });

  test("row's interventionAvailable is undefined when no budget_warning has been emitted yet", () => {
    // No events. The store's interventionBySession is empty. The
    // OperatorCommands component treats undefined as "enabled" —
    // the dashboard falls back to "intervention available" which
    // matches the brief's gate.
    store.setState({ interventionBySession: new Map() });
    const rows = computeScopedAgents([makeSessionView("parent_sess", "builder")]);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.interventionAvailable, `row "${row.name}" should be undefined when no warning has been emitted`).toBeUndefined();
    }
  });
});
