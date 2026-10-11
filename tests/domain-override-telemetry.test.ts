// U4 — `domain_override.granted` + `domain_override.revoked` telemetry
// event contract.
//
// The union-member strings and the per-event field sets land in the
// existing `emitHiveEvent` channel at `src/engine/dispatch.ts:461` (grant)
// and `:966` (revoke). This file locks the wire contract for the two
// events from the consumer's side. The plan binds this unit to AE9
// (paired events), AE10 (deterministic `staticReference`), and the
// AE2/R4 termination-reason × 5 sub-paths.
//
// Idiom mirrors `tests/dispatch-domain-override.test.ts`: drive the
// dispatch flow through `dispatchAgent` with a scripted `createSession`
// so no live model is needed, then read back the observability log and
// assert on the JSONL line shapes. The file-based read is the project's
// actual telemetry contract — every consumer (the dashboard daemon,
// the archive processor) parses JSONL, not in-memory events — so a
// file-based assertion is the test that future refactors cannot silently
// break.
//
// Scope boundary: this file owns the OBSERVED event shapes
// (`emitHiveEvent` payload contract on the JSONL wire), not the
// dispatch-lifecycle semantics. Pre-flight rejection is U2's territory;
// domain enforcement is U3's. The five termination-reason sub-tests
// intentionally borrow U2's session fixtures so a U2 regression that
// changes the reason mapping surfaces here too.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dispatchAgent, type CreateAgentSession } from "../src/engine/dispatch.ts";
import type { AgentConfig, AgentRuntime, DomainScope, OverrideEntry } from "../src/core/types.ts";

// ── helpers ─────────────────────────────────────────────────────────────

function runtimeFor(opts: {
  name: string;
  sessionFile: string;
  domain?: DomainScope[];
  governance?: AgentConfig["governance"];
}): AgentRuntime {
  return {
    config: {
      name: opts.name, slug: opts.name.toLowerCase(),
      path: `${opts.name}.md`, role: "member",
      agentType: "lead", routingTags: [],
      domain: opts.domain || [], tools: "read", model: "test/model", thinking: "off",
      ...(opts.governance ? { governance: opts.governance } : {}),
    } as AgentConfig,
    systemPrompt: "", status: "idle", task: "", lastWork: "", toolCount: 0, elapsedMs: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    costUsd: 0, contextPct: 0, runCount: 0, sessionFile: opts.sessionFile,
  };
}

