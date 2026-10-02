---
title: Wave 5C — F11 local-only landing (user action, no push)
type: refactor
wave: 5c
date: 2026-09-29
status: ready-for-implementation
---

# Wave 5C — F11 local-only landing

## Goal

Record the LOCAL-ONLY landing decision: PR #54 disposition, local-only state verification, and the gating of any future cleanup on user instruction. **No `git push`, no PR, no remote activity of any kind.** This wave records the decision in writing; the actual cleanup commands (worktree removal, local main fast-forward) are gated on explicit user instruction per AGENTS.md.

## Source of truth & operating conventions

**Consult in this order:** this brief → `../refactor-plan/docs/reviews/28-09-2026-budget-review/04-refactor-plan.md` (§X.Y cited per task) → `../refactor-plan/docs/reviews/28-09-2026-budget-review/06-final-review.md` (2026-09-29 walkthrough, commit `fc479f9`) → `../refactor-plan/docs/reviews/28-09-2026-budget-review/raw-evidence/pi-sdk-session-api.md` (SDK 0.99.1).

**Disagreement rules:** brief vs. plan → **plan wins** (brief is a summary). Plan vs. review → **review wins** for walkthrough-touched items (operator escape hatches, F13 promotion, C5 in v2, T5.15, expanded test coverage). Still unclear → surface via `ask_user` (inline mode per AGENTS.md).

**Worktree init:** per-phase worktree under `APP_ROOT/.worktrees/refactor-budget-<phase>-<task>/`, **based off `refactor/budget` (NOT `main`, NOT a remote ref)**. **Do NOT symlink `node_modules`** from APP_ROOT — APP_ROOT pins SDK 0.80.7 vs worktree 0.99.1; run `just install` independently.

**Stale-process trap:** after editing `src/engine/budget/**`, `src/engine/dispatch.ts`, `src/observability/server/**`, or `src/engine/review.ts`: `PID=$(lsof -nP -iTCP:43191 -sTCP:LISTEN -t) && kill "$PID"; just pi-dev`.

**Marking done:** flip `[ ]` → `[x]` in this brief's Tasks table **at commit time, in the same commit** that lands the task. Future sessions read this brief before HANDOFF.md.

**Branches:** stay local per LOCAL-ONLY — no `git push`, no PR.

## Scope

**In scope:**

- T11.1 — Decide PR #54 disposition: **close** (the refactor supersedes). Document the rationale in `sessions/<coordinator>-F11.md`. The actual `gh pr close 54` action may be deferred to the future session that performs the repo cleanup (per the LOCAL-ONLY constraint in `../refactor-plan/docs/reviews/28-09-2026-budget-review/README.md`)
- T11.2 — Verify local-only state: every per-phase branch exists only in this `APP_ROOT`'s refs (no remote tracking, no `git push` performed). Run `git branch -vv` in `APP_ROOT` and confirm all `refactor/budget-*` branches show no upstream. Document the verification in `sessions/<coordinator>-F11.md`
- T11.3 — Local cleanup is gated on user instruction. When the user instructs (typically after the repo-cleanup step is performed in a future session), `git worktree remove .worktrees/refactor-budget-<phase>-<task>` per AGENTS.md's precheck rule. Until then, worktrees stay in place — they are the artifact

**Out of scope:**

- `git push` of any branch (forbidden per LOCAL-ONLY constraint)
- `gh pr create` or `gh pr merge` (no remote PRs for this refactor)
- Auto-merge via branch protection or repo settings
- Refactor implementation work (Wave 0-5B already done)

## Tasks

Coordinator session. Tasks are decision-recording, not code-writing.

| Task | Description |
|---|---|
| [ ] T11.1 | Decide PR #54 disposition: **close** (the refactor supersedes). Document the rationale in `sessions/<coordinator>-F11.md`. Gate: decision recorded with explicit user sign-off |
| [ ] T11.2 | Verify local-only state: every per-phase branch exists only in this `APP_ROOT`'s refs. Run `git branch -vv` and confirm all `refactor/budget-*` branches show no upstream. Document the verification in `sessions/<coordinator>-F11.md`. Gate: verification recorded |
| [ ] T11.3 | Local cleanup gated on user instruction. When the user instructs, run `git worktree remove .worktrees/refactor-budget-<phase>-<task>` per AGENTS.md's precheck rule. Until then, worktrees stay in place. Gate: user instructions; do not perform unprompted |

