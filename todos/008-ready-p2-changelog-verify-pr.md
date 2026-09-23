---
status: ready
priority: p2
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

- [ ] CHANGELOG.md has a new entry describing the feature.
- [ ] `just verify` passes clean (typecheck + lint + tests +
      verification gates).
- [ ] Single commit (or split commits if implementation choice)
      follows Conventional Commits format.
- [ ] No AI attribution trailer in the commit message.
- [ ] Commit pushed to `resolute-oil/pi-hive` (the fork).
- [ ] PR opened against `resolute-oil/pi-hive:main`.
- [ ] PR title describes the feature.
- [ ] PR body references the design doc
      (`docs/2026-09-22-pi-hive-mode-switch-snapshot-restore-design.md`)
      and lists the leaves completed.
- [ ] PR body mentions the deviation (event-driven vs synchronous
      wait) and points to the plan doc's deviations log.
- [ ] Manual smoke test (from the plan's top-level AC): `/hive`
      then `/hive:normal` leaves the agent acting like normal Pi.

## Work Log

### 2026-09-23 — Leaf written (revised from previous "todo 009")

**By:** Claude Code (planning session)

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