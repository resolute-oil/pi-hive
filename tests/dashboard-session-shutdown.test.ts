// Regression tests for the dashboard session-shutdown cleanup behavior.
//
// Background: when a pi session quits, the dashboard server (if owned by
// that session) should be killed so the user-visible UX matches
// "/hive:observe closes when pi closes". The pre-fix handler in
// `src/integration/hooks.ts` deliberately dropped the session's
// dashboard reference without killing the process because the daemon
// was treated as a shared global — that decision was wrong for the
// single-session quit case.
//
// `killOwnedDashboardOnQuit(state, reason)` is the new helper the
// session_shutdown handler invokes. Its behavior matrix:
//
//   reason=quit + this session spawned (adopted=false)  → call stop()
//   reason=quit + adopted=true (this session adopted)   → no-op
//   reason=quit + no dashboard on state                 → no-op
//   reason=reload/new/resume/fork (any obsServer)       → no-op (daemon
//                                                         shared for next
//                                                         session to adopt)
//
// If `stop()` throws, the helper swallows the error and returns []
// — the daemon's own server-side idle-timeout fallback still
// terminates it once the browser SSE stream disconnects, and a
// shutdown-hook error must never block the rest of session_shutdown.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createState } from "../src/engine/state.ts";
import { killOwnedDashboardOnQuit } from "../src/engine/dashboard.ts";

// Minimal pi stub — `createState` only reads `pi` from the return value
// shape; nothing in these tests exercises pi behavior.
function stubPi(): ExtensionAPI {
  return {} as ExtensionAPI;
}

// `stop` injection — every test passes a spy that records calls and
// returns a fake PID list, so we can assert whether killOwnedDashboardOnQuit
// actually invoked the shutdown path.
interface StopSpy {
  calls: number;
  fn: () => Promise<number[]>;
}

function makeStopSpy(returnValue: number[] = [12345]): StopSpy {
  const spy: StopSpy = {
    calls: 0,
    fn: async () => {
      spy.calls += 1;
      return returnValue;
    },
  };
  return spy;
}

// ── quit + spawned → stop is called ────────────────────────────────────────

test("killOwnedDashboardOnQuit: quit + spawned dashboard calls stop()", async () => {
  const state = createState(stubPi());
  state.obsServer = { proc: {} as any, url: "http://127.0.0.1:43191", port: 43191, host: "127.0.0.1", adopted: false };
  const spy = makeStopSpy([99999]);
  const killed = await killOwnedDashboardOnQuit(state, "quit", { stop: spy.fn as any });
  assert.equal(spy.calls, 1, "stop() must be invoked exactly once");
  assert.deepEqual(killed, [99999], "returned PIDs come from stop()");
});

// ── quit + adopted → stop is NOT called ────────────────────────────────────

test("killOwnedDashboardOnQuit: quit + adopted dashboard leaves daemon alone", async () => {
  const state = createState(stubPi());
  state.obsServer = { url: "http://127.0.0.1:43191", port: 43191, host: "127.0.0.1", adopted: true };
  const spy = makeStopSpy();
  const killed = await killOwnedDashboardOnQuit(state, "quit", { stop: spy.fn as any });
  assert.equal(spy.calls, 0, "stop() must NOT be called for adopted dashboards");
  assert.deepEqual(killed, []);
});

test("killOwnedDashboardOnQuit: quit + no obsServer on state leaves daemon alone", async () => {
  const state = createState(stubPi());
  // state.obsServer is undefined
  const spy = makeStopSpy();
  const killed = await killOwnedDashboardOnQuit(state, "quit", { stop: spy.fn as any });
  assert.equal(spy.calls, 0, "stop() must NOT be called when no dashboard is recorded");
  assert.deepEqual(killed, []);
});

// ── non-quit reasons leave the daemon alone ────────────────────────────────

test("killOwnedDashboardOnQuit: reload reason leaves daemon alone (shared for reloaded session)", async () => {
  const state = createState(stubPi());
  state.obsServer = { proc: {} as any, url: "http://127.0.0.1:43191", port: 43191, host: "127.0.0.1", adopted: false };
  const spy = makeStopSpy();
  await killOwnedDashboardOnQuit(state, "reload", { stop: spy.fn as any });
  assert.equal(spy.calls, 0, "reload must not kill the daemon");
});

test("killOwnedDashboardOnQuit: new session reason leaves daemon alone", async () => {
  const state = createState(stubPi());
  state.obsServer = { proc: {} as any, url: "http://127.0.0.1:43191", port: 43191, host: "127.0.0.1", adopted: false };
  const spy = makeStopSpy();
  await killOwnedDashboardOnQuit(state, "new", { stop: spy.fn as any });
  assert.equal(spy.calls, 0, "session switch must not kill the daemon");
});

test("killOwnedDashboardOnQuit: resume reason leaves daemon alone", async () => {
  const state = createState(stubPi());
  state.obsServer = { proc: {} as any, url: "http://127.0.0.1:43191", port: 43191, host: "127.0.0.1", adopted: false };
  const spy = makeStopSpy();
  await killOwnedDashboardOnQuit(state, "resume", { stop: spy.fn as any });
  assert.equal(spy.calls, 0, "session resume must not kill the daemon");
});

test("killOwnedDashboardOnQuit: fork reason leaves daemon alone", async () => {
  const state = createState(stubPi());
  state.obsServer = { proc: {} as any, url: "http://127.0.0.1:43191", port: 43191, host: "127.0.0.1", adopted: false };
  const spy = makeStopSpy();
  await killOwnedDashboardOnQuit(state, "fork", { stop: spy.fn as any });
  assert.equal(spy.calls, 0, "session fork must not kill the daemon");
});

// ── error path: stop throws, helper swallows and returns [] ───────────────

test("killOwnedDashboardOnQuit: stop() throws → returns [] and does not rethrow", async () => {
  const state = createState(stubPi());
  state.obsServer = { proc: {} as any, url: "http://127.0.0.1:43191", port: 43191, host: "127.0.0.1", adopted: false };
  // Capture console.warn so the test output stays clean and we can
  // assert the warning fires once.
  const originalWarn = console.warn;
  const warnArgs: unknown[][] = [];
  console.warn = (...args: unknown[]) => { warnArgs.push(args); };
  try {
    const throwingStop = async () => { throw new Error("simulated shutdown failure"); };
    const killed = await killOwnedDashboardOnQuit(state, "quit", { stop: throwingStop });
    assert.deepEqual(killed, [], "failed stop() must resolve to an empty PID list");
    assert.equal(warnArgs.length, 1, "warning must be logged exactly once");
    const message = String(warnArgs[0][0] ?? "");
    assert.ok(message.includes("dashboard stop failed"), `warning prefix should mention the failure: ${message}`);
  } finally {
    console.warn = originalWarn;
  }
});

// ── state is not mutated by the helper ─────────────────────────────────────

test("killOwnedDashboardOnQuit: leaves state.obsServer unchanged", async () => {
  // The session_shutdown handler in hooks.ts is responsible for clearing
  // state.obsServer AFTER calling the helper. The helper itself must
  // not mutate state — it only inspects.
  const state = createState(stubPi());
  const before = { proc: {} as any, url: "http://127.0.0.1:43191", port: 43191, host: "127.0.0.1", adopted: false };
  state.obsServer = { ...before };
  await killOwnedDashboardOnQuit(state, "quit", { stop: makeStopSpy().fn as any });
  assert.deepEqual(state.obsServer, before, "state.obsServer must remain intact");
});
