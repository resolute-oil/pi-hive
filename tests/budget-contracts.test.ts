// Wave 0 contract agreement test — Slice 1: BudgetLedger class shape
//
// Purpose: pin the public surface of BudgetLedger (constructor-as-factory via
// static restore + instance methods + accessors) so Wave 1+ can implement
// against a stable API. Every stub throws "not implemented" by design; the
// test only verifies the symbol is exported and the throw contract holds.

import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionStats } from "@earendil-works/pi-coding-agent";
import { BudgetLedger } from "../src/engine/budget/ledger.ts";

test("BudgetLedger is exported as a class", () => {
  assert.equal(typeof BudgetLedger, "function", "BudgetLedger must be exported as a class (constructor function)");
  assert.equal(BudgetLedger.name, "BudgetLedger", "BudgetLedger constructor must retain its name");
});

// ── Slice 2 — BudgetPolicy pure functions ───────────────────────────────────

import * as policy from "../src/engine/budget/policy.ts";

test("BudgetPolicy exports the six pure functions with pinned arities", () => {
  assert.equal(typeof policy.checkBudgetPolicy, "function", "checkBudgetPolicy must be exported");
  assert.equal(typeof policy.workerConsumedTokens, "function", "workerConsumedTokens must be exported");
  assert.equal(typeof policy.workerConsumedCost, "function", "workerConsumedCost must be exported");
  assert.equal(typeof policy.teamUsage, "function", "teamUsage must be exported");
  assert.equal(typeof policy.ratioRemaining, "function", "ratioRemaining must be exported");
  assert.equal(typeof policy.crossedThreshold, "function", "crossedThreshold must be exported");
  // Arities pin the signature so Wave 1 cannot drop parameters.
  assert.equal(policy.checkBudgetPolicy.length, 3, "checkBudgetPolicy takes (ledger, policy, branch)");
  assert.equal(policy.workerConsumedTokens.length, 2, "workerConsumedTokens takes (session, scope)");
  assert.equal(policy.workerConsumedCost.length, 1, "workerConsumedCost takes (session)");
  assert.equal(policy.teamUsage.length, 1, "teamUsage takes (branch)");
  assert.equal(policy.ratioRemaining.length, 2, "ratioRemaining takes (used, cap)");
  assert.equal(policy.crossedThreshold.length, 2, "crossedThreshold takes (remaining, threshold)");
});

test("BudgetPolicy contract (Wave 1 fills the pure functions — verified by smoke invocation)", () => {
  // Wave 0 pinned the public surface via stub-state assertions. Wave 1 (T1.3)
  // implements the pure functions, so the stub-state "not implemented"
  // assertions are obsolete. This test now verifies the contract through a
  // minimal smoke check: ratioRemaining and crossedThreshold (the two
  // arithmetic functions) return numeric / boolean values; the full surface
  // is exercised in tests/budget-policy.test.ts (11 tests).
  assert.equal(typeof policy.ratioRemaining(50, 100), "number", "ratioRemaining returns a number");
  assert.equal(typeof policy.crossedThreshold(0.10, 0.20), "boolean", "crossedThreshold returns a boolean");
});

// ── Slice 3 — WorkerBudgetPolicy + WorkerBudgetStrategy ──────────────────────

import { resolveWorkerBudgetPolicy, resolveWorkerBudgetStrategy } from "../src/engine/budget/strategy.ts";
import type { WorkerBudgetPolicy as WBP, WorkerBudgetStrategy as WBS, HiveConfig } from "../src/core/types.ts";

test("WorkerBudgetPolicy is exported with all the §2.10 nested-shape fields", () => {
  // Compile-time shape check — the policy object must accept worker.tokens,
  // worker.costUsd, worker.runs, worker.depth, team.tokens, team.costUsd,
  // team.runs, and optional strategies. Wave 1 may populate the values; the
  // shape is locked here.
  const policy: WBP = {
    worker: {
      tokens: { cap: 1000, window: "per-session", include: ["input", "output"] },
      costUsd: { cap: 0.5, window: "per-session" },
      runs: { cap: 5 },
      depth: { cap: 2 },
    },
    team: {
      tokens: { cap: 10_000, window: "per-team-lifetime", include: ["input", "output", "cacheRead", "cacheWrite"] },
      costUsd: { cap: 5, window: "per-team-lifetime" },
      runs: { cap: 20 },
    },
    strategies: undefined,
  };
  assert.equal(policy.worker.tokens?.cap, 1000);
  assert.equal(policy.worker.depth?.cap, 2);
  assert.equal(policy.team.runs?.cap, 20);
});

