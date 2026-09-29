# Review status — 2026-09-28 budget strategies

**Review branch:** `review/budget-redesign-2026-09-28`
**Baseline:** `feat/budget-strategy` at `9f950fb` (PR #54 still open, awaiting user merge — **recommended: close in favor of the refactor** per §6.2)
**Generated:** 2026-09-28
**SDK version:** Validated against `@earendil-works/pi-coding-agent@0.99.1` on 2026-09-29 (project devDep bump, commit ea9c54a on `refactor/budget`). See `raw-evidence/pi-sdk-session-api.md` §0 for the SDK 0.99.1 vs 0.80.x diff and its impact on the prescriptions in this review.
**Status:** **Refactor plan is implementation-ready.** All 30 gaps from the spec-flow review have user-confirmed resolutions applied to the plan. All 13 prior open questions (§6.2) are now DECIDED. The 4 critical gaps and 7 high gaps are addressed with concrete tasks in the plan. Implementation runs as one coordinator session + worker sessions in per-phase worktrees under `APP_ROOT/.worktrees/`, with each worktree based off the current HEAD of `refactor-budget` (NOT `main`). See `README.md` §1 and `05-parallelization-analysis.md` §0.5 for the working conventions.

> **2026-09-29 update (SDK 0.99.1 alignment):** The `UsageEntry` / `appendUsage` prescriptions in the synthesis and refactor plan are now directly implementable against the SDK the project pins. The 0.99.1 alignment does NOT change the diagnosis (Issues 1–9, bug timeline, pi-docs alignment gaps) — only the SDK surface available to implement the prescriptions. The reader picking up this review should also check `origin/fix/fresh-rebuild`, which (per its commit messages) shipped a v2 `BudgetLedger` refactor after this review was written and may supersede parts of the planned work.

---

## 1. What this review produced

**Thirteen commits** on top of `9f950fb`, ~6,800 insertions across 23 files. All on branch `review/budget-redesign-2026-09-28`, **none pushed**.

### 1.1 Phase 1 — review-creation session (4 commits, ~4,500 insertions)

| Commit | Subject |
|---|---|
| `d87e988` | `docs(review): add 2026-09-28 budget strategies review (current codebase, pi-docs alignment, test coverage)` |
| `7ad6226` | `docs(review): add 2026-09-28 online SDK clarifications (steer/followUp returns, abort/dispose distinction, agent_settled, runtime vs session systemPrompt)` |
| `8609831` | `docs(review): regenerate HTML to reflect 7ad6226 additions (Issues 8+9, Section 12 SDK refresh)` |
| `9ab332d` | `docs(review): add pi-sdk-session-api.md — verified SDK reference for the budget refactor` |
| `af814fa` | `docs(review): add review-status.md — pickup doc for the next session` (prior session) |

### 1.2 Phase 2 — refactor-plan + presentation + spec-flow review + gap-decisions (8 commits, ~2,300 insertions)

| Commit | Subject |
|---|---|
| `8e69383` | `docs(review): add 04-refactor-plan.md — task-oriented Pi-native refactor plan` (1,473 lines, 13 features, 52+ tasks) |
| `58de33b` | `docs(review): restructure plan with [ ] checkboxes and per-feature completion guards` |
| `9112ed6` | `docs(review): add §2.13 config shape proposals (six deeper improvements)` (C1–C6) |
| `e633250` | `docs(review): kebab-case all YAML config keys in §2.10 and §2.13 examples` |
| `e47bfbe` | `docs(review): add presentation/index.html — multipage HTML overview of the plan` (1,218 lines, 13 pages, interactive checkboxes persisted to localStorage) |
| `f06e3b4` | `docs(review): add spec-flow-review.md — plan completeness analysis` (682 lines, 30 gaps + 18 questions) |
| `9a0d334` | `docs(review): add spec-flow-review.html — walkthrough of reviewer findings` (1,050 lines, 12 pages) |
| `aa8a705` | `docs(review): apply 30 gap-decisions to refactor plan` (+176/-67 LOC, plan is now 1,582 lines, 69 task checkboxes) |

---

## 2. File inventory

Every file in `docs/reviews/28-09-2026-budget-review/` with a one-line description of its importance to the implementation.

### 2.1 Orientation and synthesis (read these first)

| File | Lines | Importance |
|---|---|---|
| `README.md` | 79 | Scope statement, layout, conventions; **read first** to understand the review's boundaries. |
| `INDEX.md` | 50 | Reading-order table with time estimates and one-line summaries; the **single best pointer** if the next session has only time for one read. |
| `00-scope-and-methodology.md` | 145 | What the review covers, what it doesn't, methodology, layered approach. |
| `01-current-state-analysis.md` | 196 | **The synthesis.** Nine structural issues ranked by priority, bug timeline, pi-docs alignment summary, skill recommendations. |
| **`04-refactor-plan.md`** | **~1730** | **The implementation plan.** 13 features, 69 task checkboxes, 6 base EOL commands + `resumeWorkerSession` + 3 cooperative tools, all 30 gap-decisions applied, plus §11 parallelization strategy. **Read this second.** |
| **`05-parallelization-analysis.md`** | **~430** | **Multi-agent parallelization strategy.** 16 sub-agent invocations across 6 waves; full agent roster, file-partition strategy, dependency graph, risks. **Read this if running the implementation as a multi-agent workflow.** |
| **`review-runs/spec-flow-review.md`** | **682** | **Spec-flow analysis output.** 30 gaps + 18 questions, all resolved (resolutions applied to `04-refactor-plan.md`). |
| **`review-runs/spec-flow-review.html`** | **1050** | **Walkthrough of the spec-flow findings.** Sidebar nav, severity-styled gap cards, Q1-Q18. |

### 2.2 Current-flow evidence (the four step-by-step walkthroughs)

| File | Lines | Importance |
|---|---|---|
| `current-flow/delegation-flow.md` | 158 | End-to-end `delegate_agent` → `dispatchAgent` flow with Mermaid sequence diagram. |
| `current-flow/budget-check-flow.md` | 249 | When and how the budget is checked (pre-flight, mid-run, compaction), with abort/dispose breakdown. |
| `current-flow/accumulation-flow.md` | 174 | The dual/triple counter system explained; every write site and read site. The heart of the bug class. |
| `current-flow/fresh-true-bug-timeline.md` | 171 | The three bug layers (Bug 1, 2, 3); what was tried; what still fails. **Entry point for any "fix the fresh=true bug" investigation.** |

### 2.3 Pi-docs reference (source of truth for extension patterns)

| File | Lines | Importance |
|---|---|---|
| `pi-docs/extension-patterns-reference.md` | 480 | **12 sections of verbatim Pi docs with citations + section 12 capturing the 2026-09-28 online SDK refresh findings.** Every refactor option should be evaluated against this. |

### 2.4 Skills inventory (which compound-engineering skills to invoke)

| File | Lines | Importance |
|---|---|---|
| `skills-review/compound-engineering-inventory.md` | 198 | All 47 skills classified by theme; ranked top-10 for this review. **Top three:** `architecture-strategist`, `spec-flow-analyzer`, `code-simplicity-reviewer`. |

### 2.5 Raw evidence (primary source material)

| File | Lines | Importance |
|---|---|---|
| `raw-evidence/code-line-ranges.md` | 215 | Every relevant line of code with file:line reference. |
| `raw-evidence/test-coverage-analysis.md` | 88 | What the existing ~50 tests pin vs where the gaps are. |
| `raw-evidence/bug-history.md` | 142 | Chronological log of every budget-related bug with fix references. |
| `raw-evidence/pi-sdk-session-api.md` | 555 | **The SDK ground-truth reference.** Verified `AgentSession` / `SessionManager` / `getSessionStats()` / `getContextUsage()` / `UsageEntry` / `CompactionResult` shapes. **Read before designing any refactor.** |

### 2.6 HTML reports (diagrammatic versions, self-contained)

| File | Lines | Importance |
|---|---|---|
| `html/index.html` | 95 | Landing page with cards linking to each report and a "Key findings" list. |
| `html/01-current-flow.html` | 266 | Diagrammatic version of the flows with Mermaid diagrams. |
| `html/02-current-system.html` | 263 | Diagrammatic structural analysis (9 issues, severity-styled). |
| `html/03-pi-docs-alignment.html` | 313 | Visual pi-docs alignment audit. |
| `html/04-test-coverage.html` | 172 | Visual test coverage map. |
| `html/assets/review.css` | 511 | Shared stylesheet for the HTML reports. |

### 2.7 Refactor plan walkthrough (presentation)

| File | Lines | Importance |
|---|---|---|
| **`presentation/index.html`** | **1218** | **Multipage HTML walkthrough of the plan.** 13 pages with sidebar navigation: Overview, The problem, The goal, What goes away, What replaces it, New workflow, Side-by-side, Task plan, Config options, Pros/cons/pitfalls, Open questions, Verification gates, Pickup. Interactive checkboxes persisted to localStorage. Mermaid diagrams. Print stylesheet. |
| `presentation/assets/presentation.css` | 837 | Sidebar layout, responsive, print. |
| `presentation/assets/presentation.js` | 173 | Checkbox persistence to localStorage, sidebar active state via IntersectionObserver, reset button. |

### 2.8 Spec-flow review (the gap analysis)

| File | Lines | Importance |
|---|---|---|
| **`review-runs/spec-flow-review.md`** | **682** | **30 gaps** (4 critical / 7 high / 10 medium / 9 low) + **18 clarifying questions** (4 critical / 8 important / 6 nice-to-have). All gaps resolved — resolutions applied to `04-refactor-plan.md` commit `aa8a705`. |
| **`review-runs/spec-flow-review.html`** | **1050** | **HTML walkthrough of the spec-flow findings.** 12 pages, 27 gap cards, 18 question cards. Reuses `presentation.css`. |

---

## 3. State of the world

### 3.1 What is complete

- **Current-codebase review:** every budget-relevant code path documented end-to-end with line citations (Issues 1-9 in `01-current-state-analysis.md`).
- **Bug timeline:** all three `fresh=true` bug layers documented; Bug 1 and Bug 2 fixed in `9f950fb`; Bug 3 unresolved.
- **Pi-docs alignment audit:** 11 patterns cited + 4 from the 2026-09-28 online SDK refresh.
- **SDK ground-truth reference:** verified `.d.ts` and `.js` for the four SDK files most relevant to the refactor.
- **Skills assessment:** top-10 recommended skills.
- **HTML reports:** 5 self-contained HTML files with Mermaid diagrams.
- **Refactor plan:** `04-refactor-plan.md` (1,582 lines, 13 features, 69 task checkboxes, single-source-of-truth design via `session.getSessionStats()` + throttled `appendCustomEntry` ledger, 6 base EOL commands + `resumeWorkerSession` + 3 cooperative tools, hard cutover on config schema).
- **Multipage HTML presentation:** 13-page walkthrough of the plan with interactive checkboxes.
- **Spec-flow analysis:** 30 gaps + 18 questions identified; all 30 gaps have user-confirmed resolutions applied to the plan.
- **HTML walkthrough of spec-flow findings:** 12 pages, 27 gap cards, 18 question cards.

### 3.2 What is deferred per user instruction

The user explicitly said: "It's too early to ask implementation questions. I want a review of the current codebase and how the current budget system works. I will determine where to go from there after receiving what you asked for."

Accordingly, the following were intentionally NOT produced in the **review** portion (commits 1-5):

- Refactor options with trade-off matrix (`04-refactor-options.md` and `refactor-options/`).
- A single recommended path (`05-recommendation-and-plan.md`).
- A disposition on PR #54 (merge / amend / close) — **resolved in §6.2 as "close in favor of the refactor"**.

**Update 2026-09-28 (same day, gap-decisions session):** The user asked for a full refactor plan using Pi Best Practices, then a spec-flow review of the plan, then walked through all 30 gaps and applied the resolutions. The plan (`04-refactor-plan.md`) is now implementation-ready with all questions resolved.

### 3.3 What is unresolved in the codebase (carried over from `feat/budget-strategy`)

- **Bug 3 (third mystery):** post-abort end-of-run math. Symptom: `runtime.* = 0` but `remaining.tokens = 0` after a fresh=true abort. **The refactor plan makes this bug class structurally impossible** by collapsing to `session.getSessionStats()` as the single source of truth. **Verification via F7 T7.7 (new Bug 3 regression test, commit `aa8a705`) still required.**
- **Dashboard intervention UI:** the six base operator commands + `resumeWorkerSession` + 3 cooperative tools are correct and tested; the dashboard UI to invoke them is missing. F13 covers the dashboard intervention UI (separate PR after refactor lands).
- **PR #54 disposition:** still open, awaiting user merge. **User-confirmed: close PR #54 in favor of the refactor** (the refactor supersedes the budget-strategy feature entirely).

---

## 4. Gap decisions applied (2026-09-28 gap-decisions session)

The 30 gaps from the spec-flow review were walked through with `ask_user` (inline mode, AGENTS.md-compliant). All 30 gaps have user-confirmed resolutions. The resolutions are integrated into `04-refactor-plan.md` as concrete changes (schema additions, new tasks, modified tasks, documentation). Commit `aa8a705` carries the change.

### 4.1 Critical gaps (4) — all fixed

| Gap | Resolution | New task / change |
|---|---|---|
| G-01 `tool_call` blocking claimed but not implemented | Implement it | F3 T3.4 (6 tests) |
| G-02 `agent_settled` × `controller.abort` ordering not pinned | Add ordering test | F3 T3.6 (1 test) |
| G-03 No regression test for Bug 3 | Add fresh=true → abort → assert test | F7 T7.7 (1 test) |
| G-04 `pauseWorkerSession` without `resumeWorkerSession` | Add resume as 7th command | F5 T5.8 (1 test) |

### 4.2 High gaps (7) — all fixed

| Gap | Resolution | New task / change |
|---|---|---|
| G-05 No `session.abortCompaction` | Add T5.9 | F5 T5.9 (1 test) |
| G-06 `restoreWorkerSession` SDK API misuse | Document correct SDK chain | F5 T5.6 (3 tests) |
| G-07 Cooperative tools unimplemented | Add T5.10-T5.12 | F5 (3 tasks, 3 tests, new `cooperative-eol.test.ts`) |
| G-08 marker schema internal inconsistency | Add `kind?: string` to schema | Schema fix in §2.3 |
| G-09 Team totals not pinned under parallel | Augment T7.2 | F7 T7.2 |
| G-10 `per-day` window unverified | Add T6.10 rollover test | F6 T6.10 (1 test) |
| G-11 No branch/fork coverage | Add T8.5, T8.6 | F8 (2 tasks, 2 tests) |

### 4.3 Medium gaps (10) — all fixed or accepted

| Gap | Resolution |
|---|---|
| G-12 F5 cooperative subset has no task IDs | Subsumed by G-07 (T5.10-T5.12) |
| G-13 `depth` resource has no test | F2 T2.3 (1 test) |
| G-14 `queue` resource dropped without rationale | Added §2.15 with rationale |
| G-15 HTML/Markdown count mismatch | Re-counted; both files agree |
| G-16 No `schema_version` field | **Hard cutover decision** — no dual-format, no version field, manual hive-config.yaml migration |
| G-17 Warning × `summarize_progress` ordering not pinned | F3 T3.5 (1 test) |
| G-18 `max-delegation-depth` → `depth.cap` migration | Documented in T12 (hard cutover) |
| G-19 `worker-budgets` → `per-worker` rename | Documented in T12 (hard cutover) |
| G-20 `summarize_progress` 3 failure paths not addressed | F5 T5.7 (3 new tests for `no_runtime` / `over_cap` / `compact_failed`) |
| G-21 `entry_appended` not wired for self-throttling | Keep simpler `message_end` design |
| G-22 Telemetry dual-shape emit | **Hard cutover** — dashboard updated in same refactor |

### 4.4 Low gaps (9) — all fixed or accepted

| Gap | Resolution |
|---|---|
| G-23 No spec for `controller.signal.aborted` mid-write | Document in code, no test |
| G-24 `cacheWrite1h` and `reasoning` not in `include` | Skip (most providers don't populate) |
| G-25 No Bun-isolation gate | F9 guard: `grep -r "bun:" src/engine/budget/` returns no matches |
| G-26 `appendUsage` mentioned in TL;DR but not wired | Added §2.14 with decision rationale; removed from TL;DR |
| G-27 HTML progress counter starts at "0/0" | Compute initial count server-side (presentation CSS update) |
| G-28 `restoreWorkerSession` couples to destination session | Document coupling in T5.6; add test |
| G-29 No test for cap type-mismatch | T1.3 (1 test) |
| G-30 `interventionAvailable` flag mismatch | Added to plan §6.2 (G-30 section) |

### 4.5 Net changes to the plan

- **+12 new tasks:** T2.3, T3.4, T3.5, T3.6, T5.8, T5.9, T5.10, T5.11, T5.12, T6.10, T7.7, T8.5, T8.6 (13 actually, but T6.10 was previously 1 task → still 1)
- **+2 new sections:** §2.14 (appendUsage rationale), §2.15 (queue removal rationale)
- **+1 schema field:** `BudgetLedgerEntry.data.kind?: string` (G-08)
- **+3 modified tasks:** T1.3 (type-mismatch test), T5.6 (SDK chain), T5.7 (3 failure paths)
- **Total:** plan grew from 1,473 lines / 52+ tasks to **1,582 lines / 69 task checkboxes**
- **Test count target:** **575+ server tests** (was 510 at start; +65 new budget tests after the gap-decisions walkthrough)

---

## 5. Open questions for the user (all DECIDED as of 2026-09-28)

The 13 prior "open questions" are now **DECIDED** in the plan (§6.2). The summary:

1. **PR #54 disposition.** **DECIDED: close** (the refactor supersedes).
2. **Config migration window.** **DECIDED: hard cutover** — no dual-format, no `schema_version`, no deprecation telemetry. Users manually fix `hive-config.yaml` files.
3. **Dashboard intervention UI.** **DECIDED: separate PR after refactor lands** (F13).
4. **Per-call `CustomEntry` write cadence.** **DECIDED: throttled** (10 messages / 5% spend, always on thresholds). F3 T3.1 implements.
5. **Operator command exposure.** **DECIDED: all 7 operator commands** (end, compact, respawn, pause, snapshot, restore, resume — per G-04). Plus 3 cooperative tools (T5.10-T5.12).
6. **`session.dispose()` on `endWorkerSession`.** **DECIDED: do NOT dispose** (preserve session for potential `resumeWorkerSession`).
7. **Backwards-compat telemetry events.** **DECIDED: hard cutover** — dashboard updated in same refactor.
8. **C1 — Rename `governance:` → `budgets:` in agent.md frontmatter.** **DECIDED: land** (documented in T12).
9. **C2 — `include: [Usage keys]` instead of `scope`.** **DECIDED: land** (F6 T6.5).
10. **C3 — Sensible defaults via `defaults-enabled` flag.** **DECIDED: SKIP** (hard cutover supersedes).
11. **C4 — Discriminated union types via typebox.** **DECIDED: land** (F6 T6.7).
12. **C5 — Structured strategies.** **DECIDED: conditional** — defer to v3 by default. Implementation session can override.
13. **C6 — Explicit `window:` field.** **DECIDED: land** (F6 T6.8).
14. **`interventionAvailable` flag** — implemented in F13 T13.2. Single boolean per warning; per-command exposure computed client-side.

---

## 6. How to pick up where the review left off

### 6.1 Verify the current state

```sh
cd /Users/cgrant/.pi/agent/git/github.com/demetere/pi-hive
git worktree list                                          # confirm review worktree exists
cd .worktrees/review-budget-redesign
git log --oneline 9f950fb..HEAD                           # confirm 13 commits
git status --short                                        # confirm clean working tree
```

### 6.2 Implementation work (recommended next step)

**Updated 2026-09-29:** Implementation runs as **one coordinator session + worker sessions in per-phase worktrees**, NOT on a single `refactor/budget-pi-native` mega-branch. The full working conventions are in `README.md`; the canonical worktree-creation pattern is in `05-parallelization-analysis.md` §0.5.

The next session should:

1. **Read `README.md`** first — working conventions (worktree naming, TDD, no-defer, ask_user, removal policy, session logs).
2. **Read `04-refactor-plan.md`** — the authoritative plan; the plan's §0.5 calls out the removal policy and §0.6 calls out the regression-test policy.
3. **Read `05-parallelization-analysis.md`** — coordinator + worker model, per-phase worktrees, wave structure.
4. **Read `INDEX.md`** for the reading order if uncertain where to start.
5. **Close PR #54** via web UI or `gh pr close 54 --repo resolute-oil/pi-hive` (per plan §6.2 decision) — this is the first action item, before any worktree is opened.
6. **Pick a coordinator or worker role.** If you're a fresh session, ask the user whether to be the coordinator (owning the plan + sessions/) or a worker (picking up the next phase). If the coordinator already exists, take a worker role and pick up the next phase from `sessions/`.
7. **Open the worktree for your assigned phase or task** with the correct naming convention. The base is the **current HEAD of the local `refactor-budget` staging branch** (NOT `main`, NOT a remote ref). Examples:
   - Coordinator (wave 0 contracts): `git worktree add .worktrees/refactor-budget-f0-contracts -b refactor/budget-f0-contracts origin/refactor/budget`
   - Worker (F1 primitives): `git worktree add .worktrees/refactor-budget-f1-primitives -b refactor/budget-f1-primitives origin/refactor/budget`
   - Worker (F5 T5.3 respawn): `git worktree add .worktrees/refactor-budget-t5-3-respawn-dispose -b refactor/budget-t5-3-respawn-dispose origin/refactor/budget`
   - Each worktree: `ln -s ../../node_modules node_modules` (per AGENTS.md; the worktree is two levels under `APP_ROOT/`).
   - See `README.md` §1 for the canonical pattern, including a `REFACTOR_BUDGET=$(git rev-parse origin/refactor/budget)` helper so each command captures the current base.
8. **Work TDD-style** (red-green-refactor) per task in the plan. Each task has a gate — don't move on until the gate passes.
9. **Write a session log** in `sessions/<date>-<your-role>-<phase>.md` before ending the session. The template is in `sessions/README.md`.
10. **Commit per task, push to `origin` (not `upstream` per AGENTS.md), open a PR.** Do NOT merge — coordinator + user review per AGENTS.md.
11. **Tick the plan** when tasks complete: the coordinator updates `[ ]` to `[x]` in `04-refactor-plan.md` once the worker's PR has its gate verified.

### 6.3 Branch and worktree conventions

- **The implementation does NOT happen on a single mega-branch.** Each phase or task gets its own worktree under `APP_ROOT/.worktrees/refactor-budget-<phase>-<task>/` with branch `refactor/budget-<phase>-<task>`. See `README.md` §1 and `05-parallelization-analysis.md` §0.5.
- The review branch `review/budget-redesign-2026-09-28` is for documentation only. **Do not push it to origin.**
- Per AGENTS.md: never push to `upstream`; all pushes go to `origin` (the fork).
- The `refactor/budget` worktree on `ea9c54a` (SDK 0.99.1 bump + hive:version fix) is the staging branch for *documentation* updates only. Implementation work does NOT happen on this branch.

### 6.4 Verification gates for implementation work

Per the HANDOFF's Verification gates section + the plan's §7 + the plan's Overall completion guard:

- `just typecheck` — clean across core/bun/tests/dashboard configs
- `just test` — 510 baseline; target 575+ after refactor (was 510 at start; +65 new budget tests after gap-decisions walkthrough)
- `cd ui/web && npm run test:unit` — 49 baseline; no change unless F13 in scope
- `npx eslint <touched files>` — exit 0
- `just dashboard-build` — mandatory after F13
- `just review-vendor-verify` — pass
- `node scripts/check-package-budgets.mjs` — pass
- `just review-build` — mandatory after `ui/review/src/**` changes
- `grep -r "bun:" src/engine/budget/` returns no matches (F9 guard, G-25)

### 6.5 Stale-process trap (per HANDOFF pitfall #1, AGENTS.md)

After editing `src/engine/budget/**`, `src/engine/dispatch.ts`, `src/observability/server/**`, or `src/engine/review.ts`, restart the running server:

```sh
PID=$(lsof -nP -iTCP:43191 -sTCP:LISTEN -t) && kill "$PID"
just pi-dev
```

If `lsof` returns nothing, the server is down — just `just pi-dev`.

### 6.6 Worktree force-remove pitfall (per HANDOFF pitfall #29, AGENTS.md)

Never `git worktree remove --force` without a `git status` precheck. If the worktree has uncommitted changes, commit / back up / stash first. The precheck takes 2 seconds (`cd .worktrees/<branch> && git status --short`); recovery from a wrong call can take hours.

### 6.7 Read the right thing first

If the implementation session has 30 minutes: read `INDEX.md` then `01-current-state-analysis.md`.
If 2 hours: read `INDEX.md`, `01-current-state-analysis.md`, `04-refactor-plan.md` (the plan), and `review-runs/spec-flow-review.md` (the analysis that drove the gap decisions).
If 4+ hours: read every file in `docs/reviews/28-09-2026-budget-review/`.

---

## 7. Cross-reference

- **HANDOFF.md** (project root, gitignored) — updated 2026-09-28 with this session's accomplishments. Includes Quick state recap for the next session.
- **`raw-evidence/2025-09-28-fresh-true-budget-bug-unresolved.md`** — Bug 3 hypothesis document. The refactor plan makes Bug 3 class structurally impossible; verification via F7 T7.7.
- **`raw-evidence/budget-strategy-plan.md`** — the budget-strategy plan that `feat/budget-strategy` was built from. The plan's §1 references its gaps.
- **`AGENTS.md`** (project root) — worktree rule, `ask_user` discipline, no-upstream-push rule, conventional commits, etc.
- **Pi docs** at `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/` — cited in `pi-docs/extension-patterns-reference.md` and `raw-evidence/pi-sdk-session-api.md`.
- **Online Pi docs** at `https://pi.dev/docs/latest/` — refresh additions in `extension-patterns-reference.md#12` and `pi-sdk-session-api.md`.

---

## 8. Final state at handoff (2026-09-28)

```
Review branch:    review/budget-redesign-2026-09-28 (NOT pushed)
Review HEAD:      aa8a705 (13 commits on top of 9f950fb)
Review worktree:  .worktrees/review-budget-redesign/  (clean)
Review files:     23 files in docs/reviews/28-09-2026-budget-review/
                  (1,473 → 1,582 line refactor plan; ~6,800 insertions total)

APP_ROOT:         /Users/cgrant/.pi/agent/git/github.com/demetere/pi-hive
APP_ROOT branch:  feat/budget-strategy
APP_ROOT HEAD:    9f950fb
APP_ROOT state:   clean (HANDOFF.md is gitignored)

Open PRs:         #54 (feat/budget-strategy) — recommended CLOSE in favor of refactor
                  No refactor PR yet — coordinator + workers open per-phase PRs from
                  per-phase worktrees under APP_ROOT/.worktrees/, each based off the
                  current HEAD of the refactor-budget staging branch.

Next action:      Coordinator session picks up, reads README.md (working conventions),
                  closes PR #54, and opens the Wave 0 contracts worktree
                  (.worktrees/refactor-budget-f0-contracts/) based off the current
                  refactor-budget HEAD. Worker sessions pick up subsequent phases
                  per the wave structure in 05-parallelization-analysis.md §1.
                  See README.md §1 for the worktree naming convention.
```
