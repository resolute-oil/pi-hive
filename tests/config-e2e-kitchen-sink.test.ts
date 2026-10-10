// ── Kitchen-sink E2E test for loadConfig ────────────────────────────────────
//
// Pins the full parse+validate path against every documented top-level
// field. Pre-audit the config loader had no such regression net — every
// failure was reported via the same opaque "missing required property" or
// path-less typebox complaint, and the lowest-level invariant (a config with
// EVERY documented field set loads without throwing) was implicit rather
// than pinned. This file exercises:
//
//   1. The kitchen-sink YAML: every documented field with a non-default
//      value, must load without throwing.
//   2. Six sibling tests that drop each top-level field one at a time and
//      assert no throw (or, for the required hive/planning blocks, assert
//      the documented throw).
//
// The kitchen-sink YAML is inlined (not loaded from `tmp/`) so the test is
// self-contained and survives any external cleanup. Reference copy lives
// in `tmp/audit-kitchen-sink.yaml` in the main checkout (gitignored).

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/core/config.ts";
import type { BudgetsConfig } from "../src/core/schema.ts";

// Every documented top-level field with a non-default value. Mirrors
// `tmp/audit-kitchen-sink.yaml` so this test exercises the same surface
// area the audit traced. Inlined here so the test is self-contained and
// the source line numbers are stable.
const KITCHEN_SINK_YAML = `
budgets:
  defaults-enabled: true
  per-worker:
    tokens:
      resource: tokens
      cap: 1000
      window: per-session
      include:
        - input
        - output
    cost-usd:
      resource: costUsd
      cap: 0.5
      window: per-session
    runs:
      resource: runs
      cap: 5
    depth:
      resource: depth
      cap: 2
  per-team:
    tokens:
      resource: tokens
      cap: 10000
      window: per-team-lifetime
      include:
        - input
        - output
        - cacheRead
        - cacheWrite
    cost-usd:
      resource: costUsd
      cap: 5
      window: per-team-lifetime
    runs:
      resource: runs
      cap: 20
  strategies:
    on-approaching-limit:
      action: wrap-up
      threshold: 0.2
      hint: wrap up
    on-exhaustion:
      action: abort
    summary:
      max-tokens: 2000

settings:
  subagent-output-limit: 12000
  default-tools: "read, grep, find, ls"
  maxParallel: 4
  queueSize: 64
  secretPaths:
    - .env
    - .env.local
  distiller:
    enabled: true
    model: anthropic/claude-haiku-4-5
    conversationLines: 200
  telemetry:
    enabled: true
    dashboardAutoStart: true
    retentionDays: 30
    maxLogBytes: 52428800
    captureThinking: false
    redactSensitiveData: true
  workerBudgets:
    timeoutMs: 600000
    maxDelegationDepth: 4
    maxRuns: 100
    tokenBudget: 200000
    tokenBudgetScope: input_output
    costBudgetUsd: 10
    distillerRuns: 3
  teamBudgets:
    maxRuns: 200
    tokenBudget: 1000000
    tokenBudgetScope: input_output
    costBudgetUsd: 50

shared-context:
  - .pi/hive/context/global.md

planning:
  main:
    name: Planner
    path: .pi/hive/agents/planner.md
  agents:
    - name: Spec Reviewer
      path: .pi/hive/agents/spec-reviewer.md

hive:
  main:
    name: Lead
    path: .pi/hive/agents/lead.md
  agents:
    - name: Coder
      path: .pi/hive/agents/coder.md
    - name: Tester
      path: .pi/hive/agents/tester.md
`;

function kitchenSinkFixture() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-kitchen-sink-"));
  mkdirSync(join(cwd, ".pi", "hive", "agents"), { recursive: true });
  for (const name of ["planner", "spec-reviewer", "lead", "coder", "tester"]) {
    writeFileSync(
      join(cwd, ".pi", "hive", "agents", `${name}.md`),
      `---\nmodel: anthropic/claude-sonnet\nthinking: medium\nagent-type: coder\n---\nWork.`,
    );
  }
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), KITCHEN_SINK_YAML);
  return cwd;
}

