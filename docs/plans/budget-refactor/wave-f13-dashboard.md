---
title: F13 — Dashboard intervention UI (REQUIRED per C2 walkthrough)
type: refactor
wave: f13
date: 2026-09-29
last_updated: 2026-10-02 (T13.0 added; T13.2 engine edit clarified per F13 spec audit)
status: ready-for-implementation
---

# F13 — Dashboard intervention UI

## Goal

The dashboard exposes 11 buttons for EOL commands (now including `forceEndWorkerSession` from T5.15, `resumeWorkerSession` from T5.8, and `abortWorkerCompaction` from T5.9) and surfaces the `interventionAvailable` flag on `budget_warning` events. **Promoted from "parallel, non-blocking" to REQUIRED scope of this refactor per the C2 walkthrough review (commit `fc479f9`).** Runs after Wave 3 ships so the engine can serve real responses.

## Source of truth & operating conventions

**Consult in this order:** this brief → `../refactor-plan/docs/reviews/28-09-2026-budget-review/04-refactor-plan.md` (§X.Y cited per task) → `../refactor-plan/docs/reviews/28-09-2026-budget-review/06-final-review.md` (2026-09-29 walkthrough, commit `fc479f9`) → `../refactor-plan/docs/reviews/28-09-2026-budget-review/raw-evidence/pi-sdk-session-api.md` (SDK 0.99.1).

**Disagreement rules:** brief vs. plan → **plan wins** (brief is a summary). Plan vs. review → **review wins** for walkthrough-touched items (operator escape hatches, F13 promotion, C5 in v2, T5.15, expanded test coverage). Still unclear → surface via `ask_user` (inline mode per AGENTS.md).

**Worktree init:** per-phase worktree under `APP_ROOT/.worktrees/refactor-budget-<phase>-<task>/`, **based off `refactor/budget` (NOT `main`, NOT a remote ref)**. **Do NOT symlink `node_modules`** from APP_ROOT — APP_ROOT pins SDK 0.80.7 vs worktree 0.99.1; run `just install` independently.

**Stale-process trap:** after editing `src/engine/budget/**`, `src/engine/dispatch.ts`, `src/observability/server/**`, or `src/engine/review.ts`: `PID=$(lsof -nP -iTCP:43191 -sTCP:LISTEN -t) && kill "$PID"; just pi-dev`.

**Marking done:** flip `[ ]` → `[x]` in this brief's Tasks table **at commit time, in the same commit** that lands the task. Future sessions read this brief before HANDOFF.md.

**Branches:** stay local per LOCAL-ONLY — no `git push`, no PR.

## Scope

**In scope:**

- **T13.0 — Sunset the legacy `fresh` parameter from `delegate_agent` and `dispatchAgent`.** The `fresh=true` flag promised a clean session but only reset `runtime.*` token counters; it never reset the agent's context window (SDK `AgentSession` conversation history, mental model distiller output, `BudgetLedger` state). The F13 operator commands (`respawnWorkerSession` in particular) are the proper replacement. This is **LLM-tool cleanup, not dashboard work**, but is required for F13 to ship a coherent operator surface — `delegate_agent` currently has a misleading parameter that the F13 commands supersede. Files: `src/agents/tools.ts` (drop parameter schema + execute body handling + renderCall flag), `src/engine/dispatch.ts` (drop `fresh` from `dispatchAgent` signature, drop the `if (fresh) { reloadAgentConfig(...) }` block at lines 305-339, drop the `if (fresh && existsSync(runtime.sessionFile))` archive + counter-reset block at lines 388-413, drop `fresh` from the options object at line 477), plus any test files asserting on `fresh`. **The "config reload on `fresh`" behavior must move to an explicit operator command (e.g. `hive_reload_agent_config`) added in T13.0 — otherwise the "edit `.md` and re-delegate" workflow silently breaks.** Commit prefix: `chore(refactor): sunset legacy fresh parameter from delegate_agent (T13.0)`.
- T13.1 — Add TUI/RPC buttons for the **11** EOL commands (end / compact / respawn / pause / snapshot / restore / **resume / abort-compaction / force-kill / force-end / tear-down-all**). The 11 = 6 base commands (end / compact / respawn / pause / snapshot / restore) + 2 resume/shape variants (resume, abort-compaction) + 3 escape-hatch variants (force-kill, force-end, tear-down-all). Per C2 review 2026-09-29, F13 is in-scope for this refactor (no longer "separate PR"). Files: `ui/web/src/**`
- T13.2 — Surface the `interventionAvailable` flag on `budget_warning` events so the dashboard can decide which operator commands to expose. Files: **`src/engine/budget/events.ts:200-208` (engine: add `interventionAvailable: boolean` to the emit payload, computed from `resolveStrategies(policy).warningStrategy === "default"`) + `ui/web/src/**` (dashboard: read the flag, conditionally render intervention buttons).** Brief previously said "Files: same" — that was wrong; the change is half engine + half dashboard. **STATUS: T13.2 is not yet implemented in production at the time of this brief refresh (2026-10-02) — the production engine emits `budget_warning` events without the flag. Both halves of T13.2 are required.**
- T13.3 — Verify mode-independence — the dashboard works in TUI, RPC, print, JSON modes. Files: same

