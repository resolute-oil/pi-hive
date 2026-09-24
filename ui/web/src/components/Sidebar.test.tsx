import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import Sidebar from "./Sidebar";
import { store } from "../store";
import type { HiveEvent } from "../types";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dataset.theme = "dark";
  store.setState({
    activeTab: "overview",
    connection: "live",
    scope: { level: "fleet" },
    theme: "dark",
    projectGroups: [{
      name: "project-1",
      derivedLabel: "app",
      label: "App Project",
      sessions: [],
      live: true,
      totalCost: 0,
      cwds: ["/workspace/app"],
    }],
    scopedStats: { sessions: 2, live: 1, running: 1, tokens: 0, cost: 0 },
    scopedEvents: [],
    scopedAgentCount: 3,
    now: 0,
  });
});

describe("Sidebar", () => {
  it("provides semantic navigation and persists the selected theme", async () => {
    render(<Sidebar />);

    expect(screen.getByRole("navigation", { name: "Dashboard sections" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Overview" })).toHaveAttribute("aria-current", "page");

    await userEvent.click(screen.getByRole("button", { name: /Sessions/ }));
    expect(store.getState().activeTab).toBe("sessions");

    await userEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(store.getState().theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("hive-theme")).toBe("light");
  });

  it("switches from fleet to project scope and reveals project settings", async () => {
    render(<Sidebar />);

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Project" }), "project-1");

    expect(store.getState().scope).toEqual({ level: "project", project: "project-1" });
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });

  it("places the wall clock below the Dark/Light theme buttons", () => {
    render(<Sidebar />);

    const dark = screen.getByRole("button", { name: "Dark" });
    const light = screen.getByRole("button", { name: "Light" });
    // The clock span renders HH:MM:SS — match by format, not exact text, since
    // the store's `now` defaults to 0 and the component falls back to Date.now().
    const clock = screen.getByText(/^\d{2}:\d{2}:\d{2}$/);
    expect(clock).toBeInTheDocument();

    // Both theme buttons must precede the clock in document order — the clock
    // lives at the very bottom of the sidebar, below the theme toggle.
    expect(dark.compareDocumentPosition(clock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(light.compareDocumentPosition(clock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // The clock sits in its own card that mirrors the connection card frame
    // (bg-well + border-line + rounded-xl). jsdom doesn't apply Tailwind, so
    // assert via className rather than getComputedStyle.
    const card = clock.parentElement;
    expect(card).toBeTruthy();
    expect(card!.className).toContain("bg-well");
    expect(card!.className).toContain("border-line");
    expect(card!.className).toContain("rounded-xl");

    // The theme toggle and the connection card both use `mb-3` (12px) so the
    // gap between Connected ↔ Theme and Theme ↔ Clock are equal. Without
    // `mb-3` on the theme toggle, the two cards were virtually touching.
    expect(dark.parentElement!.className).toContain("mb-3");
  });

  it("hides the provider pressure counter when there are no recent 429/529 events", () => {
    render(<Sidebar />);
    // scopedEvents is [] in beforeEach, so the pressure counter must not render.
    expect(screen.queryByRole("status", { name: /provider rate-limit/i })).toBeNull();
  });

  it("surfaces the recent provider-pressure count when scopedEvents contain 429/529", () => {
    const now = Date.now();
    const events: HiveEvent[] = [
      { event_id: "e1", session_id: "s1", seq: 1, pid: 1, ts: new Date(now - 30_000).toISOString(), type: "provider_response", actor: "test", payload: { status: 429 } },
      { event_id: "e2", session_id: "s1", seq: 2, pid: 1, ts: new Date(now - 60_000).toISOString(), type: "provider_response", actor: "test", payload: { status: 529 } },
    ];
    store.setState({
      scopedEvents: events,
      now,
    });

    render(<Sidebar />);

    const pressure = screen.getByRole("status");
    expect(pressure.textContent).toMatch(/2×/);
    // The most recent event (newest-first in scopedEvents) is shown as the
    // "latest" status in the title attribute and visible label.
    expect(pressure.textContent).toMatch(/429/);
  });
});
