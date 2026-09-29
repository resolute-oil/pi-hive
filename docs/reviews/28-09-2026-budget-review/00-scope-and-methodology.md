# 00 — Scope and methodology

**Review:** Budget strategies redesign
**Date:** 2026-09-28
**Author branch:** `review/budget-redesign-2026-09-28`
**Baseline:** `feat/budget-strategy` at `9f950fb` (PR #54 open)
**Reviewer:** Pi-hive redesign review session

## Goal

Produce a **plan**, not code. The deliverable is a structured set of documents and HTML reports describing:

1. How the current budget enforcement code works, end to end.
2. Why the `fresh=true` budget-reset bug has resisted several rounds of fixes.
3. How the current design aligns with or diverges from Pi-documented patterns.
4. Multiple refactor options with explicit trade-offs.
5. A single recommended path with a sequenced implementation plan, including migration strategy and test strategy.

The actual refactor is **out of scope** for this branch. The user explicitly asked for "a different approach" after three sessions of incremental fixes on `feat/budget-strategy`; the review treats that branch as data, not as the destination.

## What is in scope

| Area | Question this review answers |
|---|---|
| Current code | What does the budget system do today, line by line? |
| Bug analysis | Why does the third-mystery `fresh=true` bug persist despite Bug 1 + Bug 2 fixes? |
| Pi-docs alignment | Does the current design follow Pi's documented extension patterns? |
| Compound-engineering skills | Which skills are the highest-leverage inputs to a redesign? |
| Refactor options | What are 3–4 distinct ways to redesign the budget layer? |
| Recommendation | Which option best fits the project's constraints? |
| Migration plan | How do we get from here to there without breaking the codebase? |
| Test strategy | How do we keep the budget guarantees testable after the redesign? |

## What is out of scope

| Excluded | Why |
|---|---|
| Implementing the refactor in this branch | The user asked for a plan; the implementation lives in follow-up branches. |
| Changing PR #54 directly | PR #54 is "awaiting user merge" per HANDOFF.md. The review's recommendation may supersede it; that decision belongs to the user. |
| Dashboard UI work | The dashboard's intervention UI (the "End / Compact / Respawn" buttons) is already flagged as "out of scope for PR #54" in `raw-evidence/budget-strategy-plan.md`. The review notes this as a downstream dependency but does not design the UI. |
| Respawn strategy (third strategy) | Already dropped from `feat/budget-strategy` per `raw-evidence/budget-strategy-plan.md#why-respawn-was-dropped`. The review's options keep that decision and do not revisit it unless an option requires it. |
| New Pi SDK API adoption | The review reads what Pi documents at `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/`. It does not propose new Pi APIs that are not in those docs. |
| Cross-project budget APIs (multi-hive, billing) | Out of scope; budget is per-`pi-hive` session. |

## Methodology

The review follows a layered approach. Each layer produces a document; the final synthesis draws on all of them.

### Layer 1 — Inventory (already complete)

- **Compound-engineering skills** — `skills-review/compound-engineering-inventory.md`. Read all 47 skills, classified by theme, ranked by relevance. Top three: `architecture-strategist`, `spec-flow-analyzer`, `code-simplicity-reviewer`.
- **Pi-docs reference** — `pi-docs/extension-patterns-reference.md`. Quoted verbatim with citations; mapped to budget enforcement applicability. Closing "Implications" section lists what the redesign should follow, must not violate, and currently ignores.

These were produced by parallel `Agent` invocations from `@tintinweb/pi-subagents`. The outputs are durable files in the review directory.

### Layer 2 — Current-state analysis (in progress)

- **Code reading** of the budget-relevant files:
  - `src/engine/dispatch.ts` (1101 LOC, the central flow)
  - `src/engine/governance.ts` (175 LOC, budget math)
  - `src/engine/budget-strategy.ts` (200 LOC, new in `feat/budget-strategy`)
  - `src/agents/tools/summarize-progress.ts` (117 LOC, new in `feat/budget-strategy`)
  - `src/core/types.ts` (429 LOC, AgentRuntime shape with budget-relevant fields)
  - `src/core/schema.ts` (161 LOC, validation of WorkerGovernance and TeamBudgets)
- **Test reading** of the budget-relevant tests:
  - `tests/governance.test.ts` (167 LOC)
  - `tests/budget-strategy.test.ts` (667 LOC, new in `feat/budget-strategy`)
  - `tests/dispatch-usage.test.ts` (835 LOC; includes the Bug 1 regression test at line 385 and the `W1.1` fresh-delta test at line 489)
- **Bug-history reading** of `raw-evidence/2025-09-28-fresh-true-budget-bug-unresolved.md` and the relevant HANDOFF sections.

Outputs:

- `current-flow/delegation-flow.md` — what happens from `delegate_agent` invocation through `dispatchAgent`.
- `current-flow/budget-check-flow.md` — when and how the budget is checked.
- `current-flow/accumulation-flow.md` — how tokens/cost accumulate across a worker's lifecycle.
- `current-flow/fresh-true-bug-timeline.md` — the three bug layers, what was tried, what still fails.
- `raw-evidence/code-line-ranges.md` — every relevant line with its file/line reference.
- `raw-evidence/test-coverage-analysis.md` — what is tested, what is not.
- `raw-evidence/bug-history.md` — chronological bug timeline.
- `01-current-state-analysis.md` — the synthesis of the above, with structural critique.

### Layer 3 — Refactor options

Outputs:

- `04-refactor-options.md` — the overview, with trade-off matrix.
- `refactor-options/option-A-minimal-fix.md` — smallest viable change (close the third mystery bug; keep the rest).
- `refactor-options/option-B-pi-native-tool.md` — redesign around Pi's `UsageEntry` / `CustomEntry` / `session_start getBranch()` patterns.
- `refactor-options/option-C-pure-refactor.md` — extract the budget layer into a self-contained module with one source of truth.
- `refactor-options/option-D-strategy-deprecation.md` — narrow the feature surface; only ship the `default` strategy; defer `compact` and operator intervention.

### Layer 4 — Recommendation and plan

Output:

- `05-recommendation-and-plan.md` — the single recommended path with sequenced steps.
- `refactor-plan/implementation-plan.md` — file-by-file change list.
- `refactor-plan/migration-strategy.md` — how to ship without breaking existing users.
- `refactor-plan/test-strategy.md` — the test matrix that pins every guarantee.

### Layer 5 — HTML reports

Outputs (in `html/`):

- `index.html` — landing page with links to all reports.
- `01-current-flow.html` — rendered delegation/budget/accumulation flows with diagrams.
- `02-pi-docs-reference.html` — distilled Pi patterns with citations.
- `03-refactor-options.html` — the options side-by-side with trade-offs.
- `04-refactor-plan.html` — the recommended plan with diagrams.

HTML is hand-written with inline Mermaid for diagrams; self-contained, no external CDN at runtime.

## Conventions used throughout this review

- **Code citations:** `src/engine/dispatch.ts:252` = line 252 of `src/engine/dispatch.ts` in the `feat/budget-strategy` HEAD. The review branch has the same code (the review is read-only).
- **Strategy names:** `default` and `compact` are the two strategies shipped in `feat/budget-strategy`. The third, `respawn`, was dropped per `raw-evidence/budget-strategy-plan.md` and is not reconsidered.
- **Run states:** `idle`, `running`, `done`, `error`, `queued` — from `AgentStatus` in `src/core/types.ts:13`.
- **Budget scopes:** `worker` (one agent) and `team` (sum of all non-orchestrator runtimes).
- **Resources:** `runs`, `tokens`, `cost`, `depth`, `queue` — the five resources the budget layer tracks.
- **"Fresh"** = `delegate_agent(..., fresh: true)`, which reloads config and resets counters.
- **"Bug 1"** = the reset-after-budget-check ordering bug, fixed in commit `081380a`.
- **"Bug 2"** = the mid-run budget check seeing stale `governanceTokens=0`, fixed in `3be33f6`.
- **"Bug 3" / "third mystery"** = the unresolved post-test symptom — `runtime.*=0` but `governanceTokens=15134` after a fresh=true abort. Documented in `raw-evidence/2025-09-28-fresh-true-budget-bug-unresolved.md`.

## Process

The review follows the project's documented `ask_user` discipline (AGENTS.md):

- `displayMode: "inline"` on every ask.
- One question per ask.
- At most two asks per high-stakes boundary; the user delegates anything beyond.
- Questions are asked at phase boundaries when there is enough context to anchor them — never blind.

The first strategic question is in `01-current-state-analysis.md`'s closing section: do we want a single sweeping refactor or an incremental migration? The answer shapes Layer 4.

## How to read this review

1. Start with `README.md` for orientation.
2. Read `01-current-state-analysis.md` for the structural critique.
3. Skim `current-flow/` for the step-by-step evidence.
4. Read `04-refactor-options.md` for the trade-off matrix.
5. Read `05-recommendation-and-plan.md` for the recommended path.
6. Open the HTML reports in `html/` for the diagrammatic versions.

If you only have time for one read, read `01-current-state-analysis.md` and `05-recommendation-and-plan.md`. The rest is supporting evidence.