function fixture(opts: {
  dir: string;
  worker: AgentRuntime;
  maxParallel?: number;
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

// Clean scripted session: `session.prompt()` emits a message_end +
// agent_end pair, so the inner runPromptAndFinalize path infers a
// clean finish (no `errorMessage`, no `runtime.status === "error"`)
// ⇒ dispatch's finally block falls through to `terminationReason = "return"`.
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

// Mirrors U2's `capturingSession`: the `prompt` body is caller-supplied
// so each termination-reason sub-test can hang/abort/throw as needed.
function capturingSession(opts: { prompt?: () => Promise<void> }): any {
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
    dispose(): void { /* noop */ },
  };
}

function readEmittedEvents(logPath: string): any[] {
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

// ── AE9 — paired events fire in order with full R8 field sets ──────────

test("U4 AE9 — exactly one grant then one revoke per delegation, R8 field set complete", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-uo-telemetry-paired-"));
  const worker = runtimeFor({
    name: "Builder",
    sessionFile: join(dir, "b.jsonl"),
    domain: [{ path: "src/", read: true, upsert: false, delete: false }],
  });
  const state = fixture({ dir, worker });
  const ctx = { ...baseCtx, cwd: dir } as any;
  const create: CreateAgentSession = (async () => ({ session: cleanSession() })) as any;
  const override: OverrideEntry[] = [{ path: ".worktrees/feat-x/app/", upsert: true, delete: false }];

  const result = await dispatchAgent(state, "Builder", "edit the page", ctx, create, undefined, undefined, override);

  assert.equal(result.exitCode, 0, "happy dispatch should exit 0; got: " + result.output);

  const events = readEmittedEvents(state.session.observabilityLog);
  const gs = grants(events);
  const rs = revokes(events);
  assert.equal(gs.length, 1, "exactly one grant per delegation (AE9)");
  assert.equal(rs.length, 1, "exactly one revoke per delegation (AE9)");

  // AE9 ordering: grant precedes revoke in the JSONL stream. The
  // pair must appear in the order `emitHiveEvent(grant)` then
  // `emitHiveEvent(revoke)` — `seq` is monotonic per session and
  // assertable directly, but file order is the strongest guarantee
  // since a future refactor that re-orders `seq` arithmetic wouldn't
  // break the wire contract.
  const grantIndex = events.indexOf(gs[0]);
  const revokeIndex = events.indexOf(rs[0]);
  assert.ok(grantIndex < revokeIndex, "grant must fire before revoke in the JSONL stream");

  // R8 field set — `domain_override.granted`:
  //   delegationId, dispatcher, dispatcherRole, worker, changeId,
  //   grantedAt, overrideEntries, staticReference.
  const g = gs[0].payload;
  assert.equal(typeof g.delegationId, "string", "R8: delegationId is a string");
  assert.equal(typeof g.dispatcher, "string", "R8: dispatcher is a string");
  assert.equal(g.dispatcherRole, "orchestrator", "R8: dispatcherRole is the locked 'orchestrator' value");
  assert.equal(g.worker, "builder", "R8: worker is the worker slug");
  assert.ok("changeId" in g, "R8: changeId is present (may be null when no active change)");
  assert.equal(typeof g.grantedAt, "string", "R8: grantedAt is an ISO timestamp");
  assert.ok(!Number.isNaN(Date.parse(g.grantedAt)), "R8: grantedAt parses as a valid date");
  assert.ok(Array.isArray(g.overrideEntries), "R8: overrideEntries is an array");
  assert.deepEqual(g.overrideEntries, override, "R8: overrideEntries mirrors the call's input verbatim");
  assert.equal(typeof g.staticReference, "string", "R8: staticReference is a string");
  assert.equal(g.staticReference.length, 64, "R8: staticReference is a sha256 hex digest (64 chars)");

  // R8 field set — `domain_override.revoked`:
  //   delegationId, revokedAt, terminationReason.
  const r = rs[0].payload;
  assert.equal(typeof r.delegationId, "string", "R8: delegationId is a string");
  assert.equal(typeof r.revokedAt, "string", "R8: revokedAt is an ISO timestamp");
  assert.ok(!Number.isNaN(Date.parse(r.revokedAt)), "R8: revokedAt parses as a valid date");
  assert.ok(["return", "error", "abort", "crash", "budget-exhausted", "queue-cancelled"]
    .includes(r.terminationReason), "R8: terminationReason is one of the six union members");

  // AE9 pair-binding: the revocation must reference the same delegationId
  // as the grant that authorized it. This is the load-bearing invariant
  // the audit log joins on.
  assert.equal(r.delegationId, g.delegationId, "AE9: revoke must reference the same delegationId as its grant");
});

// ── AE10 — staticReference is deterministic per static config ──────────

test("U4 AE10 — staticReference is a deterministic digest of runtime.config.domain; changes when the static config changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-uo-telemetry-staticref-"));
  const initialDomain: DomainScope[] = [{ path: "src/", read: true, upsert: false, delete: false }];
  const worker = runtimeFor({ name: "Builder", sessionFile: join(dir, "b.jsonl"), domain: initialDomain });
  const state = fixture({ dir, worker });
  const ctx = { ...baseCtx, cwd: dir } as any;
  const create: CreateAgentSession = (async () => ({ session: cleanSession() })) as any;
  const override: OverrideEntry[] = [{ path: ".worktrees/feat-x/app/", upsert: true, delete: false }];

  // First grant — capture `staticReference`.
  await dispatchAgent(state, "Builder", "grant #1", ctx, create, undefined, undefined, override);
  let events = readEmittedEvents(state.session.observabilityLog);
  let gs = grants(events);
  assert.equal(gs.length, 1, "first grant must fire");
  const staticRefA = gs[0].payload.staticReference;
  assert.equal(typeof staticRefA, "string");
  assert.equal(staticRefA.length, 64, "staticReference must be a sha256 hex digest");

  // Second grant — same static config, same override. The
  // `staticReference` must be byte-identical (the auditor's whole
  // point: detect "this override layered onto a different static
  // config than expected" by re-computing the digest against the
  // recorded value, not the current config).
  await dispatchAgent(state, "Builder", "grant #2", ctx, create, undefined, undefined, override);
  events = readEmittedEvents(state.session.observabilityLog);
  gs = grants(events);
  assert.equal(gs.length, 2, "second grant must fire");
  const staticRefB = gs[1].payload.staticReference;
  assert.equal(staticRefB, staticRefA, "AE10: identical static config ⇒ identical staticReference (64-char hex digest)");

  // Third grant — mutate the static config. `runtime.config.domain`
  // is the input that layer into the digest (Q8 lock), so swapping
  // it for a different scope must flip the digest byte-for-byte.
  worker.config.domain = [{ path: "lib/", read: true, upsert: false, delete: false }];
  await dispatchAgent(state, "Builder", "grant #3", ctx, create, undefined, undefined, override);
  events = readEmittedEvents(state.session.observabilityLog);
  gs = grants(events);
  assert.equal(gs.length, 3, "third grant must fire");
  const staticRefC = gs[2].payload.staticReference;
  assert.notEqual(staticRefC, staticRefA, "AE10: changing static config must change staticReference");
  assert.equal(staticRefC.length, 64, "AE10: even after a config change the digest stays sha256-shaped");
});

