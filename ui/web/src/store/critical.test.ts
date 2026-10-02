import { beforeEach, describe, expect, test } from "vitest";
import { EventRing } from "./event-ring";
import { applyHistoryToRuntime, buildHistoryBySession, historyTotals } from "./history";
import { buildEventStatus, buildInterventionBySession } from "./status";
import { buildAgents, flattenTopology } from "./topology";
import { sessionStore, sessionUpdatedAt } from "./identity";
import type { AgentRuntime, HiveEvent } from "../types";

function event(id: string, cursor: number | undefined, sessionId = "s1", type = "user_message", payload: Record<string, any> = {}): HiveEvent {
  return { event_id: id, cursor, session_id: sessionId, seq: cursor || 0, ts: `2026-07-15T00:00:${String(cursor || 0).padStart(2, "0")}Z`, type, actor: "test", payload } as HiveEvent;
}

describe("EventRing", () => {
  test("deduplicates, orders, trims, and rejects stale history", () => {
    const ring = new EventRing(3.9);
    expect(ring.capacity).toBe(3);
    expect(ring.add({} as HiveEvent)).toBe(false);
    expect(ring.add(event("two", 2))).toBe(true);
    expect(ring.add(event("two", 2))).toBe(false);
    expect(ring.add(event("four", 4))).toBe(true);
    expect(ring.add(event("one", 1))).toBe(true);
    expect(ring.add(event("three", 3))).toBe(true);
    expect(ring.values().map((item) => item.event_id)).toEqual(["two", "three", "four"]);
    expect(ring.full).toBe(true);
    expect(ring.add(event("stale", 1))).toBe(false);
    expect(ring.has("one")).toBe(false);
  });

  test("uses timestamp fallback and compacts its logical head", () => {
    const ring = new EventRing(2);
    const timestampOnly = { ...event("timestamp", undefined), ts: "2026-07-15T00:00:01Z" };
    const invalidTimestamp = { ...event("invalid", undefined), ts: "invalid" };
    expect(ring.add(timestampOnly)).toBe(true);
    expect(ring.add(invalidTimestamp)).toBe(true);
    expect(ring.addAll([event("ten", 10), event("eleven", 11), event("twelve", 12)])).toBe(3);
    expect(ring.values().map((item) => item.event_id)).toEqual(["twelve", "timestamp"]);
  });

  test("removes selected sessions without rebuilding for no-ops", () => {
    const ring = new EventRing(5);
    ring.addAll([event("a", 1, "a"), event("b", 2, "b"), event("c", 3, "a")]);
    expect(ring.removeSessions(new Set())).toBe(0);
    expect(ring.removeSessions(new Set(["missing"]))).toBe(0);
    expect(ring.removeSessions(new Set(["a"]))).toBe(2);
    expect(ring.values().map((item) => item.event_id)).toEqual(["b"]);
  });
});

describe("historical runtime state", () => {
  test("reconstructs durable peaks and child-only tool counts", () => {
    const events = [
      event("start", 1, "s1", "delegation_start", { to: "Builder" }),
      event("invalid", 2, "s1", "delegation_end", { runtime: null }),
      event("end", 3, "s1", "delegation_end", { from: "Builder", runtime: { name: "Builder", inputTokens: 10, outputTokens: 5, costUsd: 0.2, runCount: 2, toolCount: 1 } }),
      event("lower", 4, "s1", "delegation_end", { from: "Builder", runtime: { inputTokens: 1, outputTokens: 1, costUsd: 0.1, runCount: 1, toolCount: 0 } }),
      event("tool", 5, "s1", "worker_tool_start", { agent: "Builder" }),
      event("tool-missing", 6, "s1", "worker_tool_start", {}),
      event("other", 7, "s1", "other", {}),
    ] as HiveEvent[];
    const history = buildHistoryBySession(events);
    expect(history.get("s1")?.get("Builder")).toEqual({ input: 10, output: 5, cost: 0.2, runs: 2, tools: 2 });
    expect(historyTotals(history, "s1")).toEqual({ tokens: 15, cost: 0.2 });
    expect(historyTotals(history, "missing")).toEqual({ tokens: 0, cost: 0 });
  });

  test("applies only historical values that exceed live counters", () => {
    const agent = { inputTokens: 1, outputTokens: 1, costUsd: 0.1, runCount: 1, toolCount: 1 } as AgentRuntime;
    applyHistoryToRuntime(agent, { input: 10, output: 5, cost: 0.5, runs: 3, tools: 4 });
    expect(agent).toMatchObject({ inputTokens: 10, outputTokens: 5, costUsd: 0.5, runCount: 3, toolCount: 4 });
    applyHistoryToRuntime(agent, { input: 1, output: 1, cost: 0.1, runs: 1, tools: 1 });
    expect(agent).toMatchObject({ inputTokens: 10, outputTokens: 5, costUsd: 0.5, runCount: 3, toolCount: 4 });
  });
});

describe("event-driven statuses", () => {
  test("tracks nested waiting, parallel children, errors, and sparse events", () => {
    const events = [
      event("reset", 1, "s1", "session_start"),
      event("missing", 2, "s1", "delegation_start", {}),
      event("a", 3, "s1", "delegation_start", { from: "Lead", to: "A" }),
      event("b", 4, "s1", "delegation_start", { from: "Lead", to: "B" }),
      event("waiting-tool", 5, "s1", "worker_tool_start", { agent: "Lead" }),
      event("free-tool", 6, "s1", "worker_tool_start", { agent: "Independent" }),
      event("missing-end", 7, "s1", "delegation_end", {}),
      event("a-end", 8, "s1", "delegation_end", { from: "A", type: "done" }),
      event("b-end", 9, "s1", "delegation_end", { from: "B", type: "error" }),
      event("orphan", 10, "s1", "delegation_end", { from: "Orphan", type: "done" }),
    ] as HiveEvent[];
    const status = buildEventStatus(events).get("s1")!;
    expect(status.get("Lead")).toBe("running");
    expect(status.get("A")).toBe("done");
    expect(status.get("B")).toBe("error");
    expect(status.get("Independent")).toBe("running");
    expect(status.get("Orphan")).toBe("done");
  });
});

