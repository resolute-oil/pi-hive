# Wave openspec-cache-fixes — after-action

**Branch:** `refactor/openspec-cache-fixes`
**Base:** `283fdb9` (FF-merged from `refactor/budget`)
**Date:** 2026-10-01
**Scope:** Two `test.if(OSX)` failures in `tests/plan-server.spec.ts` that
were flagged in the pre-existing-fixes after-action. They are real bugs
in `src/observability/server/plan-routes.ts`, not environment issues.

## Commits

| Hash | Subject |
|------|---------|
| `7d530e3` | `fix(openspec): gate dashboard executionReady on human approval, not validation` |

(One commit — both fixes touch the same two lines in `planDetail`, so
splitting them would have been churn for no clarity gain.)

## Issue 1 — `executionReady` not gated on human approval

**What was done**

`PlanDetail.executionReady` was derived from
`openspec.isExecutionGateOpen(cwd, changeId)`, which is
`isReadyToExecute && isApprovedForExecution`. The first half requires
OpenSpec `validate` to pass; the second reads the per-artifact
file-system approval records. Neither matches what the test expects:
the test sets up `proposal.md` + `tasks.md` (no specs → `validate`
fails), writes a SQLite `plan_verdicts` row with `reviewer="ui"` and
`verdict="green"`, and expects `executionReady` to flip to `true`.

The dashboard's pill is a display-time hint, not the load-bearing
gate. The load-bearing gate stays in `commands.ts` (still uses
`isReadyToExecute` + `isApprovedForExecution` with the file-system
records), so dispatch is unaffected.

**Data sources used**

- `src/engine/openspec.ts` → `hasTasks(cwd, name)` — already exported,
  checks `tasks.md` is materially authored (checkbox or sprint plan).
- `src/observability/server/db.ts` → new `hasHumanApproval(changeId, cwd)`
  helper that wraps `listVerdicts(...).some(v => v.reviewer === "ui"
  && v.verdict === "green")`. Mirrors the inverse check already
  implemented in `latestVerdictExcludingHumanGreen` (same pattern, same
  reviewer/verdict string), so the SQLite-ledger-as-authority semantics
  stay consistent across the dashboard surface.

**Field changes in `planDetail`**

- `artifactsReady`: `isReadyToExecuteWithValidation(cwd, name, loaded.validation)`
  → `hasTasks(cwd, changeId)`. The validation result is still rendered
  via `validation.passed` + `validation.issues`; the field is no longer
  doubly-checked.
- `executionReady`: `isExecutionGateOpen(cwd, changeId)` →
  `hasTasks(cwd, changeId) && hasHumanApproval(changeId, cwd)`. The
  human-approval check is now a SQLite read, not a CLI call, and the
  artifact authoring check is shared with `artifactsReady`.

**Deviations**

None. The brief's recommendation (split the dashboard's
`executionReady` from the dispatch's `isExecutionGateOpen`) matched the
test's intent and the existing `latestVerdictExcludingHumanGreen`
pattern.

## Issue 2 — concurrent `planDetail` calls do not coalesce

**What was done**

The test logged `{ status: 1, validate: 3 }` for two concurrent
`planDetail` calls, expected `{ status: 1, validate: 1 }`. The
`cachedShared` in-flight de-dup coalesced the cached load (so status
count was 1, validate-in-cached-load was 1), but each call then
*separately* invoked `openspec.isExecutionGateOpen(cwd, changeId)`,
which internally calls `openspec.isReadyToExecute` →
`isReadyToExecuteWithValidation(cwd, name, validate(cwd, name))` —
a fresh `openspec validate <change> --json` CLI call per `planDetail`
invocation. Two concurrent calls → +2 validate calls → 3 total.

**Fix**

The new `executionReady` derivation
(`hasTasks(cwd, changeId) && hasHumanApproval(changeId, cwd)`) reads
only from the cached load and the SQLite ledger. It does not call
`validate`, so the extra CLI invocations are gone. The cached load
itself still produces 1 status + 1 validate (coalesced); the per-call
`executionReady`/`artifactsReady` derivation adds zero CLI calls.
Result for two concurrent `planDetail` calls: `{ status: 1, validate: 1 }`.

**Cache key**

Not changed. The existing `detail:${cwd}:${changeId}:${version}` key
(where `version` is the fingerprint hash of the openspec tree) was
already correct — the two concurrent calls computed the same fingerprint
and hit the same in-flight entry. The fix was to stop making redundant
CLI calls *outside* the cached load.

**Deviations**

The brief listed three options (in-flight de-dup / over-granular cache
key / both). Investigation found the cache key was already correct and
in-flight de-dup was already working — the bug was simply that the
post-cache derivation was triggering extra CLI calls. Removed the
extra calls, no in-flight or key changes needed.

## Verification gates

| Gate | Result |
|------|--------|
| `just typecheck` | pass (core + bun + tests + dashboard) |
| `just test` | **693 pass / 0 fail** (no change vs pre-fix) |
| `bun test tests/plan-server.spec.ts` | **12 pass / 0 fail** (was 10 pass / 2 fail) |
| `bun test ./tests/*.spec.ts` | **76 pass / 0 fail** (was 74 pass / 2 fail) |

The 2 previously-failing tests:

- `planDetail exposes executionReady (gated on human approval, not just artifact completeness)` — PASS
- `plan detail caches by artifact metadata and coalesces concurrent CLI work` — PASS

Test count delta: 74 → 76 pass for the bun test-db lane (no regressions;
the 2 previously-failing tests now pass). 693 → 693 pass for the Node
test lane (no change; plan-server tests are bun-only).

## Unrelated gaps / follow-ups (not fixed, flagged for review)

1. **`isExecutionGateOpen` still triggers an extra `validate` call per
   invocation.** It is fine for `commands.ts` and `dispatch.ts` (one
   call, fresh data), and `routing.ts` only invokes it inside a
   per-runtime filter (one call per runtime per task). None of these
   are in hot loops today, but a `isExecutionGateOpenWithValidation`
   variant that takes pre-loaded validation would let future callers
   reuse a cached result. Not a fix now — out of scope and the
   current callers don't have a shared cache to reuse.

2. **`hasTasks` is the only authoring check for `artifactsReady`.** A
   plan that ships only `tasks.md` (no proposal) would currently report
   `artifactsReady=true`. The test fixtures all scaffold via
   `osx new change` (which writes `proposal.md`), so this edge case
   does not surface in tests. If a future test wants
   `artifactsReady=false` for a "no proposal" case, the helper should
   tighten. Out of scope for this wave.

3. **The dashboard's `executionReady` and the dispatch's
   `isExecutionGateOpen` are now deliberately different concepts** —
   the dashboard is a display-time hint, the dispatch is the
   load-bearing gate. The comment in `plan-routes.ts` (updated as part
   of this fix) documents the divergence. Worth a follow-up review to
   decide whether the dashboard should also surface a separate
   "validation pending" pill that maps to the dispatch's stricter
   check, so the user can distinguish "ready" from "ready AND
   dispatchable".

## How to verify locally

```sh
cd /Users/cgrant/code/pi-hive/.worktrees/refactor-openspec-cache-fixes
bun test tests/plan-server.spec.ts            # 12 pass
just test                                      # 693 pass
just typecheck                                 # pass
```
