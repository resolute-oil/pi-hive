# Budget Strategies Review — Current Codebase and Active Refactor

**Date:** 2026-09-28 (review); 2026-09-29 (refactor redesign)
**Branch:** `review/budget-redesign-2026-09-28` (off `feat/budget-strategy` at `9f950fb`)
**Active refactor branch:** per-phase worktrees — see **Working conventions** below.
**SDK reference verified against:** `@earendil-works/pi-coding-agent@0.99.1` (commit `ea9c54a` on `refactor/budget`). Earlier draft referenced v0.87.1 in the plan header; that has been corrected to 0.99.1 in `04-refactor-plan.md`.

**Trigger:** Multiple-session failure to fix the `fresh=true` budget-reset bug in `delegate_agent`. User requested a thorough review of the current codebase and how the budget system works, plus a full refactor plan using Pi Best Practices. The current budget system is being **entirely replaced**, not patched.

## Scope

This review + refactor covers:

1. **How the budget system works today** — every code path documented end-to-end with line references (`01-current-state-analysis.md`, `current-flow/`, `raw-evidence/`).
2. **Structural issues** — nine issues that shape the bug class, ranked by priority.
3. **Bug timeline** — every bug the project has hit on this feature, with fix references.
4. **Test coverage analysis** — what's pinned, where the gaps are.
5. **Pi-docs alignment** — what the current code does that follows (or conflicts with) Pi's documented extension patterns.
6. **Skill recommendations** — which compound-engineering skills are most useful.
7. **HTML reports** — diagrammatic versions of the above for visual review.
8. **Active refactor plan** — task-oriented specification for replacing the budget system (`04-refactor-plan.md`).
9. **Multi-agent execution strategy** — coordinator + worker model, per-phase worktrees (`05-parallelization-analysis.md`).
10. **Session logs** — detailed record of each session that touches this refactor (`sessions/`).

This is an **entirely new rethink of the budget system**. The implementation will remove pre-existing code that does not fit the refactor — no layering, no defensive guards over incompatible math, no compat shims for old call sites. The new code replaces it.

## Working conventions

Every session that touches this refactor (human, coordinator, or worker) follows these rules:

### 1. Worktrees are per-phase or per-task, not per-megaproject

The implementation branch is NOT a single `refactor/budget-pi-native` branch. Each phase or task gets its own worktree under `APP_ROOT/.worktrees/`, with a branch name that names the work in progress.

**Naming convention:** `refactor/budget-<phase>-<task>` or `refactor/budget-<phase>-<short-name>`.

**Base branch for every per-phase worktree:** the **current HEAD of the local `refactor-budget` staging branch** (NOT `main`, NOT a remote ref). Implementation work does NOT happen off `main` — it happens off `refactor-budget`, the staging branch that carries this review's documentation, the SDK 0.99.1 bump, and any other infrastructure fixes. As `refactor-budget` advances, every new phase worktree picks up the latest state.

```sh
# Get the current refactor-budget HEAD
git fetch origin refactor/budget
REFACTOR_BUDGET=$(git rev-parse origin/refactor/budget)

# Phase 1 (F1) — Budget primitives
git worktree add .worktrees/refactor-budget-f1-budget-primitives \
  -b refactor/budget-f1-primitives "$REFACTOR_BUDGET"

# F5 T5.3 — respawnWorkerSession with session.dispose()
git worktree add .worktrees/refactor-budget-t5-3-respawn-dispose \
  -b refactor/budget-t5-3-respawn-dispose "$REFACTOR_BUDGET"

# F7 race tests
git worktree add .worktrees/refactor-budget-f7-race-tests \
  -b refactor/budget-f7-race-tests "$REFACTOR_BUDGET"
```

**Why per-phase worktrees based off `refactor-budget`:** A single mega-branch accumulates unrelated changes, makes reviews enormous, and lets one phase's bugs contaminate another. Per-phase worktrees give each task a clean base, clean diff, and clean merge. Basing off `refactor-budget` (not `main`) ensures every implementation worker starts from a tree that already has the SDK 0.99.1 pin, the hive:version test fix, and the review docs that document what they're implementing.

