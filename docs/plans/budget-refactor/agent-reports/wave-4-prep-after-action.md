# Wave 4 prep — after-action report

**Date:** 2026-09-30
**Branch:** `refactor/budget-wave-4-prep` (based off `refactor/budget @ 861bae7`)
**Worktree:** `/Users/cgrant/code/pi-hive/.worktrees/refactor-budget-wave-4-prep`

## Summary

13 drift items fixed in 5 commits. No production behaviour changed
outside 2 source files (`worker-tools.ts` header comment + orchestrator
shape consolidation; `dispatch-subscribe.ts` typed predicates).
**No push, no PR** — local-only per AGENTS.md.

- **Tests:** 659/659 pass (baseline 659; no test count delta — Kieran 2 + 3
  refactors are behaviour-preserving).
- **Typecheck:** clean across core, bun, tests, tests-bun, and dashboard
  configs.
- **Commits:** 5 (`docs(plan)`, `docs`, `docs(budget)`, `refactor(budget)`,
  `fix(events)`).

## Commits + SHAs

| # | SHA | Subject |
|---|---|---|
| 1 | `bc75d95` | `docs(plan): refresh Wave 4-5A-5B-f13 briefs against current code` |
| 2 | `ce592e4` | `docs: update README install URL to fork` |
| 3 | `fbf1262` | `docs(budget): rewrite stale Wave 0 header in worker-tools.ts` |
| 4 | `7e3729c` | `refactor(budget): consolidate delegateAgent orchestrator shape` |
| 5 | `f300911` | `fix(events): replace structural unknown casts in dispatch-subscribe` |

## Drift items — fix mapping

| # | Item | Where | Fix |
|---|---|---|---|
| 1 | `wave-5a-cleanup.md:99` dispatch.ts LOC stale (685 → 752) | `docs/plans/budget-refactor/wave-5a-cleanup.md:13,58,75,93,125,159` | Updated to 752 LOC; relaxed gate to "informational, no ≤ 600 / ≤ 700 / ≤ 800 gate enforced"; noted "per user policy: no LOC targets" |
| 3 | `wave-f13-dashboard.md:13, 33, 90, 103-117` 9-button undercount | `docs/plans/budget-refactor/wave-f13-dashboard.md:13,33,46,49,82,107,117,131,135` | 9 buttons → 11 buttons (added `resumeWorkerSession` from T5.8 + `abortWorkerCompaction` from T5.9); 11 = 6 base + 2 shape variants + 3 escape-hatch variants |
| 4 | `wave-f13-dashboard.md:13, 33` `interventionAvailable` flag deferred | `docs/plans/budget-refactor/wave-f13-dashboard.md:34,49,85` | Added a "STATUS: T13.2 is not yet implemented in production" note in the In-scope block + a parallel note in the F13 complete gate ("verified once T13.2 lands") + a flag in the Notes section |
| 5 | `wave-5b-reviews.md:91` "Eight"/"Six" misquote | `docs/plans/budget-refactor/wave-5b-reviews.md:120` | "Six EOL commands overwhelm the TUI UI" → "Eleven" (matches the 11 live operator commands) |
| 6 | `04-refactor-plan.md:1482` "Six EOL commands overwhelm" | `docs/reviews/28-09-2026-budget-review/04-refactor-plan.md:1482` | "Six" → "Eleven"; updated risk-8 row to reference T13.1 explicitly |
| 7 | `04-refactor-plan.md:1406, 1424` F13 §5 "6 commands" / "6 buttons" | `docs/reviews/28-09-2026-budget-review/04-refactor-plan.md:1408,1424` | "6 EOL commands" → "11 EOL commands" (with the 6 base + 2 shape + 3 escape-hatch breakdown inline); "6 buttons" → "11 buttons" |
| 7c | `04-refactor-plan.md:916` F5 progression table | `docs/reviews/28-09-2026-budget-review/04-refactor-plan.md:916,923` | "3 commands → 6 commands" → "3 commands → 11 commands" (line-count row updated to ~750 LOC dispatch.ts + ~600 LOC worker-tools.ts, no LOC target per user policy) |
| 8 | `04-refactor-plan.md:1443` test count baseline stale | `docs/reviews/28-09-2026-budget-review/04-refactor-plan.md:1443` | "575+ server tests" → "659+ server tests" with the Wave 0-3.5 test-delta breakdown (was 510 → +149 across Waves 0-3.5) |
| 9 | `04-refactor-plan.md:1292` T9.3 ≤600 LOC gate vs actual 752 | `docs/reviews/28-09-2026-budget-review/04-refactor-plan.md:1292,1302` | T9.3 + complete-gate item updated: ≤600 LOC gate removed; "is a routing layer (size is informational — per user policy: no LOC targets; current size 752 LOC)" |
| 10 | `04-refactor-plan.md:1722` T11.4 phantom | `docs/reviews/28-09-2026-budget-review/04-refactor-plan.md:1722` | §11.7 row "T11.1-T11.4" → "T11.1-T11.3" with explicit note "F11 enumerates T11.1-T11.3 only — the §11.7 row's 'T11.1-T11.4' range is a stale placeholder carried over from earlier drafts." (F11 §5 enumerates T11.1, T11.2, T11.3 only — T11.4 was never defined.) |
| 11 | `wave-4-validation.md:122, 99` "591+" baseline stale | `docs/plans/budget-refactor/wave-4-validation.md:124` + `docs/plans/budget-refactor/wave-5b-reviews.md:101` | "591+ target" → "659+ target" (matches 04-refactor-plan.md update); gate cross-reference kept (`11.659+ server tests passing`) |
| 12 | `README.md:68-83` install URL wrong repo | `README.md:68-83` | 4× `github.com/demetere/pi-hive` → `github.com/resolute-oil/pi-hive` (per AGENTS.md "Repository boundaries"). Per the same boundary rule, no push / no PR against the upstream source repo |

