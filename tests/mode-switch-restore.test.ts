import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyMode } from "../src/ui/tui/widget.ts";
import { handleAgentSettledForHiveRestore } from "../src/integration/hooks.ts";
import { createState } from "../src/engine/state.ts";
import { setCommandCtx, clearCommandCtx, getCommandCtx } from "../src/integration/commands.ts";

interface PiCall {
  method: string;
  args: unknown[];
}

// Shape of `state.pi.sendMessage`'s first argument — the custom-type message
// posted to the LLM after a successful or fallback restore. Used to type
// assertion reads of the captured calls.
interface PiMessage {
  customType: string;
  content: string;
  display: boolean;
}

interface Captures {
  navigateTreeCalls: Array<{ targetId: string; options: unknown }>;
  notifyCalls: Array<{ message: string; level: string }>;
  navigateTreeResult: { cancelled: boolean };
}

function makePi(): { pi: ExtensionAPI; calls: PiCall[] } {
  const calls: PiCall[] = [];
  // Partial mock — only the 5 methods the restore tests exercise. The cast
  // to ExtensionAPI is at this single boundary; the test never invokes a
  // method not on the partial, so the runtime cast is safe.
  const partialPi = {
    on: () => {},
    setLabel: (...args: unknown[]) => calls.push({ method: "setLabel", args }),
    setActiveTools: (...args: unknown[]) => calls.push({ method: "setActiveTools", args }),
    sendUserMessage: (...args: unknown[]) => calls.push({ method: "sendUserMessage", args }),
    sendMessage: (...args: unknown[]) => calls.push({ method: "sendMessage", args }),
  };
  return { pi: partialPi as unknown as ExtensionAPI, calls };
}

function makeFixture(opts: { populateSm?: boolean } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-mode-switch-"));
  const sm = SessionManager.inMemory(cwd);
  let leafId: string | null = null;
  if (opts.populateSm) {
    leafId = sm.appendCustomEntry("test-fixture", undefined);
  }
  return { cwd, sm, leafId };
}

function buildCommandCtx(sm: SessionManager, cwd: string, captures: Captures): ExtensionCommandContext {
  return {
    hasUI: false,
    mode: "headless",
    cwd,
    sessionManager: sm,
    waitForIdle: async () => {},
    navigateTree: async (targetId: string, options: unknown) => {
      captures.navigateTreeCalls.push({ targetId, options: options as { summarize: boolean } });
      return captures.navigateTreeResult;
    },
    ui: {
      notify: (message: string, level: string) => captures.notifyCalls.push({ message, level }),
      setHeader: () => {},
      setStatus: () => {},
      setWidget: () => {},
      setWorkingVisible: () => {},
    },
  } as unknown as ExtensionCommandContext;
}

function buildApplyCtx(sm: SessionManager, cwd: string, captures: { notifyCalls: Array<{ message: string; level: string }> }): ExtensionContext {
  return {
    hasUI: false,
    mode: "headless",
    cwd,
    sessionManager: sm,
    ui: {
      notify: (message: string, level: string) => captures.notifyCalls.push({ message, level }),
      setHeader: () => {},
      setStatus: () => {},
      setWidget: () => {},
      setWorkingVisible: () => {},
    },
  } as unknown as ExtensionContext;
}

// Spy on sm.branchWithSummary / sm.branch for capture + optional failure
// injection. Returns a Proxy that delegates to the real SessionManager and
// only intercepts the two methods we care about — the rest fall through
// unchanged. TypeScript sees the Proxy as a SessionManager, so the test
// doesn't need `as any` to inject it as `commandCtx.sessionManager`.
function spySm(realSm: SessionManager, opts: {
  throwOnFirstBranchWithSummary?: boolean;
  alwaysThrowOnBranchWithSummary?: boolean;
} = {}): { proxy: SessionManager; calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];

  const proxy = new Proxy(realSm, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;

      const propName = String(prop);
      if (propName !== "branchWithSummary" && propName !== "branch") {
        return typeof value === "function" ? value.bind(target) : value;
      }

      return (...args: unknown[]) => {
        calls.push({ method: propName, args });
        if (propName === "branchWithSummary") {
          const bwsCount = calls.filter((c) => c.method === "branchWithSummary").length;
          if (opts.alwaysThrowOnBranchWithSummary ||
              (opts.throwOnFirstBranchWithSummary && bwsCount === 1)) {
            throw new Error("simulated branchWithSummary failure");
          }
        }
        return value.apply(target, args);
      };
    },
  });

  return { proxy: proxy as unknown as SessionManager, calls };
}

test.beforeEach(() => clearCommandCtx());
test.afterEach(() => clearCommandCtx());

// ── Case 1: Snapshot on first hive entry (real SessionManager) ────────────

