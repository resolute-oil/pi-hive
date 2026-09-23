import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadAgentRuntime, reloadAgentConfig } from "../src/engine/session.ts";
import { loadConfig } from "../src/core/config.ts";
import type { AgentRuntime, HiveState, SessionState } from "../src/core/types.ts";

// Regression tests for `reloadAgentConfig`.
//
// Background: pi-hive loads agent configs at session_start via `loadConfig`
// and `loadAgentRuntime`. After that, `runtime.config` is frozen for the
// lifetime of the session. `delegate_agent` with `fresh: true` only resets
// conversation continuity (archives the prior transcript, zeroes lifetime
// token/cost counters), it does NOT re-read YAML — so a user who edits an
// agent's .md (e.g. adds a new `domain: upsert: true` grant) and re-delegates
// with `fresh: true` gets denied based on the OLD grant. The runtime is
// authoritative; the YAML is the durable source of truth.
//
// Fix: `dispatchAgent` calls `reloadAgentConfig(state, ctx, runtime)` when
// `fresh === true`. The helper re-runs `loadConfig` + `loadAgentRuntime` for
// just this agent, updates `runtime.config` and `runtime.systemPrompt`, and
// preserves runtime state (counters, runCount, session attachment, timers).
// Best-effort: any failure leaves the runtime untouched and returns false.

interface Fixture {
  cwd: string;
  sessionDir: string;
  orchestratorPath: string;
  plannerPath: string;
  configPath: string;
}

function writeText(path: string, body: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

function fixture(initialPlannerDomain: string, _initialOrchestratorDomain: string): Fixture {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-reload-"));
  const sessionDir = join(cwd, ".pi", "hive", "sessions", "test-session");
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

  const orchestratorPath = join(cwd, ".pi", "hive", "agents", "orchestrator.md");
  const plannerPath = join(cwd, ".pi", "hive", "agents", "specs-planner.md");
  const configPath = join(cwd, ".pi", "hive", "hive-config.yaml");

  writeText(orchestratorPath, `---
model: openai/gpt-5
thinking: medium
agent-type: lead
---
Orchestrate.`);

  writeText(plannerPath, `---
model: openai/gpt-5
thinking: medium
agent-type: planner
stages:
  - specs
---
${initialPlannerDomain}`);

  writeText(configPath, `settings:
  default-tools: read, grep
  distiller:
    enabled: false
  telemetry:
    enabled: false
planning:
  main:
    name: Plan Main
    path: .pi/hive/agents/orchestrator.md
  agents:
    - name: Specs Planner
      path: .pi/hive/agents/specs-planner.md
hive:
  main:
    name: Orchestrator
    path: .pi/hive/agents/orchestrator.md
  agents: []
`);

  // Smoke-check that loadConfig works against the fixture.
  const config = loadConfig(cwd);
  assert.ok(config.hive!.main, "fixture invariant: hive.main present");
  assert.ok(config.planning!.agents.length >= 1, "fixture invariant: at least one planning agent");

  return { cwd, sessionDir, orchestratorPath, plannerPath, configPath };
}

function makeCtx(cwd: string): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    mode: "headless",
    ui: {
      notify: () => {},
      setHeader: () => {},
      setStatus: () => {},
      setWidget: () => {},
      setWorkingVisible: () => {},
    },
  } as unknown as ExtensionContext;
}

function makeSessionState(sessionDir: string): SessionState {
  return {
    sessionId: "test-session",
    sessionDir,
    conversationLog: join(sessionDir, "conversation.jsonl"),
    observabilityLog: join(sessionDir, "hive-events.jsonl"),
  };
}

function makeState(ctx: ExtensionContext, session: SessionState): HiveState {
  return {
    pi: {} as any,
    config: null,
    session,
    runtimes: new Map(),
    widgetCtx: null,
    activeRuns: 0,
    mode: "plan",
    normalToolNames: [],
    sddStatus: null,
    obsSeq: 0,
    latestVerdicts: new Map(),
  };
}

// ── Domain grant picked up after YAML edit ────────────────────────────────

