// U2 — `dispatchAgent` snapshot/restore + inline validator.
//
// Covers the full override lifecycle inside `dispatchAgent`: pre-flight
// rejection predicates (R6, R9, R10, R11, R14, R15), snapshot/grant at
// call entry (R4, R5, R7, R8), revoke on every termination path (R4,
// R5, R7), KTD4 plumbing (`state.activeOverrides`), and concurrent
// dispatch isolation (AE6). Most events live on the telemetry log —
// joined on `delegationId` per AE9 — so the audit-log assertions are
// the canonical proof that the lifecycle shipped.
//
// Mirrors the dispatch-usage.test.ts idiom: a scripted `AgentSession`
// is injected via the `createSession` seam so no live model is needed.
// The seam runs through `createAgentSession`'s swap point (see
// `dispatch.ts`'s `createSession` parameter), so every wire shape
// aligns with the production code path.
//
// Scope boundary: this file owns the dispatch body wrap and the
// preflight predicate results. The merge into `enforceDomainForTool`'s
// read path is U3's job and is exercised by tests/domain-override-enforce.test.ts.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dispatchAgent, type CreateAgentSession } from "../src/engine/dispatch.ts";
import { runAsAgent, runAtDelegationDepth } from "../src/engine/session.ts";
import type { AgentConfig, AgentRuntime, DomainScope, OverrideEntry } from "../src/core/types.ts";

// ── helpers ─────────────────────────────────────────────────────────────

function runtimeFor(opts: {
  name: string;
  sessionFile: string;
  agentType?: AgentConfig["agentType"];
  role?: AgentConfig["role"];
  domain?: DomainScope[];
  governance?: AgentConfig["governance"];
}): AgentRuntime {
  return {
    config: {
      name: opts.name, slug: opts.name.toLowerCase(),
      path: `${opts.name}.md`, role: opts.role || "member",
      agentType: opts.agentType || "lead", routingTags: [],
      domain: opts.domain || [], tools: "read", model: "test/model", thinking: "off",
      ...(opts.governance ? { governance: opts.governance } : {}),
    } as AgentConfig,
    systemPrompt: "", status: "idle", task: "", lastWork: "", toolCount: 0, elapsedMs: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    costUsd: 0, contextPct: 0, runCount: 0, sessionFile: opts.sessionFile,
  };
}

// Minimal state fixture covering everything dispatchAgent reads. The
// `mode: "hive"` value unblocks the budget-gate branch in preflight
// (no execution-change gate opens in this test); the default
// `maxParallel: 2` slot cap leaves both slots free for the single-shot
// happy-path tests. Tests that need a custom cap override at the call
// site. Returns `any` so callers can poke at `state.session.*` and
// `state.activeOverrides` without the `session: SessionState | null`
// strict-null narrowing from HiveState (matches the dispatch-usage.test.ts
// pattern of `const state = { ... } as any`).
function fixture(opts: {
  dir: string;
  worker: AgentRuntime;
  maxParallel?: number;
  queueSize?: number;
  workerBudgets?: any;
}): any {
  const obsLog = join(opts.dir, "e.jsonl");
  return {
    pi: {} as any,
    config: {
      orchestrator: { name: "Orchestrator", path: "o.md" },
      agents: [opts.worker.config], sharedContext: [],
      settings: {
        subagentOutputLimit: 100,
        defaultTools: "read",
        maxParallel: opts.maxParallel ?? 2,
        queueSize: opts.queueSize,
        distiller: { enabled: false, model: "", conversationLines: 10 },
        ...(opts.workerBudgets ? { workerBudgets: opts.workerBudgets } : {}),
      },
    } as any,
    session: { sessionId: "s1", sessionDir: opts.dir, conversationLog: join(opts.dir, "c.jsonl"), observabilityLog: obsLog },
    runtimes: new Map([[opts.worker.config.slug || opts.worker.config.name.toLowerCase(), opts.worker]]),
    widgetCtx: null, activeRuns: 0, mode: "hive" as const, normalToolNames: [],
    sddStatus: null, obsSeq: 0,
  } as any;
}

const baseCtx: any = { cwd: process.cwd(), modelRegistry: { find: () => ({ provider: "test", id: "model" }) } };

