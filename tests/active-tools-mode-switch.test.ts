import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyMode } from "../src/ui/tui/widget.ts";
import { createState } from "../src/engine/state.ts";

// Regression tests for the `setActiveTools` mode-switch gate.
//
// Background: pi-hive's `applyMode` for plan/hive previously called
// `setActiveTools(PLAN_MODE_TOOLS | HIVE_MODE_TOOLS)`, which REPLACED the
// orchestrator's active tool set with pi-hive's own internal list. Any tool
// registered globally at the extension level — most importantly `ask_user`
// from the `pi-ask-user` peer dep — was silently dropped the moment the user
// entered plan or hive mode, even though the tool still appeared in the
// orchestrator's schema description (the schema is global, the handler is
// per-session).
//
// The fix: `applyMode` now MERGES the previously-active tools with the
// hive-internal tools instead of replacing, mirroring the inverse invariant
// `captureNormalTools` already uses on the normal-mode side ("everything
// except hive tools"). These tests pin that contract so the gate can't
// regress back to a replace.

// Stateful mock for `state.pi` that mirrors the real Pi tool-registration
// API: `getActiveTools` and `setActiveTools` share a single mutable array so
// each `setActiveTools` call updates what subsequent `getActiveTools` calls
// return. That is exactly the behavior pi-hive now relies on for the merge.
function makePi(initialActive: string[]): { pi: ExtensionAPI; activeTools: () => string[] } {
  let activeTools = [...initialActive];
  const pi = {
    on: () => {},
    setLabel: () => {},
    setActiveTools(tools: string[]) { activeTools = [...tools]; },
    sendUserMessage: () => {},
    sendMessage: () => {},
    getActiveTools: () => activeTools,
  };
  return { pi: pi as unknown as ExtensionAPI, activeTools: () => activeTools };
}

function makeCtx(sm: SessionManager, cwd: string): ExtensionContext {
  return {
    hasUI: false,
    mode: "headless",
    cwd,
    sessionManager: sm,
    ui: {
      notify: () => {},
      setHeader: () => {},
      setStatus: () => {},
      setWidget: () => {},
      setWorkingVisible: () => {},
    },
  } as unknown as ExtensionContext;
}

function makeFixture() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-active-tools-"));
  const sm = SessionManager.inMemory(cwd);
  return { cwd, sm };
}

// ── Plan mode preserves globally-registered tools ────────────────────────

test("applyMode entering plan preserves globally-registered tools (e.g. ask_user) and adds plan-mode tools", () => {
  const { cwd, sm } = makeFixture();
  // Simulate the orchestrator's main session in normal mode with `ask_user`
  // (peer dep), a couple of pi-hive-internal tools the user has active, and
  // standard Pi tools.
  const { pi, activeTools } = makePi(["ask_user", "read", "bash", "delegate_agent"]);
  const state = createState(pi);
  const ctx = makeCtx(sm, cwd);

  const result = applyMode(state, ctx, "plan");
  assert.equal(result, true);

  const active = activeTools();
  // Peer-dep tool survives the mode transition.
  assert.ok(active.includes("ask_user"), `ask_user preserved after entering plan mode (got: ${active.join(", ")})`);
  // Standard Pi tools survive.
  assert.ok(active.includes("read"));
  assert.ok(active.includes("bash"));
  // Plan-mode hive-internal tools are added.
  assert.ok(active.includes("plan_new"));
  assert.ok(active.includes("plan_select"));
  assert.ok(active.includes("delegate_agent"));
  assert.ok(active.includes("route_agent"));
  assert.ok(active.includes("team_status"));
  assert.ok(active.includes("team_conversation"));
  assert.ok(active.includes("hive_sdd_status"));
  // No duplicates.
  assert.equal(active.length, new Set(active).size, `active tools should be deduplicated (got: ${active.join(", ")})`);
});

// ── Hive mode preserves globally-registered tools ────────────────────────

test("applyMode entering hive preserves globally-registered tools (e.g. ask_user) and adds hive-mode tools", () => {
  const { cwd, sm } = makeFixture();
  const { pi, activeTools } = makePi(["ask_user", "read", "bash"]);
  const state = createState(pi);
  const ctx = makeCtx(sm, cwd);

  const result = applyMode(state, ctx, "hive");
  assert.equal(result, true);

  const active = activeTools();
  assert.ok(active.includes("ask_user"), `ask_user preserved after entering hive mode (got: ${active.join(", ")})`);
  assert.ok(active.includes("read"));
  assert.ok(active.includes("bash"));
  // Hive-mode tool (NOT plan-mode tool) is added.
  assert.ok(active.includes("plan_task_complete"));
  // plan_new / plan_select are plan-only and should NOT be added in hive mode.
  assert.ok(!active.includes("plan_new"), "plan_new not added in hive mode");
  assert.ok(!active.includes("plan_select"), "plan_select not added in hive mode");
});

// ── Round-trip preserves tools across normal ↔ plan ↔ hive cycles ────────

test("applyMode normal → plan → hive → normal preserves ask_user throughout", () => {
  const { cwd, sm } = makeFixture();
  const { pi, activeTools } = makePi(["ask_user", "read", "bash"]);
  const state = createState(pi);
  const ctx = makeCtx(sm, cwd);

  // Seed state.normalToolNames so the normal-mode setActiveTools path
  // (applyMode → setActiveTools(state.normalToolNames)) restores the
  // user-visible "everything except hive tools" set.
  state.normalToolNames = ["ask_user", "read", "bash"];

  applyMode(state, ctx, "plan");
  assert.ok(activeTools().includes("ask_user"), "ask_user survives plan entry");
  assert.ok(activeTools().includes("plan_new"), "plan_new added");

  applyMode(state, ctx, "hive");
  assert.ok(activeTools().includes("ask_user"), "ask_user survives plan→hive");
  assert.ok(activeTools().includes("plan_task_complete"), "plan_task_complete added on hive entry");
  // plan_new is exclusive to plan mode — entering hive should drop it.
  assert.ok(!activeTools().includes("plan_new"), "plan_new dropped on hive entry");
  assert.ok(!activeTools().includes("plan_select"), "plan_select dropped on hive entry");

  applyMode(state, ctx, "normal");
  // Normal mode restores from state.normalToolNames (the inverse gate), so
  // hive-internal tools get stripped but ask_user is back to whatever was
  // captured at session start.
  assert.ok(activeTools().includes("ask_user"), "ask_user restored in normal mode");
  assert.ok(activeTools().includes("read"));
  assert.ok(activeTools().includes("bash"));
  assert.ok(!activeTools().includes("plan_task_complete"), "hive-internal tools stripped in normal mode");
  assert.ok(!activeTools().includes("plan_new"), "plan-internal tools stripped in normal mode");
});

// ── Idempotent on no-op transitions ──────────────────────────────────────

test("applyMode normal → normal does not drop previously-active tools", () => {
  const { cwd, sm } = makeFixture();
  const { pi, activeTools } = makePi(["ask_user", "read", "bash"]);
  const state = createState(pi);
  state.normalToolNames = ["ask_user", "read", "bash"];
  state.mode = "normal";
  const ctx = makeCtx(sm, cwd);

  applyMode(state, ctx, "normal");

  assert.ok(activeTools().includes("ask_user"));
  assert.ok(activeTools().includes("read"));
  assert.ok(activeTools().includes("bash"));
});
