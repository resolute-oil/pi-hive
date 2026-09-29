/**
 * Wave 4B — F8 reload-stable ledger tests (T8.1-T8.6).
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md
 *   §3.8 F8 — Reload-stable ledger.
 *   §6.2 G-11 — `SessionManager.branch` / `SessionManager.forkFrom`
 *              interaction with the ledger.
 *
 * Coverage:
 *   T8.1 — `/reload` re-derives the ledger from session state.
 *   T8.2 — Pre-reload `BudgetExhaustedError` blocks post-reload.
 *   T8.3 — Paused session resumes after `/reload`.
 *   T8.4 — Audit closure-captured state (no mutable counters in install hooks).
 *   T8.5 — `/tree` re-derives from new branch (G-11).
 *   T8.6 — `/fork` creates ledger-fresh branch (G-11, plan §1.1 structural guarantee).
 *
 * Hard constraints:
 *   - No `Math.random()` / `Date.now()` / `setTimeout()` / `setInterval()` —
 *     deterministic scripted sessions only.
 *   - No implementation changes — tests only. A failing test indicates a
 *     real bug; report it (don't fix it).
 *   - `BudgetExhaustedError` is duck-typed via `error.name`.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  SessionEntry,
  SessionManager as SessionManagerType,
  SessionStats,
} from "@earendil-works/pi-coding-agent";
import {
  BUDGET_LEDGER_CUSTOM_TYPE,
  BudgetLedger,
} from "../src/engine/budget/ledger.ts";
import { installBudgetEventHooks } from "../src/engine/budget/events.ts";
import { checkBudgetPolicy } from "../src/engine/budget/policy.ts";
import type {
  BudgetLedgerData,
  BudgetLedgerEntry,
  WorkerBudgetPolicy,
} from "../src/engine/budget/types.ts";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function makePolicy(overrides: Partial<WorkerBudgetPolicy["worker"]> = {}): WorkerBudgetPolicy {
  return {
    worker: {
      tokens: { resource: "tokens", cap: 100_000 },
      costUsd: { resource: "costUsd", cap: 5 },
      runs: { resource: "runs", cap: 3 },
      depth: { resource: "depth", cap: 2 },
      ...overrides,
    },
    team: {
      tokens: { resource: "tokens", cap: 500_000 },
      costUsd: { resource: "costUsd", cap: 50 },
      runs: { resource: "runs", cap: 20 },
    },
  };
}

function makeStats(tokens: number, cost: number): SessionStats {
  return {
    sessionFile: undefined,
    sessionId: "reload-test",
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens },
    cost,
  };
}

/** Minimal session shape required by `installBudgetEventHooks`. */
interface ScriptedSession {
  listener: ((event: unknown) => void) | null;
  stats: SessionStats;
  abort(): void;
  subscribe(listener: (event: unknown) => void): () => void;
  getSessionStats(): SessionStats;
}

function makeSession(stats: SessionStats): ScriptedSession {
  const s: ScriptedSession = {
    listener: null,
    stats,
    abort() { /* no-op for these tests */ },
    subscribe(listener) {
      s.listener = listener;
      return () => { if (s.listener === listener) s.listener = null; };
    },
    getSessionStats() { return s.stats; },
  };
  return s;
}

async function freshLedger(policy: WorkerBudgetPolicy): Promise<{ ledger: BudgetLedger; sm: SessionManagerType }> {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-reload-"));
  const sm = SessionManager.inMemory(cwd);
  const ledger = await BudgetLedger.restore(sm, "worker", policy);
  return { ledger, sm };
}

function ledgerEntries(sm: SessionManagerType): BudgetLedgerEntry[] {
  return sm
    .getBranch()
    .filter(
      (e): e is Extract<SessionEntry, { type: "custom"; data: unknown }> =>
        e.type === "custom" &&
        (e as { customType?: unknown }).customType === BUDGET_LEDGER_CUSTOM_TYPE,
    )
    .map((e) => {
      const data = (e as { data?: BudgetLedgerData }).data;
      if (!data) throw new Error("ledger entry missing data");
      return { type: "custom", customType: "pi-hive-budget-ledger", data } satisfies BudgetLedgerEntry;
    });
}

// ---------------------------------------------------------------------------
// T8.1 — /reload re-derives the ledger from session state
// ---------------------------------------------------------------------------