**Out of scope:**

- Backend engine changes (Wave 0-3 already done)
- Engine tests (Wave 4 already done)
- Cleanup of legacy files (Wave 5A)
- Reviewer rounds (Wave 5B)

## Tasks

Single sub-agent (or, optionally, parallel with Wave 3 if the engine contract is stable enough; recommended after Wave 3 ships so the engine can serve real responses). Tasks must complete in order (**T13.0 → T13.1 → T13.2 → T13.3**). T13.0 lands first to give F13 a clean operator-tool surface; the `delegate_agent` tool should not carry a misleading `fresh` parameter into the wave that introduces its proper replacements.

| Task | Description |
|---|---|
| [ ] T13.0 | Sunset `fresh` parameter from `delegate_agent` + `dispatchAgent`. Add explicit `hive_reload_agent_config` operator command to preserve config-reload-on-edit workflow. Update tests that asserted on `fresh`. Gate: `just typecheck && just test` clean; `grep -rn "fresh" src/agents/tools.ts src/engine/dispatch.ts` returns 0 hits in production code (test fixture comments may remain); TUI rendering of `delegate_agent` calls no longer shows the `[fresh=...]` suffix |
| [ ] T13.1 | Add TUI/RPC buttons for the 11 EOL commands. Gate: `just dashboard-build` clean; visual review |
| [ ] T13.2 | Surface `interventionAvailable` flag on `budget_warning` events (engine + dashboard halves). Gate: visible in dashboard; engine test asserts the flag is present on `default` strategy and absent on `compact` strategy |
| [ ] T13.3 | Verify mode-independence — TUI, RPC, print, JSON modes all work. Gate: smoke test in all 4 modes |

For full task prose and gates, the implementing agent reads `04-refactor-plan.md` §5 F13 directly.

## Files touched

**Modified (in `src/agents/tools.ts` and `src/engine/dispatch.ts`) — T13.0:**

- Drop `fresh` parameter from `delegate_agent` tool schema (`src/agents/tools.ts:185-201`)
- Drop `fresh` handling in execute body, onUpdate, and renderCall (`src/agents/tools.ts:209-247`)
- Drop `fresh` from `dispatchAgent` signature (`src/engine/dispatch.ts:292-294`)
- Drop the `if (fresh) { reloadAgentConfig(...) }` block (`src/engine/dispatch.ts:305-339`)
- Drop the `if (fresh && existsSync(runtime.sessionFile))` archive + counter-reset block (`src/engine/dispatch.ts:388-413`)
- Drop `fresh` from the options object at line 477, 665, 718
- Add explicit `hive_reload_agent_config` operator command (or equivalent mechanism) to preserve the "edit `.md` and re-delegate" workflow
- Update `tests/*.test.ts` files that asserted on `fresh: true` — the brief's prior handler may have used `fresh` to test session isolation; the equivalent guarantee in T13.0+ comes from `respawnWorkerSession` + a real `BudgetLedger` reset, so tests may need to migrate

**Modified (in `ui/web/src/**`) — T13.1, T13.2, T13.3:**

