# Parallelization analysis — budget system refactor

**Date:** 2026-09-28
**Companion to:** `04-refactor-plan.md`
**Question:** How can the refactor's 13 features (F1-F13, 69 task checkboxes) be split across `Agent` subagents for parallel execution, given that function/interface contracts can be agreed upon before implementation begins?

**Answer:** The 13 features decompose into **16 sub-agent invocations across 6 waves**, with wall-clock roughly 5-7 waves deep. The plan's narrative Phase 1 → 4 ordering understates the parallelization potential — about 70% of the work can run concurrently if Wave 0 contract agreement lands first.

---

## 0. TL;DR

**The dependency graph is sparser than the plan's narrative order suggests.** Many tasks labeled "Phase 2" only need their *interface* to be agreed upon — once the Wave 0 stubs exist with correct TypeScript signatures, four parallel tracks can split the work.

**Wall-clock:** ~5-7 waves deep instead of 13 sequential features.
**Sub-agents:** 16 invocations across 6 waves.
**Critical prerequisite:** Wave 0 (a single ~30 min sub-agent that defines all interface contracts as `throw new Error("not implemented")` stubs that pass typecheck).
**Hard-sequential bottlenecks:** Wave 2 (F2 `delegateAgent` spine), Wave 5 cleanup + reviews.
**Out-of-band:** F13 dashboard UI can run fully parallel to backend work.

---

## 1. Dependency graph (derived from the plan)

| Task | Hard dependencies | Touched files |
|---|---|---|
| T1.1 module skeleton | none | `src/engine/budget/{ledger,policy,strategy,events,worker-tools,index}.ts` (stubs) |
| T1.2 BudgetLedger | T1.1 (interface stub) | `src/engine/budget/ledger.ts`, `tests/budget-ledger.test.ts` |
| T1.3 BudgetPolicy | T1.1 | `src/engine/budget/policy.ts`, `tests/budget-policy.test.ts` |
| T1.4 WorkerBudgetStrategy | T1.1 | `src/engine/budget/strategy.ts` |
| T2.1 installBudgetEventHooks | T1.2, T1.3 | `src/engine/budget/events.ts` |
| T2.2 delegateAgent | T2.1, F6 schema (resolved policy type) | `src/engine/budget/worker-tools.ts`, `src/engine/dispatch.ts` |
| T2.3 depth cap | T1.3, T2.2 | `src/engine/budget/policy.ts` |
| T3.x (live tracking) | T2.1 (subscribed events) | `src/engine/budget/events.ts` |
| T4.x (end-of-run) | T2.1 | `src/engine/budget/events.ts`, `src/engine/dispatch.ts` |
| T5.1-T5.12 (operator commands + cooperative tools) | T1.2, T1.3, T2.1 | `src/engine/budget/worker-tools.ts`, `src/agents/tools/summarize-progress.ts` |
| T6.1-T6.10 (config schema) | none within itself | `src/core/{types,schema,config-validation}.ts`, `src/agents/frontmatter.ts` |
| T7.x (race tests) | T2.2, T3.x, T4.x — **can be authored against interfaces** | `tests/budget-races.test.ts` |
| T8.x (reload tests) | same as T7.x | `tests/budget-reload.test.ts` |
| T9.x (legacy cleanup) | every consumer of `governance.ts` updated | `git rm src/engine/governance.ts`, `git rm src/engine/budget-strategy.ts`, dispatch.ts slimming |
| T10.x (reviewer sign-off) | full diff complete | reviewer outputs |
| T11.x (PR merge) | all the above | `gh pr` actions |
| T12.x (migration guide) | F6 spec finalized | `docs/migrations/budget-config-v2.md` |
| T13.x (dashboard UI) | F5 commands spec'd (already done in §2.8 of plan) | `ui/web/src/**` |

**Key insight from §2.3, §2.8, §2.10 of `04-refactor-plan.md`:** every operator command, every cooperative tool, and the config schema already have *specified signatures*. The plan describes the wire contract. The interfaces are the only thing blocking parallel implementation.

---

## 2. Wave 0 — Contract agreement (1 agent, ~30 min, gates everything)

