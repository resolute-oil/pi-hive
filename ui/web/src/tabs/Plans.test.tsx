import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../store";

// vi.mock factories are hoisted above all imports, so any mock references
// shared between the factory and the test body have to live inside vi.hoisted.
// Vitest's restoreMocks: true wipes implementations between tests, so the
// spy creation goes in vi.hoisted but per-test return values are configured
// in beforeEach after the restore has already happened.
const mocks = vi.hoisted(() => ({
  bootCwd: vi.fn(),
  fetchPlans: vi.fn(),
  fetchPlanDetail: vi.fn(),
  fetchPlanFile: vi.fn(),
  createReviewSession: vi.fn(),
}));

vi.mock("../api", () => ({
  bootCwd: mocks.bootCwd,
  fetchPlans: mocks.fetchPlans,
  fetchPlanDetail: mocks.fetchPlanDetail,
  fetchPlanFile: mocks.fetchPlanFile,
  createReviewSession: mocks.createReviewSession,
}));

import Plans from "./Plans";

const SAMPLE_MARKDOWN = [
  "# Demo change",
  "",
  "A short proposal for the demo change.",
  "",
  "- use sessions",
  "- support OIDC",
  "",
  "```ts",
  "const a = 1;",
  "```",
].join("\n");

// The plan-row button's accessible name concatenates its row content (id +
// status + relative timestamp), so an exact match would fail. Use a regex.
const DEMO_ROW = /demo-change/i;

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dataset.theme = "dark";
  mocks.bootCwd.mockResolvedValue("/test/project");
  mocks.fetchPlans.mockResolvedValue([
    { changeId: "demo-change", status: "in-progress", totalTasks: 0, completedTasks: 0, latestVerdict: null, lastModified: "2026-01-01T00:00:00Z" },
  ]);
  mocks.fetchPlanDetail.mockResolvedValue({
    changeId: "demo-change",
    files: ["proposal.md", "design.md"],
    artifacts: [
      { id: "proposal", status: "done", displayLabel: "Proposal", outputPath: "proposal.md" },
      { id: "design", status: "ready", displayLabel: "Design", outputPath: "design.md" },
    ],
    artifactReview: [],
    validation: { passed: true, failed: 0, issues: [] },
    taskProgress: [],
    readyToExecute: false,
  });
  mocks.createReviewSession.mockResolvedValue({
    reviewUrl: "/pl-review/?rid=demo-change%23proposal.md&cwd=/test/project&nonce=n",
    expiresAt: "2026-01-01T01:00:00Z",
  });
  store.setState({
    activeTab: "plans",
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
    scopedSessions: [],
    scopedEvents: [],
    scopedDelegations: [],
    scopedAgents: [],
    scopedAgentCount: 0,
    scopedTeamCount: 0,
    scopedStats: { sessions: 0, live: 0, running: 0, tokens: 0, cost: 0 },
    scopedKpis: { tokens: 0, cost: 0, ctx: 0, sessions: 0, live: 0, running: 0 },
    topologyByHash: new Map(),
    modelLevels: new Map(),
  } as any);
});

afterEach(async () => {
  // Let React unmount the portal first; clearing document.body while a
  // createPortal child is still attached trips jsdom's removeChild guard.
  await new Promise((r) => setTimeout(r, 0));
});

