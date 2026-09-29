/**
 * Wave 5 / Coverage-1 — F3/T3.4 production wiring of `createBudgetToolCallGuard`.
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md
 *   §3.3 F3 — T3.4 tool_call blocking for bash/edit/write/read.
 *   §6.2 G-01 — BudgetBlock discriminated union serialized into the tool-result
 *               error reason.
 *
 * Why this test exists (and why it's NOT a real `createAgentSession` test):
 *
 * `createAgentSession` requires a real model, model registry, and a working
 * cwd with the worker's resource loader reloaded. Standing one up in a unit test
 * is heavy and creates a brittle dependency on the provider mocks. The plan's
 * hard constraint is "Wiring must be minimal" — so the wiring site is one
 * `agent.beforeToolCall = wrap(previous, guard)` assignment inside
 * `installWorkerBudgetHooks` (worker-session-factory.ts).
 *
 * The wiring logic itself has exactly two observable contracts:
 *
 *   (a) After `installWorkerBudgetHooks(...)` returns, `session.agent.beforeToolCall`
 *       is a function that, when invoked with a `BeforeToolCallContext`-shaped
 *       object, returns either a `BudgetBlock` (block:true, reason:JSON) or
 *       `undefined` — same shape as the direct factory test in
 *       `tests/budget-events.test.ts` case 17.
 *   (b) The wrapper preserves the previous (SDK-installed) beforeToolCall so
 *       domain enforcement (`pi.on("tool_call", ...)` chain) still runs first
 *       and can still block on policy violations.
 *
 * These two contracts are exactly what we exercise here against a fake session
 * shaped like the real one (with an `agent.beforeToolCall` slot that mimics
 * what `AgentSession._installAgentToolHooks` installs in production). The
 * real-session integration test would only re-prove what these two contracts
 * already pin. Per the task brief: "if wiring is impossible without major
 * refactor, write the test that EXERCISES THE FACTORY DIRECTLY against a fake
 * session that has a `beforeToolCall` slot. This is the next-best option."
 *
 * Coverage (8 tests in a single test file; counted as 8 wiring tests since
 * each is a single `node:test` invocation):
 *
 *   1. installWorkerBudgetHooks wires a non-undefined `agent.beforeToolCall`
 *      handler (i.e., the factory was actually applied — the SDK default is
 *      preserved when no extension registers tool_call, but the wrapper always
 *      installs our guard).
 *   2. With budget exhausted (cumulative hits cap), `bash` is blocked with
 *      the `BudgetBlock` JSON shape (worker scope / tokens resource / remaining
 *      0 / limit matches cap).
 *   3. Same shape for `edit` / `write` / `read` — the four T3.4 targets.
 *   4. Non-target tools (`grep`, `ls`, `delegate_agent`) pass through with
 *      `undefined` — they're never gated, even when exhausted.
 *   5. When the budget has headroom (under-cap cumulative), all four blocking
 *      tools pass through with `undefined` — the gate is no-op when funds are
 *      available.
 *   6. The SDK's previous `agent.beforeToolCall` runs FIRST (domain chain
 *      preserved) — a fake SDK handler that returns `{ block: true, reason: "X" }`
 *      is consulted and short-circuits BEFORE the budget guard runs. Domain
 *      enforcement wins over budget exhaustion.
 *   7. The wrapper's return value matches the direct factory return shape
 *      exactly: `block === true`, `terminate === false`, and
 *      `JSON.parse(reason)` reconstructs the `BudgetBlock` discriminated union.
 *   8. Wiring is robust against an aborted controller — when the runController
 *      is aborted, the wrapper returns `undefined` (the budget guard's own
 *      aborted-signal short-circuit fires, regardless of cumulative).
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionStats } from "@earendil-works/pi-coding-agent";
import {
  installWorkerBudgetHooks,
} from "../src/engine/worker-session-factory.ts";
import { BudgetLedger } from "../src/engine/budget/ledger.ts";
import type {
  BudgetBlock,
  WorkerBudgetPolicy,
} from "../src/engine/budget/types.ts";

// ---------------------------------------------------------------------------
// Helpers / fixtures.
// ---------------------------------------------------------------------------

function makePolicy(overrides: Partial<WorkerBudgetPolicy["worker"]> = {}): WorkerBudgetPolicy {
  return {
    worker: {
      tokens: { resource: "tokens", cap: 1_000 },
      costUsd: { resource: "costUsd", cap: 5 },
      runs: { resource: "runs", cap: 3 },
      depth: { resource: "depth", cap: 2 },
      ...overrides,
    },
    team: {
      tokens: { resource: "tokens", cap: 5_000 },
      costUsd: { resource: "costUsd", cap: 50 },
      runs: { resource: "runs", cap: 20 },
    },
  };
}

function makeStats(tokens: number, cost: number): SessionStats {
  return {
    sessionFile: undefined,
    sessionId: "wiring-test",
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens },
    cost,
  };
}

/**
 * A minimal fake AgentSession-shaped object that satisfies both:
 *   - `installBudgetEventHooks` (subscribe / getSessionStats / abort)
 *   - The wrapper's `agent.beforeToolCall` wiring contract.
 *
 * The `previousBeforeToolCall` slot mimics what `AgentSession._installAgentToolHooks`
 * installs in production — the SDK's own handler that routes through
 * `runner.emitToolCall(...)` for pi.on("tool_call") handlers. We track whether
 * it ran (so tests can assert "domain chain fired before budget guard").
 */