**Symlink:** when the worktree needs to run tests, recreate the symlink: `ln -s ../../node_modules .worktrees/<branch>/node_modules` (target is `../../node_modules` because the worktree lives two levels under `APP_ROOT/`).

### 2. TDD throughout

Every task follows red-green-refactor:

1. **Red.** Write the test first. Verify it fails for the right reason (not a syntax error or import error — the actual behavior under test is missing).
2. **Green.** Implement the smallest change that makes the test pass. Don't pre-optimize, don't refactor adjacent code.
3. **Refactor.** With the test green, clean up the implementation. The test stays green throughout.

A task is not complete until its gate (per `04-refactor-plan.md`) is satisfied. The gate typically includes "tests pass" — that means `just test` for the worktree shows the new tests green.

### 3. Regression tests for every bug being fixed

Bug 1 (reset order), Bug 2 (mid-run check), Bug 3 (post-overwrite mystery) all get regression tests. The plan's F7 T7.1 covers Bug 3's symptom class; F7 also includes T7.6 (fresh-after-exhausted regression test for the user-reported symptom). When the implementation session finds a NEW bug (not in the plan), it adds a regression test for that bug as part of the fix. No fixes without regression tests.

### 4. Coordinator session + worker agents

This refactor runs as **one coordinator session** that owns the plan and a stream of **worker sessions** that execute phases.

