import assert from "node:assert/strict";
import { test } from "node:test";
import { applyMode } from "../src/ui/tui/widget.ts";

interface SetLabelCall {
  id: string;
  label: string;
}

function makeFixture(opts: {
  initialMode: "normal" | "plan" | "hive";
  leafId: string | null;
  existingSnapshotLeafId?: string;
  activeRuns?: number;
}) {
  const setLabelCalls: SetLabelCall[] = [];
  const notifications: string[] = [];
  // Permissive pi mock. applyMode and its callees (installHeader,
  // startHiveTelemetrySession, startDashboardActionPoller, captureNormalTools)
  // touch a handful of pi methods; we only care about setLabel here. Proxy
  // defaults all unhandled methods to no-ops so the tests below can probe just
  // the snapshot logic without rebuilding the full ExtensionAPI surface.
  const piHandlers: Record<string, (...args: any[]) => any> = {
    setLabel: (id: string, label: string) => setLabelCalls.push({ id, label }),
  };
  const pi: any = new Proxy(piHandlers, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return () => {};
    },
  });
  // Mirrors the cast-through-any style in tests/modes.test.ts — applyMode only
  // touches the fields it actually uses, so we can mock the rest.
  const state = {
    mode: opts.initialMode,
    activeRuns: opts.activeRuns ?? 0,
    config: null,
    session: null,
    runtimes: new Map(),
    obsSeq: 0,
    hiveCycleSnapshotLeafId: opts.existingSnapshotLeafId,
    pi,
  } as any;
  const ctx = {
    hasUI: false,
    mode: "headless",
    ui: {
      notify: (m: string) => notifications.push(m),
      setHeader: () => {},
      setStatus: () => {},
      setWidget: () => {},
      setWorkingVisible: () => {},
    },
    sessionManager: { getLeafId: () => opts.leafId },
    cwd: "/tmp/test-snapshot-capture",
  } as any;
  return { state, ctx, setLabelCalls, notifications };
}

test("applyMode entering hive from normal captures the current leaf as the cycle snapshot", () => {
  const { state, ctx, setLabelCalls } = makeFixture({
    initialMode: "normal",
    leafId: "leaf-xyz",
  });

  assert.equal(applyMode(state, ctx, "hive"), true);
  assert.equal(state.hiveCycleSnapshotLeafId, "leaf-xyz");
  assert.equal(setLabelCalls.length, 1);
  assert.equal(setLabelCalls[0].id, "leaf-xyz");
  // Label format: hive-cycle-<ISO-stamp-without-: or .> — filesystem-safe and
  // grep-friendly.
  assert.match(setLabelCalls[0].label, /^hive-cycle-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
});

test("applyMode mid-cycle re-entry (mode unchanged) does NOT overwrite the snapshot", () => {
  const { state, ctx, setLabelCalls } = makeFixture({
    initialMode: "hive",
    leafId: "leaf-new",
    existingSnapshotLeafId: "leaf-original",
  });

  applyMode(state, ctx, "hive");
  assert.equal(state.hiveCycleSnapshotLeafId, "leaf-original", "snapshot unchanged on mid-cycle re-entry");
  assert.equal(setLabelCalls.length, 0, "setLabel not called on mid-cycle re-entry");
});

test("applyMode when getLeafId returns null skips the snapshot without crashing", () => {
  const { state, ctx, setLabelCalls } = makeFixture({
    initialMode: "normal",
    leafId: null,
  });

  assert.equal(applyMode(state, ctx, "hive"), true);
  assert.equal(state.hiveCycleSnapshotLeafId, undefined, "no snapshot when leaf id is null");
  assert.equal(setLabelCalls.length, 0);
});

test("applyMode entering hive with null getLeafId clears any prior hiveCycleSnapshotLeafId", () => {
  // Stale snapshot from a prior (still-clearing) cycle. The invariant 004
  // enforces: each entry transition rewrites the field, so its presence means
  // "this cycle's snapshot." Without this, a sequence where the previous
  // cycle's restore handler hadn't completed would let the prior leaf id
  // linger and steer the next restore to the wrong point.
  const { state, ctx, setLabelCalls } = makeFixture({
    initialMode: "normal",
    leafId: null,
    existingSnapshotLeafId: "leaf-from-prior-cycle",
  });
  assert.equal(state.hiveCycleSnapshotLeafId, "leaf-from-prior-cycle", "fixture invariant: prior snapshot set");

  assert.equal(applyMode(state, ctx, "hive"), true);
  assert.equal(state.hiveCycleSnapshotLeafId, undefined, "prior snapshot cleared on entry with null leaf id");
  assert.equal(setLabelCalls.length, 0, "setLabel not called when leaf id is null");
});
