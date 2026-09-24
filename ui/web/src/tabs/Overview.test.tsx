import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Overview from "./Overview";
import { store } from "../store";

// The Overview page reads a lot of slices off the hive store. For modal behaviour
// we only need the TopologyFullscreenModal surface; render the page with the
// minimum data needed to skip the empty state and reach the topology pane.

beforeEach(() => {
  // Make TopologyGraph a no-op stub — it is code-split (React.lazy) and would
  // require ResizeObserver + d3 layout. We only care about the modal surface
  // here, not the graph itself.
  vi.doMock("../components/TopologyGraph", () => ({
    default: function Stub(props: { onExpand?: () => void }) {
      return (
        <div data-testid="stub-graph">
          <button type="button" onClick={props.onExpand} aria-label="stub-expand">stub-expand</button>
        </div>
      );
    },
  }));
  store.setState({
    scope: { level: "fleet" },
    sessionSummaries: new Map([["s1", {
      session_id: "s1",
      project_id: "p1",
      project_root: "/p",
      project_label: "p",
      last_event_ts: "2026-01-01T00:00:00Z",
      topologyHash: "h",
      latestVerdict: null,
    } as any]]),
    currentSession: {
      session_id: "s1",
      project_id: "p1",
      project_root: "/p",
      project_label: "p",
      last_event_ts: "2026-01-01T00:00:00Z",
      topologyHash: "h",
      latestVerdict: null,
      agents: new Map(),
      topologies: { active: "hive" as const, hive: undefined, planning: undefined },
    } as any,
    scopedAgents: [{ name: "root" } as any],
    scopedAgentCount: 1,
    scopedTeamCount: 1,
    scopedStats: { sessions: 1, live: 1, running: 0, tokens: 0, cost: 0 },
    scopedEvents: [],
    scopedKpis: { tokens: 0, cost: 0, ctx: 0, sessions: 1, live: 1, running: 0 },
    replay: { active: false, sessionId: "", events: [], cursor: -1 },
    topologyByHash: new Map(),
    eventStatus: new Map(),
    modelLevels: new Map(),
  } as any);
});

afterEach(async () => {
  vi.doUnmock("../components/TopologyGraph");
  // Let React unmount first so the createPortal child is removed via React's
  // own machinery; wiping document.body while the portal is still attached
  // trips jsdom's "node to be removed is not a child" guard.
  await new Promise((r) => setTimeout(r, 0));
});

describe("Overview topology expand modal", () => {
  it("opens the fullscreen modal when the expand affordance fires", async () => {
    const user = userEvent.setup();
    render(<Overview />);
    await waitFor(() => expect(screen.getByTestId("stub-graph")).toBeInTheDocument());
    // The stub graph exposes its expand trigger as "stub-expand" so we don't
    // depend on the real graph controls being rendered.
    await user.click(screen.getByLabelText("stub-expand"));
    expect(screen.getByRole("dialog", { name: "Agent topology" })).toBeInTheDocument();
    expect(document.querySelector(".modal-panel-fullscreen")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close topology" })).toBeInTheDocument();
  });

  it("closes the modal when the X button is clicked", async () => {
    const user = userEvent.setup();
    render(<Overview />);
    await waitFor(() => expect(screen.getByTestId("stub-graph")).toBeInTheDocument());
    await user.click(screen.getByLabelText("stub-expand"));
    await user.click(screen.getByRole("button", { name: "Close topology" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Agent topology" })).toBeNull());
  });

  it("closes the modal when ESC is pressed", async () => {
    const user = userEvent.setup();
    render(<Overview />);
    await waitFor(() => expect(screen.getByTestId("stub-graph")).toBeInTheDocument());
    await user.click(screen.getByLabelText("stub-expand"));
    expect(screen.getByRole("dialog", { name: "Agent topology" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Agent topology" })).toBeNull());
  });

  it("closes the modal when the backdrop is clicked", async () => {
    const user = userEvent.setup();
    render(<Overview />);
    await waitFor(() => expect(screen.getByTestId("stub-graph")).toBeInTheDocument());
    await user.click(screen.getByLabelText("stub-expand"));
    const backdrop = document.querySelector(".modal-backdrop-fullscreen");
    expect(backdrop).toBeTruthy();
    await user.click(backdrop as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Agent topology" })).toBeNull());
  });

  it("does not close when the panel itself is clicked (stopPropagation)", async () => {
    const user = userEvent.setup();
    render(<Overview />);
    await waitFor(() => expect(screen.getByTestId("stub-graph")).toBeInTheDocument());
    await user.click(screen.getByLabelText("stub-expand"));
    const panel = document.querySelector(".modal-panel-fullscreen") as HTMLElement;
    expect(panel).toBeTruthy();
    await user.click(panel);
    expect(screen.getByRole("dialog", { name: "Agent topology" })).toBeInTheDocument();
  });

  it("makes the content wrapper a flex column so the inner graph's flex-1 actually fills the body height", async () => {
    const user = userEvent.setup();
    render(<Overview />);
    await waitFor(() => expect(screen.getByTestId("stub-graph")).toBeInTheDocument());
    await user.click(screen.getByLabelText("stub-expand"));
    // The wrapper directly above the graph must carry the flex-col utilities;
    // otherwise .graph-wrap's flex-1 is a no-op and the SVG collapses to its
    // 300px min-height instead of filling the modal body. jsdom does not run
    // Tailwind, so verify via className rather than getComputedStyle.
    const wrapper = document.querySelector(".modal-panel-fullscreen > div.flex-1") as HTMLElement;
    expect(wrapper).toBeTruthy();
    expect(wrapper.className).toContain("flex");
    expect(wrapper.className).toContain("flex-col");
  });
});