- TUI button components (per active worker)
- RPC command handlers (one per EOL command)
- Print mode JSON shape
- Dashboard store / state management
- Component tests (`ui/web/src/**/*.test.ts`)
- Any other dashboard source files needed to wire the buttons end-to-end

**Modified (in `src/engine/budget/events.ts`) — T13.2 engine half:**

- Add `interventionAvailable: boolean` to the `budget_warning` emit payload at `src/engine/budget/events.ts:200-208`
- Compute from `resolveStrategies(policy).warningStrategy` (or equivalent strategy predicate — verify with implementing agent against `src/engine/budget/strategy.ts:193`)
- Engine test asserting presence on `default` strategy and absence on `compact` strategy

**Per AGENTS.md §Pi package rules:**

- After editing `ui/web/src/**`, run `just dashboard-build` before packaging.
- Before publishing or tagging, run `just ci`.
- Keep `ui/web/dist/` committed and included in the package — do not require users to build the dashboard at install time.

## Sub-agent roster

Single agent (`refactor/budget-f13-dashboard`). Per the parallelization analysis, F13 can run out-of-band parallel to backend work because the operator commands are fully specified in `04-refactor-plan.md` §2.8 (signatures, SDK primitives, ledger marker names). The agent only needs to know which `kind` value to send for which button.

| Agent | Branch | Worktree |
|---|---|---|
| F13 dashboard | `refactor/budget-f13-dashboard` | `.worktrees/refactor-budget-f13-dashboard/` |

**Sequencing:** Recommended split per `05-parallelization-analysis.md` §8: T13.1 + T13.2 land after Wave 3 ships (so the engine can serve real responses); T13.3 is a smoke test that runs after T13.1 + T13.2 land. F13 is REQUIRED scope per C2 walkthrough — does NOT defer to a follow-up PR.

**Worktree node_modules.** Per `tmp/HANDOFF-pickup.md` §2: "Don't symlink node_modules from APP_ROOT (SDK version mismatch). Each worktree needs its own `just install`." The dashboard worktree needs its own `just install` for `ui/web` dependencies.

## Gates

Per `04-refactor-plan.md` §5 F13 guard:

- All 3 task checkboxes (T13.1, T13.2, T13.3) marked
- Dashboard shows 11 buttons per active worker (end / compact / respawn / pause / snapshot / restore / resume / abort-compaction / force-kill / force-end / tear-down-all)
- Clicking a button invokes the corresponding operator command
- `interventionAvailable` flag is honored — verified by visual inspection. **NOTE: flag wiring is in T13.2 (still pending) — the gate is "verified once T13.2 lands".**
- Mode-independent (works in TUI, RPC, print, JSON modes) — verified by smoke test

**Cross-cutting gates (per `04-refactor-plan.md` overall completion guard):**

- `just dashboard-build` clean (mandatory after F13 lands)
- `cd ui/web && npm run test:unit` clean — 49+ dashboard tests passing

## Risks

- **Dashboard reads obsolete telemetry event shapes.** Per `01-current-state-analysis.md` Risk 7 and G-22: existing dashboards that read `worker_compaction.phase` will break. The plan is a **hard cutover** (per `04-refactor-plan.md` §6.2 decision 6) — the dashboard is updated in the same refactor to use the new event shapes. No dual-shape emit.
- **Visual review for T13.1.** Per `04-refactor-plan.md` §5 F13 gate: "visual review" — the implementing agent cannot self-verify visual correctness. Run the dashboard locally and check the 11 buttons render correctly. If unclear, use `ask_user` (inline mode per AGENTS.md) to confirm.
- **Mode-independence smoke test (T13.3).** Per AGENTS.md: extensions must be mode-independent. Verify each of the 11 EOL commands works in TUI, RPC, print, and JSON modes. Per `04-refactor-plan.md` §5 F13 gate: "smoke test in all 4 modes."
- **Component test coverage.** Dashboard components typically have their own test suite (49+ tests per the plan). New buttons may need new component tests; coordinate with the existing test infrastructure.
- **Bundle size.** Adding 11 buttons may increase the dashboard bundle size. Verify `just dashboard-build` output stays within budget.
- **Stale-process trap.** Wave F13 touches `ui/web/src/**` only — no server restart needed (dashboard is its own process). T13.0 touches `src/engine/dispatch.ts` and `src/agents/tools.ts` — server restart required per AGENTS.md (`PID=$(lsof -nP -iTCP:43191 -sTCP:LISTEN -t) && kill "$PID"; just pi-dev`).
- **Worktree SDK mismatch.** Per `tmp/HANDOFF-pickup.md` §2: APP_ROOT pins SDK 0.80.7 vs worktree's 0.99.1. The dashboard worktree may need its own `just install` for both `ui/web` deps AND the SDK.
- **T13.0 config-reload path.** The current `if (fresh) { reloadAgentConfig(...) }` block at `src/engine/dispatch.ts:305-339` is the only place in the codebase that reloads a worker's config from YAML on demand. After T13.0 removes it, no path will reload config — meaning the "edit the agent's `.md` and re-delegate" workflow silently breaks unless T13.0 adds an explicit `hive_reload_agent_config` (or equivalent) operator command. This is required, not optional.
- **T13.0 test migration.** Tests that asserted on `fresh: true` to verify session isolation need to migrate to asserting on `respawnWorkerSession` or `restoreWorkerSession` semantics, since `fresh` is no longer the way to express "give this worker a clean slate."

