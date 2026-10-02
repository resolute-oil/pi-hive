---
title: Wave 5B — F10 reviewer sign-off (three sequential rounds)
type: refactor
wave: 5b
date: 2026-09-29
status: ready-for-implementation
---

# Wave 5B — F10 reviewer sign-off

## Goal

A single sub-agent runs three sequential reviewer rounds against the implementation diff: `kieran-typescript-reviewer`, `architecture-strategist`, `code-simplicity-reviewer`. Each round applies should-fix items before the next round starts. Goal: zero unresolved should-fix items across all three reviewers, with outputs saved for audit trail.

## Source of truth & operating conventions

**Consult in this order:** this brief → `../refactor-plan/docs/reviews/28-09-2026-budget-review/04-refactor-plan.md` (§X.Y cited per task) → `../refactor-plan/docs/reviews/28-09-2026-budget-review/06-final-review.md` (2026-09-29 walkthrough, commit `fc479f9`) → `../refactor-plan/docs/reviews/28-09-2026-budget-review/raw-evidence/pi-sdk-session-api.md` (SDK 0.99.1).

**Disagreement rules:** brief vs. plan → **plan wins** (brief is a summary). Plan vs. review → **review wins** for walkthrough-touched items (operator escape hatches, F13 promotion, C5 in v2, T5.15, expanded test coverage). Still unclear → surface via `ask_user` (inline mode per AGENTS.md).

**Worktree init:** per-phase worktree under `APP_ROOT/.worktrees/refactor-budget-<phase>-<task>/`, **based off `refactor/budget` (NOT `main`, NOT a remote ref)**. **Do NOT symlink `node_modules`** from APP_ROOT — APP_ROOT pins SDK 0.80.7 vs worktree 0.99.1; run `just install` independently.

**Stale-process trap:** after editing `src/engine/budget/**`, `src/engine/dispatch.ts`, `src/observability/server/**`, or `src/engine/review.ts`: `PID=$(lsof -nP -iTCP:43191 -sTCP:LISTEN -t) && kill "$PID"; just pi-dev`.

**Marking done:** flip `[ ]` → `[x]` in this brief's Tasks table **at commit time, in the same commit** that lands the task. Future sessions read this brief before HANDOFF.md.

**Branches:** stay local per LOCAL-ONLY — no `git push`, no PR.

## Scope

**In scope:**

- T10.1 — Run `kieran-typescript-reviewer` on the implementation diff; apply all should-fix items
- T10.2 — Run `architecture-strategist` on the implementation diff; apply all should-fix items
- T10.3 — Run `code-simplicity-reviewer` on the implementation diff; apply all should-fix items
- T10.4 — Save each reviewer's output to `docs/reviews/28-09-2026-budget-review/review-runs/` for audit trail

**Out of scope:**

- Implementation changes beyond applying reviewer fixes (no new features)
- Legacy cleanup (Wave 5A already done)
- Local landing (Wave 5C)
- Dashboard wiring (F13)

## Tasks

Single sub-agent. Tasks must complete in order (T10.1 → apply fixes → T10.2 → apply fixes → T10.3 → apply fixes → T10.4). Per `05-parallelization-analysis.md` §11.6: "A single agent handles all three reviewers so it has full context across rounds. Multi-round review can lose context per HANDOFF pitfall #32."

| Task | Description |
|---|---|
| [ ] T10.1 | Run `kieran-typescript-reviewer` on the implementation diff. Apply all should-fix items. Gate: zero unresolved should-fix items (skipped per user instruction 2026-09-30 — done in a prior session) |
| [x] T10.2 | Run `architecture-strategist` on the implementation diff. Apply all should-fix items. Gate: zero unresolved should-fix items — **done 2026-09-30** (commit 44a93bc; A2, A3, A5, A11 applied; A1, A4, A6-A10, A12 informational) |
| [x] T10.3 | Run `code-simplicity-reviewer` on the implementation diff. Apply all should-fix items. Gate: zero unresolved should-fix items — **done 2026-09-30** (commit 55e5838; S1, S2, S3 applied; S4-S8 informational) |
| [x] T10.4 | Save each reviewer's output to `docs/reviews/28-09-2026-budget-review/review-runs/` for audit trail. Gate: 3 reviewer reports committed — **done 2026-09-30** (commit c064bcd adds code-simplicity report; architecture-strategist committed in 55e5838; kieran-typescript-reviewer deferred per T10.1 note) |

For full task prose and gates, the implementing agent reads `04-refactor-plan.md` §5 F10 directly.

## Files touched

**Modified by reviewer fixes:**

- Any file in the implementation diff (one or more of `src/engine/budget/**`, `src/engine/dispatch.ts`, `src/core/{types,schema,config-validation}.ts`, `src/agents/tools/summarize-progress.ts`, `tests/budget-*.test.ts`, etc.)

**New audit trail files:**

- `docs/reviews/28-09-2026-budget-review/review-runs/f10-kieran-typescript-reviewer.md`
- `docs/reviews/28-09-2026-budget-review/review-runs/f10-architecture-strategist.md`
- `docs/reviews/28-09-2026-budget-review/review-runs/f10-code-simplicity-reviewer.md`