// ── AE2/R4 — termination reason × 5 sub-paths ──────────────────────────

test("U4 AE2/return — clean session finish produces revoke with terminationReason=return", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-uo-telemetry-term-return-"));
  const worker = runtimeFor({ name: "Builder", sessionFile: join(dir, "b.jsonl") });
  const state = fixture({ dir, worker });
  const ctx = { ...baseCtx, cwd: dir } as any;
  const create: CreateAgentSession = (async () => ({ session: cleanSession() })) as any;
  const override: OverrideEntry[] = [{ path: ".worktrees/feat-x/app/", upsert: true, delete: false }];

  const result = await dispatchAgent(state, "Builder", "clean", ctx, create, undefined, undefined, override);
  assert.equal(result.exitCode, 0);

  const events = readEmittedEvents(state.session.observabilityLog);
  const rs = revokes(events);
  assert.equal(rs.length, 1, "exactly one revoke event");
  assert.equal(rs[0].payload.terminationReason, "return");
  // The revoke must carry the timestamp the design requires and a
  // delegationId the audit log can join on.
  assert.equal(typeof rs[0].payload.revokedAt, "string");
  assert.equal(typeof rs[0].payload.delegationId, "string");
});

test("U4 AE2/error — session.prompt() throwing produces revoke with terminationReason=error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-uo-telemetry-term-error-"));
  const worker = runtimeFor({ name: "Builder", sessionFile: join(dir, "b.jsonl") });
  const state = fixture({ dir, worker });
  const ctx = { ...baseCtx, cwd: dir } as any;
  const create: CreateAgentSession = (async () => ({
    session: capturingSession({ prompt: async () => { throw new Error("model crashed"); } }),
  })) as any;
  const override: OverrideEntry[] = [{ path: ".worktrees/feat-x/app/", upsert: true, delete: false }];

  const result = await dispatchAgent(state, "Builder", "throw mid-run", ctx, create, undefined, undefined, override);
  assert.equal(result.exitCode, 1, "thrown prompt must produce a non-zero exit");
  assert.match(result.output, /model crashed/);

  const events = readEmittedEvents(state.session.observabilityLog);
  const rs = revokes(events);
  assert.equal(rs.length, 1, "the dispatch finally block must still emit revoke on error path");
  assert.equal(rs[0].payload.terminationReason, "error", "thrown prompt ⇒ terminationReason=error");
});

test("U4 AE2/abort — parent-aborted dispatch produces revoke with terminationReason=abort", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-uo-telemetry-term-abort-"));
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
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("parent abort"));
  await new Promise((resolve) => setImmediate(resolve));
  releasePrompt?.();
  const result = await dispatchPromise;

  assert.equal(result.exitCode, 1);
  assert.match(result.output, /aborted/);

  const events = readEmittedEvents(state.session.observabilityLog);
  const rs = revokes(events);
  assert.equal(rs.length, 1, "abort path must still emit revoke");
  assert.equal(rs[0].payload.terminationReason, "abort", "parent-aborted dispatch ⇒ terminationReason=abort");
});

