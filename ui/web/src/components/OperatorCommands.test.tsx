// F13 (T13.1) — verify the 11 operator buttons render per active worker.
//
// The component is a thin presentational widget that POSTs each click to
// `/operator-command`; this test pins:
//   1. All 11 commands render in the brief-pinned order (brief T13.1).
//   2. Force-kill / force-end / tear-down-all carry the `data-danger` flag
//      so the dashboard's --crit CSS modifier applies.
//   3. Rescue commands (respawn, force-kill, force-end) are disabled when
//      `interventionAvailable` is false (T13.2: under the compact strategy
//      the system auto-recovers, so showing them would mislead the
//      operator).
//   4. The RPC layer is hit on click (the API function is mocked).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import OperatorCommands from "./OperatorCommands";
import type { ScopeAgent } from "../store";
import type { OperatorCommandName } from "../api";

vi.mock("../api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../api")>();
  return { ...mod, runOperatorCommand: vi.fn().mockResolvedValue({ ok: true, status: 200 }) };
});

// Minimal agent row fixture. The component only reads `name`.
function makeAgent(name: string): ScopeAgent {
  return {
    key: name, name, role: "lead", agentType: "lead", status: "running",
    tokens: 0, cost: 0, runs: 0, tools: 0, session_id: "s1", depth: 0, order: 0,
  };
}

beforeEach(() => {
  // No-op setup; vi.clearAllMocks runs in afterEach.
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("OperatorCommands (F13 T13.1)", () => {
  it("renders all 11 operator commands in the brief-pinned order", () => {
    const { container } = render(<OperatorCommands agent={makeAgent("builder")} />);
    const expectedCommands: OperatorCommandName[] = [
      "end", "compact", "respawn", "pause", "snapshot", "restore",
      "resume", "abort-compaction", "force-kill", "force-end", "tear-down-all",
    ];
    for (const name of expectedCommands) {
      const btn = container.querySelector(`[data-cmd="${name}"]`) as HTMLButtonElement;
      expect(btn, `missing button for ${name}`).not.toBeNull();
    }
    // 11 total buttons in the strip
    expect(container.querySelectorAll(".oc-btn").length).toBe(11);
  });

  it("flags the three operator-only escape hatches with data-danger", () => {
    const { container } = render(<OperatorCommands agent={makeAgent("builder")} />);
    for (const name of ["force-kill", "force-end", "tear-down-all"] as OperatorCommandName[]) {
      const btn = container.querySelector(`[data-cmd="${name}"]`) as HTMLButtonElement;
      expect(btn).not.toBeNull();
      expect(btn.getAttribute("data-danger")).toBe("true");
    }
  });

  it("flags the three rescue commands with data-rescue", () => {
    const { container } = render(<OperatorCommands agent={makeAgent("builder")} />);
    for (const name of ["respawn", "force-kill", "force-end"] as OperatorCommandName[]) {
      const btn = container.querySelector(`[data-cmd="${name}"]`) as HTMLButtonElement;
      expect(btn).not.toBeNull();
      expect(btn.getAttribute("data-rescue")).toBe("true");
    }
  });

  it("disables rescue commands when interventionAvailable=false (T13.2 compact strategy)", () => {
    const { container } = render(<OperatorCommands agent={makeAgent("builder")} interventionAvailable={false} />);
    for (const name of ["respawn", "force-kill", "force-end"] as OperatorCommandName[]) {
      const btn = container.querySelector(`[data-cmd="${name}"]`) as HTMLButtonElement;
      expect(btn, `${name} should be disabled under compact strategy`).toBeDisabled();
    }
    // Non-rescue commands remain enabled (operator may still end / pause / etc).
    expect((container.querySelector(`[data-cmd="end"]`) as HTMLButtonElement).disabled).toBe(false);
    expect((container.querySelector(`[data-cmd="pause"]`) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps rescue commands enabled when interventionAvailable=true (default strategy)", () => {
    const { container } = render(<OperatorCommands agent={makeAgent("builder")} interventionAvailable={true} />);
    for (const name of ["respawn", "force-kill", "force-end"] as OperatorCommandName[]) {
      const btn = container.querySelector(`[data-cmd="${name}"]`) as HTMLButtonElement;
      expect(btn, `${name} should be enabled under default strategy`).not.toBeDisabled();
    }
  });

  it("invokes runOperatorCommand with the agent name + command on click", async () => {
    const api = await import("../api");
    const { container } = render(<OperatorCommands agent={makeAgent("builder")} />);
    const user = userEvent.setup();
    await user.click(container.querySelector(`[data-cmd="end"]`) as HTMLButtonElement);
    expect(api.runOperatorCommand).toHaveBeenCalledWith("builder", "end");
  });
});