## Sub-agent roster

Single agent (`refactor/budget-f10-reviews`). No parallelization at Wave 5B.

| Agent | Branch | Worktree |
|---|---|---|
| 5B F10 reviews | `refactor/budget-f10-reviews` | `.worktrees/refactor-budget-f10-reviews/` |

**Sequencing:** Wave 5B must run AFTER Wave 5A (so the reviewers see the clean tree with legacy files removed).

**Per-reviewer notes:**

- **`kieran-typescript-reviewer`** focuses on type safety, modern patterns, maintainability. Look for: missing types, `any` usage, unsafe casts, non-exhaustive switch statements, untyped event handlers.
- **`architecture-strategist`** focuses on pattern compliance and design integrity. Look for: layer violations, single-responsibility violations, hidden coupling, missing seams, leaky abstractions.
- **`code-simplicity-reviewer`** focuses on YAGNI violations and simplification opportunities. Look for: unused exports, over-generalized helpers, dead code, premature abstractions.

Each reviewer can produce should-fix items that the agent applies before the next reviewer. Reference (factual; not a LOC target): the budget module ended at `~2,475 LOC added, ~375 LOC removed, ~2,100 LOC rewritten` with `governance.ts` (175 LOC) + `budget-strategy.ts` (200 LOC) deleted and replaced by focused modules in `src/engine/budget/` (per `04-refactor-plan.md` §8).

## Gates

Per `04-refactor-plan.md` §5 F10 guard:

- All 4 task checkboxes (T10.1, T10.2, T10.3, T10.4) marked
- Each reviewer's output saved to `docs/reviews/28-09-2026-budget-review/review-runs/`
- Each reviewer's verdict is "clean" or "applied all should-fix items" — verified by reading the reviewer's report
- No new `any`, no new state-in-closure, no new shared-mutable-counter patterns introduced — verified by `grep -rE ":\s*any\s*[=,;)]" src/engine/budget/` returning no new matches
- Budget module cleanup complete: `governance.ts` (175 LOC) + `budget-strategy.ts` (200 LOC) deleted; replaced by focused modules in `src/engine/budget/`; dual-counter math removed (no LOC-reduction target enforced)

Cross-cutting gates (verified at Wave 5 end, per `04-refactor-plan.md` §11.10):

- `just typecheck` clean across core/bun/tests/dashboard configs
- `just test` clean — 659+ server tests passing
- `cd ui/web && npm run test:unit` clean — 49+ tests
- `npx eslint` clean on all touched files
- `node scripts/check-package-budgets.mjs` pass

## Risks

- **Multi-round context loss.** Per HANDOFF pitfall #32: a single agent handles all three rounds with full context. Do NOT split into three sub-agents.
- **Reviewer output drift.** Each reviewer's output file must be saved before the next reviewer runs (so the audit trail is intact). If a reviewer introduces a fix that another reviewer would catch differently, the order matters; run them sequentially.
- **Applying fixes mid-review.** When a reviewer returns should-fix items, the agent applies them BEFORE running the next reviewer. This prevents one reviewer's concerns from masking another's.
- **Scope creep.** Reviewers may flag items outside the refactor's scope (e.g., pre-existing tech debt). Use `ask_user` (inline mode per AGENTS.md) to confirm before expanding the scope.
- **T10.4 audit trail.** Save each reviewer's output verbatim — including items the agent chose NOT to apply (with rationale). Future readers need to see what was reviewed and what was deferred.

## Test delta

No new tests. Reviewer fixes may add tests for edge cases; net test count change: 0 unless a reviewer flags a gap.

## Notes

- **Inconsistency to surface for reviewers (from `tmp/HANDOFF-pickup.md` §7.3):** §6.1 Risk 8 of the master plan previously said "Six EOL commands overwhelm the TUI UI" — should now be "Eleven" (counting all 11: 6 base + 2 shape variants resume/abort-compaction + 3 escape-hatch variants). Cosmetic; a reviewer round would catch this. **Flag this for the kieran-typescript-reviewer** (or any round that scans risk tables). Wave 4 prep (2026-09-30) updated plan §6.1 to "Eleven" alongside this brief refresh.
- **Reviewer run mode.** Per AGENTS.md subagent tool selection: use the `Agent` tool from `@tintinweb/pi-subagents` for subagent work in this project. The `subagent` tool from `compound-engineering-pi` is NOT the right delegation mechanism. The three reviewers (`kieran-typescript-reviewer`, `architecture-strategist`, `code-simplicity-reviewer`) are skill-driven; route them via the `Agent` tool.
- **Per-agent commit prefix** (per `04-refactor-plan.md` §11.12):
  - T10.1-T10.3: `chore(refactor): apply reviewer sign-off fixes`
  - T10.4: `docs(review): save F10 reviewer reports`
- **LOCAL-ONLY.** Per-phase branch stays local; no `git push`, no PR.

*End of Wave 5B brief. Spawn 1 sub-agent after Wave 5A completes.*