test("WorkerBudgetStrategy is the 'default' | 'compact' union", () => {
  const values: WBS[] = ["default", "compact"];
  assert.deepEqual(values, ["default", "compact"]);
  // Compile-time check that the literal type is the documented union.
  const def: WBS = "default";
  const compact: WBS = "compact";
  assert.equal(def, "default");
  assert.equal(compact, "compact");
});

test("strategy resolvers are exported with pinned arities", () => {
  assert.equal(typeof resolveWorkerBudgetStrategy, "function");
  assert.equal(typeof resolveWorkerBudgetPolicy, "function");
  assert.equal(resolveWorkerBudgetStrategy.length, 2, "resolveWorkerBudgetStrategy takes (config, agentName)");
  assert.equal(resolveWorkerBudgetPolicy.length, 2, "resolveWorkerBudgetPolicy takes (config, agentName)");
});

test("strategy resolver contract (Wave 1 fills the resolvers — verified by smoke invocation)", () => {
  // Wave 0 pinned the public surface via stub-state assertions. Wave 1 (T1.4)
  // implements the resolvers, so the stub-state "not implemented" assertions
  // are obsolete. This test now verifies the resolvers return their
  // documented types when called with a structurally-valid config.
  const config = {} as HiveConfig;
  const strategy = resolveWorkerBudgetStrategy(config, "agent");
  assert.equal(typeof strategy, "string", "resolveWorkerBudgetStrategy returns a string (the documented enum)");
  const policy = resolveWorkerBudgetPolicy(config, "agent");
  assert.equal(typeof policy, "object", "resolveWorkerBudgetPolicy returns an object (the documented WorkerBudgetPolicy shape)");
  assert.ok(policy !== null && "worker" in policy && "team" in policy, "policy has the worker / team blocks");
});

// ── Slice 4 — BudgetBlock discriminated union ───────────────────────────────

import type { BudgetBlock } from "../src/core/types.ts";

test("BudgetBlock requires scope and resource; carries reason/remaining/limit", () => {
  const workerTokens: BudgetBlock = {
    reason: "worker tokens exhausted",
    scope: "worker",
    resource: "tokens",
    remaining: { tokens: 0 },
    limit: { tokens: 1000 },
  };
  const teamCostUsd: BudgetBlock = {
    reason: "team cost exhausted",
    scope: "team",
    resource: "costUsd",
    remaining: { costUsd: 0 },
    limit: { costUsd: 5 },
  };
  const workerDepth: BudgetBlock = {
    reason: "depth exceeded",
    scope: "worker",
    resource: "depth",
    remaining: {},
    limit: { depth: 3 },
  };
  // scope and resource are the discriminators; downstream code (the
  // dispatcher + dashboard) narrows on them. Build a smoke check that the
  // exhaustive union compiles.
  const blocks: BudgetBlock[] = [workerTokens, teamCostUsd, workerDepth];
  for (const block of blocks) {
    assert.ok(typeof block.reason === "string" && block.reason.length > 0, "reason must be a non-empty string");
    assert.ok(block.scope === "worker" || block.scope === "team", "scope must be worker or team");
    assert.ok(["tokens", "costUsd", "runs", "depth"].includes(block.resource), "resource must be one of the four documented kinds");
  }
  assert.equal(blocks[0].limit.tokens, 1000, "worker block must carry the violated cap");
  assert.equal(blocks[1].limit.costUsd, 5, "team block must carry the violated cap");
  assert.equal(blocks[2].limit.depth, 3, "depth block must carry the violated depth cap");
});

// ── Slice 5+6 — 11 operator commands + 3 cooperative tools ──────────────────

import * as workerTools from "../src/engine/budget/worker-tools.ts";

test("worker-tools exports all 11 operator commands", () => {
  const operatorCommands = [
    "endWorkerSession",
    "compactWorkerSession",
    "respawnWorkerSession",
    "pauseWorkerSession",
    "snapshotWorkerSession",
    "restoreWorkerSession",
    "resumeWorkerSession",
    "abortWorkerCompaction",
    "forceKillWorkerSession",
    "forceEndWorkerSession",
    "tearDownAllWorkers",
  ];
  for (const name of operatorCommands) {
    assert.equal(typeof (workerTools as Record<string, unknown>)[name], "function", `${name} must be exported as a function`);
  }
});

