# Session logs

Every session that touches the budget-refactor work writes a log here. The coordinator owns this directory and uses it to track state across sessions.

## When to write a log

- **Coordinator session** — one log per session, dated, named after the phase(s) progressed.
- **Worker session** — one log per session, named after the phase/task being worked.
- **Sub-agent invocation** — a sub-section inside the parent worker's log if it ran in the same session; a separate log if it ran standalone.

If a session spans multiple phases (e.g., coordinator does F1 setup and F5 review in the same call), the log covers all of them but the file name uses the dominant phase.

## Naming

```
sessions/YYYY-MM-DD-<agent>-<phase-or-task>.md
```

Examples:

```
sessions/2026-09-29-coordinator-F1-F5.md
sessions/2026-09-29-worker-F1-primitives.md
sessions/2026-09-29-worker-T5-3-respawn-dispose.md
sessions/2026-09-30-coordinator-review-F1.md
```

`<agent>` is one of: `coordinator`, `worker`, `subagent`. If a human session drives the work directly (e.g., picking up the refactor manually), `<agent>` is `human`.

## Template

Copy this template when starting a new session log. Keep it terse — 1-2 pages.

```markdown
# Session log — YYYY-MM-DD <agent> <phase-or-task>

**Worktree:** `.worktrees/<branch>` (branch: `refactor/budget-<phase>-<task>`)
**Base commit:** <SHA on origin/main or origin/feat/budget-strategy>
**Tasks touched:** F<n>.<m>, F<n>.<m+1>, ... (checkboxes ticked)
**Tests added/modified:** <list>
**Files touched:** <list>
**Sub-agent invocations:** <list, or none>
**ask_user escalations:** <list, or none>

## What was done

- <bullet 1>
- <bullet 2>

## What was learned

- <bullet — surprises, gaps, dead ends>
- <bullet — SDK behavior discovered>

## Blockers / decisions needed

- <bullet — items routed back to coordinator or user>

## Next steps

- <bullet — for the next session>

## Open tasks at end of session

- [ ] <task that was started but not finished>
- [x] <task completed in this session>
```

## What the coordinator tracks

The coordinator's session log additionally tracks:

- **Plan tick state.** Which `[ ]` boxes in `04-refactor-plan.md` are now `[x]`. Cross-reference the plan.
- **Phase completion.** Which features (F1, F2, ...) are fully done vs in-progress vs blocked.
- **Escalations to user.** What was asked via `ask_user` and the outcome.
- **Worker handoff notes.** What's blocking each worker session; what each worker should pick up next.

If the coordinator session spans multiple days, append a section per day rather than starting a new file.

## Reading order for a fresh session

1. `README.md` (this directory's parent) — working conventions.
2. Latest coordinator log — current state of the refactor.
3. Latest worker log for the phase you're picking up — what's been started, what's blocked.
4. `04-refactor-plan.md` — tick the boxes you'll work on from `[ ]` to `[WIP]` (and back when done).