describe("Plans preview markdown button", () => {
  it("renders the preview button in the review toolbar once an artifact is selected", async () => {
    const user = userEvent.setup();
    render(<Plans search="" />);
    await user.click(await screen.findByRole("button", { name: DEMO_ROW }));
    expect(await screen.findByRole("button", { name: /Preview/i })).toBeInTheDocument();
  });

  it("opens the modal with the rendered markdown when the preview button is clicked", async () => {
    const user = userEvent.setup();
    mocks.fetchPlanFile.mockResolvedValue({ content: SAMPLE_MARKDOWN, size: SAMPLE_MARKDOWN.length });
    render(<Plans search="" />);
    await user.click(await screen.findByRole("button", { name: DEMO_ROW }));
    await user.click(await screen.findByRole("button", { name: /Preview/i }));
    const dialog = await screen.findByRole("dialog", { name: /Markdown preview/i });
    await waitFor(() => expect(mocks.fetchPlanFile).toHaveBeenCalledWith("demo-change", "proposal.md", "/test/project"));
    await waitFor(() => expect(dialog.querySelector("h1")?.textContent).toBe("Demo change"));
    expect(dialog.textContent).toContain("support OIDC");
  });

  it("closes the modal when the close button is clicked", async () => {
    const user = userEvent.setup();
    mocks.fetchPlanFile.mockResolvedValue({ content: SAMPLE_MARKDOWN, size: SAMPLE_MARKDOWN.length });
    render(<Plans search="" />);
    await user.click(await screen.findByRole("button", { name: DEMO_ROW }));
    await user.click(await screen.findByRole("button", { name: /Preview/i }));
    await screen.findByRole("dialog", { name: /Markdown preview/i });
    await user.click(screen.getByRole("button", { name: /Close markdown preview/i }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Markdown preview/i })).toBeNull());
  });

  it("surfaces a missing-artifact message when the file is not on disk", async () => {
    const user = userEvent.setup();
    mocks.fetchPlanFile.mockResolvedValue({ content: null, error: true });
    render(<Plans search="" />);
    await user.click(await screen.findByRole("button", { name: DEMO_ROW }));
    await user.click(await screen.findByRole("button", { name: /Preview/i }));
    const dialog = await screen.findByRole("dialog", { name: /Markdown preview/i });
    await waitFor(() => expect(dialog.textContent).toContain("not yet authored"));
  });

  it("hides the preview button when the artifact is already approved", async () => {
    const user = userEvent.setup();
    // The inline approved-artifact panel also reads the file, so the fetch
    // has to resolve (with any markdown) — otherwise the readOnlyMarkdown
    // effect throws before the bar renders.
    mocks.fetchPlanFile.mockResolvedValue({ content: SAMPLE_MARKDOWN, size: SAMPLE_MARKDOWN.length });
    mocks.fetchPlanDetail.mockResolvedValue({
      changeId: "demo-change",
      files: ["proposal.md", "design.md"],
      artifacts: [
        { id: "proposal", status: "done", displayLabel: "Proposal", outputPath: "proposal.md" },
        { id: "design", status: "ready", displayLabel: "Design", outputPath: "design.md" },
      ],
      artifactReview: [{ id: "proposal", humanVerdict: "green", humanReviewReady: true }],
      validation: { passed: true, failed: 0, issues: [] },
      taskProgress: [],
      readyToExecute: true,
    });
    render(<Plans search="" />);
    await user.click(await screen.findByRole("button", { name: DEMO_ROW }));
    // The approved inline panel renders the markdown already; the modal
    // would be redundant. The Preview button should be gone.
    await waitFor(() => expect(screen.queryByRole("button", { name: /Preview/i })).toBeNull());
    // Fullscreen remains available in all review states.
    expect(screen.getByRole("button", { name: /Fullscreen/i })).toBeInTheDocument();
  });
});

describe("Plans row StatusBadge color code", () => {
  // The row StatusBadge reports the OpenSpec CLI's task-execution state
  // (`status: "in-progress" | "complete" | "no-tasks"`). "In progress" is an
  // active-execution signal — workers are reporting `markExecutionTaskComplete`,
  // the gate may be open, there's nothing to warn about — so the pill must
  // NOT share the dashboard's `text-warn bg-warn-soft` color (which is used
  // for failing validation and yellow reviewer verdicts). It should use the
  // project's `run` semantic (same tone as streaming sessions / `tl-type`).
  //
  // jsdom doesn't compute Tailwind classes, so the regression is pinned at
  // the source-CSS level: read base.css and assert that the
  // `.plan-status-in-progress` rule applies the run-toned utilities and does
  // not apply the warn-toned ones.
  it(".plan-status-in-progress uses the run token, not the warn token", () => {
    const css = readFileSync(join(__dirname, "..", "base.css"), "utf8");
    const rule = css.match(/\.plan-status-in-progress\s*\{[^}]*\}/);
    expect(rule, "expected a .plan-status-in-progress rule in base.css").not.toBeNull();
    const body = rule![0];
    expect(body).toMatch(/text-run/);
    expect(body).toMatch(/bg-run-soft/);
    expect(body).not.toMatch(/text-warn/);
    expect(body).not.toMatch(/bg-warn-soft/);
  });
});