test("reloadAgentConfig picks up a new domain grant added to the agent's .md since session_start", () => {
  const fx = fixture(
    "Planner. Domain: read-only.",
    "Orchestrator. Domain: read-only.",
  );
  const ctx = makeCtx(fx.cwd);
  const state = makeState(ctx, makeSessionState(fx.sessionDir));

  // Initial load — at session_start the planner had read-only access.
  const initialConfig = loadConfig(fx.cwd);
  const initialPlanner = initialConfig.planning!.agents.find((a) => a.name === "Specs Planner")!;
  const initialRuntime = loadAgentRuntime(state, ctx, initialConfig, initialPlanner);
  assert.equal(initialRuntime.config.domain!.length, 0, "fixture: initial domain is empty");

  // User edits the planner's .md to grant upsert on openspec/changes/.
  // Domain validation requires `read` to be explicitly true or false on every
  // scope; defaulting is not allowed.
  writeFileSync(fx.plannerPath, `---
model: openai/gpt-5
thinking: medium
agent-type: planner
stages:
  - specs
domain:
  - path: openspec/changes/
    read: false
    upsert: true
    delete: false
---
Planner with new grant.`);

  // Reload via the helper.
  const reloaded = reloadAgentConfig(state, ctx, initialRuntime);
  assert.equal(reloaded, true, "reload returned true");

  // The runtime's config now reflects the new YAML grant.
  assert.equal(initialRuntime.config.domain!.length, 1, "domain now has one entry");
  const scope = initialRuntime.config.domain![0];
  assert.equal(scope.path, "openspec/changes/");
  assert.equal(scope.upsert, true);
});

// ── Multiple YAML edits propagate in sequence ─────────────────────────────

test("reloadAgentConfig picks up tools edits made between reloads", () => {
  const fx = fixture("Planner.", "Orchestrator.");
  const ctx = makeCtx(fx.cwd);
  const state = makeState(ctx, makeSessionState(fx.sessionDir));

  const config = loadConfig(fx.cwd);
  const planner = config.planning!.agents.find((a) => a.name === "Specs Planner")!;
  const runtime = loadAgentRuntime(state, ctx, config, planner);
  // normalizeTools strips whitespace, so "read, grep" becomes "read,grep".
  assert.equal(runtime.config.tools, "read,grep", "fixture: initial tools from default-tools");

  // Edit hive-config.yaml to add bash to default-tools.
  writeFileSync(fx.configPath, `settings:
  default-tools: read, grep, bash
  distiller:
    enabled: false
  telemetry:
    enabled: false
planning:
  main:
    name: Plan Main
    path: .pi/hive/agents/orchestrator.md
  agents:
    - name: Specs Planner
      path: .pi/hive/agents/specs-planner.md
hive:
  main:
    name: Orchestrator
    path: .pi/hive/agents/orchestrator.md
  agents: []
`);

  // Note: reloadAgentConfig only re-reads the per-agent .md via loadAgentRuntime
  // (which calls parseFrontmatter on the agent path). Settings.* are read once
  // by loadConfig and the planner's `tools` line in the .md overrides
  // settings.default-tools. So a settings change alone doesn't propagate — the
  // user must also touch the .md. This test pins that contract.
  writeFileSync(fx.plannerPath, `---
model: openai/gpt-5
thinking: medium
agent-type: planner
stages:
  - specs
tools: read, grep, bash, write
---
Planner with broader tools.`);

  reloadAgentConfig(state, ctx, runtime);
  assert.equal(runtime.config.tools, "read,grep,bash,write", "tools updated from .md frontmatter");
});

// ── Runtime state is preserved across reload ──────────────────────────────

test("reloadAgentConfig preserves runtime state (runCount, counters, status, lastWork)", () => {
  const fx = fixture("Planner.", "Orchestrator.");
  const ctx = makeCtx(fx.cwd);
  const state = makeState(ctx, makeSessionState(fx.sessionDir));

  const config = loadConfig(fx.cwd);
  const planner = config.planning!.agents.find((a) => a.name === "Specs Planner")!;
  const runtime = loadAgentRuntime(state, ctx, config, planner);

  // Mutate runtime state to non-default values.
  runtime.runCount = 7;
  runtime.inputTokens = 1234;
  runtime.outputTokens = 5678;
  runtime.costUsd = 0.42;
  runtime.status = "running";
  runtime.task = "build the auth flow";
  runtime.lastWork = "auth flow";
  const originalSessionFile = runtime.sessionFile;

  // Edit YAML.
  writeFileSync(fx.plannerPath, `---
model: openai/gpt-5
thinking: medium
agent-type: planner
stages:
  - specs
---
Planner v2.`);

  reloadAgentConfig(state, ctx, runtime);

  // Runtime state preserved.
  assert.equal(runtime.runCount, 7, "runCount preserved");
  assert.equal(runtime.inputTokens, 1234, "inputTokens preserved");
  assert.equal(runtime.outputTokens, 5678, "outputTokens preserved");
  assert.equal(runtime.costUsd, 0.42, "costUsd preserved");
  assert.equal(runtime.status, "running", "status preserved");
  assert.equal(runtime.task, "build the auth flow", "task preserved");
  assert.equal(runtime.lastWork, "auth flow", "lastWork preserved");
  assert.equal(runtime.sessionFile, originalSessionFile, "sessionFile preserved");
});