test("applyMode entering hive captures the current leaf as the cycle snapshot via real SessionManager", () => {
  const { cwd, sm, leafId } = makeFixture({ populateSm: true });
  assert.ok(leafId, "fixture invariant: sm has at least one entry");

  const { pi, calls } = makePi();
  const state = createState(pi);
  const notifyCalls: Array<{ message: string; level: string }> = [];
  const ctx = buildApplyCtx(sm, cwd, { notifyCalls });

  const result = applyMode(state, ctx, "hive");

  assert.equal(result, true);
  assert.equal(state.hiveCycleSnapshotLeafId, leafId, "snapshot leaf id matches the entry we appended");

  const setLabelCall = calls.find((c) => c.method === "setLabel");
  assert.ok(setLabelCall, "setLabel was called");
  const [labelId, label] = setLabelCall.args as [string, string];
  assert.equal(labelId, leafId, "setLabel called with the right leaf id");
  assert.match(
    label,
    /^hive-cycle-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/,
    "label matches hive-cycle-<ISO>",
  );
});

// ── Case 3: Trigger fires on hive→normal ──────────────────────────────────

test("applyMode hive→normal with a baseline fires sendUserMessage and stashes pending-restore", () => {
  const { cwd, sm } = makeFixture();
  const { pi, calls } = makePi();
  const state = createState(pi);
  state.mode = "hive";
  state.hiveCycleSnapshotLeafId = "leaf-abc";

  const notifyCalls: Array<{ message: string; level: string }> = [];
  const ctx = buildApplyCtx(sm, cwd, { notifyCalls });

  applyMode(state, ctx, "normal");

  const sendUserMessageCall = calls.find((c) => c.method === "sendUserMessage");
  assert.ok(sendUserMessageCall, "sendUserMessage was called");
  const [content, options] = sendUserMessageCall.args as [string, { deliverAs?: string }];
  assert.match(content, /You have exited hive or plan mode/, "trigger text matches");
  assert.deepEqual(options, { deliverAs: "followUp" });

  assert.ok(state.pendingHiveCycleRestore, "pending-restore set");
  assert.equal(state.pendingHiveCycleRestore?.snapshotLeafId, "leaf-abc");
  assert.equal(state.pendingHiveCycleRestore?.summary, undefined, "summary undefined until tool fires");
});

// ── Case 5: No-op restore when no baseline ────────────────────────────────

test("applyMode hive→normal without a baseline skips the trigger", () => {
  const { cwd, sm } = makeFixture();
  const { pi, calls } = makePi();
  const state = createState(pi);
  state.mode = "hive";
  // No snapshot leaf id — fresh session in hive mode.

  const notifyCalls: Array<{ message: string; level: string }> = [];
  const ctx = buildApplyCtx(sm, cwd, { notifyCalls });

  applyMode(state, ctx, "normal");

  assert.equal(calls.find((c) => c.method === "sendUserMessage"), undefined, "sendUserMessage NOT called");
  assert.equal(state.pendingHiveCycleRestore, undefined, "pending-restore NOT set");
});

// ── Case 4: Restore via agent_settled handler (success) ───────────────────

test("handleAgentSettledForHiveRestore branches and navigates on first-attempt success", async () => {
  const { cwd, sm, leafId } = makeFixture({ populateSm: true });
  assert.ok(leafId, "fixture invariant: sm has at least one entry");

  const { pi, calls } = makePi();
  const state = createState(pi);
  state.pendingHiveCycleRestore = { snapshotLeafId: leafId, summary: "did X and Y" };

  const captures: Captures = {
    navigateTreeCalls: [],
    notifyCalls: [],
    navigateTreeResult: { cancelled: false },
  };
  const { proxy, calls: smCalls } = spySm(sm);
  const commandCtx = buildCommandCtx(proxy, cwd, captures);
  setCommandCtx(commandCtx);
  assert.equal(getCommandCtx(), commandCtx, "fixture invariant: commandCtx is set");

  await handleAgentSettledForHiveRestore(state);

  // First attempt succeeded — no retry.
  const bwsCalls = smCalls.filter((c) => c.method === "branchWithSummary");
  assert.equal(bwsCalls.length, 1, "branchWithSummary called once");
  assert.equal((bwsCalls[0].args as [string, string])[0], leafId, "branched from snapshot leaf");
  assert.equal((bwsCalls[0].args as [string, string])[1], "did X and Y", "used the LLM's summary");

  // Reset leaf (load-bearing — without it, navigateTree is a no-op).
  const branchCalls = smCalls.filter((c) => c.method === "branch");
  assert.deepEqual(
    branchCalls.map((c) => c.args[0]),
    [leafId],
    "sm.branch(reset) called once with snapshot leaf id",
  );

  // Navigate to the new branch.
  assert.equal(captures.navigateTreeCalls.length, 1, "navigateTree called once");
  assert.deepEqual(captures.navigateTreeCalls[0].options, { summarize: false });
  assert.equal(captures.navigateTreeCalls[0].targetId.length > 0, true, "navigateTree targetId is a non-empty leaf id");

  // State cleared after success.
  assert.equal(state.pendingHiveCycleRestore, undefined, "pending-restore cleared after handler");

  // Success notification sent to LLM.
  const sendMessageCall = calls.find((c) => c.method === "sendMessage");
  assert.ok(sendMessageCall, "sendMessage called for the post-restore notification");
  const msg = (sendMessageCall.args as PiMessage[])[0];
  assert.equal(msg.customType, "pi-hive-mode-switch");
  assert.equal(msg.display, false);
});