test("worker-tools exports all 3 cooperative tools", () => {
  const cooperativeTools = ["request_compaction", "request_end_session", "request_snapshot"];
  for (const name of cooperativeTools) {
    assert.equal(typeof (workerTools as Record<string, unknown>)[name], "function", `${name} must be exported as a function`);
  }
});

test("operator command signatures match the §2.8 contract", () => {
  // We check the parameter NAMES (not .length, which counts up to the first
  // defaulted parameter and so doesn't pin the documented signature for
  // functions with optional args). The compiled async function body keeps
  // the param names in order; matching them pins the contract. The stub uses
  // `_` prefixes (no body) so the names are still present in the source text.
  const signatures: Record<string, RegExp> = {
    endWorkerSession: /_?agent.*_?reason.*_?signal/,
    compactWorkerSession: /_?agent.*_?reason/,
    respawnWorkerSession: /_?agent.*_?reason/,
    pauseWorkerSession: /_?agent.*_?reason.*_?signal/,
    snapshotWorkerSession: /_?agent.*_?label.*_?signal/,
    restoreWorkerSession: /_?agent.*_?snapshotId.*_?signal/,
    resumeWorkerSession: /_?agent.*_?signal/,
    abortWorkerCompaction: /_?agent.*_?signal/,
    forceKillWorkerSession: /_?agent.*_?reason.*_?signal/,
    forceEndWorkerSession: /_?agent.*_?reason.*_?signal/,
    tearDownAllWorkers: /_?reason/,
  };
  for (const [name, pattern] of Object.entries(signatures)) {
    const fn = (workerTools as Record<string, (...args: unknown[]) => unknown>)[name];
    const text = fn.toString();
    assert.ok(pattern.test(text), `${name} signature must contain ${pattern}; got: ${text}`);
  }
});

test("cooperative tool signatures match the §2.8 contract", () => {
  const signatures: Record<string, RegExp> = {
    request_compaction: /_?customInstructions|_?signal/,
    request_end_session: /_?reason.*_?signal/,
    request_snapshot: /_?label.*_?signal/,
  };
  for (const [name, pattern] of Object.entries(signatures)) {
    const fn = (workerTools as Record<string, (...args: unknown[]) => unknown>)[name];
    const text = fn.toString();
    assert.ok(pattern.test(text), `${name} signature must contain ${pattern}; got: ${text}`);
  }
});

test("operator command stubs throw not implemented when called", async () => {
  const fakeSignal = new AbortController().signal;
  await assert.rejects(workerTools.endWorkerSession("agent", "reason", fakeSignal), /not implemented/);
  await assert.rejects(workerTools.compactWorkerSession("agent", "reason"), /not implemented/);
  await assert.rejects(workerTools.respawnWorkerSession("agent", "reason"), /not implemented/);
  await assert.rejects(workerTools.pauseWorkerSession("agent", "reason", fakeSignal), /not implemented/);
  await assert.rejects(workerTools.snapshotWorkerSession("agent", "label", fakeSignal), /not implemented/);
  await assert.rejects(workerTools.restoreWorkerSession("agent", "snapshot-id", fakeSignal), /not implemented/);
  await assert.rejects(workerTools.resumeWorkerSession("agent", fakeSignal), /not implemented/);
  await assert.rejects(workerTools.abortWorkerCompaction("agent", fakeSignal), /not implemented/);
  await assert.rejects(workerTools.forceKillWorkerSession("agent", "reason", fakeSignal), /not implemented/);
  await assert.rejects(workerTools.forceEndWorkerSession("agent", "reason", fakeSignal), /not implemented/);
  await assert.rejects(workerTools.tearDownAllWorkers("reason"), /not implemented/);
});

test("cooperative tool stubs throw not implemented when called", async () => {
  const fakeSignal = new AbortController().signal;
  await assert.rejects(workerTools.request_compaction(), /not implemented/);
  await assert.rejects(workerTools.request_end_session("reason", fakeSignal), /not implemented/);
  await assert.rejects(workerTools.request_snapshot("label", fakeSignal), /not implemented/);
});

// ── Slice 7 — Config schema (typebox discriminated unions + types) ──────────

import { BudgetCap, BudgetsConfigSchema } from "../src/core/schema.ts";
import type { Static } from "typebox";
import type {
  BudgetsConfig as BCC,
  IncludeKey,
  Strategies as Strats,
  TeamBudgetConfig as TBC,
  WindowKind as WK,
  WorkerBudgetConfig as WBC,
} from "../src/core/types.ts";