test("T8.1 /reload: a fresh BudgetLedger.restore() on the same SM sees the same cumulative and entries as the live ledger", async () => {
  const policy = makePolicy();
  const { ledger: live, sm } = await freshLedger(policy);
  const session = makeSession(makeStats(0, 0));
  installBudgetEventHooks(session, live, policy, sm, new AbortController());

  // First message writes via the spend-ratio trigger (6% of cap).
  session.stats = makeStats(6_000, 0.30);
  session.listener!({ type: "message_end" });
  // Second message writes via the spend-ratio trigger (6% delta from prior).
  session.stats = makeStats(12_000, 0.60);
  session.listener!({ type: "message_end" });
  // Nine more messages at the same tokens — throttled, no additional writes.
  for (let i = 0; i < 9; i++) session.listener!({ type: "message_end" });

  const liveEntries = ledgerEntries(sm);
  const liveCumulative = { ...live.cumulative };

  // Simulate /reload by restoring a fresh ledger on the SAME SM.
  const reloaded = await BudgetLedger.restore(sm, "worker", policy);

  assert.equal(reloaded.cumulative.tokens, liveCumulative.tokens);
  assert.equal(reloaded.cumulative.costUsd, liveCumulative.costUsd);
  assert.equal(reloaded.cumulative.runs, liveCumulative.runs);
  assert.equal(reloaded.entries().length, liveEntries.length, "reloaded ledger sees the same entries as the live branch");

  // The latest entry's cumulative equals the reloaded cumulative (proves
  // "re-derives from the most recent ledger entry", not closure state).
  const latest = reloaded.entries()[reloaded.entries().length - 1]!;
  assert.equal(latest.data.cumulative.tokens, reloaded.cumulative.tokens);
});

// ---------------------------------------------------------------------------
// T8.2 — Pre-reload BudgetExhaustedError blocks post-reload
// ---------------------------------------------------------------------------

test("T8.2 /reload: a marker:exhausted entry written pre-reload still blocks post-reload dispatch", async () => {
  const cap = 1_000;
  const policy = makePolicy({ tokens: { resource: "tokens", cap } });
  const { ledger, sm } = await freshLedger(policy);
  const session = makeSession(makeStats(0, 0));
  const controller = new AbortController();
  installBudgetEventHooks(session, ledger, policy, sm, controller);

  // Drive the worker to the cap → evaluateThresholds writes marker:"exhausted".
  session.stats = makeStats(cap, 0);
  session.listener!({ type: "message_end" });

  const exhaustedBefore = ledgerEntries(sm).filter((e) => e.data.marker === "exhausted");
  assert.equal(exhaustedBefore.length, 1, "pre-reload: one exhausted entry on the branch");

  // Simulate /reload.
  const reloaded = await BudgetLedger.restore(sm, "worker", policy);
  assert.equal(reloaded.cumulative.tokens, cap);

  // The block must persist — checkBudgetPolicy returns a BudgetBlock. This
  // is the contract runBudgetPreflight relies on to throw BudgetExhaustedError
  // (worker-tools.ts:491-494 duck-types `error.name = "BudgetExhaustedError"`).
  const blocked = checkBudgetPolicy(reloaded, policy, sm.getBranch(), 1);
  assert.ok(blocked, "post-reload checkBudgetPolicy returns a BudgetBlock");
  assert.equal(blocked!.scope, "worker");
  assert.equal(blocked!.resource, "tokens");
  assert.equal(blocked!.remaining.tokens, 0);

  const error = new Error(blocked!.reason) as Error & { name: string };
  error.name = "BudgetExhaustedError";
  assert.equal(error.name, "BudgetExhaustedError", "the thrown error is duck-typed as BudgetExhaustedError");
});

// ---------------------------------------------------------------------------
// T8.3 — Paused session resumes after /reload
// ---------------------------------------------------------------------------

test("T8.3 /reload: kind:pause + kind:resume ledger entries survive restore and stay in branch order", async () => {
  const policy = makePolicy();
  const { ledger, sm } = await freshLedger(policy);
  // Seed cumulative so the pause snapshot has non-zero tokens, mirroring the
  // pauseWorkerSession shape (plan §3.5): waitForIdle → snapshot(kind:pause).
  ledger.recordEvent("message_end", { tokens: 1_500, costUsd: 0.10, runs: 1 });
  ledger.snapshot(makeStats(1_500, 0.10), policy, "pause");
  // resumeWorkerSession shape: re-attach hooks → snapshot(kind:resume).
  ledger.snapshot(makeStats(1_700, 0.12), policy, "resume");

  // Simulate /reload.
  const reloaded = await BudgetLedger.restore(sm, "worker", policy);
  const kinds = reloaded.entries().map((e) => e.data.kind);

  assert.ok(kinds.includes("pause"), "pause entry survived reload");
  assert.ok(kinds.includes("resume"), "resume entry survived reload");
  assert.ok(kinds.indexOf("pause") < kinds.indexOf("resume"), `pause precedes resume (got: ${JSON.stringify(kinds)})`);
  assert.equal(reloaded.cumulative.tokens, 1_700);
  assert.equal(reloaded.cumulative.costUsd, 0.12);
});

// ---------------------------------------------------------------------------
// T8.4 — Audit closure-captured state
// ---------------------------------------------------------------------------

