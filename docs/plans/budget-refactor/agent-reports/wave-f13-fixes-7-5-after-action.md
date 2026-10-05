# Wave 7.5 F13 fixup — after-action

**Branch:** `refactor/budget-f13-fixes-7-5`
**Fix commit:** `c20e65a` — `fix(dashboard): align scoped-agents row lookup with Wave 7 worker-keyed reducer`
**Base:** `06e6954` (one commit ahead of `refactor/budget-f13-fixes @ 06e6954`)
**Date:** 2026-09-30

## Scope

The F1-F13 audit caught a real bug the plan-side audit missed: the Wave 7
reducer keying change in `ui/web/src/store/status.ts:30-33` made the map
keyed by the worker's session id (`payload.session_id`), but the row
builder at `ui/web/src/store/scoped-agents.ts:104` still looked up the
flag by the parent's session id (`sess.session_id`). Every row's
`interventionAvailable` was `undefined`, so the
`OperatorCommands` compact-strategy gate never engaged.

This was a focused, bounded fix — not a full audit pass.

## What I changed

### `ui/web/src/store/status.ts`

Added a parent-side alias write after the worker key. When
`payload.session_id` differs from `e.session_id`, also write the entry
under the parent key so the row lookup at `scoped-agents.ts:104` works.

```ts
out.set(workerSessionId, flag);
// Wave 7.5 F13 fixup: also write the entry under the parent's session id
// (when it differs from the worker key). The row builder at
// `scoped-agents.ts` looks up the flag by the parent's session id
// because the row's `session_id` field is the parent (the topology
// describes the parent's team, not the worker's own session). ...
if (workerSessionId !== e.session_id) out.set(e.session_id, flag);
```

Cost: one extra `Map.set` per `budget_warning` event. The worker key
keeps per-worker distinction intact (preserving the test in
`critical.test.ts:163`); the parent key is the alias the current UI
consumer reads.

### `ui/web/src/store/critical.test.ts`

Updated the two-worker test (line 163) to reflect the new design. The
test still asserts per-worker keys stay distinct (`worker_a` / `worker_b`
are not collapsed), and now also asserts the parent key is written (so
the row-lookup consumer can find it). The test now expects `out.size`
to be 3 (two worker keys + the parent alias).

### `ui/web/src/store/scoped-agents.test.ts` (new)

Three tests that exercise the FULL path the audit cared about —
**events → reducer → store → `computeScopedAgents` → row's
`interventionAvailable` field**. A reducer-only test would not have
caught the original bug (the reducer was correct in isolation; the
consumer was the problem).

- `row's interventionAvailable is set to false when a worker emits interventionAvailable=false (compact strategy)` — proves the compact-strategy gate engages end-to-end.
- `row's interventionAvailable is set to true when a worker emits interventionAvailable=true (default strategy)` — proves the default-strategy gate stays open.
- `row's interventionAvailable is undefined when no budget_warning has been emitted yet` — proves the "default enabled" fallback still works.

## Option choice

I picked **Option A** (reducer keeps a parent-side alias) from the
audit's three options. Reasons:

- **Smallest diff.** 6-line change in the reducer + a test update + a
  new test file. Option B (plumb per-worker sessionId through
  `computeScopedAgents` / `buildAgentRow`) would have required
  modifying the row builder, the topology walk, and the runtime-agent
  fallback loop. Option C (revert the reducer keying) would have
  regressed the per-worker distinction proven by
  `critical.test.ts:163`.
- **Preserves the per-worker distinction.** The worker key is still
  the primary key, written first. The parent key is a side alias. Any
  future consumer that wants the per-worker entry (a Worker-detail
  page, a per-worker notification, etc.) can read it directly. The
  audit's note that "Option A would cost N+1 entries" is wrong —
  each event writes exactly 2 entries (worker + parent), not N+1.
- **Doesn't break the existing test.** The test in
  `critical.test.ts:163` was the load-bearing assertion that the
  reducer keying is correct. The update I made preserves the
  per-worker assertion (both workers still get their own map entry)
  and adds a new assertion for the parent alias. No regression.