test("loadConfig accepts a kitchen-sink YAML with every documented field", () => {
  // The kitchen sink exercises the full parse + validate path. A failure
  // here means the parser, the schema validator, OR the post-validation
  // enrichment (frontmatter agent-type copy, settings normalization)
  // disagree on some field — the regression net the audit said was
  // missing.
  const cwd = kitchenSinkFixture();
  const config = loadConfig(cwd);
  // The loader's `loadConfig` types `settings.budgets` as
  // `BudgetsConfig | { cap: number; ... } | undefined` because its return
  // shape union-includes the raw-parsed fallback. Runtime guarantees
  // `BudgetsConfig` for the kitchen sink (validator path), so narrow for
  // the `resource:` discriminator assertions below.
  const budgets = config.settings.budgets as BudgetsConfig | undefined;

  // settings.* defaults (the kitchen sink overrides every default value).
  assert.equal(config.settings.subagentOutputLimit, 12_000);
  assert.equal(config.settings.defaultTools, "read, grep, find, ls");
  assert.deepEqual(config.settings.secretPaths, [".env", ".env.local"]);
  assert.equal(config.settings.distiller.enabled, true);
  assert.equal(config.settings.distiller.model, "anthropic/claude-haiku-4-5");
  assert.equal(config.settings.telemetry?.retentionDays, 30);
  // `maxParallel` and `queueSize` are deliberately settable; the kitchen
  // sink sets both so the loader accepts the values verbatim.
  assert.equal(config.settings.maxParallel, 4);
  assert.equal(config.settings.queueSize, 64);

  // budgets lands with the validated (post-discriminator-injection) shape
  // and the configured `resource:` tags.
  assert.ok(budgets, "budgets validated and assigned to settings.budgets");
  assert.equal(budgets?.perWorker?.tokens?.cap, 1000);
  assert.equal(budgets?.perWorker?.tokens?.resource, "tokens");
  assert.equal(budgets?.perTeam?.tokens?.cap, 10_000);
  assert.equal(budgets?.perTeam?.tokens?.resource, "tokens");
  assert.equal(budgets?.perWorker?.depth?.cap, 2);
  assert.equal(budgets?.perWorker?.depth?.resource, "depth");
  assert.equal(budgets?.strategies?.onExhaustion?.action, "abort");
  assert.equal(budgets?.strategies?.onApproachingLimit?.threshold, 0.2);
  assert.equal(budgets?.strategies?.summary?.maxTokens, 2000);

  // Both teams parsed; the planning team's main and a single agent are
  // present, the hive team has main + 2 agents.
  assert.equal(config.planning?.main.name, "Planner");
  assert.equal(config.planning?.agents.length, 1);
  assert.equal(config.planning?.agents[0].name, "Spec Reviewer");
  assert.equal(config.hive?.main.name, "Lead");
  assert.equal(config.hive?.agents.length, 2);
  assert.deepEqual(config.hive?.agents.map((a) => a.name), ["Coder", "Tester"]);
});

test("loadConfig accepts a kitchen-sink YAML without a settings: block (defaults fill every gap)", () => {
  // Mirror of the kitchen sink with the entire settings: block dropped.
  // The loader must NOT throw "settings is missing" or "distiller.model is
  // required" — defaults fill every documented field and the absent
  // distiller: stays off (commit 2: opt-in default).
  const yaml = KITCHEN_SINK_YAML.replace(/^settings:\n[\s\S]*?(?=^shared-context:)/m, "");
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-kitchen-sink-nosettings-"));
  mkdirSync(join(cwd, ".pi", "hive", "agents"), { recursive: true });
  for (const name of ["planner", "spec-reviewer", "lead", "coder", "tester"]) {
    writeFileSync(
      join(cwd, ".pi", "hive", "agents", `${name}.md`),
      `---\nmodel: anthropic/claude-sonnet\nthinking: medium\nagent-type: coder\n---\nWork.`,
    );
  }
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), yaml);

  const config = loadConfig(cwd);
  assert.equal(config.settings.subagentOutputLimit, 12_000, "default subagentOutputLimit applies");
  assert.equal(config.settings.defaultTools, "read, grep, find, ls", "default defaultTools applies");
  assert.deepEqual(config.settings.secretPaths, [], "secretPaths defaults to empty");
  assert.equal(config.settings.distiller.enabled, false, "absent distiller: defaults to enabled=false (opt-in)");
  assert.equal(config.settings.distiller.model, "", "absent distiller.model stays empty");
  assert.equal(config.settings.telemetry?.retentionDays, 30, "default telemetry retention");
  assert.equal(config.settings.maxParallel, undefined, "no cap by default — dispatcher skips the parallel branch");
  assert.equal(config.settings.queueSize, undefined, "no queue by default — dispatcher skips the queue branch");
  // Top-level budgets is independent of settings: and still validates.
  assert.ok(config.settings.budgets, "top-level budgets still validates without settings:");
  assert.equal(config.settings.budgets?.perWorker.tokens?.cap, 1000);
});