For full task prose and gates, the implementing agent reads `04-refactor-plan.md` §5 F11 directly.

## Files touched

**New audit trail files:**

- `docs/reviews/28-09-2026-budget-review/sessions/<coordinator>-F11.md` (PR #54 disposition decision + local-only state verification)

**Modified:**

- `docs/reviews/28-09-2026-budget-review/sessions/README.md` (if it exists; add the F11 session log to the index)

## Sub-agent roster

Coordinator session. The coordinator owns `04-refactor-plan.md` and `sessions/`. No sub-agent is dispatched — the coordinator performs the recording.

**Sequencing:** Wave 5C runs AFTER Wave 5B (reviewer sign-off complete). The coordinator reviews the entire implementation diff locally before recording the disposition.

## Gates

Per `04-refactor-plan.md` §5 F11 guard:

- All 3 task checkboxes (T11.1, T11.2, T11.3) marked
- PR #54 disposition decided and documented (T11.1)
- Local-only verification recorded (T11.2) — every `refactor/budget-*` branch shows no upstream
- Worktrees remain in place until the user instructs otherwise (T11.3)

**Per AGENTS.md and the LOCAL-ONLY constraint:**

- User has explicitly merged the PR (when applicable — the LOCAL-ONLY constraint defers this)
- Local main is fast-forwarded to the merged commit (gated on user instruction)
- Worktree removed (after `git status` precheck confirms clean tree, per AGENTS.md worktree rule)

**Cross-cutting gates (per `04-refactor-plan.md` overall completion guard):**

- `just typecheck` clean across core/bun/tests/dashboard configs
- `just test` clean — 591+ server tests passing
- `cd ui/web && npm run test:unit` clean — 49+ tests
- `npx eslint` clean on all touched files
- `just dashboard-build` clean (mandatory after F13 lands)
- `just review-vendor-verify` clean
- `node scripts/check-package-budgets.mjs` pass

## Risks

- **No push, no PR.** Per the LOCAL-ONLY constraint at `../refactor-plan/docs/reviews/28-09-2026-budget-review/README.md`: "All work for this refactor stays local to this `APP_ROOT`. Nothing is pushed." This is the binding constraint. Do not deviate.
- **Auto-merge forbidden.** Per AGENTS.md: "Never merge a pull request without explicit user permission. Committing, pushing, and creating PRs is allowed; merging requires the user to instruct it each time." Even local merges require user instruction.
- **Future session cleanup.** When a future session performs the repo cleanup on `origin` (per the LOCAL-ONLY constraint), the local commits are preserved across the cleanup as long as the worktree lives on. The future session will need to push the merged branches and resolve the upstream history entanglement.
- **Worktree state.** Worktrees remain in place until the user instructs removal. Per AGENTS.md: "Clean up with `git worktree remove .worktrees/<branch>` after the branch merges. This rule applies to every agent session that touches this repo, including the one writing this rule." The merge hasn't happened yet, so worktrees stay.

## Test delta

No new tests. Wave 5C is a decision-recording wave, not a code-writing wave.

## Notes

- **PR #54 disposition rationale.** Per `04-refactor-plan.md` §6.2 decision 1: "close (the refactor supersedes)." The actual `gh pr close 54` action may be deferred to the future session that performs repo cleanup (per the LOCAL-ONLY constraint). The decision itself is recorded here.
- **Local-only verification commands:**

  ```bash
  cd /Users/cgrant/code/pi-hive  # APP_ROOT
  git branch -vv | grep refactor/budget
  # All entries should show no upstream (no [origin/...] suffix)
  ```

- **Future cleanup commands** (gated on user instruction):

  ```bash
  # After the user instructs:
  cd /Users/cgrant/code/pi-hive
  git status  # precheck — must be clean
  git worktree remove .worktrees/refactor-budget-f0-contracts
  git worktree remove .worktrees/refactor-budget-f1-primitives
  # ... (one per per-phase branch)
  # Then the future session can:
  # git checkout main
  # git merge --ff-only refactor/budget-f10-reviews
  # git push origin main  # ONLY after user instructs push
  ```

- **Per AGENTS.md §Repository boundaries:** "Never merge a pull request without explicit user permission." Even after Wave 5C records the disposition, the merge + push is a user-driven action.
- **No commit prefix needed** — Wave 5C is decision-recording. If the coordinator commits, use `docs(review): record F11 local-only landing`.

*End of Wave 5C brief. The coordinator records the disposition after Wave 5B completes. No sub-agent dispatch.*