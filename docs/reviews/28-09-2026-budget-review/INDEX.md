# Index — Budget Strategies Review

**Date:** 2026-09-28 (initial); SDK 0.99.1 alignment pass 2026-09-29
**Baseline:** `feat/budget-strategy` at `9f950fb`
**SDK reference:** verified against `@earendil-works/pi-coding-agent@0.99.1` (commit ea9c54a on `refactor/budget`). The `UsageEntry` / `appendUsage` prescriptions in §4 of the synthesis are now directly implementable against the installed SDK; `getSessionStats()` was rewritten in 0.99.1 to iterate `getEntries()` and explicitly accumulate `UsageEntry` records — see `raw-evidence/pi-sdk-session-api.md` §0 and §2.2 for the diff and its implications.

## Reading order

| # | File | What it contains | Time |
|---|---|---|---|
| 1 | `README.md` | Orientation: scope, layout, conventions | 3 min |
| 2 | `00-scope-and-methodology.md` | What this review covers, methodology, what's excluded | 5 min |
| 3 | `01-current-state-analysis.md` | **The synthesis.** Structural issues, bug timeline, pi-docs alignment, skills summary | 20 min |
| 4 | `current-flow/delegation-flow.md` | `delegate_agent` → `dispatchAgent` → first model call | 15 min |
| 5 | `current-flow/budget-check-flow.md` | When and how the budget is checked (pre-flight, mid-run, compaction) | 15 min |
| 6 | `current-flow/accumulation-flow.md` | The dual/triple counter system; how tokens/cost accumulate | 15 min |
| 7 | `current-flow/fresh-true-bug-timeline.md` | The three bug layers; what was tried; what still fails | 15 min |
| 8 | `raw-evidence/code-line-ranges.md` | Every relevant line with file/line reference | lookup |
| 9 | `raw-evidence/test-coverage-analysis.md` | What tests pin, what they don't | 10 min |
| 10 | `raw-evidence/bug-history.md` | Chronological bug timeline + lessons learned | 10 min |
| 11 | `pi-docs/extension-patterns-reference.md` | Pi-documented patterns quoted verbatim with citations | reference |
| 12 | `skills-review/compound-engineering-inventory.md` | All 47 skills + ranked recommendations | reference |
| 13 | `html/index.html` | Landing page for HTML reports | open in browser |
| 14 | `html/01-current-flow.html` | Diagrammatic version of current flows | open in browser |
| 15 | `html/02-current-system.html` | Diagrammatic structural analysis | open in browser |
| 16 | `html/03-pi-docs-alignment.html` | Visual pi-docs alignment audit | open in browser |
| 17 | `html/04-test-coverage.html` | Visual test coverage map | open in browser |
| 18 | `raw-evidence/pi-sdk-session-api.md` | **SDK ground-truth reference** — verified `AgentSession` / `SessionManager` / `getSessionStats()` / `getContextUsage()` / `UsageEntry` / `CompactionResult` shapes and behaviors from the local SDK `.d.ts` and `.js`. Read this before designing any refactor. | reference |
| 19 | **`review-status.md`** | **Status / progress / next-steps doc.** Complete file inventory with importance, state of the world, next steps for the next session, open questions for the user. **Read this first if you're picking up this review.** | reference |
| 20 | **`04-refactor-plan.md`** | **Implementation plan.** Task-oriented specification for the budget system refactor using Pi Best Practices: what goes away, what replaces it, end-to-end workflow, side-by-side diff, ~50 new tests, phase-by-phase task list with gates, risks, open questions, pickup instructions, **§11 parallelization strategy**. **Read this first if you're implementing.** | reference |
| 21 | **`05-parallelization-analysis.md`** | **Multi-agent parallelization strategy.** 16 sub-agent invocations across 6 waves; full agent roster, file-partition strategy, dependency graph, risks. **Read this if running the implementation as a multi-agent workflow.** | reference |

Total reading time: ~2.5 hours. The synthesis is in `01-current-state-analysis.md`; the implementation plan is in `04-refactor-plan.md`; the multi-agent parallelization strategy is in `05-parallelization-analysis.md`; the rest is supporting evidence.

## TL;DR

- **The budget system has three counters per runtime** (`runtime.*` SDK-reported session-lifetime, `governanceTokens` frozen-at-run-end, `effectiveTokens` current-context-load). Three write sites (per-message `message_end`, per-run `agent_end`, per-compaction `compaction_end`). Three read sites (`checkDispatchBudgets`, `workerConsumedTokens`, `budgetRemaining`). The `??` fallthroughs in the read sites paper over the inconsistency.

- **Three bugs have hit the `fresh=true` path** in the past week. Bug 1 (ordering) and Bug 2 (mid-run check) are fixed in `feat/budget-strategy` at `9f950fb`. Bug 3 (post-abort end-of-run math) is unresolved per `raw-evidence/2025-09-28-fresh-true-budget-bug-unresolved.md`.

- **The bug class lives in the dual-counter system.** Every fix so far has been a defensive guard in the read sites. A structural fix would collapse the counters to one source of truth.

- **Tests cover the deterministic paths strongly** (`tests/governance.test.ts`, `tests/budget-strategy.test.ts`, `tests/dispatch-usage.test.ts:385, 489, 544`). The race-condition paths (abort-then-`getSessionStats`, parallel delegation updates) are not pinned.

- **Pi-docs alignment gaps** are: state in closure rather than `CustomEntry`; no `ctx.signal` propagation in handler paths; worker-attributed spend not written as `UsageEntry`; pre-dispatch check instead of `tool_call` blocking.

- **Top 3 skills for any future refactor:** `architecture-strategist`, `spec-flow-analyzer`, `code-simplicity-reviewer`.

- **Implementation plan drafted.** See `04-refactor-plan.md` for the full Pi-native refactor: collapse the dual/triple counter system to a single source of truth (`session.getSessionStats()` + throttled `CustomEntry` ledger), migrate from `agent_end` to `agent_settled`, expose 6 EOL/respawn commands (vs. current 3), make the `fresh=true` bug class structurally impossible. ~50 new tests including race coverage. Implementation branch: `refactor/budget-pi-native` (not yet created).

## Open question (deferred per user feedback)

The user explicitly asked for a review of the current codebase first. Implementation questions (which refactor approach to take, whether to scrap PR #54) are deferred. The `01-current-state-analysis.md` was drafted with an "open question" section that was removed once the user clarified scope. The structural critique stands on its own as input to a future direction decision.

**Update 2026-09-28 (same session):** The user asked for a full refactor plan using Pi Best Practices. That plan now exists at `04-refactor-plan.md` — task-oriented, ~50 new tests, phase-by-phase with gates. Seven open questions in §6 of the plan await user decisions before implementation begins.