test("U4 AE2/budget-exhausted — BudgetExhaustedError produces revoke with terminationReason=budget-exhausted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-uo-telemetry-term-budget-"));
  // `costBudgetUsd: 0` ⇒ checkBudgetPolicy immediately fails with
  // BudgetExhaustedError for `resource: "costUsd"`. The static config
  // already grants upsert on the override's path so R14 doesn't fire
  // before the grant. No `maxDelegationDepth` so R15 also doesn't fire.
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
  const rs = revokes(events);
  const gs = grants(events);
  assert.equal(gs.length, 1, "grant must fire before the budget gate throws");
  assert.equal(rs.length, 1, "revoke must still fire on the budget-exhausted path");
  assert.equal(rs[0].payload.terminationReason, "budget-exhausted", "BudgetExhaustedError ⇒ terminationReason=budget-exhausted");
  assert.equal(rs[0].payload.delegationId, gs[0].payload.delegationId, "revoke must reference its grant's delegationId even on budget-exhausted");
});

test("U4 AE2/queue-cancelled — slot-acquisition failure produces revoke with terminationReason=queue-cancelled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-uo-telemetry-term-queue-"));
  const worker = runtimeFor({ name: "Builder", sessionFile: join(dir, "b.jsonl") });
  // `maxParallel: 0` makes acquireWorkerSlot return "parallel"
  // immediately (no `queueSize` ⇒ no-queue branch). The slot check
  // runs AFTER the snapshot/grant block, so the grant fires and the
  // revoke observes `queueCancelled = true`.
  const state = fixture({ dir, worker, maxParallel: 0 });
  const ctx = { ...baseCtx, cwd: dir } as any;
  const create: CreateAgentSession = (async () => ({ session: cleanSession() })) as any;
  const override: OverrideEntry[] = [{ path: ".worktrees/feat-x/app/", upsert: true, delete: false }];

  const result = await dispatchAgent(state, "Builder", "queue", ctx, create, undefined, undefined, override);
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /parallel|queue|cancell/i);

  const events = readEmittedEvents(state.session.observabilityLog);
  const rs = revokes(events);
  const gs = grants(events);
  assert.equal(gs.length, 1, "grant still fires (snapshot/grant is BEFORE slot acquisition)");
  assert.equal(rs.length, 1, "revoke must still fire on the queue-cancelled path");
  assert.equal(rs[0].payload.terminationReason, "queue-cancelled", "slot-acquisition failure ⇒ terminationReason=queue-cancelled");
  assert.equal(rs[0].payload.delegationId, gs[0].payload.delegationId, "revoke must reference its grant's delegationId even on queue-cancelled");
});

// ── Type-level sanity check on the union members and field names ───────

test("U4 type contract — the two event types are members of the telemetry union and the R8 payload shape is structurally valid", async () => {
  // The two union members were registered in `src/shared/telemetry.ts`
  // during the U2 deviation (per the dev-log comment at
  // `src/shared/telemetry.ts:83-90`). A future refactor that drops
  // either string literal breaks this assert before it breaks the
  // dispatch's `emitHiveEvent` calls — those calls would fail
  // typecheck at the `emitHiveEvent(state, "domain_override.granted",
  // ...)` / `:966` call sites, which is the strongest possible
  // signal that the union member was dropped.
  //
  // This test exists to make the contract discoverable from the test
  // suite without re-reading the design doc — the assertions below
  // are deliberately redundant with the AE9 / AE10 tests above. They
  // document the R8 field set in the test code itself.
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-uo-telemetry-contract-"));
  const worker = runtimeFor({ name: "Builder", sessionFile: join(dir, "b.jsonl") });
  const state = fixture({ dir, worker });
  const ctx = { ...baseCtx, cwd: dir } as any;
  const create: CreateAgentSession = (async () => ({ session: cleanSession() })) as any;
  const override: OverrideEntry[] = [{ path: ".worktrees/feat-x/app/", upsert: true, delete: false }];

  await dispatchAgent(state, "Builder", "contract", ctx, create, undefined, undefined, override);

  const events = readEmittedEvents(state.session.observabilityLog);
  const g = grants(events)[0];
  const r = revokes(events)[0];

  // Every R8 field must be present (even if `changeId === null`,
  // which is a valid value per the design — no active change).
  const grantFields = ["delegationId", "dispatcher", "dispatcherRole", "worker", "changeId", "grantedAt", "overrideEntries", "staticReference"];
  for (const field of grantFields) {
    assert.ok(field in g.payload, `R8 grant payload is missing field: ${field}`);
  }
  const revokeFields = ["delegationId", "revokedAt", "terminationReason"];
  for (const field of revokeFields) {
    assert.ok(field in r.payload, `R8 revoke payload is missing field: ${field}`);
  }
});