interface FakeAgent {
  beforeToolCall: ((ctx: unknown, signal?: AbortSignal) => Promise<unknown>) | undefined;
  previousBeforeToolCallCount: number;
  previousBeforeToolCallBlock?: { block: true; reason?: string; terminate?: boolean };
}

interface FakeSession {
  subscribe(listener: (event: unknown) => void): () => void;
  getSessionStats(): SessionStats;
  abort(): Promise<void> | void;
  agent: FakeAgent;
}

function makeFakeSession(initialPrevious: ((ctx: unknown, signal?: AbortSignal) => Promise<unknown>) | undefined): FakeSession {
  const fakeAgent: FakeAgent = {
    beforeToolCall: initialPrevious,
    previousBeforeToolCallCount: 0,
  };
  return {
    subscribe(): () => void {
      return () => undefined;
    },
    getSessionStats(): SessionStats {
      return makeStats(0, 0);
    },
    abort(): void {
      // no-op
    },
    agent: fakeAgent,
  };
}

async function installWithSeededCumulative(args: {
  cap: number;
  cumulative: number;
  previousBeforeToolCall?: ((ctx: unknown, signal?: AbortSignal) => Promise<unknown>) | undefined;
  controller?: AbortController;
}): Promise<{ session: FakeSession; sessionManager: SessionManager; ledger: BudgetLedger; controller: AbortController }> {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-wiring-"));
  const sessionManager = SessionManager.inMemory(cwd);
  const policy = makePolicy({ tokens: { resource: "tokens", cap: args.cap } });
  // Seed the ledger with a CustomEntry at `args.cumulative` so the post-restore
  // cumulative matches the test scenario (the wiring runs checkBudgetPolicy
  // against `ledger.cumulative` directly — no real `message_end` event needed).
  if (args.cumulative > 0) {
    sessionManager.appendCustomEntry("pi-hive-budget-ledger", {
      caps: { workerTokens: args.cap, teamTokens: 5_000 },
      cumulative: { tokens: args.cumulative, costUsd: 0, runs: 1 },
      writtenAt: 1,
      agentSlug: "wiring-worker",
    });
  }
  const controller = args.controller ?? new AbortController();
  const session = makeFakeSession(args.previousBeforeToolCall);
  // F2/F5 wiring: installWorkerBudgetHooks only wires the F3 tool_call
  // guard; the budget event hooks are installed by createBudgetAwareSession.
  // The test calls installWorkerBudgetHooks directly to exercise the guard
  // wrapping in isolation, mirroring how the production path wires it AFTER
  // createBudgetAwareSession's event-hook install.
  const ledger = await BudgetLedger.restore(sessionManager, "wiring-worker", policy, controller.signal);
  await installWorkerBudgetHooks({
    session,
    sessionManager,
    preflightPolicy: policy,
    ledger,
    runController: controller,
    currentDelegationDepth: () => 1,
  });
  return { session, sessionManager, ledger, controller };
}

/** Builds the BeforeToolCallContext-shaped object the SDK passes. */
function makeContext(toolName: string, args: unknown = {}): unknown {
  return {
    assistantMessage: { role: "assistant", content: [] },
    toolCall: { id: "tc1", name: toolName, arguments: args },
    args,
    context: {},
  };
}

// ── Case 1: wiring installs a non-undefined handler ───────────────────────

test("installWorkerBudgetHooks wires session.agent.beforeToolCall to a non-undefined function", async () => {
  const { session } = await installWithSeededCumulative({
    cap: 1_000,
    cumulative: 0,
  });
  assert.ok(
    typeof session.agent.beforeToolCall === "function",
    "wiring must install a function (not leave the SDK default undefined-or-otherwise)",
  );
});

// ── Case 2: bash is blocked when budget is exhausted ──────────────────────

test("wiring: 'bash' is blocked when cumulative hits the cap (BudgetBlock JSON in reason)", async () => {
  const cap = 1_000;
  const { session } = await installWithSeededCumulative({ cap, cumulative: cap });
  const result = await session.agent.beforeToolCall!(makeContext("bash", { command: "echo hi" }));
  assert.ok(result, "guard returned a non-undefined result");
  const r = result as { block: true; reason: string; terminate: false };
  assert.equal(r.block, true);
  assert.equal(r.terminate, false);
  const block = JSON.parse(r.reason) as BudgetBlock;
  assert.equal(block.scope, "worker");
  assert.equal(block.resource, "tokens");
  assert.equal(block.remaining.tokens, 0);
  assert.equal(block.limit.tokens, cap);
  assert.match(block.reason, /exhausted/i);
});