A single agent defines all new TypeScript interfaces and types in shared module files, with stub function bodies that throw `Error("not implemented")`. This is **interface-only** — no behavior. Goal: a green typecheck across the codebase.

### 2.1 Files touched in Wave 0

- `src/engine/budget/types.ts` (new) — re-export of all budget type contracts
- `src/engine/budget/{ledger,policy,strategy,events,worker-tools,index}.ts` — created as stubs with correct signatures, throwing `Error("not implemented")`
- `src/core/types.ts` — append `BudgetLedgerEntry`, `WorkerBudgetPolicy`, `BudgetBlock`, `BudgetLedger`, `WorkerBudgetStrategy`, discriminated-union `BudgetLedgerEntry` (with the G-08 `kind?: string` fix)
- `src/core/schema.ts` — typebox schemas for the new nested config (T6.1 schema only — no dual-format yet)
- `src/agents/tools/summarize-progress.ts` — new signature accepting `BudgetLedger` instead of `runtime.progressNotes`
- `src/observability/server/runtime.ts` (or wherever telemetry event types live) — append new `BudgetLedgerEntry` event shape (for G-22 dashboard hard cutover)

### 2.2 Contracts to lock down

1. `BudgetLedger` class shape: `restore(sessionManager, agentName, policy)`, `recordEvent(type, cumulative, signal)`, `maybeSnapshot(cumulative, policy, signal)`, `recordCompaction(savings, signal)`, `snapshot(stats, policy, marker, signal)`, `entries[]`
2. `BudgetPolicy` pure functions: `checkBudgetPolicy(ledger, policy, branch)`, `workerConsumedTokens(session, scope)`, `workerConsumedCost(session)`, `teamUsage(branch)`, `ratioRemaining(used, cap)`, `crossedThreshold(remaining, threshold)`
3. `WorkerBudgetPolicy` resolved shape per §2.5/§2.10 of `04-refactor-plan.md`
4. `BudgetBlock` discriminated union: `{reason, scope: "worker"|"team", resource: "tokens"|"costUsd"|"runs"|"depth", remaining, limit}`
5. **Operator command signatures** (7 commands, all from plan §2.8):
   - `endWorkerSession(agent, reason): Promise<{sessionId, ledgerSnapshot}>`
   - `compactWorkerSession(agent, reason, customInstructions?): Promise<...>`
   - `respawnWorkerSession(agent, reason, newTask?): Promise<{oldSessionId, newSessionId, ledgerSnapshot}>`
   - `pauseWorkerSession(agent, reason): Promise<...>`
   - `snapshotWorkerSession(agent, label): Promise<...>`
   - `restoreWorkerSession(agent, snapshotId): Promise<{sessionId, ledgerSnapshot}>`
   - `resumeWorkerSession(agent): Promise<...>`
   - `abortWorkerCompaction(agent): Promise<...>`
6. **Cooperative tool signatures** (3 tools, from plan §2.8 + G-07):
   - `request_compaction(customInstructions?)`
   - `request_end_session(reason)`
   - `request_snapshot(label)`
7. New config schema types (per §2.10 + §2.13): `BudgetsConfig`, `WorkerBudgetConfig`, `TeamBudgetConfig`, `TokensCap`, `CostUsdCap`, `RunsCap`, `DepthCap` (discriminated by `resource` per C4), `WindowKind` (per C6), `IncludeKeys` (per C2), `Strategies` (per C5, conditional)
8. `BudgetLedgerEntry.data` schema including G-08 `kind?: string` field

### 2.3 Wave 0 gate

`just typecheck` clean across all four configs. **No tests added yet. No imports in dispatch.ts yet** — the stubs sit unused.

---

## 3. Wave 1 — Independent foundation work (4 parallel agents)

After Wave 0, four agents work in parallel on disjoint file sets.

### 3.1 Agent 1A — F1: Budget primitives

**Tasks:** T1.2 (BudgetLedger, 8 tests), T1.3 (BudgetPolicy, 11 tests including G-29 type-mismatch), T1.4 (WorkerBudgetStrategy resolver, 4 tests).