## Test delta

- T13.0: net test count change depends on how many tests asserted on `fresh`. Estimate -2 to -6 tests; new total ~666 (down from 670). Plus +1 to +3 tests for the new `hive_reload_agent_config` command. Net target: ~665-668.
- T13.1: +? tests (component coverage for the 11 buttons)
- T13.2: +1 to +2 engine tests (assert flag present on `default` strategy, absent on `compact` strategy) + dashboard tests
- T13.3: 0 (smoke test only)

The plan's overall completion guard says "49+ dashboard tests passing (no change expected unless F13 is in scope)" — but F13 IS in scope, so net dashboard test count likely increases.

## Notes

- **F13 was originally "out-of-band" in the wave structure** (`tmp/HANDOFF-pickup.md` §7.8). The C2 walkthrough decision (commit `fc479f9`) promoted it to REQUIRED scope. The plan's overall completion guard and `tmp/HANDOFF-pickup.md` §4 Step 8 reflect this; **§11.7 wave structure description is now outdated.** Flag for the next session to fix in the master plan.
- **11-button UI** (not 7, not 9). The original F13 task list specified 6 base commands; subsequent gap-decisions added 2 shape variants (resume / abort-compaction from T5.8 + T5.9) and 3 escape-hatch variants (force-kill / force-end / tear-down-all from T5.13, T5.14, T5.15). Cooperative tools are agent-callable, not operator-callable — they don't appear in the dashboard. The "9" count from the C2 walkthrough pre-dated T5.8/T5.9 landing; the live count is 11.
- **Force-kill and tear-down-all are operator-only** (per `04-refactor-plan.md` §2.2 note). They appear in the dashboard but are NOT exposed as agent-callable tools. The dashboard is the operator surface; cooperative tools are the agent surface.
- **Intervention-available flag** (per G-30 / `04-refactor-plan.md` §6.2 `interventionAvailable` decision). The dashboard reads the flag to decide which commands to expose per active worker. Implementation is in T13.2. The flag is a single boolean per warning; per-command exposure is computed client-side from the flag + the worker's runtime state.
- **Per-agent commit prefix** (per `04-refactor-plan.md` §11.12):
  - T13.0: `chore(refactor): sunset legacy fresh parameter from delegate_agent (T13.0)`
  - T13.1: `feat(dashboard): add 11-button intervention UI (F13, now required)`
  - T13.2: `feat(engine): add interventionAvailable flag to budget_warning emit (F13 engine half)` + `feat(dashboard): read interventionAvailable flag and conditionally render buttons (F13 dashboard half)`
  - T13.3: `test(dashboard): verify mode-independence for 11-button UI`
- **LOCAL-ONLY.** Per-phase branch stays local; no `git push`, no PR. The dashboard is local-only until the future session performs repo cleanup on `origin`.

*End of F13 brief. Spawn 1 sub-agent after Wave 3 merges (so the engine can serve real responses) and before Wave 5A (so cleanup includes any dashboard worktree cleanups).*