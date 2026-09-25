import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