// Fire a clean scripted session: one turn + agent_end; no errors. The
// `subscribe` returns a no-op unsubscribe and `state.errorMessage`
// stays undefined so runPromptAndFinalize infers a clean finish
// (errorMessage === undefined ⇒ terminationReason: "return").
function cleanSession(): any {
  let handler: ((e: any) => void) | undefined;
  return {
    subscribe(): () => void { return () => undefined; },
    getAvailableThinkingLevels(): string[] { return ["off"]; },
    getContextUsage(): { percent: number } { return { percent: 0 }; },
    getSessionStats(): any { return { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: 0 }; },
    state: { errorMessage: undefined },
    async prompt(): Promise<void> {
      handler?.({ type: "message_end", message: { role: "assistant", model: "test/model", stopReason: "endTurn", usage: { input: 1, output: 1, cost: 0 } } });
      handler?.({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
    },
    async abort(): Promise<void> { /* noop */ },
    dispose(): void { /* noop */ },
  };
}

function readEmittedEvents(logPath: string): any[] {
  // The preflight-rejection tests (AE4/R10, AE5/R11, AE11/R9, R14, R15)
  // short-circuit ABOVE the snapshot/grant block, so no telemetry events
  // are written and the observability log never gets created. Treating
  // "file missing OR empty" as "no events" makes those tests' absence
  // assertions truthful regardless of whether dispatch wrote anything.
  let raw = "";
  try {
    raw = readFileSync(logPath, "utf8").trim();
  } catch {
    return [];
  }
  if (!raw) return [];
  return raw.split("\n").map((l: string) => JSON.parse(l));
}

function grants(events: any[]): any[] {
  return events.filter((e) => e.type === "domain_override.granted");
}
function revokes(events: any[]): any[] {
  return events.filter((e) => e.type === "domain_override.revoked");
}

// ── AE1 / AE2 happy path — valid override → grant → revoke (return) ─────

test("dispatchAgent U2 happy path — valid override emits paired grant/revoke with terminationReason=return (AE1/AE2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-uo-happy-"));
  const worker = runtimeFor({ name: "Builder", sessionFile: join(dir, "b.jsonl"), domain: [{ path: "src/", read: true, upsert: false, delete: false }] });
  const state = fixture({ dir, worker });
  const ctx = { ...baseCtx, cwd: dir } as any;
  const create: CreateAgentSession = (async () => ({ session: cleanSession() })) as any;

  const override: OverrideEntry[] = [{ path: ".worktrees/feat-x/app/", upsert: true, delete: false }];
  const result = await dispatchAgent(state, "Builder", "edit the page", ctx, create, undefined, undefined, override);

  assert.equal(result.exitCode, 0, "happy dispatch should exit 0; got: " + result.output);
  const events = readEmittedEvents(state.session.observabilityLog);
  const gs = grants(events);
  const rs = revokes(events);
  assert.equal(gs.length, 1, "expected exactly one grant event");
  assert.equal(rs.length, 1, "expected exactly one revoke event");
  assert.equal(gs[0].payload.delegationId, rs[0].payload.delegationId, "delegationId must pair grant with revoke");
  assert.equal(gs[0].payload.worker, "builder");
  assert.equal(gs[0].payload.dispatcherRole, "orchestrator");
  assert.equal(rs[0].payload.terminationReason, "return", "clean session.prompt() finish must yield terminationReason=return");
  assert.ok(gs[0].payload.staticReference?.length === 64, "staticReference must be a sha256 hex digest (64 chars)");
  assert.deepEqual(gs[0].payload.overrideEntries, override);
  assert.equal(state.activeOverrides, undefined, "KTD4 plumbing must be cleared after revoke");
});

// ── AE3 / R12 — empty override is "no override" ─────────────────────────

test("dispatchAgent U2 AE3/R12 — empty override emits no grant and no revoke", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-uo-empty-"));
  const worker = runtimeFor({ name: "Builder", sessionFile: join(dir, "b.jsonl") });
  const state = fixture({ dir, worker });
  const ctx = { ...baseCtx, cwd: dir } as any;
  const create: CreateAgentSession = (async () => ({ session: cleanSession() })) as any;

  const result = await dispatchAgent(state, "Builder", "no override", ctx, create, undefined, undefined, []);

  assert.equal(result.exitCode, 0);
  const events = readEmittedEvents(state.session.observabilityLog);
  assert.equal(grants(events).length, 0, "empty override must not grant");
  assert.equal(revokes(events).length, 0, "no grant means no revoke");
  assert.equal(state.activeOverrides, undefined, "activeOverrides stays clear when no override is passed");
});

// ── AE7 / R13 — conflict-worktree path is accepted (not a reserved path) ─

test("dispatchAgent U2 AE7/R13 — conflict-worktree path is accepted by preflight and produces paired events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-uo-conflict-"));
  const worker = runtimeFor({ name: "Builder", sessionFile: join(dir, "b.jsonl") });
  const state = fixture({ dir, worker });
  const ctx = { ...baseCtx, cwd: dir } as any;
  const create: CreateAgentSession = (async () => ({ session: cleanSession() })) as any;

  const override: OverrideEntry[] = [{ path: ".worktrees/_conflict-x/app/", upsert: true, delete: false }];
  const result = await dispatchAgent(state, "Builder", "merge conflict", ctx, create, undefined, undefined, override);

  assert.equal(result.exitCode, 0, "conflict-worktree path must be accepted; output=" + result.output);
  const events = readEmittedEvents(state.session.observabilityLog);
  const gs = grants(events);
  const rs = revokes(events);
  assert.equal(gs.length, 1, "conflict-path override should grant");
  assert.equal(rs.length, 1);
  assert.equal(rs[0].payload.terminationReason, "return");
});

// ── AE4 / R10 — reserved-path override entry is rejected pre-spawn ──────

