import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import Activity from "./Activity";
import { store } from "../store";
import type { HiveEvent } from "../types";

// Builds a minimal HiveEvent for a single session, suitable for seeding
// the scoped-slices path the Activity feed reads from directly. Fields the
// component does not read stay at sensible defaults.
function sessionEvent(partial: Partial<HiveEvent> & Pick<HiveEvent, "type" | "session_id" | "payload">): HiveEvent {
  return {
    event_id: partial.event_id ?? `eid-${Math.random().toString(36).slice(2)}`,
    ts: partial.ts ?? "2024-01-01T00:00:00Z",
    type: partial.type,
    session_id: partial.session_id,
    project_id: partial.project_id ?? "p1",
    actor: partial.actor ?? "system",
    pid: partial.pid ?? 1,
    seq: partial.seq ?? 1,
    payload: partial.payload,
  } as HiveEvent;
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dataset.theme = "dark";
  store.setState({
    activeTab: "activity",
    theme: "dark",
    scope: { level: "fleet" },
    projectGroups: [],
    sessions: [],
    sessionsById: new Map(),
    sessionSummaries: new Map(),
    allEvents: [],
    eventRing: { values: () => [], capacity: 0 } as any,
    eventRevision: 0,
    snapshots: {},
    delegations: [],
    delegationsCursor: 0,
    liveSet: new Set(),
    currentSession: undefined,
    fleetStats: { sessions: 0, live: 0, running: 0, tokens: 0, cost: 0 },
    scopedSessions: [{
      session_id: "s1",
      project: "p1",
      project_id: "p1",
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
      topology: { orchestrator: { name: "Root" }, agents: [] } as any,
      topologies: { active: "hive", hive: { orchestrator: { name: "Root" }, agents: [] }, planning: undefined },
      history: new Map(),
    } as any],
    scopedEvents: [],
    scopedDelegations: [],
    scopedAgents: [],
    scopedAgentCount: 0,
    scopedTeamCount: 0,
    scopeTitle: { title: "Activity", crumbs: ["Activity"], live: 0 },
    eventStatus: new Map(),
    interventionBySession: new Map(),
    thinkingBySession: new Map(),
    projectOverrides: new Map(),
    modelLevels: new Map(),
    modelInfo: new Map(),
    topologiesByCwd: new Map(),
    topologyByHash: new Map(),
    now: 0,
    replay: { active: false, sessionId: "", events: [], loading: false, loadedCount: 0, cursor: 0, playing: false, speed: 1, truncatedStart: false, historyStartsAt: "" },
  } as any);
});

// R8 / Follow-up #1, domain_override.granted with `dispatcherRole: "operations"`
// renders an `operations` badge plus a title naming the dispatching agent.
// dashboard consumers reading the activity feed need to see at a glance which
// grants come from the lifecycle lead on the new tier.
describe("Activity domain_override dispatcherRole", () => {
  it("renders the operations badge and an operations-aware title for an operations-dispatched grant", () => {
    const granted = sessionEvent({
      event_id: "grant-op",
      type: "domain_override.granted",
      session_id: "s1",
      ts: "2024-01-01T00:00:00Z",
      payload: {
        delegationId: "del-1",
        dispatcher: "Operations",
        dispatcherRole: "operations",
        worker: "builder",
        changeId: null,
        grantedAt: "2024-01-01T00:00:00Z",
        overrideEntries: [{ path: ".worktrees/feat-x/", upsert: true, delete: false }],
        staticReference: "abc",
      },
    });
    store.setState({ scopedEvents: [granted] } as any);
    render(<Activity search="" />);

    // The badge text is the operations role name in lowercase, matching the
    // telemetry contract's `dispatcherRole: "operations"` literal.
    expect(screen.getByText("operations")).toBeInTheDocument();
    // The title carries the new operations-aware wording; the worker slug
    // surfaces in the subtitle so a reader sees the dispatch target.
    expect(screen.getByText(/Operations granted scope to builder/)).toBeInTheDocument();
    // The grant event's tl-type label is still shown so the event type
    // remains the primary identifier at the row head. Both the tl-type
    // span AND the title <b> carry the literal type for the non-operations
    // fallback path; the title substitutes to the new wording when
    // dispatcherRole === "operations", so only the tl-type span carries
    // it here.
    expect(screen.getAllByText("domain_override.granted").length).toBeGreaterThan(0);
  });

  it("does not render the operations badge when dispatcherRole is the orchestrator fallback", () => {
    // Regression for the prior default rendering: an orchestrator-dispatched
    // grant (or a grant missing dispatcherRole) must still render as today,
    // so existing dashboard users see no change for the common path.
    const granted = sessionEvent({
      event_id: "grant-orch",
      type: "domain_override.granted",
      session_id: "s1",
      ts: "2024-01-01T00:00:00Z",
      payload: {
        delegationId: "del-2",
        dispatcher: "Orchestrator",
        dispatcherRole: "orchestrator",
        worker: "builder",
        changeId: null,
        grantedAt: "2024-01-01T00:00:00Z",
        overrideEntries: [],
        staticReference: "abc",
      },
    });
    store.setState({ scopedEvents: [granted] } as any);
    render(<Activity search="" />);

    // No badge for the orchestrator fallback. Multiple event-type tokens
    // render in the row, so an exact-match query is required to avoid
    // matching the dispatcher's payload text.
    expect(screen.queryByText(/^operations$/)).toBeNull();
    // Title falls back to the literal event type. Both the tl-type span
    // and the title <b> carry it on this branch, so an exact-match query
    // would trip "multiple matches"; check that at least one renders.
    expect(screen.getAllByText("domain_override.granted").length).toBeGreaterThan(0);
  });

  it("does not render the operations badge when dispatcherRole is absent from the payload", () => {
    // Pre-PR76 telemetry had no dispatcherRole; the dashboard must
    // continue to render those rows identically to the orchestrator
    // fallback so a project upgrading the runtime does not see a sudden
    // visual change in historical rows.
    const granted = sessionEvent({
      event_id: "grant-legacy",
      type: "domain_override.granted",
      session_id: "s1",
      ts: "2024-01-01T00:00:00Z",
      payload: {
        delegationId: "del-3",
        dispatcher: "Orchestrator",
        worker: "builder",
        changeId: null,
        grantedAt: "2024-01-01T00:00:00Z",
        overrideEntries: [],
        staticReference: "abc",
      },
    });
    store.setState({ scopedEvents: [granted] } as any);
    render(<Activity search="" />);

    expect(screen.queryByText(/^operations$/)).toBeNull();
    expect(screen.getAllByText("domain_override.granted").length).toBeGreaterThan(0);
  });
});