- **No new regression vector.** A `Map.set` is idempotent; writing
  the same value under the parent key in addition to the worker key
  is the minimal possible change.

**Trade-off acknowledged:** in the multi-worker case, the parent key
holds the most-recent worker's flag (latest event wins, same rule as
the worker keys). A parent's row in the UI will get the most recent
worker's flag, not an aggregate. This is documented in the new test
file and the updated comment in `status.ts`. The audit noted this as
a future improvement (plumb per-worker sessionId through
`buildAgentRow`); the parent alias is enough to make the gate
engage for now.

## Verification

### Tests pass with the fix

```
$ cd ui/web && npm run test:unit
 Test Files  11 passed (11)
      Tests  63 passed (63)
```

```
$ just test
ℹ tests 693
ℹ pass 693
ℹ fail 0
```

```
$ just typecheck
./node_modules/.bin/tsc -p tsconfig.core.json
./node_modules/.bin/tsc -p tsconfig.bun.json
./node_modules/.bin/tsc -p tsconfig.tests.json
./node_modules/.bin/tsc -p tsconfig.tests-bun.json
cd ui/web && npm run typecheck
✓ built in 1.34s
```

```
$ just dashboard-build
dist/index.html                          0.40 kB │ gzip:   0.27 kB
dist/assets/index-B3qGv0H0.css          70.43 kB │ gzip:  12.93 kB
dist/assets/TopologyGraph-CcYyXRR3.js   17.07 kB │ gzip:   6.57 kB
dist/assets/index-CfiwWjvD.js          621.70 kB │ gzip: 191.89 kB
✓ built in 1.34s
stamped dashboard build
```

### The new test would have caught the prior bug

I temporarily reverted the `status.ts` change (kept the new test file
and the updated `critical.test.ts` assertion), ran the test suite, and
observed 3 failures — exactly the regressions we expected:

```
FAIL  src/store/critical.test.ts:194:126
  expect(out.has("parent_sess"), "parent session_id is also written as
         a side alias...").toBe(true)
  Expected: true
  Received: false

FAIL  src/store/scoped-agents.test.ts:88:112
  row "Root" should pick up the worker's compact-strategy flag
  expected undefined to be false

FAIL  src/store/scoped-agents.test.ts:101:112
  row "Root" should pick up the worker's default-strategy flag
  expected undefined to be true

Tests  3 failed | 60 passed (63)
```

The third new test (no events) still passed because it doesn't depend
on the reducer. Restoring the fix makes all 63 tests pass.

## Files touched

| File | Lines | Purpose |
| --- | --- | --- |
| `ui/web/src/store/status.ts` | +11 | Parent-side alias write in the reducer |
| `ui/web/src/store/critical.test.ts` | +20 / -9 | Update the two-worker test to reflect the new design |
| `ui/web/src/store/scoped-agents.test.ts` | +113 (new) | Three row-lookup regression tests |
| `ui/web/dist/**` | (build artifacts) | `just dashboard-build` output |

Total source diff: +144 / -9.

## Test deltas

- `just test` (Node): 693 → 693 (unchanged)
- `ui/web` vitest: 60 → 63 (+3, all new)
- New file: `ui/web/src/store/scoped-agents.test.ts` (3 tests)

## Out of scope (not done)

- **Plumbing a per-worker `sessionId` through `buildAgentRow` /
  `computeScopedAgents`.** This would let each row read its own
  worker key, not the parent alias. It's the right design long-term
  but is a bigger refactor that the audit flagged as a future
  improvement. The parent alias is enough to make the gate engage
  for the common single-worker case and works correctly (with the
  "most recent worker" semantic) for the multi-worker case.
- **Pushing to `origin`.** Local only, per the brief's hard
  constraints.
- **Opening a PR.** Same reason.
- **Code review.** The orchestrator's `code-review` skill is invoked
  at the wave level, not for individual fixup commits; not done here.