test("dispatchAgent U2 AE4/R10 — reserved-path override entry rejected before worker spawns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-uo-reserved-"));
  const worker = runtimeFor({ name: "Builder", sessionFile: join(dir, "b.jsonl") });
  const state = fixture({ dir, worker });
  const ctx = { ...baseCtx, cwd: dir } as any;
  let createCalled = 0;
  const create: CreateAgentSession = (async () => { createCalled++; return { session: cleanSession() }; }) as any;

  const override: OverrideEntry[] = [{ path: ".env.local", upsert: true, delete: false }];
  const result = await dispatchAgent(state, "Builder", "leak secret", ctx, create, undefined, undefined, override);

  assert.equal(result.exitCode, 1);
  assert.match(result.output, /reserved path/i, "rejection message must mention reserved-paths fence");
  assert.equal(createCalled, 0, "createSession must not run on preflight rejection — worker never spawns");
  const events = readEmittedEvents(state.session.observabilityLog);
  assert.equal(grants(events).length, 0, "no grant on preflight rejection");
  assert.equal(revokes(events).length, 0, "no revoke without a preceding grant");
  assert.equal(state.activeOverrides, undefined);
});

// ── AE5 / R11 — reviewer-typed worker with write override is rejected ───

test("dispatchAgent U2 AE5/R11 — reviewer + write override rejected by preflight", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-uo-reviewer-"));
  const worker = runtimeFor({ name: "Reviewer", agentType: "reviewer", sessionFile: join(dir, "r.jsonl") });
  const state = fixture({ dir, worker });
  const ctx = { ...baseCtx, cwd: dir } as any;
  const create: CreateAgentSession = (async () => ({ session: cleanSession() })) as any;

  const override: OverrideEntry[] = [{ path: ".worktrees/feat-x/app/", upsert: true, delete: false }];
  const result = await dispatchAgent(state, "Reviewer", "mutate", ctx, create, undefined, undefined, override);

  assert.equal(result.exitCode, 1);
  assert.match(result.output, /reviewer/i, "rejection must name the agent-type policy");
  assert.equal(grants(readEmittedEvents(state.session.observabilityLog)).length, 0);
});

// AE5 / R11 mirror — operations + write override is NOT rejected.
//
// The fence at `src/engine/dispatch.ts:147` is `agentType === "reviewer"`
// (and only "reviewer"). Operations is the canonical author of
// `domain_override` (the lifecycle lead routes `git push`,
// `gh pr create`, `git worktree add` through writes that the static
// config forbids); the validator must let operations through. This
// test pins that the validator's check is reviewer-exclusive so a
// future refactor that broadens the fence to "any read-only agent
// type" or "operations too" surfaces here.
test("dispatchAgent U2 AE5/R11 mirror — operations + write override is NOT rejected by preflight", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-uo-operations-"));
  const operations = runtimeFor({
    name: "Operations",
    agentType: "operations",
    role: "lead",
    sessionFile: join(dir, "o.jsonl"),
    domain: [
      { path: ".git/", read: true, upsert: true, delete: true },
      { path: ".worktrees/", read: true, upsert: true, delete: true },
      { path: ".pi/hive/agents/operations/", read: true, upsert: true, delete: true },
    ],
  });
  // Worker is `lead`-typed (not coder/tester) to bypass the hive-mode
  // execution-gate preflight at `src/engine/dispatch.ts:110` — that
  // gate requires an approved change id, which these unit tests do
  // not stand up. The AE5/R11 fence being tested is reviewer-exclusive
  // and independent of the worker's own agent-type.
  const worker = runtimeFor({
    name: "Builder",
    sessionFile: join(dir, "b.jsonl"),
    agentType: "lead",
    domain: [{ path: "src/", read: true, upsert: false, delete: false }],
  });
  // canDelegateTo is the tree-bound fence at
  // `src/engine/domain.ts:18`. The CALLER (Operations here, set via
  // `runAsAgent` below) needs the target in its allowedAgents —
  // mirroring the production orchestrator→Operations tree.
  (operations.config as any).allowedAgents = ["Builder"];
  const state = fixture({ dir, worker });
  state.runtimes.set(operations.config.name.toLowerCase(), operations);
  const ctx = { ...baseCtx, cwd: dir } as any;
  const create: CreateAgentSession = (async () => ({ session: cleanSession() })) as any;

  const override: OverrideEntry[] = [{ path: ".worktrees/feat-x/app/", upsert: true, delete: false }];
  const result = await runAsAgent("Operations", () => dispatchAgent(state, "Builder", "mutate", ctx, create, undefined, undefined, override));

  assert.equal(result.exitCode, 0, "operations + write override must NOT be rejected by preflight; got: " + result.output);
  assert.doesNotMatch(result.output, /reviewer/i, "rejection must not name the reviewer fence (operations is reviewer-exclusive)");
  const events = readEmittedEvents(state.session.observabilityLog);
  assert.equal(grants(events).length, 1, "exactly one grant must fire for the operations-dispatched delegation");
  assert.equal(grants(events)[0].payload.dispatcherRole, "operations", "R8: dispatcherRole is 'operations' for the operations-dispatched grant");
});

// ── AE11 / R9 — isReadOnly + write override is rejected (names both) ─────

test("dispatchAgent U2 AE11/R9 — isReadOnly + write override rejected with a message naming both parameters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-uo-readonly-"));
  const worker = runtimeFor({ name: "Builder", sessionFile: join(dir, "b.jsonl") });
  const state = fixture({ dir, worker });
  const ctx = { ...baseCtx, cwd: dir } as any;
  const create: CreateAgentSession = (async () => ({ session: cleanSession() })) as any;

  const override: OverrideEntry[] = [{ path: ".worktrees/feat-x/app/", upsert: true, delete: false }];
  const result = await dispatchAgent(state, "Builder", "read but mutate", ctx, create, undefined, true, override);

  assert.equal(result.exitCode, 1);
  // The rejection must name BOTH `domain_override` AND `isReadOnly` so the
  // caller can disambiguate which parameter to adjust (R6 structured error).
  assert.match(result.output, /isReadOnly/, "rejection must name isReadOnly");
  assert.match(result.output, /domain_override/, "rejection must name domain_override");
  assert.equal(grants(readEmittedEvents(state.session.observabilityLog)).length, 0);
});