test("typebox BudgetCap is the discriminated union with four resource kinds", () => {
  // The schema is the discriminated union (C4). We assert at the type level
  // that all four resource variants are constructible and the static type
  // carries the discriminator.
  const tokens: Static<typeof BudgetCap> = { resource: "tokens", cap: 1000, window: "per-session", include: ["input", "output"] };
  const cost: Static<typeof BudgetCap> = { resource: "costUsd", cap: 0.5, window: "per-team-lifetime" };
  const runs: Static<typeof BudgetCap> = { resource: "runs", cap: 5 };
  const depth: Static<typeof BudgetCap> = { resource: "depth", cap: 2 };
  for (const cap of [tokens, cost, runs, depth]) {
    assert.ok(["tokens", "costUsd", "runs", "depth"].includes(cap.resource), "resource discriminator must be one of the four documented kinds");
    assert.ok(typeof cap.cap === "number" && cap.cap >= 0, "cap must be a non-negative number");
  }
  // Pin the §2.13/C4 narrowing: tokens.window accepts the WindowKind union,
  // costUsd.window accepts only the per-session/per-team-lifetime subset.
  assert.equal(tokens.window, "per-session");
  assert.equal(cost.window, "per-team-lifetime");
});

test("WindowKind, IncludeKey types match the documented unions", () => {
  const windowValues: WK[] = ["per-session", "per-run", "per-day", "per-team-lifetime"];
  assert.deepEqual(windowValues, ["per-session", "per-run", "per-day", "per-team-lifetime"]);
  const includeKeys: IncludeKey[] = ["input", "output", "cacheRead", "cacheWrite", "reasoning"];
  assert.equal(includeKeys.length, 5);
});

test("Strategies / BudgetsConfig / WorkerBudgetConfig / TeamBudgetConfig shapes match §2.13", () => {
  // Compile-time shape check.
  const strategies: Strats = {
    onApproachingLimit: { action: "wrap-up", threshold: 0.2, hint: "wrap up" },
    onExhaustion: { action: "abort" },
    summary: { maxTokens: 2000 },
  };
  assert.equal(strategies.onApproachingLimit.action, "wrap-up");
  assert.equal(strategies.summary.maxTokens, 2000);

  const budgets: BCC = {
    defaultsEnabled: true,
    perWorker: { tokens: { cap: 1000, window: "per-session", include: ["input", "output"] }, runs: { cap: 5 } },
    perTeam: { tokens: { cap: 10_000, window: "per-team-lifetime" }, runs: { cap: 20 } },
    strategies,
  };
  assert.equal(budgets.perWorker.tokens?.cap, 1000);
  assert.equal(budgets.perTeam.tokens?.cap, 10_000);

  const worker: WBC = { tokens: { cap: 500 }, depth: { cap: 2 } };
  assert.equal(worker.tokens?.cap, 500);
  assert.equal(worker.depth?.cap, 2);

  const team: TBC = { tokens: { cap: 5000 }, runs: { cap: 50 } };
  assert.equal(team.tokens?.cap, 5000);
  assert.equal(team.runs?.cap, 50);
});

test("BudgetsConfigSchema is the typebox runtime validator", () => {
  assert.equal(typeof BudgetsConfigSchema, "object", "BudgetsConfigSchema must be exported as a typebox schema");
  // A canonical config validates; a malformed one does not. We don't run the
  // validator (typebox's Value.* APIs), but the schema's static type is the
  // contract: any config that satisfies the schema compiles to the documented
  // shape.
  const sample: Static<typeof BudgetsConfigSchema> = {
    defaultsEnabled: true,
    perWorker: { tokens: { resource: "tokens", cap: 1000 }, runs: { resource: "runs", cap: 5 } },
    perTeam: { tokens: { resource: "tokens", cap: 10_000 } },
    strategies: {
      onApproachingLimit: { action: "wrap-up", threshold: 0.2, hint: "wrap up" },
      onExhaustion: { action: "abort" },
      summary: { maxTokens: 2000 },
    },
  };
  assert.ok(sample);
  assert.equal(sample.perWorker.tokens?.cap, 1000);
});

// ── Slice 8 — BudgetLedgerEntry schema + BudgetLedgerKind (14 values) ────────

import type { BudgetLedgerEntry, BudgetLedgerKind } from "../src/core/types.ts";