// ── Reload failure doesn't throw and doesn't mutate runtime ────────────────

test("reloadAgentConfig returns false and leaves runtime untouched when YAML is broken", () => {
  const fx = fixture("Planner.", "Orchestrator.");
  const ctx = makeCtx(fx.cwd);
  const state = makeState(ctx, makeSessionState(fx.sessionDir));

  const config = loadConfig(fx.cwd);
  const planner = config.planning!.agents.find((a) => a.name === "Specs Planner")!;
  const runtime = loadAgentRuntime(state, ctx, config, planner);

  const originalConfigRef = runtime.config;
  const originalPrompt = runtime.systemPrompt;
  runtime.runCount = 3;

  // Corrupt the YAML.
  writeFileSync(fx.configPath, "this is: not: valid: yaml: : :");

  let result: boolean;
  try {
    result = reloadAgentConfig(state, ctx, runtime);
  } catch (err) {
    assert.fail(`reloadAgentConfig threw on broken YAML: ${err}`);
  }
  assert.equal(result, false, "reload returned false on YAML parse failure");
  assert.strictEqual(runtime.config, originalConfigRef, "config reference unchanged");
  assert.equal(runtime.systemPrompt, originalPrompt, "systemPrompt unchanged");
  assert.equal(runtime.runCount, 3, "runCount unchanged");
});

// ── Reload on a removed agent doesn't crash ───────────────────────────────

test("reloadAgentConfig returns false when the agent was removed from hive-config.yaml", () => {
  const fx = fixture("Planner.", "Orchestrator.");
  const ctx = makeCtx(fx.cwd);
  const state = makeState(ctx, makeSessionState(fx.sessionDir));

  const config = loadConfig(fx.cwd);
  const planner = config.planning!.agents.find((a) => a.name === "Specs Planner")!;
  const runtime: AgentRuntime = loadAgentRuntime(state, ctx, config, planner);
  const originalConfigRef = runtime.config;

  // Remove the planner from planning.agents.
  writeFileSync(fx.configPath, `settings:
  default-tools: read, grep
  distiller:
    enabled: false
  telemetry:
    enabled: false
planning:
  main:
    name: Plan Main
    path: .pi/hive/agents/orchestrator.md
  agents: []
hive:
  main:
    name: Orchestrator
    path: .pi/hive/agents/orchestrator.md
  agents: []
`);

  const result = reloadAgentConfig(state, ctx, runtime);
  assert.equal(result, false, "reload returned false when agent removed");
  assert.strictEqual(runtime.config, originalConfigRef, "config unchanged");
});

// ── Reload updates systemPrompt ───────────────────────────────────────────

test("reloadAgentConfig updates runtime.systemPrompt from the new YAML body", () => {
  const fx = fixture("Original body.", "Orchestrator.");
  const ctx = makeCtx(fx.cwd);
  const state = makeState(ctx, makeSessionState(fx.sessionDir));

  const config = loadConfig(fx.cwd);
  const planner = config.planning!.agents.find((a) => a.name === "Specs Planner")!;
  const runtime = loadAgentRuntime(state, ctx, config, planner);
  assert.match(runtime.systemPrompt, /Original body/);

  writeFileSync(fx.plannerPath, `---
model: openai/gpt-5
thinking: medium
agent-type: planner
stages:
  - specs
---
Updated body with new instructions.`);

  reloadAgentConfig(state, ctx, runtime);
  assert.match(runtime.systemPrompt, /Updated body with new instructions/);
});

// ── Reload is a no-op when state.session is missing ───────────────────────

test("reloadAgentConfig returns false when state.session is null", () => {
  const fx = fixture("Planner.", "Orchestrator.");
  const ctx = makeCtx(fx.cwd);

  // Build the runtime with a real session, then null the session afterward to
  // simulate the dispatch-time case where the session is gone but a runtime
  // object still references it. loadAgentRuntime requires a non-null session,
  // so we build first and then null it.
  const state = makeState(ctx, makeSessionState(fx.sessionDir));
  const config = loadConfig(fx.cwd);
  const planner = config.planning!.agents.find((a) => a.name === "Specs Planner")!;
  const runtime = loadAgentRuntime(state, ctx, config, planner);
  state.session = null;

  const result = reloadAgentConfig(state, ctx, runtime);
  assert.equal(result, false, "reload returns false when session is null");
});

// Cleanup the temp fixtures after the suite so the test runner's cwd isn't littered.
test.after(() => {
  // No-op: mkdtempSync fixtures are in os.tmpdir() and the OS will reap them.
  // This hook exists to satisfy lint that flags unused imports otherwise.
  void existsSync;
  void rmSync;
});