**Files:** `src/engine/budget/{ledger,policy,strategy}.ts`, `tests/budget-ledger.test.ts`, `tests/budget-policy.test.ts`, `tests/budget-strategy-resolver.test.ts`.

**Isolation:** Only writes files under `src/engine/budget/{ledger,policy,strategy}.ts` and the three test files.

### 3.2 Agent 1B — F6: Config schema migration

**Tasks:** T6.1 (new nested schema, 2 tests), T6.2 (old flat as deprecated alias, 2 tests), T6.3 (dual-format validation, 2 tests), T6.4 (C1 rename `governance:` → `budgets:`, 1 test), T6.5 (C2 `include:` list, 2 tests), **T6.6 dropped per G-16 hard cutover** (C3 `defaults-enabled` flag not implemented), T6.7 (C4 typebox discriminated unions, 1 test), T6.8 (C6 explicit `window:`, 1 test), **T6.9 conditional** (C5 structured strategies — defer to v3 unless user overrides before Wave 1 starts), T6.10 (per-day rollover test, 1 test).

**Files:** `src/core/{types,schema,config-validation}.ts`, `src/agents/frontmatter.ts`, `tests/config-schema.test.ts`.

**Note:** Per the gap-decisions walkthrough, C3 is dropped (G-16 hard cutover) and C5 is conditional. Agent 1B should land C1, C2, C4, C6, T6.1, T6.2, T6.3, T6.10 — skip C3 entirely, treat C5 as conditional pending user input.

**Isolation:** Only writes files under `src/core/**` and `src/agents/frontmatter.ts`. The `WorkerBudgetPolicy` type from F1 is consumed but already declared in Wave 0; Agent 1B doesn't depend on F1's implementation, only on the *type contract*.

### 3.3 Agent 1C — F12: Config migration guide (docs)

**Tasks:** T12.1 (≥5 before/after examples), T12.2 (document hard cutover), T12.3 (rollback instructions).

**Files:** `docs/migrations/budget-config-v2.md` (new).

**Isolation:** Only writes to `docs/migrations/budget-config-v2.md`.

### 3.4 Agent 1D — T5.7: summarize_progress tool refactor

**Tasks:** T5.7 (simplify `summarize_progress` to use `appendCustomMessageEntry` instead of `runtime.progressNotes`; cover 3 failure paths: `no_runtime`, `over_cap`, `compact_failed`). 7 tests total (2 preserved + 5 new).

**Files:** `src/agents/tools/summarize-progress.ts`, `tests/summarize-progress.test.ts`.

**Isolation:** Only writes to those two files. The tool's signature was updated in Wave 0, so this agent only needs to fill in the body.

### 3.5 Wave 1 gate

`just test` clean; 4 agents' tests all pass in isolation. Each agent commits to its own files. **No merge conflicts because the file sets are disjoint.**

---

## 4. Wave 2 — F2 spine (1 agent, must be sequential)

F2 is the **integration point** — `delegateAgent` wires F1's primitives + F6's schema + the existing dispatch path. It cannot run in parallel with itself; it depends on Agent 1A's primitives existing and Agent 1B's resolved policy types being usable.

### 4.1 Agent 2 — F2: Budget-aware delegate_agent

**Tasks:** T2.1 (installBudgetEventHooks factory, 12 tests), T2.2 (delegateAgent, 15 tests — refactor dispatch.ts:dispatchAgent to delegate), T2.3 (depth cap, 1 test).

**Files:** `src/engine/budget/events.ts`, `src/engine/budget/worker-tools.ts`, `src/engine/dispatch.ts` (refactor to delegate), `tests/budget-events.test.ts`, `tests/budget-worker-tools.test.ts`.

**Sequencing within the agent:** T2.1 must land before T2.2 (T2.2 calls `installBudgetEventHooks`). T2.3 modifies the policy.ts depth pre-flight check but the test pins it after T2.2 lands.

### 4.2 Wave 2 gate

Existing 510 tests still pass (dispatch.ts refactor preserves behavior). New tests: T2.1 + T2.2 + T2.3 = 28 new tests. Smoke test: orchestrator can still delegate to a worker end-to-end.