test("BudgetLedgerKind accepts all 14 documented values", () => {
  const all: BudgetLedgerKind[] = [
    "end",
    "compact",
    "respawn",
    "pause",
    "snapshot",
    "restore",
    "resume",
    "compact-aborted",
    "force-kill",
    "force-end",
    "tear-down-all",
    "cooperative-compact",
    "cooperative-end",
    "cooperative-snapshot",
  ];
  assert.equal(all.length, 14, "BudgetLedgerKind must enumerate exactly 14 values");
  // Spot-check the discriminators between operator (end/compact/etc.) and
  // cooperative (cooperative-*) actions.
  assert.ok(all.includes("end"));
  assert.ok(all.includes("cooperative-end"));
  assert.notEqual(all.indexOf("end"), all.indexOf("cooperative-end"));
});

test("BudgetLedgerEntry is a CustomEntry with the documented caps/cumulative/marker/kind shape", () => {
  // Build entries with each combination of marker x kind to prove the shape
  // is exhaustive at the type level.
  const entries: BudgetLedgerEntry[] = [
    {
      type: "custom",
      customType: "pi-hive-budget-ledger",
      data: {
        caps: { workerTokens: 1000, teamTokens: 10_000 },
        cumulative: { tokens: 500, costUsd: 0.1, runs: 1 },
        writtenAt: 1_700_000_000_000,
        agentSlug: "coder",
        marker: "warning",
        kind: "end",
      },
    },
    {
      type: "custom",
      customType: "pi-hive-budget-ledger",
      data: {
        caps: {},
        cumulative: { tokens: 0, costUsd: 0, runs: 0 },
        writtenAt: 0,
        agentSlug: "coder",
        marker: "checkpoint",
        kind: "cooperative-compact",
      },
    },
    {
      type: "custom",
      customType: "pi-hive-budget-ledger",
      data: {
        caps: { workerCostUsd: 0.5, workerRuns: 5, workerDepth: 2, teamCostUsd: 5, teamRuns: 20 },
        cumulative: { tokens: 1234, costUsd: 0.25, runs: 3 },
        writtenAt: 1,
        agentSlug: "tester",
        // marker and kind are optional; omit both for the throttled cadence path.
      },
    },
  ];
  for (const entry of entries) {
    assert.equal(entry.type, "custom", "type must be 'custom' (SessionEntry discriminator)");
    assert.equal(entry.customType, "pi-hive-budget-ledger", "customType must be the documented budget-ledger tag");
    assert.ok(["warning", "exhausted", "checkpoint", undefined].includes(entry.data.marker), "marker must be one of the three documented kinds or undefined");
    assert.ok(typeof entry.data.agentSlug === "string", "agentSlug must always be a string");
  }
  assert.equal(entries[0].data.kind, "end");
  assert.equal(entries[1].data.kind, "cooperative-compact");
  assert.equal(entries[2].data.kind, undefined);
});

// ── Slice 9 — summarize_progress tool signature ──────────────────────────────

import { summarizeProgressTool } from "../src/agents/tools/summarize-progress.ts";

test("summarizeProgressTool is exported as a function returning a ToolDefinition", () => {
  assert.equal(typeof summarizeProgressTool, "function", "summarizeProgressTool must be exported as a function");
  // Wave 1 fills the body; for now the stub throws. The arity pins the contract
  // so a future refactor that adds a required parameter breaks the test first.
  assert.equal(summarizeProgressTool.length, 0, "summarizeProgressTool takes no required arguments (state is captured at registration time)");
});

test("summarizeProgressTool stub throws not implemented when called", () => {
  assert.throws(() => summarizeProgressTool(), /not implemented/);
});

// ── Slice 10 — Telemetry event shape for BudgetLedgerEntry ──────────────────

import type { BudgetLedgerTelemetryEvent } from "../src/shared/telemetry.ts";