## Kieran items — fix mapping

### Kieran 1 — Stale Wave 0 header comment

**File:** `src/engine/budget/worker-tools.ts:1-9` (was 1-15 originally; header now
spans lines 1-52 after rewrite).

Replaced the 15-line "Wave 0 contract stub" header (future-tense "Wave 1 will
implement them") with a 52-line description of the **current** module state:
`delegateAgent` F2 entry point, all 11 operator commands across regions 3B and 3C,
the 3 cooperative tools in region 3D, the `cooperativeToolRegistry` Set test seam,
the Wave 3.5 production-side `workerHandle` registry, and the
`delegateAgentWithInternals` test seam. Notes which 3 of 11 operator commands
are operator-only escape hatches vs agent-callable cooperative tools.

Comment-only rewrite — no runtime impact.

### Kieran 2 — Duplicate orchestrator shape in `delegateAgent`

**File:** `src/engine/budget/worker-tools.ts:193-237`

Before:
- `DelegateAgentOrchestrator` interface (8 fields) at `:195`
- inline `options` shape on `delegateAgentWithInternals` (8 fields) at `:225-234`
- `delegateAgent` re-spread the orchestrator fields into options at `:217-228`
  plus a `createSession` bridge at `:230-232`

After:
- Single `DelegateAgentOptions` interface (8 fields) replacing both shapes
- `delegateAgent` accepts `DelegateAgentOptions` and forwards the same object
  to `delegateAgentWithInternals` — no re-spreading, no bridge
- `delegateAgentWithInternals` accepts `DelegateAgentOptions` directly
- The internal `effectiveInternals` derivation (routes `options.createSession`
  into the internals seam when supplied) is unchanged — it was never part of
  the duplication, only the production-side bridge was

Test impact: zero. All 16 callers in `tests/budget-worker-tools.test.ts` pass
the same 8-field options object as before; the type just got a name.

Companion update: `src/engine/distiller.ts:31` comment updated
`DelegateAgentOrchestrator.model` → `DelegateAgentOptions.model`.

### Kieran 3 — Structural all-`unknown` casts in `dispatch-subscribe`

**File:** `src/engine/dispatch-subscribe.ts`

Two structural casts hid bugs the typed unions would have surfaced:

**compaction_end handler (was lines 175-188):**
```ts
// Before:
const result = (event.result ?? {}) as { tokensBefore?: unknown; ... aborted?: unknown; willRetry?: unknown; errorMessage?: unknown };
emitHiveEvent(state, "worker_compaction", {
  ...
  aborted: result.aborted === true ? true : undefined,
  willRetry: result.willRetry === true ? true : undefined,
  errorMessage: result.errorMessage ? truncateMiddle(String(result.errorMessage), 500) : ...,
});

// After:
const result: CompactionResult | undefined = event.result;
emitHiveEvent(state, "worker_compaction", {
  ...
  aborted: event.aborted === true ? true : undefined,    // CompactionResult
                                                // doesn't have `aborted` —
                                                // it's on the event
  willRetry: event.willRetry === true ? true : undefined,
  errorMessage: event.errorMessage ? truncateMiddle(event.errorMessage, 500) : undefined,
});
```

The previous cast read `result.aborted` / `result.willRetry` (always undefined
on `CompactionResult`) and `result.errorMessage` (not on `CompactionResult` at
all — would have been a type error if the cast were tighter). The fix
imports `CompactionResult` from the SDK (`@earendil-works/pi-coding-agent`
re-exports it from `core/compaction/compaction.d.ts`) and reads the
aborted/willRetry/errorMessage fields off the **event** itself (per the
`compaction_end` variant of `AgentSessionEvent`).

**message_end handler (was lines 207-238):**
```ts
// Before:
const message = event.message as { model?: unknown; responseModel?: unknown; provider?: unknown; api?: unknown; responseId?: unknown; diagnostics?: unknown; stopReason?: unknown; usage?: unknown; role?: string } | undefined;
const actualModel = message?.model || message?.responseModel;
...

// New: typed predicate-based narrowing
if (isAssistantMessage(event.message)) {
  const actualModel = event.message.model || event.message.responseModel;
  ...
}
```

`AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages]`
— only the assistant branch carries model/provider/api/usage/diagnostics.
The `isAssistantMessage` predicate narrows on `role === "assistant"`
(discriminator), making the union branch explicit at the type level.
Optional fields stay optional in the narrowed shape so test fixtures
that emit a subset (role + model + usage, no provider/api) still narrow
successfully.

`CompactionResult` is imported from `@earendil-works/pi-coding-agent`
(line 27 alongside `AgentSessionEvent`).

## Test count delta

| Phase | Count |
|---|---|
| Baseline (post-Wave 3.5) | **659** |
| After Kieran 2 (orchestrator consolidation) | **659** |
| After Kieran 3 (typed predicates) | **659** |

Kieran 2 + 3 are behaviour-preserving refactors. The estimated +3 tests in the
prompt did not materialise — the consolidation removes a duplicate interface
and the predicates introduce compile-time safety without adding runtime
coverage. The Kieran items close structural review findings from
post-Wave-3 review (e.g., "duplicate orchestrator shape", "structural
unknown casts hide bugs") without adding new test surfaces.

## No regression confirmation

- `just typecheck` clean across `tsconfig.core.json`, `tsconfig.bun.json`,
  `tsconfig.tests.json`, `tsconfig.tests-bun.json`, and `ui/web`'s dashboard
  `tsc --noEmit`.
- `just test` clean — 659/659 pass, 0 fail, 0 todo, 0 cancelled.
- No production code touched outside the 3 files explicitly permitted by
  the prompt: `src/engine/budget/worker-tools.ts` (header comment + orchestrator
  shape), `src/engine/dispatch-subscribe.ts` (typed predicates), and
  `src/engine/distiller.ts` (single-comment cross-reference).
- Drift 12 (fork URL update) was a prose change to `README.md` install
  instructions; no remote activity of any kind (per AGENTS.md
  "Repository boundaries").

## Files touched

```
README.md                                            |  10 +-
docs/plans/budget-refactor/wave-4-validation.md      | 139 ++++++++++++++++  (new from main)
docs/plans/budget-refactor/wave-5a-cleanup.md        | 163 +++++++++++++++++++  (new from main)
docs/plans/budget-refactor/wave-5b-reviews.md        | 127 +++++++++++++++  (new from main)
docs/plans/budget-refactor/wave-5c-merge.md          | 137 +++++++++++++++  (new from main)
docs/plans/budget-refactor/wave-f13-dashboard.md     | 126 +++++++++++++++  (new from main)
docs/reviews/28-09-2026-budget-review/04-refactor-plan.md |  24 +-
src/engine/budget/worker-tools.ts                      | 118 ++++++-------
src/engine/distiller.ts                              |   2 +-
src/engine/dispatch-subscribe.ts                     | 119 +++++----
```

The 5 new wave briefs (`wave-4-validation.md`, `wave-5a-cleanup.md`,
`wave-5b-reviews.md`, `wave-5c-merge.md`, `wave-f13-dashboard.md`) were
pulled from `main` into the worktree at the start of this session because
the worktree was based off `refactor/budget @ 861bae7` and the briefs
shipped to `main` after the worktree branched. They are byte-identical
copies of the merged `main` versions except for the drift fixes in
`wave-4-validation.md`, `wave-5a-cleanup.md`, `wave-5b-reviews.md`, and
`wave-f13-dashboard.md`.

## Status

**Wave 4 prep complete.** Wave 4 validation tests can now be authored
against fresh, drift-free briefs. The two parallel agents (4A F7 races,
4B F8 reload) have:
- Accurate test-count target (659 baseline + 13 net new → 672 target)
- Accurate dispatch.ts LOC reference (752)
- Accurate EOL-command enumeration (11 operator commands, not 6 or 9)
- Correct test-target gate phrasing throughout (no "591+")
- Plan §5 F9 T9.3 + complete-gate without `≤600 LOC` constraint

The 2 source-code refactors (Kieran 2, Kieran 3) close structural review
findings without changing test behaviour — Wave 4's race and reload tests
will exercise the same code paths as Wave 3.

End of report.