// ── R14 — override expanding the static budget is rejected ──────────────

test("dispatchAgent U2 R14 — override that expands write scope beyond static budget is rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-uo-budget-"));
  const staticDomain: DomainScope[] = [
    { path: "src/", read: true, upsert: false, delete: false },
    { path: "static/feature/", read: true, upsert: true, delete: false },
  ];
  const worker = runtimeFor({
    name: "Builder",
    sessionFile: join(dir, "b.jsonl"),
    domain: staticDomain,
    governance: { tokenBudget: 100_000 } as any,
  });
  const state = fixture({ dir, worker });
  const ctx = { ...baseCtx, cwd: dir } as any;
  const create: CreateAgentSession = (async () => ({ session: cleanSession() })) as any;

  // The override path `.worktrees/feat-x/other/` is OUTSIDE the static
  // upsert set (only "static/feature/" upserts) → R14 fires because
  // tokenBudget is set, so the override cannot expand write scope.
  const override: OverrideEntry[] = [{ path: ".worktrees/feat-x/other/", upsert: true, delete: false }];
  const result = await dispatchAgent(state, "Builder", "expand scope", ctx, create, undefined, undefined, override);

  assert.equal(result.exitCode, 1);
  assert.match(result.output, /budget/i, "rejection must reference the budget cap");
  assert.equal(grants(readEmittedEvents(state.session.observabilityLog)).length, 0);
});

// ── R15 — depth-cap violation rejected at preflight ─────────────────────

test("dispatchAgent U2 R15 — depth-cap violation rejected at preflight before grant", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-uo-depth-"));
  const worker = runtimeFor({
    name: "Builder",
    sessionFile: join(dir, "b.jsonl"),
    governance: { maxDelegationDepth: 0 } as any,
  });
  const state = fixture({ dir, worker });
  const ctx = { ...baseCtx, cwd: dir } as any;
  const create: CreateAgentSession = (async () => ({ session: cleanSession() })) as any;

  const override: OverrideEntry[] = [{ path: ".worktrees/feat-x/app/", upsert: true, delete: false }];
  // Pre-flight R15 fires because currentDelegationDepth()=0, +1=1 > 0 cap,
  // BEFORE any grant — short-circuit above the snapshot/grant block.
  const result = await runAtDelegationDepth(0, () =>
    dispatchAgent(state, "Builder", "too deep", ctx, create, undefined, undefined, override),
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.output, /depth cap/i, "rejection must mention the depth cap");
  assert.equal(grants(readEmittedEvents(state.session.observabilityLog)).length, 0, "no grant on R15 rejection");
});

// ── AE6 / R7 — concurrent dispatches each get their own paired events ──

test("dispatchAgent U2 AE6/R7 — two concurrent dispatches produce two distinct grant/revoke pairs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-uo-concurrency-"));
  // NOTE: domain is empty so both overrides are write-grants only; no
  // tokenBudget/costBudgetUsd/maxRuns on governance so R14 doesn't fire
  // post-grant. The empty static config keeps `staticReference` stable
  // for both delegations.
  const worker = runtimeFor({ name: "Builder", sessionFile: join(dir, "b.jsonl") });
  const state = fixture({ dir, worker, maxParallel: 2 });
  const ctx = { ...baseCtx, cwd: dir } as any;
  const create: CreateAgentSession = (async () => ({ session: cleanSession() })) as any;

  const overrideA: OverrideEntry[] = [{ path: ".worktrees/_conflict-x/app/", upsert: true, delete: false }];
  const overrideB: OverrideEntry[] = [{ path: ".worktrees/_conflict-y/app/", upsert: true, delete: false }];

  await Promise.all([
    dispatchAgent(state, "Builder", "task A", ctx, create, undefined, undefined, overrideA),
    dispatchAgent(state, "Builder", "task B", ctx, create, undefined, undefined, overrideB),
  ]);

  const events = readEmittedEvents(state.session.observabilityLog);
  const gs = grants(events);
  const rs = revokes(events);
  assert.equal(gs.length, 2, "two concurrent dispatches emit two grants");
  assert.equal(rs.length, 2, "each grant must have a paired revoke");
  const grantIds = new Set(gs.map((g) => g.payload.delegationId));
  const revokeIds = new Set(rs.map((r) => r.payload.delegationId));
  assert.equal(grantIds.size, 2, "delegationIds must be distinct across concurrent dispatches");
  assert.deepEqual(grantIds, revokeIds, "every grant delegationId must have a matching revoke");
  for (const r of rs) assert.equal(r.payload.terminationReason, "return", "clean finish ⇒ return");
  // End-state KTD4 plumbing: with save/restore (M1), each dispatch
  // revokes by restoring whatever was active at ITS grant time. For
  // concurrent dispatches, the LATER granter snapshots the EARLIER
  // granter's grant, so if the later granter revokes last, the end
  // state is the earlier granter's grant (saved by the later granter).
  // The earlier granter's saved value was undefined, so if it revokes
  // last the end state is undefined. The end state is therefore
  // well-defined but order-dependent — either undefined (earlier
  // granter revokes last) or one of the two grants (later granter
  // revokes last, restoring the earlier granter's grant). Reject any
  // value outside this set as a save/restore regression.
  const finalState = state.activeOverrides;
  const finalDelegationId = finalState?.delegationId;
  const finalIsValid =
    finalState === undefined ||
    grantIds.has(finalDelegationId);
  assert.ok(
    finalIsValid,
    `activeOverrides must be undefined or one of the two concurrent grants; got delegationId=${finalDelegationId} (grants=${[...grantIds].join(",")})`,
  );
});