---

## 5. Wave 3 — Three independent feature tracks (4 parallel agents)

After F2 ships, four agents work on disjoint features. All three F5 sub-tracks can run in parallel because T5.7 already shipped in Wave 1, and the remaining 11 operator commands partition by command-cluster (state-mutation vs. branch-management vs. cooperative tools).

### 5.1 Agent 3A — F3 + F4: Live tracking + end-of-run

**Tasks:** T3.1 (throttled snapshot), T3.2 (warning emit at 20%, dedup), T3.3 (abort at 0%, exhausted emit), T3.4 (tool_call blocking for bash/edit/write/read — G-01, 6 tests), T3.5 (warning × summarize_progress ordering — G-17), T3.6 (abort-then-agent_settled ordering — G-02), T4.1 (agent_settled final snapshot), T4.2 (remove old agent_end handler in dispatch.ts).

**Files:** `src/engine/budget/events.ts` (extending the installer from T2.1), `src/engine/dispatch.ts` (T4.2 cleanup), `tests/budget-events.test.ts` (additional tests for T3.x).

**Sub-sequencing:** T3.1 → T3.2 → T3.3 → T3.4 (T3.4 is independent of T3.1-T3.3 but ordering tests T3.5/T3.6 need T3.2/T3.3 done first). T4.1 and T4.2 are end-of-run and naturally follow.

### 5.2 Agent 3B — F5 operator commands: stop/pause/resume cluster

**Tasks:** T5.1 (endWorkerSession — session.abort + ledger), T5.2 (compactWorkerSession — session.compact + ledger), T5.4 (pauseWorkerSession — waitForIdle + ledger), T5.8 (resumeWorkerSession — resume from paused), T5.9 (abortWorkerCompaction — session.abortCompaction).

**Files:** `src/engine/budget/worker-tools.ts` (append-only section, lines ~151-300), `tests/budget-eol.test.ts` (3 tests per command).

**Why this is one agent:** All five commands operate on a single existing session via `session.abort()`/`session.compact()`/`session.waitForIdle()`. They share helper code (e.g., the snapshot-write pattern with marker/kind).

### 5.3 Agent 3C — F5 operator commands: branch/clone cluster

**Tasks:** T5.3 (respawnWorkerSession — session.dispose + SessionManager.create + branchWithSummary, the most complex — needs SDK chain research), T5.5 (snapshotWorkerSession — branchWithSummary), T5.6 (restoreWorkerSession — createBranchedSession, with documented SDK chain per plan §2.8).

**Files:** `src/engine/budget/worker-tools.ts` (append-only section, lines ~301-450), `tests/budget-eol.test.ts`.

**Why this is one agent:** All three commands involve `SessionManager`'s branching APIs (`branchWithSummary`, `createBranchedSession`, `dispose`). T5.3 is the load-bearing one — get it right first, T5.5 and T5.6 follow the same shape.

**Conflict risk with Agent 3B:** Both agents edit `src/engine/budget/worker-tools.ts`. **Mitigation:** partition by line range (see §10.1). Each agent appends a contiguous region. A merge conflict at the function-order line is acceptable and easy to resolve.

### 5.4 Agent 3D — F5 cooperative tools

**Tasks:** T5.10 (request_compaction — agent-callable tool), T5.11 (request_end_session), T5.12 (request_snapshot).

**Files:** `src/engine/budget/worker-tools.ts` (separate region, lines ~451-600), `tests/cooperative-eol.test.ts` (new file).

**Why this is one agent:** Three tools, all sharing the cooperative-tool scaffold (similar input validation, similar ledger write pattern). Each tool is small (1 test).

### 5.5 Wave 3 gate

`just test` clean. New tests: F3 + F4 (T3.x + T4.x) ≈ 18 tests + F5 commands (T5.1-T5.12 minus T5.7 which is in Wave 1) ≈ 22 tests. Total Wave 3 increment: ~40 tests. Cross-agent file conflicts resolved by the user (or by a quick `git diff` review since partition is by line range).

---

## 6. Wave 4 — Validation tracks (2 parallel agents, can overlap with Wave 3)