**Coordinator session responsibilities:**
- Owns `04-refactor-plan.md`. Ticks `[ ]` boxes to `[x]` as tasks complete (per the skill's checkbox update rule).
- Owns `sessions/` directory. Maintains a session log per session that touches the refactor.
- Reviews worker PR diffs before merging. Uses `ask_user` for ambiguous decisions the worker escalated.
- Never defers — if a worker hands off a deferred item without explicit user permission, the coordinator either asks the user or routes it back to the worker.

**Worker session responsibilities:**
- Picks up a phase or task from the plan (one or more contiguous task checkboxes).
- Works in a per-phase worktree under `APP_ROOT/.worktrees/`.
- Writes the test first (TDD red step).
- Implements to green.
- Refactors, commits per-task, pushes to `origin` (not `upstream` — see AGENTS.md).
- Opens a PR. Does NOT merge. Wait for coordinator + user approval.
- Writes a session log in `sessions/<date>-<agent>-<phase>.md` covering: what was done, what was learned, blockers, next steps.
- Uses `ask_user` for ambiguous decisions, not guesses. Never defers — if blocked, asks.

**Sub-agent invocations** within a worker session (per `05-parallelization-analysis.md`) follow the same conventions: TDD, regression tests, no defer, ask_user, session log entries for each sub-agent invocation.

### 5. ask_user for ambiguous decisions

Per `AGENTS.md` and the project's `ask_user` skill, every worker uses `ask_user` with `displayMode: "inline"` for ambiguous decisions. Common triggers:

- Schema choice (e.g., "should the new config key be `tokens.cap` or `tokens.cap_ceiling`?")
- API surface (e.g., "should the operator commands take an options object or positional args?")
- Migration policy (e.g., "hard cutover vs. dual-format for one release?")
- Anything where the worker has a preference but the user might disagree

**Display mode is always inline.** The popup overlay interrupts the conversation; this project's preference is inline per AGENTS.md.

### 6. No defer without permission

Workers and the coordinator **do not defer** decisions, scope cuts, or workarounds without asking the user. The default is: do it now, ask if blocked, never silently punt.

Common defer patterns to flag and avoid:
- "We can address that in a follow-up PR" — don't. Either ask the user now or scope it down with explicit user permission.
- "This is out of scope for this branch" — confirm with the user before treating anything as out of scope.
- "I'll leave the defensive guard in place" — if the defensive guard is for code the refactor is removing, the guard goes too.

### 7. Remove pre-existing conflicting code

The new design is **not** layered on top of the existing code. Code that conflicts with the refactor is removed:

- Counter fields that the refactor replaces (see `04-refactor-plan.md` §1.1) are deleted, not deprecated.
- Functions that the refactor replaces (see §1.2, §1.3) are deleted, not aliased.
- Config keys that change shape (see §2.10) are not accepted in their old form — old configs need manual migration (per gap-decision G-16).
- Defensive guards over the old math (e.g., the `??` fallthroughs in `workerConsumedTokens`) are removed when the math they guarded is removed.
- The user-facing TUI / dashboard wiring for removed commands is removed, not stubbed.

If the worker finds code that should be removed but is uncertain, the worker uses `ask_user` to confirm before removing.

### 8. Session logs

Every session (coordinator, worker, or sub-agent invocation) that touches this refactor writes a session log:

```
sessions/
├── README.md                       # this directory's conventions + template
├── YYYY-MM-DD-coordinator-F5.md    # coordinator session for F5 phase
├── YYYY-MM-DD-worker-F1.md         # worker session for F1 phase
└── YYYY-MM-DD-worker-F1-subagent-test-gen.md  # sub-agent invocation
```

Session logs are short (1-2 pages) and cover: what was done, what was learned, blockers, next steps, files touched, tests added. The coordinator's session log also tracks which tasks are ticked vs open, and which decisions escalated to the user.

## Layout

```
docs/reviews/28-09-2026-budget-review/
├── README.md                          # this file
├── INDEX.md                           # master index / table of contents
├── 00-scope-and-methodology.md        # what this review + refactor covers
├── 01-current-state-analysis.md       # the synthesis — Issues 1-9, bug timeline, pi-docs alignment
├── 04-refactor-plan.md                # the implementation plan — the source of truth
├── 05-parallelization-analysis.md     # multi-agent execution strategy (coordinator + workers)
├── current-flow/                      # evidence for the current implementation
│   ├── delegation-flow.md
│   ├── budget-check-flow.md
│   ├── accumulation-flow.md
│   └── fresh-true-bug-timeline.md
├── pi-docs/                           # pi-docs patterns with citations
│   └── extension-patterns-reference.md
├── skills-review/                     # skill inventory + recommendation
│   └── compound-engineering-inventory.md
├── raw-evidence/                      # primary source material
│   ├── code-line-ranges.md
│   ├── test-coverage-analysis.md
│   ├── bug-history.md
│   ├── pi-sdk-session-api.md          # SDK ground-truth reference (validated 0.99.1)
│   ├── budget-strategy-plan.md
│   └── 2025-09-28-fresh-true-budget-bug-unresolved.md
├── sessions/                          # session logs (one per session that touches the refactor)
│   ├── README.md
│   └── YYYY-MM-DD-<agent>-<phase>.md
├── html/                              # rendered HTML reports (self-contained)
│   ├── index.html
│   ├── 01-current-flow.html
│   ├── 02-current-system.html
│   ├── 03-pi-docs-alignment.html
│   └── 04-test-coverage.html
├── presentation/                      # multipage HTML walkthrough of the plan
│   └── index.html
└── review-runs/                       # gap analysis applied to the plan
    ├── spec-flow-review.md
    └── spec-flow-review.html
```

## Relationship to in-flight work

`feat/budget-strategy` (PR #54, awaiting merge) and `origin/fix/fresh-rebuild` (v2 BudgetLedger refactor) both pre-date this redesign. The refactor plan supersedes them. The user has decided to close PR #54 in favor of the refactor (per gap-decision §6.2). The `fix/fresh-rebuild` v2 work is a partial implementation of the same direction; the refactor plan should be checked against it for code that can be reused, but the redesign itself is independent.

## How to read this review

If you're picking up this refactor and have time:

1. Read this README for orientation and working conventions.
2. Read `INDEX.md` for the full reading order.
3. Read `01-current-state-analysis.md` for the structural diagnosis (Issues 1-9, bug timeline).
4. Read `04-refactor-plan.md` for the implementation plan — the source of truth.
5. Read `05-paragraph-analysis.md` if you're running the implementation as a multi-agent workflow.
6. Skim `sessions/` for the latest state of work-in-progress.
7. Read `current-flow/` and `raw-evidence/` as needed for context.

If you only have time for one read, read `04-refactor-plan.md`. The plan is the source of truth; everything else is supporting evidence.