describe("Plans URL sync (?selected=<change-id>)", () => {
  // The selected plan is reflected in the URL so a hard refresh or a shared
  // link lands on the same plan. pushState is used on selection so the back
  // and forward buttons navigate between selections; a popstate listener
  // updates local state when the URL changes externally.
  beforeEach(() => {
    // Reset to a clean `/plans` URL before each test. pushState, not direct
    // assignment, because jsdom's window.location is read-only.
    window.history.replaceState(null, "", "/plans");
  });

  it("URL reflects the selected change id when a plan row is clicked", async () => {
    const user = userEvent.setup();
    render(<Plans search="" />);
    await user.click(await screen.findByRole("button", { name: DEMO_ROW }));
    expect(window.location.search).toContain("selected=demo-change");
  });

  it("preselects the plan named in the URL on mount and fetches its detail", async () => {
    // Regression for the smoke-test symptom: visiting `/plans?selected=X`
    // and reloading left the detail panel stuck at "Loading OpenSpec
    // change…" because useUrlPlanSelection initialized `selected` from the
    // URL but no fetch was triggered on mount. The fix is a useEffect that
    // calls selectPlan whenever `selected` is non-null — verified here by
    // asserting that fetchPlanDetail was called AND the artifact panel
    // renders content (the artifact display labels, not just the row being
    // highlighted).
    window.history.replaceState(null, "", "/plans?selected=demo-change");
    render(<Plans search="" />);
    const row = await screen.findByRole("button", { name: DEMO_ROW });
    expect(row.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(mocks.fetchPlanDetail).toHaveBeenCalledWith("demo-change", "/test/project", expect.anything()));
    // The fixture has proposal (done) and design (ready) as artifacts.
    // Proposal renders as an authored-artifact chip; design renders as the
    // "up next" hint. Both are signals that the detail panel resolved —
    // before the fix, neither rendered because detail stayed null and the
    // panel showed "Loading OpenSpec change…".
    await screen.findByText("Proposal");
    await screen.findByText(/up next: Design/);
    expect(screen.queryByText(/Loading OpenSpec change/i)).toBeNull();
  });

  it("fetches the detail after popstate changes the URL to a new ?selected", async () => {
    // The back/forward path: useUrlPlanSelection's popstate listener updates
    // `selected` from the URL, and the new useEffect on `selected` triggers
    // the fetch. Fixture has only one plan, so we simulate a "back to no
    // selection" then "forward to a selection" by manipulating the URL and
    // dispatching popstate. The detail fetch must fire on the forward step.
    window.history.replaceState(null, "", "/plans");
    render(<Plans search="" />);
    expect(mocks.fetchPlanDetail).not.toHaveBeenCalled();
    // Forward to ?selected=demo-change via simulated popstate.
    window.history.replaceState(null, "", "/plans?selected=demo-change");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(mocks.fetchPlanDetail).toHaveBeenCalledWith("demo-change", "/test/project", expect.anything()));
    await screen.findByText("Proposal");
  });

  it("restores prior selection when the user navigates back via popstate", async () => {
    const user = userEvent.setup();
    render(<Plans search="" />);
    // First click selects "demo-change" (pushState "?selected=demo-change").
    await user.click(await screen.findByRole("button", { name: DEMO_ROW }));
    expect(window.location.search).toContain("selected=demo-change");
    // The fixture has only one plan, so simulate a back-navigation by
    // manually popping state to a URL with no `selected` and dispatching
    // popstate — the hook should reset selection.
    window.history.replaceState(null, "", "/plans");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => {
      const row = screen.getByRole("button", { name: DEMO_ROW });
      expect(row.getAttribute("aria-pressed")).toBe("false");
    });
  });
});
