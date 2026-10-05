# Wave pre-existing-fixes — after-action

**Branch:** `refactor/budget-pre-existing-fixes`
**Base:** `061bca3` (one commit ahead of `refactor/budget-f13-fixes-7-5`)
**Date:** 2026-10-01
**Scope:** Two pre-existing, non-blocking issues flagged during the F13
audits. Both were known to be pre-existing — neither was introduced by
F13 or any wave.

## Commits

| Hash | Subject |
|------|---------|
| `a5b4ab4` | `fix(dashboard): handle budget_ledger case in status switch (ESLint exhaustive)` |
| `7cba2d8` | `test(plan): resolve bun: URL scheme issue in plan-server and aaa-runtime-thinking specs` |

## Issue 1 — ESLint switch error in `ui/web/src/store/status.ts`

**What was done**

The exhaustive-switch lint surfaced `Cases not matched: "budget_ledger"`
at `status.ts:101`. The reducer has an explicit no-op list for events
that intentionally do not affect agent status (with a comment citing
the `@typescript-eslint/switch-exhaustiveness-check` rule); the new
`budget_ledger` event type (added in WT-1's narrowing of `HiveEvent.type`
to the union, per the existing comment) was missing from that list.

Added `case "budget_ledger":` to the no-op list at `status.ts:173`.
One-line change, falls through to the same no-op behavior the comment
documents.

**Deviations**

None. The simplest path (option (a) in the brief — explicit no-op case)
matched the comment's stated intent and the existing pattern of every
other event in the switch.

**Blockers**

None.

## Issue 2 — `ERR_UNSUPPORTED_ESM_URL_SCHEME: bun:` in plan-server + aaa-runtime-thinking tests

**What was done**

Reproduced the error: `node --import tsx --import ./tests/register-ts-loader.mjs --test tests/plan-server.spec.ts` (or any `*.spec.ts`) throws
`ERR_UNSUPPORTED_ESM_URL_SCHEME: bun:` because the default Node ESM
loader rejects `bun:sqlite` / `bun:test` URLs. The `*.spec.ts` files
import from those URLs because they're meant to run under `bun test`,
not Node — the project already separates the two via `just test`
(`.test.ts` glob, Node) and `just test-db` (`.spec.ts` glob, Bun), and
the justfile's `test` recipe is documented to use the `.test.ts` glob
so the Node runner never picks up spec files.

The error only triggers when a `.spec.ts` file is loaded under Node
(e.g. by typing the wrong command, an AI agent making a mistake, or a
CI script that bypasses `just test`). Confirmed it reproduces on the
parent commit `061bca3` (no F13 involvement).

Fix: extended `tests/ts-extension-loader.mjs` to detect any `bun:`
specifier in the `resolve` hook and throw a clear, actionable error
naming the correct runner. The loader is only registered for Node
runs (via `just test`, `just test-node-compat`, and the `c8` coverage
command), so the Bun path is unaffected. `*.test.ts` files do not
import from `bun:*`, so `just test` still passes 693/693.

The error message now points the operator at `just test-db` or
`bun test <file>` instead of leaving them with a bare URL-scheme
stack frame.

**Deviations**

Brief option (b) — "add a shim or refactor the import to be
bun-agnostic" — was rejected as out of scope. A `bun:sqlite` polyfill
under Node would require reimplementing the SQLite layer, which is
the entire reason `db.ts` is a Bun-only module. The loader-level guard
is the minimum change that gives a useful error.

**Blockers**

None.

## Unrelated pre-existing failures (NOT my responsibility)

`bun test tests/plan-server.spec.ts` and `just test-db` show 2
failures that exist on the parent commit `061bca3` and are unrelated
to either issue:

- `planDetail exposes executionReady (gated on human approval, not just artifact completeness)` (line 79, `test.if(OSX)`)
- `plan detail caches by artifact metadata and coalesces concurrent CLI work` (line 123, `test.if(OSX)`)

Both are `test.if(OSX)` — they only run when the OpenSpec CLI binary
is installed and the wrapper can intercept the calls. They depend on
the OpenSpec binary behaving a specific way during in-test subprocess
recording. Confirmed identical failures on the parent commit. They
are out of scope for this wave (the brief listed them only as context
for the `bun:` URL issue, not as issues to fix). Surfacing here for
the next agent.

## Verification gates

| Gate | Result |
|------|--------|
| `just typecheck` | pass |
| `just test` | **693 pass / 0 fail** (no change vs pre-fix) |
| `just dashboard-build` | pass |
| `npx eslint ui/web/src/store/status.ts` | clean (0 errors) |
| `bun test tests/plan-server.spec.ts tests/aaa-runtime-thinking.spec.ts` | 12 pass / 2 pre-existing fail (same as parent commit) |
| Node-runner repro (`node --import tsx --import ./tests/register-ts-loader.mjs --test tests/plan-server.spec.ts`) | clear error: "Refusing to resolve 'bun:test' from ... under Node. Bun test files (*.spec.ts) must run under `bun test`, not Node. Use `just test-db` or `bun test <file>`." |

## Test count delta

- Node (`just test`): 693 → 693 (no change)
- Vitest (`ui/web`): 63 → 63 (no change)
- Bun (`just test-db`): 74 pass → 74 pass (no change; 2 pre-existing failures
  unchanged from parent commit)

No new tests were added; the fixes are pure refactor / DX. The brief's
test count target (693 Node + 63 vitest) is met.

## Unresolved follow-ups

- The 2 pre-existing `test.if(OSX)` failures in `plan-server.spec.ts`
  (see above) are real bugs in the cache-coalescing and
  executionReady-gating logic. They depend on a specific OpenSpec
  binary behavior that is not stable in this environment. Recommend a
  dedicated fixup wave — they are not blockers for the merge of
  `refactor/budget` since the parent commit shows the same failures.