// ── AE2 termination paths — return, error, abort, budget-exhausted, queue-cancelled, crash ──

function capturingSession(opts: { prompt?: () => Promise<void>; dispose?: () => void }): any {
  let handler: ((e: any) => void) | undefined;
  return {
    subscribe(): () => void { return () => undefined; },
    getAvailableThinkingLevels(): string[] { return ["off"]; },
    getContextUsage(): { percent: number } { return { percent: 0 }; },
    getSessionStats(): any { return { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: 0 }; },
    state: { errorMessage: undefined },
    async prompt(): Promise<void> {
      if (opts.prompt) return opts.prompt();
      handler?.({ type: "message_end", message: { role: "assistant", model: "test/model", stopReason: "endTurn", usage: { input: 1, output: 1, cost: 0 } } });
      handler?.({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
    },
    async abort(): Promise<void> { /* noop */ },
    dispose(): void { opts.dispose?.(); },
  };
}

test("dispatchAgent U2 AE2/return — clean finish produces revoke with terminationReason=return", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-uo-term-return-"));
  const worker = runtimeFor({ name: "Builder", sessionFile: join(dir, "b.jsonl") });
  const state = fixture({ dir, worker });
  const ctx = { ...baseCtx, cwd: dir } as any;
  const create: CreateAgentSession = (async () => ({ session: capturingSession({}) })) as any;
  const override: OverrideEntry[] = [{ path: ".worktrees/feat-x/app/", upsert: true, delete: false }];

  await dispatchAgent(state, "Builder", "clean", ctx, create, undefined, undefined, override);

  const events = readEmittedEvents(state.session.observabilityLog);
  const rs = revokes(events);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].payload.terminationReason, "return");
  assert.equal(state.activeOverrides, undefined);
});

test("dispatchAgent U2 AE2/error — session.prompt throws → revoke with terminationReason=error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-uo-term-error-"));
  const worker = runtimeFor({ name: "Builder", sessionFile: join(dir, "b.jsonl") });
  const state = fixture({ dir, worker });
  const ctx = { ...baseCtx, cwd: dir } as any;
  const create: CreateAgentSession = (async () => ({
    session: capturingSession({ prompt: async () => { throw new Error("model crashed"); } }),
  })) as any;
  const override: OverrideEntry[] = [{ path: ".worktrees/feat-x/app/", upsert: true, delete: false }];

  const result = await dispatchAgent(state, "Builder", "crash mid-run", ctx, create, undefined, undefined, override);

  assert.equal(result.exitCode, 1);
  assert.match(result.output, /model crashed/);
  const events = readEmittedEvents(state.session.observabilityLog);
  const rs = revokes(events);
  assert.equal(rs.length, 1, "must still emit revoke on error path");
  assert.equal(rs[0].payload.terminationReason, "error", "thrown prompt ⇒ error");
  assert.equal(state.activeOverrides, undefined);
});

test("dispatchAgent U2 AE2/abort — parent-aborted dispatch produces revoke with terminationReason=abort", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-uo-term-abort-"));
  const worker = runtimeFor({ name: "Builder", sessionFile: join(dir, "b.jsonl") });
  const state = fixture({ dir, worker });
  const ctx = { ...baseCtx, cwd: dir } as any;
  let releasePrompt: (() => void) | undefined;
  const create: CreateAgentSession = (async () => ({
    session: capturingSession({
      prompt: async () => { await new Promise<void>((resolve) => { releasePrompt = resolve; }); },
    }),
  })) as any;
  const override: OverrideEntry[] = [{ path: ".worktrees/feat-x/app/", upsert: true, delete: false }];

  const controller = new AbortController();
  const dispatchPromise = dispatchAgent(state, "Builder", "abort me", ctx, create, controller.signal, undefined, override);
  // Yield so dispatchAgent wires `abortSignal` listeners before we trip
  // the signal; matches the dispatch-usage.test.ts abort pattern.
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("parent abort"));
  // Release the prompt() await so the abort path can complete.
  await new Promise((resolve) => setImmediate(resolve));
  releasePrompt?.();
  const result = await dispatchPromise;

  assert.equal(result.exitCode, 1);
  assert.match(result.output, /aborted/);
  const events = readEmittedEvents(state.session.observabilityLog);
  const rs = revokes(events);
  assert.equal(rs.length, 1, "must still emit revoke on abort path");
  assert.equal(rs[0].payload.terminationReason, "abort", "parent-aborted ⇒ abort");
  assert.equal(state.activeOverrides, undefined);
});