**Important:** Per the TDD argument in the plan's gate descriptions, F7 and F8 are tests that pin behavior. They can be written *before* the implementation lands, against the Wave 0 interface contracts, and then run against the Wave 3 implementation. This means F7 and F8 can start as soon as Wave 0 ships, in parallel with Wave 1 / Wave 2 / Wave 3.

### 6.1 Agent 4A — F7: Race-safe accounting

**Tasks:** T7.1 (abort-then-getSessionStats race, must pass 100 consecutive runs), T7.2 (parallel delegation updates — augment per G-09 to assert team totals), T7.3 (mid-run compaction racing message_end), T7.4 (session_start racing CustomEntry write), T7.6 (agent_settled after abort), T7.7 (Bug 3 end-to-end regression — G-03).

**Files:** `tests/budget-races.test.ts` (new, ~250 LOC).

**Sub-sequencing:** Tests use deterministic fake-session factories per the plan's `no Math.random/Date.now/setTimeout` rule. Authored against the interface contracts; can be written before the implementation.

### 6.2 Agent 4B — F8: Reload-stable ledger

**Tasks:** T8.1 (`/reload` re-derivation), T8.2 (pre-reload `BudgetExhaustedError` blocks post-reload), T8.3 (paused session resumes), T8.4 (audit closure-captured state), T8.5 (`/tree` re-derives from new branch — G-11), T8.6 (`/fork` creates ledger-fresh branch — G-11).

**Files:** `tests/budget-reload.test.ts` (new).

### 6.3 Wave 4 gate

