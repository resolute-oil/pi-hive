---
status: complete
priority: p2
completion_date: "2026-09-23"
issue_id: "008"
tags: [pi-hive, mode-switch, release, pr]
dependencies: ["007"]
---

# CHANGELOG, `just verify`, commit, push, PR

## Problem Statement

The implementation is not "done" until it ships: CHANGELOG entry,
all checks green, commit with Conventional Commits format, pushed
to the fork, and a PR opened against
`resolute-oil/pi-hive:main`.

This leaf is the release gate. It runs only after the
implementation leaves (001–007) all pass their acceptance
criteria.

## Findings

- CHANGELOG.md follows a simple per-PR section format (per HANDOFF.md).
- `just verify` runs typecheck + lint + tests + verification gates.
- Conventional Commits format: `feat(mode-switch): add
  snapshot/restore for hive→normal handoff`. No AI attribution
  trailers (AGENTS.md).
- Push to fork: `git push origin feat/mode-switch-snapshot-restore`.
- PR via `gh pr create --repo resolute-oil/pi-hive --base main
  --head feat/mode-switch-snapshot-restore`.
- HANDOFF.md workflow conventions (don't make code changes without
  consulting, all PRs to fork only, etc.) all apply here.
- The implementation summary should mention the deviation from the
  design doc's sketch (event-driven via `agent_settled` instead of
  synchronous wait in `applyMode`). Reference the deviations log
  in the plan doc.

## Proposed Solutions

### Option 1: Single commit for the whole feature

One commit covering 001-007, message:
`feat(mode-switch): add snapshot/restore for hive→normal handoff`.

**Pros:** Single atomic unit. Easy to bisect if it breaks.

**Cons:** Bigger diff per commit; harder to review incrementally.

**Effort:** ~30 minutes.

**Risk:** Low.

### Option 2: One commit per leaf (or per logical group)

Plumbing (001) + tool (002) in one commit; snapshot (003-004) in
one; trigger (005) in one; handler (006) in one; tests (007) in one.

**Pros:** Reviewable in logical chunks.

**Cons:** More state to manage; each commit must keep the build
green.

**Effort:** ~60 minutes (more git wrangling).

**Risk:** Medium. Build-green-per-commit requires careful
sequencing.

## Recommended Action

**Option 1** for now. Single commit keeps the implementation
simple. If the PR is hard to review at this size (unlikely — design
said 200-400 lines), split into 2-3 commits.

## Technical Details

**Affected files:**
- `CHANGELOG.md` — add a new entry at the top describing the feature.
- Possibly `docs/2026-09-22-pi-hive-mode-switch-snapshot-restore-design.md`
  — note in the doc that it's been implemented (a one-line status
  update). Optional.

**CHANGELOG entry format** (matching prior PRs):
```markdown
### PR #NN — feat(mode-switch): add snapshot/restore for hive→normal handoff

When the user switches from hive or plan mode back to normal, the
agent now resumes from a summary branch anchored at the cycle
entry point rather than continuing with hive-mode history in
context. Orphaned branches remain visible in `/tree` if the user
wants to revisit them. Resolves the "agent still acts like an
orchestrator after /hive:normal" symptom reported in the smoke
test.

Implementation note: the snapshot/restore uses the pi-context
`agent_settled` event-handler pattern (tool stash + event-driven
branching) rather than the synchronous wait sketched in the design.
This gives a faster `/hive:normal` UX (mode switches immediately;
branching happens once the LLM responds to the follow-up summary
prompt). See `docs/2026-09-23-mode-switch-snapshot-restore-implementation-plan.md`
for the deviations from the design doc.
```

## Resources

- HANDOFF.md — workflow conventions, commands for PR workflow.
- AGENTS.md — repository hygiene rules (Conventional Commits, no AI
  attribution, worktree rule).
- PR #10/11/12/13/14/15/16/17/18/19/20 in the merged-branches list
  for CHANGELOG entry style.
- Plan doc: "Deviations from design" section.

## Acceptance Criteria

- [x] CHANGELOG.md has a new entry describing the feature (under
      `[Unreleased]` → `### Added`, matching the existing
      per-PR section format).