test("BudgetLedgerTelemetryEvent is a HiveTelemetryEvent variant carrying the ledger entry", () => {
  // Compile-time shape check: the event type narrows to { type: "budget_ledger"; payload: { agentSlug, entry } }
  // without changing the HiveTelemetryEvent discriminator contract.
  const event: BudgetLedgerTelemetryEvent = {
    event_id: "evt-1",
    ts: new Date().toISOString(),
    type: "budget_ledger",
    session_id: "session-1",
    actor: "coder",
    pid: 1,
    seq: 1,
    payload: {
      agentSlug: "coder",
      entry: {
        type: "custom",
        customType: "pi-hive-budget-ledger",
        data: {
          caps: { workerTokens: 1000 },
          cumulative: { tokens: 500, costUsd: 0.1, runs: 1 },
          writtenAt: Date.now(),
          agentSlug: "coder",
          marker: "checkpoint",
          kind: "end",
        },
      },
    },
  };
  assert.equal(event.type, "budget_ledger", "event type must be the documented 'budget_ledger' discriminator");
  assert.equal(event.payload.agentSlug, "coder", "payload must carry the agent slug for the dashboard's per-worker timeline");
  assert.equal(event.payload.entry.data.kind, "end", "payload.entry must be a full BudgetLedgerEntry");
});

test("BudgetLedger.restore is a static factory returning a Promise<BudgetLedger>", () => {
  assert.equal(typeof BudgetLedger.restore, "function", "BudgetLedger.restore must be a static method");
  // The signature must accept (sessionManager, agentName, policy, signal). We
  // can't invoke without real SDK instances, but we CAN assert the arity so a
  // future refactor that drops a parameter breaks the test before runtime.
  assert.equal(BudgetLedger.restore.length, 4, "BudgetLedger.restore must take 4 parameters");
});

test("BudgetLedger instance methods exist with the expected signatures", () => {
  // The prototype carries the instance surface. Asserting on the prototype
  // (not an instance) avoids the static-factory call path; Wave 1 will populate
  // the instance from restore().
  const proto = BudgetLedger.prototype as unknown as Record<string, unknown>;
  assert.equal(typeof proto.recordEvent, "function", "recordEvent must exist on the prototype");
  assert.equal(typeof proto.maybeSnapshot, "function", "maybeSnapshot must exist on the prototype");
  assert.equal(typeof proto.recordCompaction, "function", "recordCompaction must exist on the prototype");
  assert.equal(typeof proto.snapshot, "function", "snapshot must exist on the prototype");
  // Each method's arity pins its contract — Wave 1 cannot drop parameters.
  type AnyFn = (...args: unknown[]) => unknown;
  assert.equal((proto.recordEvent as AnyFn).length, 3, "recordEvent must take 3 parameters (type, cumulative, signal)");
  assert.equal((proto.maybeSnapshot as AnyFn).length, 3, "maybeSnapshot must take 3 parameters (cumulative, policy, signal)");
  assert.equal((proto.recordCompaction as AnyFn).length, 2, "recordCompaction must take 2 parameters (savings, signal)");
  assert.equal((proto.snapshot as AnyFn).length, 4, "snapshot must take 4 parameters (stats, policy, marker, signal)");
});

test("BudgetLedger declares the entries and cumulative accessors as readonly", () => {
  // Compile-time check that the accessors carry the contract types. A
  // sample instance is typed; the runtime objects may be undefined until
  // Wave 1 fills them in.
  const sample: BudgetLedger = {} as unknown as BudgetLedger;
  const entriesType: ReadonlyArray<unknown> = sample.entries;
  const cumulativeType: { tokens: number; costUsd: number; runs: number } = sample.cumulative;
  assert.ok(Array.isArray(entriesType) || entriesType === undefined, "entries must be array-like at runtime");
  assert.ok(cumulativeType === undefined || typeof cumulativeType === "object", "cumulative must be the ledger's spend-shape at runtime");
});

test("BudgetLedger contract (Wave 1 fills the methods — verified via restore + invoke)", async () => {
  // Wave 0 pinned the public surface via stub-state assertions. Wave 1 (T1.2)
  // implements the methods, so the stub-state "not implemented" assertions
  // are obsolete. This test now verifies the contract through the documented
  // restore() entry point: a fresh SessionManager + restore() + a write call
  // must produce a persisted CustomEntry. Method bodies live in
  // tests/budget-ledger.test.ts (8 tests covering each write path).
  const sm = SessionManager.inMemory("/tmp");
  const ledger = await BudgetLedger.restore(sm, "agent", {} as never, new AbortController().signal);
  const signal = new AbortController().signal;
  ledger.recordEvent("message_end", { tokens: 1, costUsd: 0, runs: 1 }, signal);
  const branch = sm.getBranch();
  const wrote = branch.some((e) => e.type === "custom" && (e as unknown as { customType?: string }).customType === "pi-hive-budget-ledger");
  assert.ok(wrote, "BudgetLedger.recordEvent persists a CustomEntry via sessionManager.appendCustomEntry");
});