// ── Case 6: No-op agent_settled when no pending state ─────────────────────

test("handleAgentSettledForHiveRestore is a no-op when pendingHiveCycleRestore is undefined", async () => {
  const { cwd, sm } = makeFixture();
  const { pi } = makePi();
  const state = createState(pi);
  // No pending state.

  const captures: Captures = {
    navigateTreeCalls: [],
    notifyCalls: [],
    navigateTreeResult: { cancelled: false },
  };
  const { proxy, calls: smCalls } = spySm(sm);
  const commandCtx = buildCommandCtx(proxy, cwd, captures);
  setCommandCtx(commandCtx);

  await handleAgentSettledForHiveRestore(state);

  assert.equal(smCalls.filter((c) => c.method === "branchWithSummary").length, 0, "branchWithSummary NOT called");
  assert.equal(captures.navigateTreeCalls.length, 0, "navigateTree NOT called");
});

// ── Case 7: Retry with empty summary on first failure ─────────────────────

test("handleAgentSettledForHiveRestore retries with empty summary when first attempt fails", async () => {
  const { cwd, sm, leafId } = makeFixture({ populateSm: true });
  assert.ok(leafId, "fixture invariant");

  const { pi, calls } = makePi();
  const state = createState(pi);
  state.pendingHiveCycleRestore = { snapshotLeafId: leafId, summary: "did X" };

  const captures: Captures = {
    navigateTreeCalls: [],
    notifyCalls: [],
    navigateTreeResult: { cancelled: false },
  };
  const { proxy, calls: smCalls } = spySm(sm, { throwOnFirstBranchWithSummary: true });
  const commandCtx = buildCommandCtx(proxy, cwd, captures);
  setCommandCtx(commandCtx);

  await handleAgentSettledForHiveRestore(state);

  const bwsCalls = smCalls.filter((c) => c.method === "branchWithSummary");
  assert.equal(bwsCalls.length, 2, "branchWithSummary called twice");
  assert.equal((bwsCalls[0].args as [string, string])[1], "did X", "first call used the LLM's summary");
  assert.equal((bwsCalls[1].args as [string, string])[1], "", "retry used empty summary");

  // Navigate called once with the retry's nid.
  assert.equal(captures.navigateTreeCalls.length, 1, "navigateTree called once (after retry succeeded)");

  // Send-message called with the fallback content.
  const sendMessageCall = calls.find((c) => c.method === "sendMessage");
  assert.ok(sendMessageCall, "sendMessage called");
  const fallbackMsg = (sendMessageCall.args as PiMessage[])[0];
  assert.match(fallbackMsg.content, /empty summary fallback/, "fallback content text");
});

// ── Case 8: Best-effort fallback on second failure ────────────────────────

test("handleAgentSettledForHiveRestore falls back to best-effort when both attempts fail", async () => {
  const { cwd, sm, leafId } = makeFixture({ populateSm: true });
  assert.ok(leafId, "fixture invariant");

  const { pi } = makePi();
  const state = createState(pi);
  state.pendingHiveCycleRestore = { snapshotLeafId: leafId, summary: "did X" };

  const captures: Captures = {
    navigateTreeCalls: [],
    notifyCalls: [],
    navigateTreeResult: { cancelled: false },
  };
  const { proxy, calls: smCalls } = spySm(sm, { alwaysThrowOnBranchWithSummary: true });
  const commandCtx = buildCommandCtx(proxy, cwd, captures);
  setCommandCtx(commandCtx);

  // Capture console.warn to verify the best-effort log.
  const originalWarn = console.warn;
  const warnCalls: unknown[][] = [];
  console.warn = (...args: unknown[]) => { warnCalls.push(args); };

  try {
    await handleAgentSettledForHiveRestore(state);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(smCalls.filter((c) => c.method === "branchWithSummary").length, 2, "branchWithSummary called twice");
  assert.equal(captures.navigateTreeCalls.length, 0, "navigateTree NOT called (both attempts failed)");
  assert.equal(state.pendingHiveCycleRestore, undefined, "pending-restore cleared");
  assert.ok(warnCalls.length > 0, "console.warn called for best-effort log");
  assert.ok(
    warnCalls.some((c) => c.some((arg) => typeof arg === "string" && arg.includes("history restore failed"))),
    "warn message mentions restore failure",
  );
});