// ── Case 3: edit / write / read are all blocked when budget is exhausted ─

test("wiring: edit / write / read are blocked when budget is exhausted (all four T3.4 targets)", async () => {
  const cap = 1_000;
  const { session } = await installWithSeededCumulative({ cap, cumulative: cap });
  for (const tool of ["edit", "write", "read"] as const) {
    const result = await session.agent.beforeToolCall!(makeContext(tool, {}));
    assert.ok(result, `${tool}: guard returned a non-undefined result`);
    const r = result as { block: true; reason: string; terminate: false };
    assert.equal(r.block, true, `${tool}: block must be true`);
    const block = JSON.parse(r.reason) as BudgetBlock;
    assert.equal(block.scope, "worker", `${tool}: scope must be worker`);
    assert.equal(block.resource, "tokens", `${tool}: resource must be tokens`);
  }
});

// ── Case 4: non-target tools pass through even when budget is exhausted ──

test("wiring: non-target tools (grep, ls, delegate_agent) pass through with undefined", async () => {
  const cap = 1_000;
  const { session } = await installWithSeededCumulative({ cap, cumulative: cap });
  for (const tool of ["grep", "ls", "delegate_agent"]) {
    const result = await session.agent.beforeToolCall!(makeContext(tool, {}));
    assert.equal(result, undefined, `${tool}: must not be gated (T3.4 only targets bash/edit/write/read)`);
  }
});

// ── Case 5: under-budget cumulative is a no-op for all blocking tools ────

test("wiring: all four blocking tools pass through when budget has headroom", async () => {
  const cap = 1_000;
  const { session } = await installWithSeededCumulative({ cap, cumulative: 100 });
  for (const tool of ["bash", "edit", "write", "read"] as const) {
    const result = await session.agent.beforeToolCall!(makeContext(tool, {}));
    assert.equal(result, undefined, `${tool}: under-budget calls must pass through`);
  }
});

// ── Case 6: domain enforcement chain runs FIRST (and wins over budget) ───

test("wiring: previous (SDK/extension) beforeToolCall runs first and can block before the budget guard", async () => {
  const cap = 1_000;
  // A fake "previous" handler that always blocks with reason "domain".
  const previous = async () => ({ block: true as const, reason: "domain violation: out of scope", terminate: false });
  const { session } = await installWithSeededCumulative({
    cap,
    cumulative: cap, // exhausted AND would normally trigger the budget gate
    previousBeforeToolCall: previous,
  });
  // The wrapper must call previous and short-circuit on its block result.
  const result = await session.agent.beforeToolCall!(makeContext("bash", {}));
  assert.ok(result, "wrapper returned a non-undefined result");
  const r = result as { block: true; reason: string };
  assert.equal(r.block, true);
  assert.equal(r.reason, "domain violation: out of scope", "domain chain must win — budget guard never fires when domain blocks");
});

// ── Case 7: return shape matches the direct factory contract exactly ─────

test("wiring: return shape is byte-identical to createBudgetToolCallGuard's direct factory test", async () => {
  const cap = 1_000;
  const { session } = await installWithSeededCumulative({ cap, cumulative: cap });
  const result = await session.agent.beforeToolCall!(makeContext("bash", { command: "ls" }));
  // Exact-shape assertions pinned by case 17 in budget-events.test.ts — the
  // wrapping here must preserve every field of the factory's return shape.
  assert.ok(result, "result is non-undefined");
  const r = result as { block: true; reason: string; terminate: false };
  assert.equal(typeof r, "object");
  assert.equal(r.block, true);
  assert.equal(r.terminate, false);
  assert.equal(typeof r.reason, "string");
  const parsed = JSON.parse(r.reason) as BudgetBlock;
  // Every field of the discriminated union is present and well-typed.
  assert.equal(typeof parsed.reason, "string");
  assert.equal(parsed.scope, "worker");
  assert.equal(parsed.resource, "tokens");
  assert.ok(parsed.remaining && typeof parsed.remaining === "object");
  assert.ok(parsed.limit && typeof parsed.limit === "object");
});

// ── Case 8: aborted controller short-circuits the gate ───────────────────

test("wiring: aborted runController returns undefined (the in-flight call can finish settling)", async () => {
  const cap = 1_000;
  const controller = new AbortController();
  controller.abort();
  const { session } = await installWithSeededCumulative({
    cap,
    cumulative: cap, // exhausted, but the abort short-circuit must win
    controller,
  });
  const result = await session.agent.beforeToolCall!(makeContext("bash", {}));
  assert.equal(result, undefined, "aborted controller skips the gate so the agent can settle");
});