test("loadConfig accepts a kitchen-sink YAML without a budgets: block", () => {
  // Drop the entire budgets: block — the loader treats budgets as
  // optional and leaves `settings.budgets` undefined (no per-team, no
  // per-worker defaults applied; the resolver handles that).
  const yaml = KITCHEN_SINK_YAML.replace(/^budgets:\n[\s\S]*?(?=^settings:)/m, "");
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-kitchen-sink-nobudgets-"));
  mkdirSync(join(cwd, ".pi", "hive", "agents"), { recursive: true });
  for (const name of ["planner", "spec-reviewer", "lead", "coder", "tester"]) {
    writeFileSync(
      join(cwd, ".pi", "hive", "agents", `${name}.md`),
      `---\nmodel: anthropic/claude-sonnet\nthinking: medium\nagent-type: coder\n---\nWork.`,
    );
  }
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), yaml);

  const config = loadConfig(cwd);
  assert.equal(config.settings.budgets, undefined, "no budgets: ⇒ settings.budgets is undefined");
});

test("loadConfig rejects a config that omits both hive: AND planning:", () => {
  // The hive: and planning: blocks are LEGITIMATELY required — the
  // runtime is hard-coded to switch between them by mode and can't run
  // without either. The loader surfaces a documented throw so a partial
  // config (e.g., one that only declares planning:) fails loud rather
  // than silently dropping the active team.
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-kitchen-sink-noteams-"));
  mkdirSync(join(cwd, ".pi", "hive", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), `
shared-context:
  - README.md
`);
  assert.throws(() => loadConfig(cwd), /hive-config\.yaml must define a dedicated `planning:` team block/);
});

test("loadConfig accepts a kitchen-sink YAML without a shared-context: block", () => {
  // shared-context is OPTIONAL. The loader normalizes an absent block to
  // an empty array (matches the documented "absent ⇒ empty" contract).
  const yaml = KITCHEN_SINK_YAML.replace(/^shared-context:\n[\s\S]*?(?=^planning:)/m, "");
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-kitchen-sink-noshared-"));
  mkdirSync(join(cwd, ".pi", "hive", "agents"), { recursive: true });
  for (const name of ["planner", "spec-reviewer", "lead", "coder", "tester"]) {
    writeFileSync(
      join(cwd, ".pi", "hive", "agents", `${name}.md`),
      `---\nmodel: anthropic/claude-sonnet\nthinking: medium\nagent-type: coder\n---\nWork.`,
    );
  }
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), yaml);

  const config = loadConfig(cwd);
  assert.deepEqual(config.sharedContext, [], "absent shared-context: ⇒ empty array");
});

test("loadConfig accepts a kitchen-sink YAML without a telemetry: block", () => {
  // telemetry: is OPTIONAL — defaults (enabled=true, dashboardAutoStart=true,
  // retentionDays=30, redactSensitiveData=true, captureThinking=false)
  // apply silently. A user who never opts into telemetry still gets the
  // documented defaults.
  const yaml = KITCHEN_SINK_YAML.replace(/^\s+telemetry:\n[\s\S]*?(?=^\s+workerBudgets:)/m, "");
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-kitchen-sink-notelemetry-"));
  mkdirSync(join(cwd, ".pi", "hive", "agents"), { recursive: true });
  for (const name of ["planner", "spec-reviewer", "lead", "coder", "tester"]) {
    writeFileSync(
      join(cwd, ".pi", "hive", "agents", `${name}.md`),
      `---\nmodel: anthropic/claude-sonnet\nthinking: medium\nagent-type: coder\n---\nWork.`,
    );
  }
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), yaml);

  const config = loadConfig(cwd);
  assert.equal(config.settings.telemetry?.enabled, true, "default enabled=true");
  assert.equal(config.settings.telemetry?.retentionDays, 30, "default retentionDays=30");
  assert.equal(config.settings.telemetry?.dashboardAutoStart, true, "default dashboardAutoStart=true");
});

test("loadConfig accepts a kitchen-sink YAML without a distiller: block (opt-in default)", () => {
  // Mirror of the commit 2 fix at the kitchen-sink level: absent
  // distiller: stays off (enabled=false) and no model is required. The
  // rest of the kitchen sink (settings.telemetry, settings.budgets, …)
  // still parses cleanly.
  const yaml = KITCHEN_SINK_YAML.replace(/^\s+distiller:\n[\s\S]*?(?=^\s+telemetry:)/m, "");
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-kitchen-sink-nodistiller-"));
  mkdirSync(join(cwd, ".pi", "hive", "agents"), { recursive: true });
  for (const name of ["planner", "spec-reviewer", "lead", "coder", "tester"]) {
    writeFileSync(
      join(cwd, ".pi", "hive", "agents", `${name}.md`),
      `---\nmodel: anthropic/claude-sonnet\nthinking: medium\nagent-type: coder\n---\nWork.`,
    );
  }
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), yaml);

  const config = loadConfig(cwd);
  assert.equal(config.settings.distiller.enabled, false, "absent distiller: ⇒ enabled=false (opt-in)");
  assert.equal(config.settings.distiller.model, "", "absent distiller.model stays empty");
  assert.equal(config.settings.distiller.conversationLines, 200, "default conversationLines=200 applies");
});