- [ ] `just verify` passes clean (typecheck + lint + tests +
      verification gates). **Blocked on 3 pre-existing lint
      errors** (per the implementation plan's documented accepted
      risk; will document in PR body per the plan's Option A).
      typecheck ✓, test 390/390 ✓.
- [x] Single commit (or split commits if implementation choice)
      follows Conventional Commits format.
- [x] No AI attribution trailer in the commit message.
- [x] Commit pushed to `resolute-oil/pi-hive` (the fork).
- [x] PR opened against `resolute-oil/pi-hive:main`.
- [x] PR title describes the feature.
- [x] PR body references the design doc
      (`docs/2026-09-22-pi-hive-mode-switch-snapshot-restore-design.md`)
      and lists the leaves completed.
- [x] PR body mentions the deviation (event-driven vs synchronous
      wait) and points to the plan doc's deviations log.
- [ ] Manual smoke test (from the plan's top-level AC): `/hive`
      then `/hive:normal` leaves the agent acting like normal Pi.
      **Deferred to user** — the PR was opened without merge so
      the user can run a real session against another pi instance
      to verify the smoke before approving.

## Work Log

### 2026-09-23 — Leaf written (revised from previous "todo 009")


**Actions:**
- Renumbered from 009 to 008 (the leaf count went from 9 to 8 after
  folding retry into the event handler leaf).
- Added explicit PR-body requirement to mention the design
  deviation.

**Learnings:**
- This leaf is the only one that touches git remotes and the
  GitHub PR API. Everything before this is local.
- Manual smoke test at the end is the user's loop-closure —
  without it, the implementation might pass all tests and still
  feel wrong.
- Surfacing the deviation in the PR body pre-empts reviewer
  questions about why the implementation differs from the design
  doc.

### 2026-09-23 — Implemented

**Actions:**
- Added a 3-bullet entry under `[Unreleased]` → `### Added` in
  `CHANGELOG.md` describing the feature, the new
  `hive_cycle_summary` tool, and the `agent_settled` handler.
  Followed the existing per-PR section format (no `### PR #NN`
  prefix; sections group by Added/Changed/Fixed).
- Ran `just verify`. typecheck ✓, test 390/390 ✓, lint reports
  **3 pre-existing errors + 62 warnings** (all pre-existing on
  the entry baseline, none in this feature's files). Documented
  in PR body per the implementation plan's Option A (don't fix
  pre-existing lint in this PR; flag for reviewers).
- One incidental lint cleanup: removed an unused `HiveState`
  import in `tests/mode-switch-restore.test.ts` that I had added
  during the M3 fixture-typing pass. Caught by `just verify`; not
  in any prior `just typecheck` pass because `noUnusedLocals` is
  only enforced by lint, not by `tsc`. Lesson: tighten the test
  loop to include lint alongside typecheck.
- Staged and committed via `git add` (selective paths, excluding
  the `node_modules` worktree symlink per the repo's `.gitignore`).
  Single commit per the leaf's Option 1 recommendation.
- Pushed to `origin` (= `git@github.com:resolute-oil/pi-hive.git`).
- Opened PR against `resolute-oil/pi-hive:main`. **Not merged**
  per user instruction — the user wants to run a real pi session
  against the PR's branch first to validate the smoke
  (`/hive` → `/hive:normal`) before merge.

**Commit subject:** `feat(mode-switch): add snapshot/restore for
hive→normal handoff`. No AI attribution trailer.

**Files in commit (18 tracked + 0 untracked-test-files, total):**
- 6 source/test files modified (todo 001-007 changes).
- 4 new test files added (todos 002, 003, 005, 007 test files).
- 8 todos renamed to complete (001-008).
- 1 CHANGELOG.md modified.

**Learnings:**
- `just typecheck` does not catch unused-import errors; only
  `just verify` (which runs lint) does. The unused `HiveState`
  import would have shipped in the commit if I hadn't run
  `just verify` first. Adding lint to the local pre-commit
  loop is worth considering for future PRs.
- The pre-existing lint failures are concentrated in
  `src/agents/tools.ts:3`, `tests/bash-path-tokens.test.ts:45,364`,
  `src/observability/server/db.ts`, and `ui/web/src/tabs/*.tsx` —
  none in the files this feature touches. Documenting in the PR
  body pre-empts reviewer confusion.
- `gh pr create --body-file` is the cleanest way to ship a long
  PR body. The body file is gitignored scratch (under `/tmp/`)
  so it doesn't pollute the worktree.