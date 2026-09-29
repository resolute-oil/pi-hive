# Budget Strategies Review — Current Codebase

**Date:** 2026-09-28
**Branch:** `review/budget-redesign-2026-09-28` (off `feat/budget-strategy` at `9f950fb`)
**Trigger:** Multiple-session failure to fix the `fresh=true` budget-reset bug in `delegate_agent`. User requested a thorough review of the current codebase and how the budget system works before deciding direction.

## Scope (revised per user feedback)

This review focuses on **the current codebase** — how the budget system works today, what the structural issues are, and where the bug class lives. It does NOT propose specific refactor options or implementation plans. The user will determine direction after reviewing this report.

What this review delivers:

1. **How the budget system works today** — every code path documented end-to-end with line references.
2. **Structural issues** — the seven issues that shape the bug class, ranked by priority.
3. **Bug timeline** — every bug the project has hit on this feature, with fix references.
4. **Test coverage analysis** — what's pinned, where the gaps are.
5. **Pi-docs alignment** — what the current code does that follows (or conflicts with) Pi's documented extension patterns.
6. **Skill recommendations** — which compound-engineering skills are most useful for any future refactor.
7. **HTML reports** — diagrammatic versions of the above for visual review.

What this review does NOT deliver (deferred to user direction):

- Refactor options with trade-off matrix.
- A single recommended path.
- A sequenced implementation plan.
- A migration strategy.

## Conventions

- All file paths are relative to `APP_ROOT/.worktrees/review-budget-redesign/` unless otherwise noted.
- Code citations use `path:line` form, against the current `feat/budget-strategy` HEAD (`9f950fb`).
- Pi doc citations use `pi-docs/<file>.md#<section-anchor>`.
- HTML reports are self-contained (Mermaid inline; no external CDN at runtime where possible).
- The user's inline `ask_user` preference applies; questions are batched at phase boundaries when possible.

## Layout

```
docs/reviews/28-09-2026-budget-review/
├── README.md                   # this file
├── INDEX.md                    # master index / table of contents
├── 00-scope-and-methodology.md # what this review covers and how it was done
├── 01-current-state-analysis.md # the synthesis — structural critique, bug timeline, pi-docs alignment
├── current-flow/               # detailed evidence for the current implementation
│   ├── delegation-flow.md
│   ├── budget-check-flow.md
│   ├── accumulation-flow.md
│   └── fresh-true-bug-timeline.md
├── pi-docs/                    # pi-docs patterns with citations
│   └── extension-patterns-reference.md
├── skills-review/              # compound-engineering skill inventory + recommendation
│   └── compound-engineering-inventory.md
├── raw-evidence/               # primary source material (code line ranges, test coverage, bug history)
│   ├── code-line-ranges.md
│   ├── test-coverage-analysis.md
│   └── bug-history.md
└── html/                       # rendered HTML reports (self-contained)
    ├── index.html
    ├── 01-current-flow.html
    ├── 02-current-system.html
    ├── 03-pi-docs-alignment.html
    └── 04-test-coverage.html
```

## Relationship to in-flight work

`feat/budget-strategy` (PR #54, awaiting merge) is the baseline. The review reads its code as-shipped and notes the open work (Bug 3 unresolved, dashboard UI missing). It does not propose changes to PR #54 in this document; that is a separate decision the user will make.

## How to read this review

1. Start with `INDEX.md` for orientation.
2. Read `01-current-state-analysis.md` for the synthesis (structural issues, bug timeline, pi-docs alignment summary).
3. Skim `current-flow/` for step-by-step evidence (delegation, budget check, accumulation, fresh=true bug timeline).
4. Read `raw-evidence/` for the lookup tables (every code line, every test, every bug).
5. Read `pi-docs/extension-patterns-reference.md` for the source-of-truth Pi patterns.
6. Read `skills-review/compound-engineering-inventory.md` for the skill landscape.
7. Open the HTML reports in `html/` for the diagrammatic versions.

If you only have time for one read, read `01-current-state-analysis.md`. The rest is supporting evidence.