describe("topology and identity state", () => {
  beforeEach(() => { sessionStore.clear(); sessionUpdatedAt.clear(); });

  test("builds agent maps and recursively flattens topology", () => {
    expect(buildAgents(undefined).size).toBe(0);
    const alpha = { name: "Alpha" } as AgentRuntime;
    const beta = { name: "Beta" } as AgentRuntime;
    expect([...buildAgents({ agents: [alpha, beta] }).keys()]).toEqual(["Alpha", "Beta"]);
    expect(flattenTopology(undefined)).toEqual([]);
    expect((flattenTopology({
      orchestrator: { name: "Lead", children: [{ name: "Nested" }] },
      agents: [{ name: "Worker" }],
    } as any) || []).map((node) => node.name)).toEqual(["Lead", "Nested", "Worker"]);
  });

  test("identity maps preserve mutable session objects and timestamps", () => {
    const session = { session_id: "s1" } as any;
    sessionStore.set("s1", session);
    sessionUpdatedAt.set("s1", 123);
    expect(sessionStore.get("s1")).toBe(session);
    expect(sessionUpdatedAt.get("s1")).toBe(123);
  });

  // T13.2 — buildInterventionBySession reads the `interventionAvailable`
  // field off every `budget_warning` event and maps it per session_id.
  // Engine emits `true` under the default strategy, `false` under compact.
  test("buildInterventionBySession stamps the most recent budget_warning flag per session", () => {
    const events: HiveEvent[] = [
      // First warning for s1: default strategy (intervention available).
      event("w1", 1, "s1", "budget_warning", { scope: "worker", resource: "tokens", remaining: 1000, cap: 5000, interventionAvailable: true }),
      // First warning for s2: compact strategy (no manual intervention).
      event("w2", 2, "s2", "budget_warning", { scope: "worker", resource: "tokens", remaining: 500, cap: 5000, interventionAvailable: false }),
      // Second warning for s1: still default — latest wins, value unchanged.
      event("w3", 3, "s1", "budget_warning", { scope: "worker", resource: "tokens", remaining: 200, cap: 5000, interventionAvailable: true }),
      // Non-worker warning (e.g. team-level) — ignored at the session_id key.
      event("w4", 4, "s3", "budget_warning", { scope: "team", resource: "tokens", interventionAvailable: true }),
    ];
    const out = buildInterventionBySession(events);
    expect(out.get("s1")).toBe(true);
    expect(out.get("s2")).toBe(false);
    // s3 emitted a non-worker warning — the per-session entry is still
    // stamped from the event itself; the dashboard gates on the row's
    // interventionAvailable value, not on event-level scope filtering.
    expect(out.get("s3")).toBe(true);
    expect(out.size).toBe(3);
  });

  test("buildInterventionBySession ignores events without a boolean flag", () => {
    const events: HiveEvent[] = [
      event("x1", 1, "s1", "budget_warning", { scope: "worker", resource: "tokens" }),
      event("x2", 2, "s2", "budget_warning", { scope: "worker", resource: "tokens", interventionAvailable: "yes" /* wrong type */ }),
      event("x3", 3, "s3", "budget_warning", { scope: "worker", resource: "tokens", interventionAvailable: true }),
    ];
    const out = buildInterventionBySession(events);
    expect(out.has("s1")).toBe(false);
    expect(out.has("s2")).toBe(false);
    expect(out.get("s3")).toBe(true);
    expect(out.size).toBe(1);
  });

  // Wave 7 F13 production wiring: the engine emits a HiveTelemetryEvent
  // of type "budget_warning" to the PARENT's observability log (so the
  // dashboard can see it), but the worker's session id is threaded
  // through the payload (multiple workers can share a parent session
  // and they need distinct map entries). The reducer must prefer
  // payload.session_id (the worker) over e.session_id (the parent).
  test("buildInterventionBySession prefers payload.session_id (worker) over e.session_id (parent) for the F13 production emit", () => {
    // Two distinct workers running in the same parent session (parent_sess).
    // Each worker has its own SDK AgentSession (worker_a, worker_b). The
    // engine emits a budget_warning with session_id=parent_sess and
    // payload.session_id=worker_a / worker_b respectively.
    const events: HiveEvent[] = [
      event("a1", 1, "parent_sess", "budget_warning", { scope: "worker", resource: "tokens", remaining: 200, cap: 1000, interventionAvailable: true, session_id: "worker_a" }),
      event("a2", 2, "parent_sess", "budget_warning", { scope: "worker", resource: "tokens", remaining: 200, cap: 1000, interventionAvailable: false, session_id: "worker_b" }),
    ];
    const out = buildInterventionBySession(events);
    // Without the Wave 7 fix, both events would collide on key=parent_sess
    // and only the last value (false) would be visible — worker_a's
    // rescue buttons would be wrongly disabled. With the fix, each
    // worker gets its own map entry.
    expect(out.get("worker_a")).toBe(true);
    expect(out.get("worker_b")).toBe(false);
    expect(out.has("parent_sess"), "parent session_id is NOT used as the key when payload.session_id is present").toBe(false);
    expect(out.size).toBe(2);
  });
});
