# Budget Refactor Completeness Review — INDEX

**Date:** 2025-09-29
**Baseline:** `refactor/budget-pi-native` @ `ca9930a` (PR #57)
**Reviewers:** 3 parallel sub-agents via `SubagentWorkflow` (completeness, code quality, compact-strategy forensic) + direct file reads
**Wall-clock:** ~6 minutes for the parallel audit
**HTML version:** [`html/index.html`](html/index.html)
**Raw agent outputs:** `tmp/audit-{completeness,quality,compact}.json` (in APP_ROOT tmp/, preserved for transparency)

---

## TL;DR

PR #57 shipped 13 features and ~2,100 LOC of rewritten code. The F10 reviewer rounds (kieran-typescript, architecture-strategist, code-simplicity) signed off on `src/engine/budget/` **in isolation**. This review asked: did the features actually land and get wired into production entry points?

| Tier | Count | Detail |
|---|---|---|
| Complete + wired | 6 | F1, F3, F4, F7, F8, F12 |
| Complete + Wave 5A slim | 1 | F9 (with minor LOC overshoot: 699 vs 600 target) |
| Function-complete, unwired | 1 | **F5** (8 operator commands + 3 cooperative tools + `summarize_progress`) |
| Implemented but test-only | 1 | **F2** (`delegateAgent` is the test-only F2 spine; production uses inline `dispatch.ts` path) |
| Partial wiring | 1 | **F6** (YAML wired, frontmatter `validateBudgetsFrontmatter` not connected — real silent-no-op bug) |
| Explicitly deferred | 1 | F13 (dashboard UI) |
| Intentionally deferred (C5) | 1 | **Structured strategies** — `compact` mode unreachable to users at runtime |

**The big finding:** F5 is function-complete and unit-tested but never invoked by `dispatchAgent`, never exposed in `buildHiveTools`, never wired to any operator CLI. ~1,300 LOC + ~3,200 LOC of tests for code with zero production callers.

**The user's specific question:** The `compact` budget strategy was **intentionally deferred to v3** per plan §6.2 #12, but the deferral was never communicated to **workers**. The `summarize_progress` tool still advertises `compact: true` as a working feature; in practice it always returns `compact_failed` with two lies in the unreachable success path (`details.strategy: "compact"` at line 297, `"(compact honored)"` text at line 286). Operator-facing docs are honest; worker-facing surfaces are not.

**Code quality:** 12 new findings beyond F10 (1 verified F10 fix, 5 medium-severity, 6 low-severity). See §5 of the HTML report.

---

## Sections

1. **Executive summary** — [`html/index.html#summary`](html/index.html#summary)
2. **Why `compact` is unreachable** — 17-step forensic evidence chain — [`html/index.html#compact`](html/index.html#compact)
3. **Per-feature completeness (F1-F13)** — [`html/index.html#features`](html/index.html#features)
4. **The F5 wiring gap** — full inventory of unwired code — [`html/index.html#wiring`](html/index.html#wiring)
5. **Code quality findings (12 new beyond F10)** — [`html/index.html#quality`](html/index.html#quality)
6. **Recommendations** — [`html/index.html#recommendations`](html/index.html#recommendations)
7. **Methodology** — [`html/index.html#methodology`](html/index.html#methodology)

---

## The compact strategy — forensic answer (preview)

The full answer is in §2 of the HTML report, with a 17-step evidence chain. The summary:

1. **Decision (§6.2 #12):** C5 (structured strategies) deferred to v3 by default. The user accepted.
2. **Type uninhabitable** (`types.ts:96`): `WorkerBudgetStrategy { readonly _placeholder: never }` — no value can satisfy it.
3. **Resolver hardcodes `undefined`** (`strategy.ts:31`): every call returns `undefined`.
4. **Convenience predicates hardcode `false`** (`strategy.ts:43, 53`).
5. **Tool has its own resolver** (`summarize-progress.ts:142`): always returns `"default"`, doesn't even consult the strategy module.
6. **Compact-mode branch always fails** (`summarize-progress.ts:228-251`): `if (strategy !== "compact")` guard fires; `appendCustomMessageEntry` is unreachable.
7. **Tool description lies** (`summarize-progress.ts:176`): claims `compact: true` injects notes under the `compact` strategy.
8. **Error message frames it wrong** (`summarize-progress.ts:235`): implies a `compact` strategy exists.
9. **Schema rejects any `strategies:` config** (`schema.ts:313`): `Type.Optional(Type.Never())`.
10. **Legacy escape hatch deleted** (`types.ts:163`): `WorkerGovernance.budgetStrategy` removed by F9.
11. **Migration guide is honest to operators** (`docs/budgets.md:83`): "If a project still relies on `compact` behavior, leave it pinned to the last v1 release until C5 lands."
12. **Operator command `compactWorkerSession` works** independently (`worker-tools.ts:608`): the operator path is functional, but it's not what workers hit via `summarize_progress({compact: true})`.

**Conclusion:** `compact` was intentionally deferred. The dead branches remain because C5 is conditional on user demand for richer strategies in v2. The fix is documentation-only (Tier 1, ~30 min total). Do not remove the dead code yet — it's stable until v3.

---

## Recommendations (preview, prioritized)

**Tier 1 — User-facing correctness:**
- Document the `compact` deferral in the tool description (trivial)
- Fix the error message at `summarize-progress.ts:235` (trivial)
- Drop the dead `(compact honored)` and `details.strategy: "compact"` lies at lines 286, 297 (trivial)
- Wire `validateBudgetsFrontmatter` into `enrichFromFrontmatter` (5 min)
- Add a test pinning non-zero `reasoningTokens` (5 min)

**Tier 2 — Documentation hygiene:**
- Replace 7 dangling `tmp/2025-09-29-fresh-true-rebuild-runtime.md` references
- Delete the `streamedSnapshot` comment at `dispatch.ts:289-311`
- Update `docs/budgets.md` to describe `dispatchAgent` (not `delegateAgent`) as the entry point
- Delete dead branches in `tools.ts:158-160` and `distiller.ts:140-141,153`

**Tier 3 — Code quality fixes from §5:**
- Chain `.catch` on `events.ts:384` abort (Q1)
- Widen cooperative-tool error envelopes (Q2)
- Extract `translateBudgetExhausted` helper (Q3)
- Extract `getBudgetsConfig` helper (Q5)
- Log swallowed `appendCustomMessageEntry` errors (Q6)
- Honor `ctx.signal.aborted` in operator commands (Q7)
- Bind errors in `dispatch.ts:264` and other silent catches (Q8)
- Clean up `_signal` parameters on ledger methods (Q9/Q10)
- Document or guard cooperative SDK state checks (Q11)

**Tier 4 — F5 wiring decision (requires user input):**
- **Recommended:** Defer + Document (commit the uncommitted F5 marker; update docs). Zero code removal. The implementation is correct and reviewed; wiring can land in a follow-up PR alongside F13.

**Tier 5 — Pure dead code removal (after user confirmation):**
- ~150 lines of clearly-not-features: `index.ts` barrel, `BudgetExhaustedError` class, `EffectiveWorkerGovernance`, `TeamUsageTotals`, `NewShapeSettings.workerBudgets`/`teamBudgets`.

---

## Related documents

- **Refactor plan:** `docs/reviews/28-09-2026-budget-review/04-refactor-plan.md`
- **F10 review outputs:** `docs/reviews/28-09-2026-budget-review/review-runs/round-{1,2,3}-*.md`
- **Previous audit prep:** `tmp/2025-09-29-refactor-completeness-review.md`
- **Session handoff:** `HANDOFF.md` (this session's entry point)
- **Migration guide:** `docs/migrations/budget-config-v2.md`
- **System overview:** `docs/budgets.md`

---

## Raw sub-agent outputs (for transparency)

The 3 parallel sub-agents returned structured JSON:

| Agent | Output file | Size | What it covered |
|---|---|---|---|
| Completeness | `tmp/audit-completeness.json` | 27KB | F1-F12 status, wiring evidence, top findings |
| Code quality | `tmp/audit-quality.json` | 28KB | 12 findings beyond F10 |
| Compact strategy | `tmp/audit-compact.json` | 24KB | 17-step forensic evidence chain, 7 dead code paths, 5 recommendations |

---

*End of INDEX. The full report is in `html/index.html`.*