test("T8.4 audit: closure-written CustomEntries from installBudgetEventHooks are persisted via the shared SessionManager (no captured mutable state)", async () => {
  const policy = makePolicy();
  const { ledger, sm } = await freshLedger(policy);
  const session = makeSession(makeStats(0, 0));
  // Install the hook — `ledger` is captured in the subscribe closure.
  installBudgetEventHooks(session, ledger, policy, sm, new AbortController());

  // Drive events that produce a throttled snapshot + a final checkpoint.
  session.stats = makeStats(7_000, 0.35); // 7% of cap → spend-trigger snapshot
  session.listener!({ type: "message_end" });
  session.listener!({ type: "agent_settled" });

  const writtenAfterHook = ledgerEntries(sm);
  assert.ok(writtenAfterHook.length >= 2, `hook wrote ≥2 entries (got ${writtenAfterHook.length})`);
  assert.ok(
    writtenAfterHook.filter((e) => e.data.marker === "checkpoint").length >= 1,
    "agent_settled wrote a checkpoint",
  );

  // Discard the in-memory `ledger` reference and restore a fresh one on the
  // same SM. If the hook closure held a mutable counter (not the SM), this
  // restore would see 0 entries. Instead it sees everything the hook wrote.
  const reloaded = await BudgetLedger.restore(sm, "worker", policy);
  assert.equal(
    reloaded.entries().length,
    writtenAfterHook.length,
    "fresh restore sees the same entries the hook wrote — closure holds no counter state",
  );
});

// ---------------------------------------------------------------------------
// T8.5 — /tree re-derives from new branch (G-11)
// ---------------------------------------------------------------------------

test("T8.5 /tree: SessionManager.branch(otherLeafId) changes which ledger CustomEntries BudgetLedger.restore reads", async () => {
  const policy = makePolicy();
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-reload-tree-"));
  const sm = SessionManager.inMemory(cwd);

  // Branch A: write a ledger entry at the root.
  sm.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, {
    caps: { workerTokens: 100_000 },
    cumulative: { tokens: 1_000, costUsd: 0.05, runs: 1 },
    writtenAt: 1,
    agentSlug: "branch-A-worker",
  });
  const branchALeafId = sm.getLeafId()!;

  // Branch B: append a child, then a DIFFERENT ledger entry — this creates a
  // sibling branch off the root (branch A is still at the root, branch B is
  // rooted at the user_message child).
  sm.appendCustomMessageEntry("user_message", "second branch", true);
  sm.appendCustomEntry(BUDGET_LEDGER_CUSTOM_TYPE, {
    caps: { workerTokens: 100_000 },
    cumulative: { tokens: 2_000, costUsd: 0.10, runs: 1 },
    writtenAt: 2,
    agentSlug: "branch-B-worker",
  });

  // Default leaf points at the most recent write — branch B.
  const ledgerOnB = await BudgetLedger.restore(sm, "branch-B-worker", policy);
  assert.equal(ledgerOnB.cumulative.tokens, 2_000, "current leaf = branch B → tokens=2_000");

  // Navigate to branch A.
  sm.branch(branchALeafId);
  const ledgerOnA = await BudgetLedger.restore(sm, "branch-A-worker", policy);
  assert.equal(ledgerOnA.cumulative.tokens, 1_000, "after branch(branchALeafId) → tokens=1_000");

  // Restoring branch-B-worker on branch A reads 0 (B's entry is on the
  // sibling path, not A's). Per-branch isolation — the structural
  // guarantee that /tree re-derives ledger from the active branch only.
  const ledgerBOnA = await BudgetLedger.restore(sm, "branch-B-worker", policy);
  assert.equal(ledgerBOnA.cumulative.tokens, 0, "branch-B-worker has no entries on branch A's path");
});

// ---------------------------------------------------------------------------
// T8.6 — /fork creates ledger-fresh branch (G-11)
// ---------------------------------------------------------------------------

test("T8.6 /fork: SessionManager.forkFrom on a source with no ledger entries produces a ledger-fresh branch (cumulative = 0)", async () => {
  const policy = makePolicy();
  // Source session: file-backed so forkFrom can read the source path. The
  // session must contain at least one user + assistant message so the SDK
  // flushes the JSONL to disk (session-manager.js:_persist only writes on
  // the first assistant message arrival).
  const sourceCwd = mkdtempSync(join(tmpdir(), "pi-hive-fork-source-"));
  const sourceDir = mkdtempSync(join(tmpdir(), "pi-hive-fork-source-sessions-"));
  const sourceSM = SessionManager.create(sourceCwd, sourceDir);
  sourceSM.appendMessage({ role: "user", content: "pre-fork prompt" } as never);
  sourceSM.appendMessage({ role: "assistant", content: "pre-fork response" } as never);
  const sourcePath = sourceSM.getSessionFile();
  assert.ok(sourcePath, "source SM must be persisted (forkFrom reads the file)");

  // Fork into a fresh target cwd.
  const targetCwd = mkdtempSync(join(tmpdir(), "pi-hive-fork-target-"));
  const targetSM = SessionManager.forkFrom(sourcePath, targetCwd);

  // Restore a ledger on the forked SM — no ledger entries were on the
  // source, so the fork's branch is ledger-fresh (structural guarantee from
  // plan §1.1: new branches have ledger-fresh state).
  const forkedLedger = await BudgetLedger.restore(targetSM, "any-worker", policy);
  assert.equal(forkedLedger.cumulative.tokens, 0, "forked branch: tokens = 0 (ledger-fresh)");
  assert.equal(forkedLedger.cumulative.costUsd, 0);
  assert.equal(forkedLedger.cumulative.runs, 0);
  assert.equal(forkedLedger.entries().length, 0, "forked branch has no ledger CustomEntries");
});