test("dispatchAgent U2 AE2/budget-exhausted — BudgetExhaustedError from delegate_agent produces revoke with terminationReason=budget-exhausted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-uo-term-budget-"));
  // Set costBudgetUsd to 0 (cap of zero) so `checkBudgetPolicy` finds
  // `ledger.cumulative.costUsd (0) >= 0` and emits a BudgetExhaustedError
  // for `resource: "costUsd"`. Don't set maxDelegationDepth so the
  // dispatch-level R15 preflight check doesn't reject before the grant
  // fires. The R14 dispatch-level check does NOT fire either because
  // the override path is INSIDE the static `upsert` set
  // (`runtime.config.domain` has `static/feature` upsert and the
  // override uses the same `static/feature/app/` path).
  const worker = runtimeFor({
    name: "Builder",
    sessionFile: join(dir, "b.jsonl"),
    domain: [{ path: "static/feature/app/", read: true, upsert: true, delete: false }],
    governance: { costBudgetUsd: 0 } as any,
  });
  const state = fixture({ dir, worker, workerBudgets: {} });
  const ctx = { ...baseCtx, cwd: dir } as any;
  const create: CreateAgentSession = (async () => ({ session: cleanSession() })) as any;
  const override: OverrideEntry[] = [{ path: "static/feature/app/", upsert: true, delete: false }];

  const result = await dispatchAgent(state, "Builder", "exhaust", ctx, create, undefined, undefined, override);

  assert.equal(result.exitCode, 1);
  const events = readEmittedEvents(state.session.observabilityLog);
  const gs = grants(events);
  const rs = revokes(events);
  assert.equal(gs.length, 1, "grant must fire before the budget gate throws");
  assert.equal(rs.length, 1);
  assert.equal(rs[0].payload.terminationReason, "budget-exhausted");
  assert.equal(state.activeOverrides, undefined, "KTD4 plumbing restored after budget-exhausted");
});

test("dispatchAgent U2 AE2/queue-cancelled — slot-acquisition failure produces revoke with terminationReason=queue-cancelled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-uo-term-queue-"));
  const worker = runtimeFor({ name: "Builder", sessionFile: join(dir, "b.jsonl") });
  // maxParallel: 0 ⇒ acquireWorkerSlot returns "parallel" immediately
  // (no queueSize ⇒ the no-queue branch fires). The slot check runs
  // AFTER the grant, so the revoke fires with `queue-cancelled`.
  const state = fixture({ dir, worker, maxParallel: 0 });
  const ctx = { ...baseCtx, cwd: dir } as any;
  let createCalled = 0;
  const create: CreateAgentSession = (async () => { createCalled++; return { session: cleanSession() }; }) as any;
  const override: OverrideEntry[] = [{ path: ".worktrees/feat-x/app/", upsert: true, delete: false }];

  const result = await dispatchAgent(state, "Builder", "queue", ctx, create, undefined, undefined, override);

  assert.equal(result.exitCode, 1);
  assert.match(result.output, /parallel|queue|cancell/i, "expected slot-acquisition message");
  assert.equal(createCalled, 0, "worker session factory must not run on queue-cancelled path");
  const events = readEmittedEvents(state.session.observabilityLog);
  const gs = grants(events);
  const rs = revokes(events);
  assert.equal(gs.length, 1, "grant still fires (snapshot/grant is BEFORE slot acquisition)");
  assert.equal(rs.length, 1);
  assert.equal(rs[0].payload.terminationReason, "queue-cancelled");
  assert.equal(state.activeOverrides, undefined);
});

test("dispatchAgent U2 AE2/crash — unhandled throw from post-grant setup escape produces revoke with terminationReason=crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-uo-term-crash-"));
  const worker = runtimeFor({ name: "Builder", sessionFile: join(dir, "b.jsonl") });
  const state = fixture({ dir, worker });
  // Make `publishRuntimeUpdate` (called inside `emitDelegationStart`
  // BEFORE `runPromptAndFinalize`) throw — this is the one place
  // post-grant that's NOT wrapped in any inner try/catch. The throw
  // escapes the dispatch body, lands in my outer catch which sets
  // `crashed = true` and re-throws. The result: the dispatch promise
  // rejects with the same error, and the body's `finally` fires the
  // revoke event with `terminationReason: "crash"`. This is the
  // design's defensive default for genuinely unhandled throw paths
  // (vs worker-prompt throws, which the inner catches convert to
  // `errorMessage` / `runtime.status = "error"` ⇒ "error" reason).
  let onUpdateCalls = 0;
  state.onRuntimeUpdate = () => {
    onUpdateCalls++;
    throw new Error("post-grant setup crash");
  };
  const ctx = { ...baseCtx, cwd: dir } as any;
  const create: CreateAgentSession = (async () => ({ session: cleanSession() })) as any;
  const override: OverrideEntry[] = [{ path: ".worktrees/feat-x/app/", upsert: true, delete: false }];

  await assert.rejects(
    () => dispatchAgent(state, "Builder", "crash", ctx, create, undefined, undefined, override),
    /post-grant setup crash/,
    "dispatch promise must reject with the throw from publishRuntimeUpdate",
  );
  assert.ok(onUpdateCalls >= 1, "publishRuntimeUpdate must have been invoked at least once");

  const events = readEmittedEvents(state.session.observabilityLog);
  const gs = grants(events);
  const rs = revokes(events);
  assert.equal(gs.length, 1, "grant fires before the throw");
  assert.equal(rs.length, 1, "finally still fires even on re-thrown errors");
  assert.equal(rs[0].payload.terminationReason, "crash", "post-grant throw escaping all inner catches ⇒ crash");
  assert.equal(state.activeOverrides, undefined, "finally clears KTD4 even on crash");
});

