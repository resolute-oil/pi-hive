import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import Agents from "./Agents";
import { store } from "../store";
import type { HiveEvent } from "../types";

// Builds a minimal ScopeAgent-shaped row keyed by `name`. The optional
// enforcement fields are populated only when `overrides` carries them, so a
// single test can shape the field-under-test without re-declaring the rest.
function agentRow(name: string, overrides: Record<string, any> = {}) {
  return {
    key: "s1::" + name.toLowerCase(),
    name,
    role: "member",
    status: "idle",
    tokens: 0,
    cost: 0,
    runs: 0,
    tools: 0,
    session_id: "s1",
    depth: 0,
    order: 0,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dataset.theme = "dark";
  store.setState({
    activeTab: "agents",
    connection: "live",
    scope: { level: "fleet" },
    theme: "dark",
    projectGroups: [],
    sessions: [],
    sessionsById: new Map(),
    sessionSummaries: new Map(),
    allEvents: [] as HiveEvent[],
    eventRing: { values: () => [], capacity: 0 } as any,
    eventRevision: 0,
    snapshots: {},
    delegations: [],
    delegationsCursor: 0,
    liveSet: new Set(),
    currentSession: undefined,
    fleetStats: { sessions: 0, live: 0, running: 0, tokens: 0, cost: 0 },
    scopedSessions: [{
      session_id: "s1", project: "p1", project_id: "p1", first_ts: "2024-01-01T00:00:00Z",
      last_ts: "2024-01-01T00:00:01Z", event_count: 0, live: false, running: 0, tokens: 0, cost: 0,
      cwds: ["/tmp"], cwd: "/tmp",
      agents: new Map(), topology: { orchestrator: { name: "Root" }, agents: [] } as any,
      topologies: { active: "hive", hive: { orchestrator: { name: "Root" }, agents: [] }, planning: undefined },
      history: new Map(),
    } as any],
    scopedEvents: [],
    scopedDelegations: [],
    scopedStats: { sessions: 1, live: 0, running: 0, tokens: 0, cost: 0 },
    scopedAgents: [],
    scopedAgentCount: 0,
    scopedTeamCount: 0,
    scopeTitle: { title: "Agents", crumbs: ["Agents"], live: 0 },
    eventStatus: new Map(),
    thinkingBySession: new Map(),
    projectOverrides: new Map(),
    modelLevels: new Map(),
    modelInfo: new Map(),
    now: 0,
  });
});

describe("Agents", () => {
  it("renders rows without crashing when stages / domain / routingTags are string-shaped instead of arrays", () => {
    // The runtime SQLite round-trip (parseJsonMaybe) can hand back a string
    // when an upstream row was inserted without JSON.stringify, e.g.
    // `stages: "specs"` instead of `stages: ["specs"]`. The old enforcement
    // title checked `.length` (truthy on a string) and then called `.join`
    // (undefined on a string) — crashing the whole Agents tab and taking
    // the sidebar down with it. This test reproduces that shape and asserts
    // the page still renders.
    const malformed = agentRow("Specser", {
      stages: "specs,plan",
      domain: "src",
      routingTags: "fast",
    });
    store.setState({
      scopedAgents: [malformed],
      scopedAgentCount: 1,
    });

    // If the bug regresses, this render() call throws synchronously and
    // fails the test — we never reach the assertion below.
    expect(() => render(<Agents search="" />)).not.toThrow();

    // The row should still appear in the table.
    expect(screen.getByText("Specser")).toBeInTheDocument();
    // And the (now-empty) enforcement cell should render as "—" rather than
    // throw while computing its label.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("renders enforcement tooltip text for a well-formed agent row", () => {
    const wellFormed = agentRow("Planner", {
      commit: true,
      domain: ["src"],
      stages: ["specs", "plan"],
    });
    store.setState({
      scopedAgents: [wellFormed],
      scopedAgentCount: 1,
    });

    expect(() => render(<Agents search="" />)).not.toThrow();

    expect(screen.getByText("Planner")).toBeInTheDocument();
    // The title attribute on the enforcement cell carries the full contract.
    const titleEl = document.querySelector("td span[title]");
    expect(titleEl?.getAttribute("title")).toMatch(/commit: yes/);
    expect(titleEl?.getAttribute("title")).toMatch(/domains: src/);
    expect(titleEl?.getAttribute("title")).toMatch(/plan gates: specs, plan/);
  });
});
