import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HiveState } from "../src/core/types.ts";
import { applyMode } from "../src/ui/tui/widget.ts";

interface SendUserMessageCall {
  content: string;
  options: { deliverAs?: "followUp" | "steer" };
}

// Verbatim trigger text. Source-of-truth lives in src/ui/tui/widget.ts applyMode.
// Re-declared here so this test pins the wording — if the source drifts, the
// assertion fails with the actual text both sides have.
const TRIGGER_TEXT = [
  "You have exited hive or plan mode and the user wants to continue in normal mode. ",
  "Write a concise handoff summary of the work you did in this cycle and call the ",
  "`hive_cycle_summary` tool with that summary. The user will not re-read the hive-mode ",
  "tail; the summary is their only window into what happened. ",
  "If no meaningful work happened, call `hive_cycle_summary` with an empty string.",
].join("");

function makeFixture(opts: {
  initialMode: "normal" | "plan" | "hive";
  snapshotLeafId?: string;
}): { state: HiveState; ctx: ExtensionContext; sendUserMessageCalls: SendUserMessageCall[]; notifications: string[] } {
  const sendUserMessageCalls: SendUserMessageCall[] = [];
  const notifications: string[] = [];
  // Permissive pi mock: only sendUserMessage is exercised by todo 005; the
  // proxy returns no-ops for everything else. The Proxy is typed as the
  // full ExtensionAPI at the helper boundary; the test never reads methods
  // not on the proxy's underlying handlers, so the runtime cast is safe.
  const piHandlers = {
    sendUserMessage: (content: string, options: { deliverAs?: "followUp" | "steer" }) =>
      sendUserMessageCalls.push({ content, options }),
  } as Record<string, (...args: unknown[]) => unknown>;
  const pi: ExtensionAPI = new Proxy(piHandlers, {
    get(target, prop: string) {
      if (typeof prop === "string" && prop in target) return target[prop];
      return () => {};
    },
  }) as unknown as ExtensionAPI;
  const state: HiveState = {
    mode: opts.initialMode,
    activeRuns: 0,
    config: null,
    session: null,
    runtimes: new Map(),
    obsSeq: 0,
    hiveCycleSnapshotLeafId: opts.snapshotLeafId,
    pi,
  } as unknown as HiveState;
  const ctx: ExtensionContext = {
    hasUI: false,
    mode: "headless",
    ui: {
      notify: (m: string) => notifications.push(m),
      setHeader: () => {},
      setStatus: () => {},
      setWidget: () => {},
      setWorkingVisible: () => {},
    },
    sessionManager: { getLeafId: () => null },
    cwd: "/tmp/test-trigger-summary-prompt",
  } as unknown as ExtensionContext;
  return { state, ctx, sendUserMessageCalls, notifications };
}

test("applyMode hive→normal with baseline fires sendUserMessage and stashes pending-restore", () => {
  const { state, ctx, sendUserMessageCalls } = makeFixture({
    initialMode: "hive",
    snapshotLeafId: "leaf-snap",
  });

  const result = applyMode(state, ctx, "normal");

  assert.equal(result, true, "applyMode returns true on successful mode switch");
  assert.equal(sendUserMessageCalls.length, 1, "sendUserMessage called exactly once");
  assert.equal(sendUserMessageCalls[0].content, TRIGGER_TEXT, "trigger text is verbatim");
  assert.deepEqual(sendUserMessageCalls[0].options, { deliverAs: "followUp" });
  assert.ok(state.pendingHiveCycleRestore, "pending-restore set");
  assert.equal(state.pendingHiveCycleRestore?.snapshotLeafId, "leaf-snap");
  assert.equal(state.pendingHiveCycleRestore?.summary, undefined, "summary not yet filled in by the tool");
});

test("applyMode hive→normal without a baseline skips the trigger and leaves pending-restore untouched", () => {
  const { state, ctx, sendUserMessageCalls } = makeFixture({
    initialMode: "hive",
    // snapshotLeafId undefined: simulates a session that started directly in
    // hive mode, so todo 004's no-op restore applies.
  });

  applyMode(state, ctx, "normal");

  assert.equal(sendUserMessageCalls.length, 0, "sendUserMessage NOT called without a baseline");
  assert.equal(state.pendingHiveCycleRestore, undefined, "pending-restore NOT set");
});

test("applyMode hive→hive mid-cycle does not fire the trigger", () => {
  const { state, ctx, sendUserMessageCalls } = makeFixture({
    initialMode: "hive",
    snapshotLeafId: "leaf-snap",
  });

  applyMode(state, ctx, "hive");

  assert.equal(sendUserMessageCalls.length, 0, "mid-cycle re-entry does not fire the trigger");
  assert.equal(state.pendingHiveCycleRestore, undefined);
});

test("applyMode normal→normal does not fire the trigger", () => {
  const { state, ctx, sendUserMessageCalls } = makeFixture({
    initialMode: "normal",
    snapshotLeafId: "leaf-snap",
  });

  applyMode(state, ctx, "normal");

  assert.equal(sendUserMessageCalls.length, 0, "normal→normal does not fire the trigger");
  assert.equal(state.pendingHiveCycleRestore, undefined);
});