// ── AE8 / R5 / R7 — nested delegate_agent each has its own lifetime ────

test("dispatchAgent U2 AE8 — nested delegate_agent produces two distinct grant/revoke pairs joined by delegationId", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-uo-nested-"));
  // Parent + child share the same static config — the spec's "B has its
  // own effective scope built from parent's static + B's override"
  // describes this baseline. Distinct override subdirs (app/ vs test/)
  // so each grant event carries a different `overrideEntries`, which is
  // how a downstream audit query can reconstruct which override was
  // active during each delegation without consulting the dispatch call.
  const staticDomain: DomainScope[] = [{ path: "src/", read: true, upsert: false, delete: false }];
  const parent = runtimeFor({ name: "Parent", sessionFile: join(dir, "p.jsonl"), domain: staticDomain });
  const child = runtimeFor({ name: "Child", sessionFile: join(dir, "c.jsonl"), domain: staticDomain });
  // The orchestrator → lead → worker tree requires the parent to have
  // permission to delegate to the child. The default `runtimeFor`
  // helper produces a `role: "member"` config which `canDelegateTo`'s
  // tree-only branch rejects with "X is not configured to delegate to
  // other agents" — this is the SAME rejection that blocks a real
  // "member"-role worker from spawning a child via the
  // `delegate_agent` tool. Promote the parent to `role: "lead"` and
  // declare the child in `allowedAgents` so the nested dispatch
  // passes `canDelegateTo` (production-parallel: orchestrator or lead
  // dispatching into their subtree).
  (parent.config as AgentConfig).role = "lead";
  (parent.config as AgentConfig).allowedAgents = ["child"];
  const state = fixture({ dir, worker: parent });
  // The single-worker fixture only puts the primary worker in
  // `state.runtimes`; both `resolveRuntime` and `agentRoster` (used by
  // the early-return guard at dispatch.ts:120 and preflightCheck's
  // "Unknown agent" branch) read from this map, so the child runtime
  // has to land in the SAME map the orchestrator reads from.
  // `state.config.agents` is consulted by `allConfiguredAgents` /
  // permission checks; matching the runtimes map keeps the test's
  // view of the agent roster internally consistent.
  state.runtimes.set("child", child);
  state.config.agents.push(child.config);
  const ctx = { ...baseCtx, cwd: dir } as any;

  const parentOverride: OverrideEntry[] = [{ path: ".worktrees/x/app/", upsert: true, delete: false }];
  const childOverride: OverrideEntry[] = [{ path: ".worktrees/x/test/", upsert: true, delete: false }];

  // The child's session factory is a clean one-shot (no nested
  // recursion — terminating the chain with `cleanSession`'s
  // `agent_end` so `runPromptAndFinalize` sees a clean finish). The
  // parent's session factory's `prompt()` synchronously awaits the
  // child's `dispatchAgent` call before resolving — this is the SDK's
  // `delegate_agent` tool running inside the parent's worker session
  // in production (single-threaded JS event loop).
  //
  // The child session is wrapped in a `capturingSession` so the test
  // can observe `state.activeOverrides` mid-child-dispatch (capture
  // #2 below): the override branch sets the child's grant BEFORE the
  // try block runs `runPromptAndFinalize` → `session.prompt()`, so the
  // very first thing this mock prompt observes is the child's grant
  // active. After this mock resolves, the child's finally restores the
  // parent's grant, which is what capture #3 observes inside the
  // parent's prompt.
  const activeOverridesSnapshots: Array<{ label: string; value: any }> = [];
  const childCreate: CreateAgentSession = (async () => ({
    session: capturingSession({
      prompt: async () => {
        activeOverridesSnapshots.push({ label: "inside-child-prompt-after-child-grant", value: state.activeOverrides });
      },
    }),
  })) as any;
  const parentCreate: CreateAgentSession = (async () => ({
    session: capturingSession({
      prompt: async () => {
        await dispatchAgent(state, "Child", "child task", ctx, childCreate, undefined, undefined, childOverride);
        // After the child's dispatch returns, the child's finally has
        // restored `state.activeOverrides` to the parent's grant (the
        // save/restore in dispatch.ts). The parent's prompt is still
        // in flight, so the parent's grant is the live value here.
        activeOverridesSnapshots.push({ label: "inside-parent-prompt-after-child-revoke", value: state.activeOverrides });
      },
    }),
  })) as any;

  // Capture #1: before parent dispatch. No prior grant has set the
  // field, so the live value is `undefined`.
  activeOverridesSnapshots.push({ label: "before-parent-dispatch", value: state.activeOverrides });

  const result = await dispatchAgent(state, "Parent", "parent task", ctx, parentCreate, undefined, undefined, parentOverride);

  // Capture #4: after both dispatchers return. The parent's finally
  // restored to `undefined` (no grandparent), so the live value is
  // `undefined` again.
  activeOverridesSnapshots.push({ label: "after-both-return", value: state.activeOverrides });

  assert.equal(result.exitCode, 0, "nested parent dispatch should exit 0; output=" + result.output);

  const events = readEmittedEvents(state.session.observabilityLog);
  const gs = grants(events);
  const rs = revokes(events);
  assert.equal(gs.length, 2, "expected two grants (one per delegation); got " + gs.length);
  assert.equal(rs.length, 2, "expected two revokes (one per delegation); got " + rs.length);

  // Identify each grant by the worker slug it was emitted for, then
  // pin delegationId distinctness — AE8's "B has its own" requires
  // each nested dispatch to mint a fresh UUID, NOT share with its
  // parent. Sharing would break AE9's downstream join.
  const parentGrant = gs.find((g) => g.payload.worker === "parent");
  const childGrant = gs.find((g) => g.payload.worker === "child");
  assert.ok(parentGrant, "parent grant must be present");
  assert.ok(childGrant, "child grant must be present");
  assert.notEqual(parentGrant.payload.delegationId, childGrant.payload.delegationId, "nested delegations must mint distinct delegationIds");

  // Each revoke pairs with its grant on delegationId (AE9 round-trip —
  // the "join on delegationId" the design's audit query depends on).
  const parentRevoke = rs.find((r) => r.payload.delegationId === parentGrant.payload.delegationId);
  const childRevoke = rs.find((r) => r.payload.delegationId === childGrant.payload.delegationId);
  assert.ok(parentRevoke, "parent revoke must match parent grant by delegationId");
  assert.ok(childRevoke, "child revoke must match child grant by delegationId");
  for (const r of [parentRevoke, childRevoke]) {
    assert.equal(r.payload.terminationReason, "return", "both clean finishes ⇒ return");
  }

  // Each grant event's `overrideEntries` matches the override passed to
  // its dispatch — the audit log can reconstruct which override was
  // active during each delegation purely from `granted` + `revoked`
  // pairs, without consulting the original `delegate_agent` call.
  assert.deepEqual(parentGrant.payload.overrideEntries, parentOverride, "parent grant overrideEntries must match the dispatched override");
  assert.deepEqual(childGrant.payload.overrideEntries, childOverride, "child grant overrideEntries must match the dispatched override");

  // The static config is the same for both nested siblings (parent and
  // child share `runtime.config.domain`), so both `staticReference`
  // digests must be identical — confirms AE10's "recompute against
  // the recorded value" rule across nested siblings and pins the
  // audit log's claim that B's effective scope is built from the SAME
  // static the parent had.
  assert.equal(parentGrant.payload.staticReference, childGrant.payload.staticReference, "shared static config ⇒ identical staticReference across siblings");
  assert.equal(parentGrant.payload.staticReference.length, 64, "staticReference must be a sha256 hex digest (64 chars)");

  // KTD4 plumbing restored: the outer's revoke clears the field last.
  // `activeOverrides` is undefined after both delegations end — no
  // global residue leaks to subsequent dispatches.
  assert.equal(state.activeOverrides, undefined, "activeOverrides must be undefined after the outer revoke");

  // Save/restore round-trip across nested delegation — pin each of
  // the four checkpoints' live value so the M1 fix can't silently
  // regress to "always undefined" (the old finally) without the test
  // catching it. Reads from the live `state` object; never mutates it.
  // The captures are ordered: before parent → during child → after
  // child returns (parent still in flight) → after both return.
  const findSnap = (label: string) => {
      const snap = activeOverridesSnapshots.find((s) => s.label === label);
      assert.ok(snap, `capture #${label} must be recorded; got labels: ${activeOverridesSnapshots.map((s) => s.label).join(", ")}`);
      return snap!;
    };
  const beforeParent = findSnap("before-parent-dispatch");
  assert.equal(beforeParent.value, undefined, "before parent dispatch: activeOverrides must be undefined (no prior grant)");
  const childInsidePrompt = findSnap("inside-child-prompt-after-child-grant");
  assert.ok(childInsidePrompt.value, "during child prompt (after child grant fired, before child revoke): activeOverrides must be the child's grant");
  assert.equal(childInsidePrompt.value.delegationId, childGrant.payload.delegationId, "during child prompt: activeOverrides.delegationId must match the child's grant");
  assert.equal(childInsidePrompt.value.worker, "child", "during child prompt: activeOverrides.worker must be 'child'");
  const parentInsidePrompt = findSnap("inside-parent-prompt-after-child-revoke");
  assert.ok(parentInsidePrompt.value, "after child revoke but inside parent prompt: activeOverrides must be restored to the parent's grant");
  assert.equal(parentInsidePrompt.value.delegationId, parentGrant.payload.delegationId, "after child revoke: activeOverrides.delegationId must match the parent's grant (save/restore round-trip)");
  assert.equal(parentInsidePrompt.value.worker, "parent", "after child revoke: activeOverrides.worker must be 'parent'");
  const afterBoth = findSnap("after-both-return");
  assert.equal(afterBoth.value, undefined, "after both dispatchers return: activeOverrides must be undefined (parent restored to no-grant)");
});
