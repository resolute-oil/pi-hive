import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TopologyGraph from "./TopologyGraph";
import { store } from "../store";

// TopologyGraph subscribes to a couple of store slices. Pre-populate the store
// with the minimum it needs so the component renders its controls without
// crashing — the actual rendering logic (d3 layout, edges, nodes) is not what
// we're testing here; only the control cluster wiring and the expand button.

const MINIMAL_STORE = {
  scope: { level: "fleet" },
  topologyByHash: new Map(),
  eventStatus: new Map(),
  modelLevels: new Map(),
} as any;

beforeEach(() => {
  store.setState(MINIMAL_STORE);
  // jsdom does not implement ResizeObserver; TopologyGraph uses one to re-fit on
  // container resize. A no-op stub keeps the effect from throwing. jsdom makes
  // globals read-only, so we have to define the property instead of assigning.
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: class { observe() {} unobserve() {} disconnect() {} },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  // Each test creates the fullscreen modal portal; ensure the body is clean.
  document.body.innerHTML = "";
});

const sampleTopology = {
  orchestrator: { name: "root", role: "orchestrator", children: [
    { name: "child-a", role: "lead", children: [] },
  ] },
  agents: [],
} as any;

describe("TopologyGraph controls", () => {
  it("renders the fit-to-view and expand buttons when onExpand is provided", () => {
    const onExpand = vi.fn();
    render(
      <TopologyGraph source={{ session_id: "s1", topology: sampleTopology, agents: new Map() } as any} statusMode="none" onExpand={onExpand} />,
    );
    const controls = document.querySelector(".graph-controls");
    expect(controls).toBeTruthy();
    const fitBtn = within(controls as HTMLElement).getByTitle("Fit to view");
    const expandBtn = within(controls as HTMLElement).getByTitle("Expand to fullscreen");
    expect(fitBtn).toBeInTheDocument();
    expect(expandBtn).toBeInTheDocument();
  });

  it("uses an SVG icon for Fit to view (no longer the unicode glyph) with an inner dashed rect", () => {
    render(
      <TopologyGraph source={{ session_id: "s1", topology: sampleTopology, agents: new Map() } as any} statusMode="none" onExpand={() => {}} />,
    );
    const fitBtn = screen.getByTitle("Fit to view");
    const svg = fitBtn.querySelector("svg");
    expect(svg).toBeTruthy();
    // No more unicode ⤢ text inside the button.
    expect(fitBtn.textContent?.trim()).toBe("");
    // The SVG carries four corner brackets (paths) and the inner content rect
    // that visually distinguishes it from the expand icon.
    const paths = svg!.querySelectorAll("path");
    expect(paths.length).toBe(4);
    const innerRect = svg!.querySelector("rect[stroke-dasharray]");
    expect(innerRect).toBeTruthy();
  });

  it("uses a plain-corner-brackets SVG for Expand (no inner rect, no unicode)", () => {
    render(
      <TopologyGraph source={{ session_id: "s1", topology: sampleTopology, agents: new Map() } as any} statusMode="none" onExpand={() => {}} />,
    );
    const expandBtn = screen.getByTitle("Expand to fullscreen");
    const svg = expandBtn.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(expandBtn.textContent?.trim()).toBe("");
    const paths = svg!.querySelectorAll("path");
    expect(paths.length).toBe(4);
    expect(svg!.querySelector("rect")).toBeNull();
  });

  it("renders the expand button as the LAST item in the controls column (below fit/zoom)", () => {
    render(
      <TopologyGraph source={{ session_id: "s1", topology: sampleTopology, agents: new Map() } as any} statusMode="none" onExpand={() => {}} />,
    );
    const buttons = document.querySelectorAll(".graph-controls button");
    const titles = Array.from(buttons).map((b) => b.getAttribute("title"));
    expect(titles).toEqual(["Zoom in", "Zoom out", "Fit to view", "Expand to fullscreen"]);
  });

  it("hides the expand affordance when no onExpand callback is passed (e.g. inside another modal)", () => {
    render(
      <TopologyGraph source={{ session_id: "s1", topology: sampleTopology, agents: new Map() } as any} statusMode="none" />,
    );
    expect(document.querySelector(".graph-controls button[title='Expand to fullscreen']")).toBeNull();
  });

  it("invokes onExpand when the expand button is clicked", async () => {
    const user = userEvent.setup();
    const onExpand = vi.fn();
    render(
      <TopologyGraph source={{ session_id: "s1", topology: sampleTopology, agents: new Map() } as any} statusMode="none" onExpand={onExpand} />,
    );
    await user.click(screen.getByTitle("Expand to fullscreen"));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});