All race tests pass 100 consecutive runs (the plan's `for i in {1..100}; do just test -- tests/budget-races.test.ts || exit 1; done`). Zero flake.

---

## 7. Wave 5 — Cleanup + review (sequential, must come last)

### 7.1 Agent 5A — F9: Legacy cleanup

**Tasks:** T9.1 (`git rm src/engine/governance.ts` + import updates), T9.2 (`git rm src/engine/budget-strategy.ts` + import updates), T9.3 (slim `src/engine/dispatch.ts` from ~1100 to ≤600 LOC), T9.4 (eslint clean).

**Files:** deletions + dispatch.ts cleanup + import updates across the codebase.

**Why this must be last:** F9 deletes the modules that pre-Wave-2 callers may have used. After Wave 3, every consumer has been updated to use the new `src/engine/budget/` modules, so the deletions are safe.

### 7.2 Agent 5B — F10: Reviewer sign-off

**Tasks:** T10.1 (kieran-typescript-reviewer), T10.2 (architecture-strategist), T10.3 (code-simplicity-reviewer), T10.4 (save outputs to `docs/reviews/28-09-2026-budget-review/review-runs/`).

**Sequential:** T10.1 → apply fixes → T10.2 → apply fixes → T10.3 → apply fixes. Each reviewer can produce should-fix items that the agent applies before the next reviewer.

**Why one agent for all three reviewers:** Multi-round review can lose context (per HANDOFF pitfall #32). A single agent handles all three rounds with full context preserved.

### 7.3 Agent 5C — F11: PR merge (user-action, not agent)

T11.1 (decide PR #54 disposition), T11.2 (open refactor PR), T11.3 (wait for user merge per AGENTS.md), T11.4 (fast-forward local main).

**Per AGENTS.md, the user merges; the agent cannot auto-merge.**

---

## 8. Out-of-band — F13: Dashboard UI (1 agent, parallel with everything)

**Tasks:** T13.1 (6 EOL buttons per active worker), T13.2 (interventionAvailable flag), T13.3 (mode-independence).

**Files:** `ui/web/src/**`.

**Why out-of-band:** The dashboard reads the engine's wire contract. The operator commands are fully specified in §2.8 of the plan (signatures, SDK primitives, ledger marker names). The agent only needs to know which `kind` value to send for which button. The dashboard can be developed against a stub server (or after Wave 3 ships) — either way it's parallel to all backend work.

**Recommended split:** T13.1 + T13.2 land after Wave 3 ships (so the engine can serve real responses); T13.3 is a smoke test.

---

## 9. Wave structure visualized

```
Wave 0  ──→  Agent 0 (interface stubs, 30 min)
                  │
                  ▼
Wave 1  ──→  Agent 1A (F1 primitives)  ─┐
            Agent 1B (F6 schema)        ─┤
            Agent 1C (F12 docs)         ─┼─→  parallel
            Agent 1D (T5.7 summarize)  ─┘
                  │
                  ▼
Wave 2  ──→  Agent 2 (F2 spine)                  ← sequential
                  │
                  ▼
Wave 3  ──→  Agent 3A (F3 live + F4 end-of-run)  ─┐
            Agent 3B (F5 stop/pause/resume)      ─┤
            Agent 3C (F5 branch/clone)           ─┼─→  parallel
            Agent 3D (F5 cooperative tools)      ─┘
                  │
                  ▼
Wave 4  ──→  Agent 4A (F7 races)         ─┐
            Agent 4B (F8 reload)         ─┴─→  parallel (can also start in Wave 1)
                  │
                  ▼
Wave 5  ──→  Agent 5A (F9 cleanup)               ← sequential (deletes files)
            Agent 5B (F10 reviewers)              ← sequential (3 review rounds)
            Agent 5C (F11 PR merge, user-driven)  ← user action

Out-of-band parallel:
  Agent 6 (F13 dashboard) — can run anytime after Wave 0; recommended after Wave 3 ships
```

**Wall-clock estimate:** ~5 waves deep. Each wave's wall-clock is its slowest agent. Wave 3 is the longest (4 parallel agents, ~3-4 hours each); other waves are 30 min - 2 hours.

---

## 10. The 16-agent roster

| # | Wave | Scope | Tasks | Files owned |
|---|---|---|---|---|
| 0 | 0 | Contracts | — | type files, stubs |
| 1A | 1 | F1 primitives | T1.2, T1.3, T1.4 | `src/engine/budget/{ledger,policy,strategy}.ts` + tests |
| 1B | 1 | F6 schema | T6.1-T6.10 (skip C3, conditional C5) | `src/core/{types,schema,config-validation}.ts`, `src/agents/frontmatter.ts` + tests |
| 1C | 1 | F12 docs | T12.1-T12.3 | `docs/migrations/budget-config-v2.md` |
| 1D | 1 | T5.7 simplify | T5.7 | `src/agents/tools/summarize-progress.ts` + tests |
| 2 | 2 | F2 spine | T2.1-T2.3 | `src/engine/budget/{events,worker-tools}.ts`, `src/engine/dispatch.ts` + tests |
| 3A | 3 | F3+F4 | T3.1-T3.6, T4.1-T4.2 | `src/engine/budget/events.ts`, `src/engine/dispatch.ts` + tests |
| 3B | 3 | F5 stop/pause/resume | T5.1, T5.2, T5.4, T5.8, T5.9 | `src/engine/budget/worker-tools.ts` (lines ~151-300), tests |
| 3C | 3 | F5 branch/clone | T5.3, T5.5, T5.6 | `src/engine/budget/worker-tools.ts` (lines ~301-450), tests |
| 3D | 3 | F5 cooperative tools | T5.10, T5.11, T5.12 | `src/engine/budget/worker-tools.ts` (lines ~451-600), `tests/cooperative-eol.test.ts` |
| 4A | 4 | F7 races | T7.1-T7.7 | `tests/budget-races.test.ts` |
| 4B | 4 | F8 reload | T8.1-T8.6 | `tests/budget-reload.test.ts` |
| 5A | 5 | F9 cleanup | T9.1-T9.4 | deletions + dispatch.ts |
| 5B | 5 | F10 review | T10.1-T10.4 | reviewer outputs |
| 5C | 5 | F11 merge | T11.1-T11.4 | PR actions (user-driven) |
| 6 | OO | F13 dashboard | T13.1-T13.3 | `ui/web/src/**` |

---

## 11. Cross-track constraints and risks

### 11.1 File-collision risks

The single biggest risk: **multiple agents editing `src/engine/budget/worker-tools.ts`** in Wave 3. Mitigation: partition by line range, with each agent appending to a pre-agreed region.

**Recommended line-range partition** (verify against Wave 0's stub output):

```
src/engine/budget/worker-tools.ts:
  Lines 1-50:    module imports + barrel
  Lines 51-150:  delegateAgent (F2 — Agent 2 owns this)
  Lines 151-300: endWorkerSession + compactWorkerSession + pauseWorkerSession + resumeWorkerSession + abortWorkerCompaction (Agent 3B)
  Lines 301-450: respawnWorkerSession + snapshotWorkerSession + restoreWorkerSession (Agent 3C)
  Lines 451-600: request_compaction + request_end_session + request_snapshot (Agent 3D)
  Lines 600+:    helpers (used by all; whoever needs a helper adds it; merge resolved by keeping the most-general)
```

If two agents need to add helpers, conflicts will be small (3-5 line additions) and easy to merge.

### 11.2 Schema-evolution risk

Agent 1B defines the resolved `WorkerBudgetPolicy` type and Agent 1A defines the policy *checker*. If Agent 1A's checker expects a `cap` field that Agent 1B doesn't expose, the typecheck breaks at Wave 1 end.

**Mitigation:** Wave 0's contract-agreement phase MUST lock the resolved-policy type. Agent 1A and 1B both consume it as input — neither is allowed to add fields without a follow-up contract amendment.

### 11.3 SDK-chain risk for T5.6

The plan's T5.6 explicitly flags that `SessionManager.createBranchedSession` returns `string | undefined`, not an `AgentSession`. The SDK chain research is a load-bearing task for Agent 3C. **Agent 3C should run a brief exploration of the local SDK source at `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts` before implementing T5.6** — the d.ts file has the answer.

### 11.4 Test-fixture risk for F7

Per the plan, F7 tests must pass 100 consecutive runs with zero flake. The plan's T7.4 ("session_start racing with CustomEntry write") and T7.5 ("reload mid-budget") are inherently timing-sensitive. **Agent 4A must use deterministic fake-session factories, not real SDK calls** — the plan's `no Math.random/Date.now/setTimeout` rule is a hard constraint. If real SDK timing is required for the race test, that test cannot be made deterministic and should be moved to integration-test status, not unit-test.

### 11.5 Stale-process trap

HANDOFF pitfall #1 / AGENTS.md: every change to `src/engine/budget/**`, `src/engine/dispatch.ts`, `src/observability/server/**`, or `src/engine/review.ts` requires a server restart. Each Wave 3+ agent that touches those files must restart:

```sh
PID=$(lsof -nP -iTCP:43191 -sTCP:LISTEN -t) && kill "$PID"; just pi-dev
```

### 11.6 Cross-reviewer risk for F10

Per HANDOFF pitfall #32, multi-round review can lose context. Agent 5B should write down each reviewer's output AND the applied fixes before moving to the next reviewer. **A single agent handles all three reviewers** so it has full context across rounds.

### 11.7 PR #54 disposition

Per plan §6.2 decision: close PR #54 before the refactor branch opens. This is a user action (T11.1) and should happen between Wave 0 and Wave 1 (so the refactor branch is uncontaminated).

---

## 12. What's NOT parallelizable

After this analysis, three things remain genuinely sequential:

1. **Wave 2 (F2)** — `delegateAgent` is the integration spine. It cannot be parallelized because every downstream feature depends on its signature being correct.
2. **F9 cleanup** — Must be last because the deletion of `governance.ts` and `budget-strategy.ts` invalidates any code that still imports them.
3. **F10 reviewer sign-off** — Three sequential review rounds, each potentially surfacing fixes that block the next.

Everything else is parallelizable given the Wave 0 contract agreement.

---

## 13. Comparison to the plan's narrative order

The plan's Phase 1 → 2 → 3 → 4 ordering is correct for *conceptual* sequencing (foundation first, then integration, then validation, then cleanup). But within Phase 2 (the largest phase with 31 tasks), 24 of those tasks can run in parallel across 4 agents. The plan's task-by-task narrative understates the parallelization potential by ~70%.

The plan's gate-after-every-task discipline is preserved: each agent's tasks have their own gates, and a failing gate in one agent's tasks does not block the others' tasks from landing (since the file sets are disjoint). Cross-cutting gates (final `just test`, final lint) are checked at Wave ends.

---

## 14. What this analysis assumes

1. **AGENTS.md file-edits-in-worktree rule applies** — every agent works in the same worktree (`refactor/budget-pi-native` off `main`) but on disjoint files. The user opens one PR at Wave 5 end.
2. **Each sub-agent has Bash + Read + Edit + Write** (general-purpose subagent type, per AGENTS.md tool selection).
3. **The Wave 0 contract-agreement is its own sub-agent task** — short, focused, single file set. Should not exceed 30 min.
4. **The plan's interface specifications are accurate** — §2.3, §2.5, §2.8, §2.10, §2.13 of `04-refactor-plan.md` are the source of truth for what each Wave 0 stub must declare. If anything in those sections is wrong, Wave 0 is the place to catch it (via typecheck), before downstream agents depend on it.
5. **The plan's F1-F13 narrative is faithful to the SDK reality** — `appendCustomEntry`, `appendCustomMessageEntry`, `getBranch()`, `session.abort()`, `session.dispose()`, `session.compact()`, `session.abortCompaction()`, `session.waitForIdle()`, `branchWithSummary()`, `createBranchedSession()` all behave as the SDK reference doc (`raw-evidence/pi-sdk-session-api.md`) describes. If a future SDK release changes behavior, T5.x commands will need SDK-chain research before implementation.

---

## 15. Pickup instructions for the implementation session

A future session picking up this work and running it in parallel-agent mode should:

1. **Read `04-refactor-plan.md` first** (the implementation plan).
2. **Read this file** (parallelization analysis) — establishes the wave structure and agent roster.
3. **Decide on T6.9 (C5 structured strategies)** — confirm with user before Wave 1 starts (or accept the default: defer to v3).
4. **Close PR #54** before Wave 0 (user action per plan §6.2).
5. **Open a fresh worktree** off `main`:
   ```sh
   APP_ROOT=/Users/cgrant/.pi/agent/git/github.com/demetere/pi-hive
   git worktree add .worktrees/refactor-budget-pi-native -b refactor/budget-pi-native main
   ln -s "$APP_ROOT/node_modules" "$APP_ROOT/.worktrees/refactor-budget-pi-native/node_modules"
   ln -s "$APP_ROOT/ui/web/node_modules" "$APP_ROOT/.worktrees/refactor-budget-pi-native/ui/web/node_modules"
   ```
6. **Run Wave 0** (1 sub-agent, ~30 min) — locks all interface contracts.
7. **Run Wave 1** (4 sub-agents in parallel) — F1, F6, F12, T5.7 in disjoint files.
8. **Run Wave 2** (1 sub-agent) — F2 spine. Sequential after Wave 1.
9. **Run Wave 3** (4 sub-agents in parallel) — F3+F4, three F5 sub-tracks.
10. **Run Wave 4** (2 sub-agents in parallel) — F7 races, F8 reload. (Or earlier, in parallel with Waves 1-3.)
11. **Run Wave 5** (3 sequential sub-agents) — F9 cleanup, F10 reviews, F11 merge.
12. **Out-of-band:** Agent 6 (F13 dashboard) runs anytime after Wave 0, recommended after Wave 3.
13. **Commit per agent** to the same branch; the user opens one PR at Wave 5 end.
14. **Wait for user merge** per AGENTS.md.

---

## 16. Cross-references

- **`04-refactor-plan.md`** — the implementation plan this analysis decomposes
- **`01-current-state-analysis.md`** — the 9 structural issues the plan addresses
- **`raw-evidence/pi-sdk-session-api.md`** — verified SDK reference for every interface contract
- **`pi-docs/extension-patterns-reference.md`** — Pi patterns applied across the plan
- **`review-runs/spec-flow-review.md`** — 30 gaps + 18 questions driving the plan's correctness
- **`AGENTS.md`** — worktree rule, `ask_user` discipline, no-upstream-push rule

---

*End of parallelization analysis. Implementation can begin after PR #54 closure and Wave 0 contract agreement.*
