---
title: Wave 4 — Validation (2 parallel agents)
type: refactor
wave: 4
date: 2026-09-29
status: ready-for-implementation
---

# Wave 4 — Validation

## Goal

Two sub-agents work in parallel to pin race conditions and reload-stable behavior. F7 races are deterministic against fake-session factories (100-consecutive-run stability gate); F7 also includes 2 integration tests using real SDK timing. F8 reload tests cover `/reload`, `/tree`, and `/fork` interactions with the ledger.

## Source of truth & operating conventions

**Consult in this order:** this brief → `../refactor-plan/docs/reviews/28-09-2026-budget-review/04-refactor-plan.md` (§X.Y cited per task) → `../refactor-plan/docs/reviews/28-09-2026-budget-review/06-final-review.md` (2026-09-29 walkthrough, commit `fc479f9`) → `../refactor-plan/docs/reviews/28-09-2026-budget-review/raw-evidence/pi-sdk-session-api.md` (SDK 0.99.1).

**Disagreement rules:** brief vs. plan → **plan wins** (brief is a summary). Plan vs. review → **review wins** for walkthrough-touched items (operator escape hatches, F13 promotion, C5 in v2, T5.15, expanded test coverage). Still unclear → surface via `ask_user` (inline mode per AGENTS.md).

**Worktree init:** per-phase worktree under `APP_ROOT/.worktrees/refactor-budget-<phase>-<task>/`, **based off `refactor/budget` (NOT `main`, NOT a remote ref)**. **Do NOT symlink `node_modules`** from APP_ROOT — APP_ROOT pins SDK 0.80.7 vs worktree 0.99.1; run `just install` independently.

**Stale-process trap:** after editing `src/engine/budget/**`, `src/engine/dispatch.ts`, `src/observability/server/**`, or `src/engine/review.ts`: `PID=$(lsof -nP -iTCP:43191 -sTCP:LISTEN -t) && kill "$PID"; just pi-dev`.

**Marking done:** flip `[ ]` → `[x]` in this brief's Tasks table **at commit time, in the same commit** that lands the task. Future sessions read this brief before HANDOFF.md.

**Branches:** stay local per LOCAL-ONLY — no `git push`, no PR.

## Scope

**In scope:**

