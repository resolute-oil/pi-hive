import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { store } from "./store";

// `App` calls `connect()` in a useEffect, which opens an EventSource to the
// dashboard's /stream endpoint. jsdom doesn't ship EventSource, so the test
// would crash on the first render with "ReferenceError: EventSource is not
// defined". Provide a minimal no-op stub so connect() can run without
// tripping the test runner.
class StubEventSource {
  url: string;
  constructor(url: string) { this.url = url; }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
const originalEventSource = (globalThis as any).EventSource;

beforeEach(() => {
  (globalThis as any).EventSource = StubEventSource;
  localStorage.clear();
  document.documentElement.dataset.theme = "dark";
  store.setState({
    activeTab: "overview",
    scope: { level: "fleet" },
    scopedStats: { sessions: 24, live: 0, running: 0, tokens: 0, cost: 0 },
    scopedAgents: [],
    scopedAgentCount: 0,
    sessions: [],
    scopedSessions: [],
    scopeTitle: { title: "Overview", crumbs: ["Overview"], live: 0 },
    scopedEvents: [],
    now: 0,
  });
});

afterEach(() => {
  if (originalEventSource) (globalThis as any).EventSource = originalEventSource;
  else delete (globalThis as any).EventSource;
  vi.restoreAllMocks();
});

describe("App page header", () => {
  it("renders the page title that matches the active tab", async () => {
    render(<App />);
    // Default activeTab in beforeEach is "overview" → title is "Overview".
    expect(screen.getByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();

    // Switching to each tab updates the heading text. `findByRole` waits for
    // the new heading, so any async state updates the tab component kicks
    // off on mount are flushed before the assertion (the `await` lets React
    // Testing Library wrap everything in act() internally).
    for (const [tab, expected] of [
      ["sessions", "Sessions"],
      ["agents", "Agents"],
      ["activity", "Activity"],
      ["plans", "Plans"],
      ["cost", "Cost"],
    ] as const) {
      act(() => { store.setState({ activeTab: tab }); });
      expect(await screen.findByRole("heading", { level: 1, name: expected })).toBeInTheDocument();
    }
  });

  it("places the scope subtitle on the same row as the page title (right side)", () => {
    render(<App />);

    const heading = screen.getByRole("heading", { level: 1, name: "Overview" });
    const subtitle = screen.getByText(/sessions across all projects/);

    // Subtitle must be in the DOM (sanity).
    expect(subtitle).toBeInTheDocument();

    // Both must be inside the same flex row at the top of the main panel —
    // i.e. share an immediate parent that lays them out horizontally with
    // justify-between (title left, subtitle right). jsdom doesn't apply CSS,
    // so we walk the DOM rather than reading getComputedStyle.
    const row = heading.parentElement?.parentElement;
    expect(row).toBeTruthy();
    // The row holds the heading on the left and the subtitle on the right
    // (the subtitle's parent IS the row, not nested under the heading).
    expect(row!.contains(heading)).toBe(true);
    expect(row!.contains(subtitle)).toBe(true);
    // Heading and subtitle are siblings of each other, not parent/child.
    expect(heading.contains(subtitle)).toBe(false);
    expect(subtitle.contains(heading)).toBe(false);
  });

  it("wraps the page header in a card frame matching the dashboard's card language", () => {
    render(<App />);

    const heading = screen.getByRole("heading", { level: 1, name: "Overview" });

    // Walk up to the card wrapper (title cluster's parent = card div).
    const card = heading.parentElement?.parentElement;
    expect(card).toBeTruthy();

    // jsdom doesn't apply Tailwind, so assert via className rather than
    // getComputedStyle. The card frame matches the dashboard's main-content
    // card vocabulary (bg-panel + border-border + rounded-2xl) — the same
    // palette and radius the .tab-card / .kpi tiles use, so the header
    // visually pairs with the content below it instead of floating bare on
    // the page background.
    expect(card!.className).toContain("bg-panel");
    expect(card!.className).toContain("border-border");
    expect(card!.className).toContain("rounded-2xl");
  });

  it("keeps the session-scope badge next to the title when scope narrows to a session", () => {
    // Seed the store directly with a session scope so the badge renders on
    // first paint (avoids act() gymnastics around in-test scope mutations).
    act(() => {
      store.setState({
        activeTab: "agents",
        scope: { level: "session", project: "p1", sessionId: "sess-abc" },
        scopeTitle: {
          title: "p1",
          crumbs: ["Overview", "p1", "sess-abc"],
          live: 0,
          session: { session_id: "sess-abc" } as any,
        },
      });
    });

    render(<App />);

    expect(screen.getByRole("heading", { level: 1, name: "Agents" })).toBeInTheDocument();
    const badge = document.querySelector('button[title^="Back to project"]');
    expect(badge).toBeTruthy();
    // The badge sits next to the heading in the DOM (siblings under the
    // title cluster).
    expect(badge!.parentElement!.contains(screen.getByRole("heading", { level: 1 }))).toBe(true);
  });
});
