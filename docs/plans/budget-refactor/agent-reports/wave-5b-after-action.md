# Wave 5B F10 — after-action report

**Date:** 2026-09-30
**Branch:** `refactor/budget-f10-reviews` (based off `refactor/budget @ 6c51206`)
**Worktree:** `/Users/cgrant/code/pi-hive/.worktrees/refactor-budget-f10-reviews`

## Summary

Two of three Wave 5B reviewer rounds completed in a single agent
session. T10.1 (`kieran-typescript-reviewer`) was deferred per user
instruction (2026-09-30: "T10.1 kieran-typescript-reviewer was
already done by a separate prior session. Skipping it.").

- **Tests:** 674/674 pass (baseline 674; **0 test count delta**).
- **Typecheck:** clean across core, bun, tests, tests-bun, and
  dashboard configs.
- **Reviewers run:** 2 (architecture-strategist, code-simplicity-reviewer).
- **Should-fix items applied:** 7 (A2, A3, A5, A11, S1, S2, S3).
- **Informational items:** 13 (documented in the two review reports;
  deferred with rationale).
- **LOCAL-ONLY:** no push, no PR (per the brief + AGENTS.md
  "Repository boundaries").

## Commits + SHAs

| # | SHA | Subject |
|---|---|---|
| 1 | `44a93bc` | `chore(refactor): apply architecture-strategist fix (A2, A3, A5, A11)` |
| 2 | `55e5838` | `chore(refactor): apply code-simplicity-reviewer fix (S1, S2, S3)` |
| 3 | `c064bcd` | `docs(review): save F10 code-simplicity-reviewer report` |

(Commits 1 and 2 also include the audit-trail files staged in the
following commit; commit 3 was the second reviewer's report; the
architecture-strategist report was staged alongside the S-fix commit.
The audit trail is intact for both reviewers.)

## Mapping fixes → review findings

### Round 1 — architecture-strategist

| # | File | Lines | Change | Status |
|---|---|---|---|---|
| A2 | `src/engine/budget/worker-tools.ts` | 144-155 | Drop misleading "the export is unnecessary" comment (the binding was `const`, not `export const`) | applied |
| A3 | `src/engine/budget/worker-tools.ts` | 141-155, 220 | Collapse `defaultInternals` + `defaultDelegateAgentInternals` duplicate binding to a single `defaultInternals` | applied |
| A5 | `src/engine/budget/worker-tools.ts` | 385-394 | Drop unused `WorkerHandleShape` export; the three production wrappers now reference the file-local `WorkerHandle` interface (no consumer outside the file) | applied |
| A11 | `src/engine/budget/events.ts` + 3 test files | various | Rename `_resetBudgetContextsForTests` → `__resetBudgetContextsForTests` (consistency with `__resetCooperativeToolRegistryForTests`); updates 39 call sites across 4 files | applied |

### Round 2 — code-simplicity-reviewer

| # | File | Lines | Change | Status |
|---|---|---|---|---|
| S1 | `src/engine/dispatch-subscribe.ts` | 64-77 | Drop dead `governance` parameter from `wireDispatchSubscription` (never read in the function body) | applied |
| S1 | `src/engine/dispatch.ts` | 705 | Drop the `governance` argument from the call site | applied |
| S2 | `src/engine/budget/ledger.ts` | 47-53 | Export `isLedgerEntry` (canonical owner of the CustomEntry shape) | applied |
| S2 | `src/engine/budget/policy.ts` | 13, 159-164 | Import `isLedgerEntry` from ledger.ts; drop the local duplicate | applied |
| S3 | `src/engine/budget/ledger.ts` | 222-256 | Drop the dead options-object overload of `BudgetLedger.snapshot` (11 call sites use the 5-arg positional form; the options form has zero callers) | applied |

## Informational findings (deferred with rationale)

### architecture-strategist

- **A1** — `checkDispatchBudgets` + `GovernanceBlock` in
  `remaining.ts:26, 106-139` are exported but have no production
  caller. Removing requires deleting 5 test cases in
  `tests/budget-remaining.test.ts:39-135` that pin the legacy
  behavior. The "Test count should not decrease" gate forbids this
  in F10; defer to a future wave that explicitly authorizes a
  test-count delta, or to a follow-up that rewrites the cases
  against `checkBudgetPolicy` from `policy.ts`.
- **A4** — Two-name `registerWorkerHandle*` API
  (`__registerHandle` / `registerWorkerHandleForProduction` pointing
  at the same Map) is load-bearing — the test pin in
  `tests/wave-3-5-wiring.test.ts:367-389` asserts they share the Map.
  Intentional design; leave for follow-up.
- **A6** — Comment block narrating "we cannot re-export" is
  cosmetic; the comment is accurate.
- **A7** — Untyped `event` parameter in `buildBudgetToolCallHandler`
  is intentionally decoupled from SDK churn (the structural literal
  suppresses cascading type changes when the SDK adds fields).
- **A8** — Module-level `budgetContextsByAgent` registry is
  documented hidden coupling; the test seam
  `__resetBudgetContextsForTests` makes hermetic tests possible.
- **A9** — Two parallel ledger-write paths
  (`writeKindLedgerEntry` in worker-tools.ts vs
  `BudgetLedger.snapshot` in ledger.ts) reflect a real
  architectural split (region 3C writes through a passed-in
  SessionManager, not the ledger's; consolidating would change the
  contract).
- **A10** — Dual `createSession` seam in `DelegateAgentOptions` and
  `DelegateAgentInternals` is the production-vs-test split the brief
  explicitly requires.
- **A12** — `BudgetLedger.snapshot` dual overload — see S3 (resolved
  in the simplicity round).

### code-simplicity-reviewer

- **S4** — Cooperative tool stubs
  `request_compaction` / `request_end_session` / `request_snapshot`
  (worker-tools.ts:579-581) are dead in production but pinned by
  the contract test at
  `tests/budget-contracts.test.ts:173-178, 235-237`. Renaming would
  propagate to the cooperative-tool registry and the
  cooperative-eol test. Net effect: -1 test (the stubs test) for
  zero useful replacement. The "Test count should not decrease"
  gate forbids this. The git log shows an earlier fixup "drop
  arity-0 stub export (C D5)" for `summarize-progress`; a future
  cleanup wave can do the same for the cooperative stubs.
- **S5** — Two parallel ledger-write paths — same as A9.
- **S6** — `effectiveInternals` bridge in `delegateAgent` is the
  production-vs-test split (3 LOC of spread).
- **S7** — `writeKindLedgerEntry` 5-arg vs cooperative factory 3-arg
  options object — different call-site shapes serve their consumers.
- **S8** — 11 operator commands + 3 cooperative tools + 3
  respawn/snapshot/restore — surface dictated by the refactor plan.

## Test count delta

- Baseline: 674 tests
- After round 1: 674 tests (rename is a mechanical 39-occurrence
  global substitution; no tests added or removed)
- After round 2: 674 tests (parameter / overload / duplicate removal
  did not add or remove tests; the contract test
  `tests/budget-contracts.test.ts:484` continues to pin
  `proto.snapshot.length === 4` via the explicit
  `kind: BudgetLedgerKind | undefined = undefined` default — the
  simpler `kind?` form would compile to `.length = 5` in this
  project's tsx setup and break the contract test)
- Final: 674 tests, 0 fail

## Brief checkboxes

The `docs/plans/budget-refactor/wave-5b-reviews.md` Tasks table is
updated:

- T10.1: `[ ]` (skipped per user instruction; prior session)
- T10.2: `[x]` (commit 44a93bc; A2, A3, A5, A11 applied)
- T10.3: `[x]` (commit 55e5838; S1, S2, S3 applied)
- T10.4: `[x]` (commit c064bcd adds code-simplicity report;
  architecture-strategist report committed in 55e5838; T10.1 audit
  trail deferred per user)

## Risks for downstream waves

- **A1 / S4 are the two YAGNI items that would reduce LOC and test
  count.** Both are blocked by the F10 "Test count should not
  decrease" gate. Future waves that explicitly authorize a
  test-count delta can land them.
- **A12 (now S3) is the only item that landed in this round with
  a contract-test interaction.** The contract test at
  `budget-contracts.test.ts:484` pins `.length === 4`. The fix
  preserves this with the explicit `= undefined` default. A future
  contributor who switches back to `kind?` (TS optional) will hit
  the contract test with a "5 !== 4" message — a regression that
  surfaces immediately.
- **A11 (rename) is a 39-occurrence global substitution.** All
  call sites in `src/` and `tests/` were updated; the sed pattern
  is precise (no false matches). No follow-up risk.

## Verdict

Wave 5B F10 reviewer sign-off complete. Both review rounds
produced reports saved to
`docs/reviews/28-09-2026-budget-review/review-runs/`. All
should-fix items applied. 13 informational items documented with
deferral rationale. The implementation diff is ready for Wave 5C
(local-only landing).