- F7 race tests: abort-then-`getSessionStats` race, parallel delegation updates (G-09: team totals), mid-run compaction × `message_end`, `session_start` × CustomEntry write, `/reload` mid-budget (F8's regression test authored here for sequencing), `agent_settled` after abort, Bug 3 end-to-end regression (G-03 + P10 review), **2 real-SDK integration tests** (T7.8 per P4 review)
- F8 reload tests: `/reload` re-derives ledger (T8.1), pre-reload `BudgetExhaustedError` blocks post-reload (T8.2), paused session resumes (T8.3), closure-captured state audit (T8.4), `/tree` re-derives (T8.5 G-11), `/fork` creates ledger-fresh branch (T8.6 G-11)

**Out of scope:**

- New behavior (this is validation only — no implementation changes beyond what Wave 3 ships)
- Cleanup of legacy files (Wave 5A)
- Reviewer rounds (Wave 5B)
- Dashboard wiring (F13)

## Tasks

Two parallel agents. Tasks per agent:

**Agent 4A (F7 races):**

| Task | Description |
|---|---|
| [ ] T7.1 | Abort-then-`getSessionStats()` race (Bug 3 symptom class); 100 consecutive runs, no flake |
| [ ] T7.2 | Parallel delegation updates; **augmented per G-09 to assert team totals consistency** |
| [ ] T7.3 | Mid-run compaction racing with `message_end` |
| [ ] T7.4 | `session_start` racing with in-flight `CustomEntry` write |
| [ ] T7.5 | `/reload` mid-budget (F8's regression test authored here for sequencing) |
| [ ] T7.6 | `agent_settled` after abort |
| [ ] T7.7 | Bug 3 end-to-end regression: fresh=true delegation → budget at 99% → manual abort at 0% → `restore` ledger → assert `remaining.tokens` reflects actual cumulative spend. **Per P10 review:** also assert `getSessionStats().tokens.total` matches the expected value AFTER `restoreWorkerSession` — restored sessions must not have wrong totals from non-filtered `stopReason === 'aborted'` messages |
| [ ] T7.8 | **NEW per P4 review:** 2 integration tests using real SDK timing (abort-then-`getSessionStats()` race; parallel delegation updates against a real `SessionManager`). 100-run stability gate does NOT apply (real SDK timing is inherently non-deterministic); assert behavior within bounded timing windows |

**Agent 4B (F8 reload):**

| Task | Description |
|---|---|
| [ ] T8.1 | `/reload` re-derives ledger from `getBranch()` (T7.5 covers the regression) |
| [ ] T8.2 | Pre-reload `BudgetExhaustedError` blocks post-reload dispatch |
| [ ] T8.3 | Paused session resumes correctly after `/reload` |
| [ ] T8.4 | Audit `src/engine/budget/` for closure-captured state; remove any that survived |
| [ ] T8.5 | `/tree` re-derives ledger from new branch (G-11); navigate via `SessionManager.branch(branchFromId)`; assert `BudgetLedger.restore` reads the new branch's `CustomEntry`s |
| [ ] T8.6 | `/fork` creates a ledger-fresh branch (G-11); fork via `SessionManager.forkFrom`; assert the new session has an empty ledger and a fresh budget |

For full task prose, the implementing agent reads `04-refactor-plan.md` §5 F7 and §5 F8 directly.

## Files touched

**Agent 4A (F7 races):**

- `tests/budget-races.test.ts` (new, ~250 LOC, 6 tests: T7.1, T7.2, T7.3, T7.4, T7.6, T7.7)
- `tests/budget-races-integration.test.ts` (new, ~80 LOC, 2 tests: T7.8 real-SDK integration)
- `tests/budget-eol.test.ts` (T7.5 end-to-end section; T7.6 — `agent_settled` after abort)

**Agent 4B (F8 reload):**

- `tests/budget-reload.test.ts` (new, ~120 LOC, 5 tests: T8.1, T8.2, T8.3, T8.5, T8.6)
- `src/engine/budget/**` (T8.4 audit — remove any closure-captured state)

## Sub-agent roster

**Two parallel agents.** Per `04-refactor-plan.md` §11.6 and `05-parallelization-analysis.md` §6. Wave 4 can start as soon as Wave 0 ships (the tests can be authored against the Wave 0 interface contracts and run against the Wave 3 implementation).

| Agent | Branch | Worktree |
|---|---|---|
| 4A F7 races | `refactor/budget-f7-races` | `.worktrees/refactor-budget-f7-races/` |
| 4B F8 reload | `refactor/budget-f8-reload` | `.worktrees/refactor-budget-f8-reload/` |

**Isolation strategy:** Agent 4A writes race tests; Agent 4B writes reload tests + audits `src/engine/budget/`. The two agents touch different files; the audit in T8.4 may overlap with Wave 3's last agent. Agent 4B should run the audit AFTER Wave 3 merges (so the closure-captured state is final). If Wave 4 starts before Wave 3 merges, Agent 4B's audit is preliminary.

## Gates

**Wave 4 gate (per `04-refactor-plan.md` §11.10):**

- All race tests pass 100 consecutive runs (verified by `./scripts/race-stability-check.sh`, or `just race-stability`; runs `tests/budget-races.test.ts` 100× and fails on any non-zero exit)
- All reload tests pass in isolation
- **T7.8 real-SDK integration tests** pass within bounded timing windows (NOT 100-consecutive-run; document the timing window)
- Each race test exercises a SPECIFIC bug class the prior review identified (cross-reference to `01-current-state-analysis.md` Issues 1-9 documented inline as test comments)
- **No `await` between write and read in the racing paths** — verified by reading the test code
- Tests are deterministic (no `Math.random()`, no `Date.now()`, no `setTimeout()`) — verified by `grep -E "(Math\.random|Date\.now|setTimeout)" tests/budget-races.test.ts` returning no matches
- T7.7 Bug 3 end-to-end regression uses the exact `15134` value from `bug-history.md` (per `06-final-review.md` §5 Pros-11)
- T8.4 audit: `grep -rE "let\s+\w+\s*=\s*0" src/engine/budget/` returns no matches in budget-state variables (only in test fixtures and unrelated counters)
- T8.5, T8.6 verify ledger re-derivation via `getBranch()` on branch switch / fork

Smoke test (per `04-refactor-plan.md` §5 F8 guard): open a session, run a worker, hit `/reload`, verify the budget display reflects pre-reload state — verified by running through `/hive:observe` in the user's session.

## Risks

- **F7 race tests must be deterministic.** Per `04-refactor-plan.md` §11.11: "Agent 4A must use deterministic fake-session factories, not real SDK calls." T7.8 is the explicit exception (real SDK timing) and asserts behavior within bounded timing windows. Other T7.x tests use fake-session factories.
- **T7.7 Bug 3 regression uses exact `15134` value** from `bug-history.md`. If the test fixture drifts from the original incident, the regression test loses its power. Verify the value before authoring the test.
- **T7.8 bounded timing windows.** Real SDK timing is non-deterministic. T7.8's gate is "behavior verified within bounded timing windows," not "100-consecutive-run stability." Document the timing budget (e.g., 50ms ± 10ms) in the test prose.
- **T8.5/T8.6 (G-11)** depend on `SessionManager.branch` and `SessionManager.forkFrom` semantics from `pi-sdk-session-api.md`. If the SDK 0.99.1 chain has changed since the SDK reference was written, the agent must verify the chain against `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts` in the worktree.
- **Stale-process trap.** Agent 4B's T8.4 audit touches `src/engine/budget/**` — restart server per `04-refactor-plan.md` §7 if any closure-captured state is removed.
- **Reload tests timing.** `/reload` re-derives from `getBranch()`. The test fixture must simulate a JSONL file with `CustomEntry`s and verify the ledger restoration matches pre-reload state. If the fixture is wrong, the test passes vacuously.

## Test delta

+13 tests (Agent 4A: 6 races + 2 integration + 1 T7.5 (also in T7.1-T7.7 set) = ~8; Agent 4B: 5 reload). Wave 4 contribution to the 659+ target.

Per the plan's overall completion guard: F7 races (6 + 2 integration) + F8 reload (5) = 13 tests.

## Notes

- **Determinism rule.** Per `04-refactor-plan.md` §5 F7 guard: "Tests are deterministic (no `Math.random()`, no `Date.now()`, no `setTimeout()`)." T7.8 is the explicit exception; document the bounded timing window.
- **100-consecutive-run gate.** Per `04-refactor-plan.md` §11.10: `for i in {1..100}; do just test -- tests/budget-races.test.ts || exit 1; done`. This is the structural confidence check that catches flakiness. Run manually or in CI before merging.
- **Bug 3 regression value.** T7.7 uses the exact `15134` value from `bug-history.md`. If the value is unavailable in the worktree, fall back to a documented proxy (e.g., the `tokens.total` value at the point of abort in the prior session).
- **T8.4 audit.** `grep -rE "let\s+\w+\s*=\s*0" src/engine/budget/` should return no matches in budget-state variables. Test fixtures and unrelated counters (e.g., loop counters in helper functions) are allowed.
- **Per-agent commit prefixes** (per `04-refactor-plan.md` §11.12):
  - 4A: `test(budget): pin race-condition paths`
  - 4B: `test(budget): pin reload-stable behavior`
- **LOCAL-ONLY.** Per-phase branches stay local; no `git push`, no PR.

*End of Wave 4 brief. Spawn 2 sub-agents in parallel after Wave 0 ships (can also start after Wave 3 ships for the full implementation under test).*