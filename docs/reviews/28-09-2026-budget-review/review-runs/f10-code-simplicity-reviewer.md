---
title: F10 code-simplicity-reviewer review (Wave 5B)
date: 2026-09-30
type: review
reviewer: code-simplicity-reviewer
status: applied
---

# F10 code-simplicity-reviewer review

## Scope

Reviewed the implementation diff for the budget refactor
(`refactor/budget @ 6c51206` vs `main @ 9f252f2`) after the
architecture-strategist round landed, focused on:

- YAGNI violations
- Unused exports (each `^export` in `src/engine/budget/` verified
  against its call sites)
- Over-generalized helpers
- Dead code (functions with no callers)
- Premature abstractions

Source files reviewed: `src/engine/budget/*.ts` (7 files, 1,776 LOC),
`src/engine/dispatch.ts` (752 LOC), `src/engine/dispatch-subscribe.ts`
(333 LOC).

## Export Inventory

Total exports in `src/engine/budget/`:

| File | Exports | Used externally? |
|---|---|---|
| `events.ts` | `getBudgetContextForAgent`, `__resetBudgetContextsForTests` (renamed in A11), `BLOCKED_TOOL_NAMES`, `buildBudgetToolCallHandler`, `installBudgetEventHooks` | yes (handler factory used by worker-extension.ts) |
| `ledger.ts` | `MESSAGE_COUNT_THRESHOLD`, `TOKEN_COUNT_THRESHOLD`, `RecordEventOptions`, `BudgetLedger` class, `BudgetLedgerKind` (re-export), `isLedgerEntry` (now exported, see S2) | yes |
| `policy.ts` | `checkBudgetPolicy`, `workerConsumedTokens`, `workerConsumedCost`, `teamUsage`, `ratioRemaining`, `crossedThreshold` | yes |
| `remaining.ts` | `BudgetRemaining`, `GovernanceBlock`, `TokenScope`, `effectiveWorkerGovernance`, `workerConsumedTokens`, `workerConsumedCost`, `teamUsage`, `budgetRemaining`, `checkDispatchBudgets` | `effectiveWorkerGovernance` + `budgetRemaining` + `teamUsage` (legacy) used; `checkDispatchBudgets` + `GovernanceBlock` dead (A1 informational); `workerConsumed*` + `TokenScope` only used within `remaining.ts` |
| `strategy.ts` | `resolveWorkerBudgetStrategy`, `resolveWorkerBudgetPolicy` | yes |
| `worker-only-tools.ts` | `WorkerOnlyBindings`, `populateWorkerOnlyBindings`, `buildWorkerOnlyTools` | yes |
| `worker-tools.ts` | `DelegateAgentModel`, `DelegateAgentThinkingLevel`, `BudgetExhaustedError`, `DelegateAgentInternals`, `CreateSessionOptions`, `DelegateAgentResult`, `DelegateAgentOptions`, `delegateAgent`, `delegateAgentWithInternals`, `__registerHandle`, `__unregisterHandle`, `registerWorkerHandleForProduction`, `unregisterWorkerHandleForProduction`, `lookupWorkerHandleForProduction`, 11 operator commands, `WorkerContext`, 3 respawn/snapshot/restore, 3 cooperative stubs, `__cooperativeToolRegistry`, `__resetCooperativeToolRegistryForTests`, 3 `buildRequest*Tool` factories | yes |

## Findings

### S1 — Dead `governance` parameter in `wireDispatchSubscription` (applied)

**File:** `src/engine/dispatch-subscribe.ts:64-77`,
`src/engine/dispatch.ts:705`

`wireDispatchSubscription` declared a
`governance: { tokenBudget?, costBudgetUsd?, timeoutMs? }` parameter
but never read it in the function body. The parameter was passed by
the dispatcher from a local `governance` variable. Comment at
`dispatch-subscribe.ts:64-66` justified it as "for downstream
event-handling parity" but no downstream code reads it.

The parameter shape mirrors the legacy `effectiveWorkerGovernance`
merge shim that the budget pre-flight path no longer needs — the
budget warning / abort code path lives in `installBudgetEventHooks`
now, not in the dispatch subscribe handler.

**Fix:** drop the parameter and the call site. Updates
`dispatch-subscribe.ts` and `dispatch.ts:705` (one line each).

### S2 — Duplicate `isLedgerEntry` type guard (applied)

**File:** `src/engine/budget/policy.ts:163`,
`src/engine/budget/ledger.ts:49`

The same `isLedgerEntry` type guard was defined twice with identical
bodies:

```ts
function isLedgerEntry(entry: SessionEntry): entry is SessionEntry & { data: BudgetLedgerEntry["data"] } {
  return entry.type === "custom" && (entry as unknown as { customType?: string }).customType === LEDGER_CUSTOM_TYPE;
}
```

The policy.ts copy (lines 159-164) had a comment explaining
"policy.ts doesn't import from the ledger class — it only consumes
the branch shape." But the policy.ts consumer uses the same SDK
`SessionEntry` shape, so the same predicate works in both files.

**Fix:** export `isLedgerEntry` from `ledger.ts` (the canonical
owner of the `BudgetLedgerEntry` shape) and import it in
`policy.ts`. Drops 5 lines from `policy.ts`, adds 4 lines of
explanatory comment in `ledger.ts`.

### S3 — Dead options-object overload of `BudgetLedger.snapshot` (applied)

**File:** `src/engine/budget/ledger.ts:237-282`

The function was declared with two overloads:
- `(stats, policy, marker, signal, kind?)` (5-arg positional)
- `(stats, policy, opts: { marker, signal, kind? })` (options
  object)

All 11 call sites use the positional form:
- 8 operator commands in `worker-tools.ts` region 3B (lines 396,
  403, 410, 417, 424, 431, 439, 444)
- 3 cooperative tools in `worker-tools.ts` region 3D (lines 602,
  607, 614)
- 1 `agent_settled` hook in `events.ts:268`

The options-object form has zero callers. The comment at
`ledger.ts:222-232` says "the options-object overload reads more
clearly at the operator-command call sites and is preferred for
new code," but no call site uses it.

The contract test `tests/budget-contracts.test.ts:484` pins the
arity at 4 — `proto.snapshot.length === 4` — which works with the
positional form (4 required params + 1 default), but the
options-overload version had `arg4?` and `arg5 = undefined` (both
optional), so the implementation `.length` was also 4. The
contract test continued to pass either way.

**Fix:** drop the options-object overload. Keep the 5-arg
positional form. The function `.length` stays at 4 (4 required
params + `kind: BudgetLedgerKind | undefined = undefined` default).
The internal branching (`typeof arg3 === "string"`) is removed.

Note: the parameter declaration had to use `kind: BudgetLedgerKind
| undefined = undefined` (not `kind?`) because `?` parameters
compile to `.length = 5` in this project's tsx setup, while
explicit `= undefined` defaults compile to `.length = 4`. The
contract test pins `.length === 4`, so the explicit default is
required.

### S4 — Cooperative tool stubs `request_compaction` / `request_end_session` / `request_snapshot` (informational; not applied)

**File:** `src/engine/budget/worker-tools.ts:579-581`,
`tests/budget-contracts.test.ts:173-178, 235-237`

The Wave 0 contract stubs throw "not implemented" — they were the
original arity-0 surface for the cooperative tools. With Wave 3 +
Wave 3.5, the real cooperative tools are wired via
`buildRequestCompactionTool` / `buildRequestEndSessionTool` /
`buildRequestSnapshotTool` (in `worker-tools.ts` region 3D), with
deferred-binding wrappers in `worker-only-tools.ts`.

The contract test (`tests/budget-contracts.test.ts:173-178`) pins
the surface: "the 3 cooperative tool names must be exported as
functions." The cooperative factory names are different
(`buildRequest*Tool`), so the contract test cannot be updated
without renaming either the test or the stubs.

The cooperative-tool registry (`worker-tools.ts:589-598`) types
the cooperative name union using the stub names, so renaming
them would propagate to the registry and the cooperative-eol test.

**Decision: not applied.** The stubs serve a documented contract
test purpose. Renaming them is a wider refactor that touches the
cooperative-tool registry, the contract test, and the
cooperative-eol test. Net effect: -1 test (the stubs test) vs
+0 test (no useful replacement). The "Test count should not
decrease" gate forbids this. The git log shows an earlier
fixup "chore(summarize-progress): drop arity-0 stub export (C
D5)" for `summarize-progress` (a similar pattern); a future
cleanup wave can do the same for the cooperative stubs.

### S5 — Two parallel ledger-write paths (informational; not applied)

**File:** `src/engine/budget/worker-tools.ts:514-517` (region 3C)
vs `src/engine/budget/ledger.ts:228-253` (snapshot)

`writeKindLedgerEntry` (worker-tools.ts:514) and
`BudgetLedger.snapshot(...)` (ledger.ts) both produce a
`BudgetLedgerEntry` with `marker: "checkpoint"` and a `kind`
field. Region 3B's operator commands call
`ledger.snapshot(stats, policy, "checkpoint", signal, kind)`;
region 3C's respawn / snapshot / restore call
`writeKindLedgerEntry`.

The two paths differ in WHERE the entry is written: `ledger.snapshot`
writes through `this.sessionManager` (the ledger's session) and
updates the ledger's `entries` array; `writeKindLedgerEntry` writes
through a passed-in `sessionManager` and does NOT update any
in-memory ledger.

This reflects a real architectural split: region 3C operates on a
`WorkerContext` where the ledger may be a fresh restore and the
session manager is the new (branched) one, not the ledger's
original. A single helper that reads `ledger.sessionManager`
would not work for region 3C.

**Decision: not applied.** Could be consolidated by adding a
`sessionManager` parameter to `ledger.snapshot`, but that's a
wider refactor with no test count change. The two paths are
small (10-15 LOC each) and the comment on `writeKindLedgerEntry`
explains the asymmetry.

### S6 — `effectiveInternals` bridge in `delegateAgent` (informational; not applied)

**File:** `src/engine/budget/worker-tools.ts:236-238`

```ts
const effectiveInternals: DelegateAgentInternals = options.createSession
  ? { ...internals, createSession: options.createSession }
  : internals;
```

The bridge merges `options.createSession` (production path) into
the `internals.createSession` (test path) seam. Three lines of
spread.

Documented as the production-vs-test split: production callers
"pass it via the options object; tests pass it via internals
directly."

**Decision: not applied.** The dual location is required by
the brief's "Production-side seam" design. The bridge is 3 lines.

### S7 — `writeKindLedgerEntry` parameter list (informational; not applied)

**File:** `src/engine/budget/worker-tools.ts:514-517`

`writeKindLedgerEntry` takes 5 positional parameters:
`(sm, agent, policy, stats, runs, kind)`. The cooperative tool
factories in region 3D use a different shape (the `o: { session,
policy, ledger }` options object).

The asymmetry is real: `writeKindLedgerEntry` is called by
3C's `respawnWorkerSession` / `snapshotWorkerSession` /
`restoreWorkerSession`, which have already destructured their
`WorkerContext` to local variables. The cooperative factories
build their tool from a 3-field options object because the
deferred-binding pattern (worker-only-tools.ts) requires it.

**Decision: not applied.** Both shapes serve their call sites.
Consolidating would require either adding an options-object form
to `writeKindLedgerEntry` or restructuring the 3C call sites —
neither improves readability enough to justify the change.

### S8 — 11 operator commands + 3 cooperative tools + 3 respawn/snapshot/restore (informational; not applied)

**File:** `src/engine/budget/worker-tools.ts:397-560`

A large number of similar-looking exports. The brief calls out 11
operator commands (region 3B + 3C) and 3 cooperative tools
(region 3D), and each has a distinct `BudgetLedgerKind` value so
the dashboard can distinguish operator- vs worker-initiated
shutdowns.

**Decision: not applied.** The surface is dictated by the
refactor plan. Each command is a thin wrapper over a session
method + a ledger snapshot. No simplification opportunity that
doesn't reduce functionality.

## Applied Fixes

| # | File | Lines | Change |
|---|---|---|---|
| S1 | `src/engine/dispatch-subscribe.ts` | 64-77 | Drop dead `governance` parameter |
| S1 | `src/engine/dispatch.ts` | 705 | Drop the `governance` argument from the call site |
| S2 | `src/engine/budget/ledger.ts` | 47-53 | Export `isLedgerEntry` |
| S2 | `src/engine/budget/policy.ts` | 13, 159-164 | Import `isLedgerEntry` from ledger.ts; drop the local duplicate |
| S3 | `src/engine/budget/ledger.ts` | 222-256 | Drop the options-object overload; keep the 5-arg positional form |

## Net Effect

- LOC: -24 (collapses 32-line dual-overload to 11-line single
  signature; drops 5-line `isLedgerEntry` duplicate; drops 1-line
  `governance` argument from call site).
- Test count: 0 change (S1-S3 do not add or remove tests).
- Overloads: -1 (`BudgetLedger.snapshot` has one overload now).
- File-local duplicates: -1 (`isLedgerEntry`).
- Dead parameters: -1 (`governance` in `wireDispatchSubscription`).

## Risks

- S3 changes the runtime signature of `BudgetLedger.snapshot`.
  The contract test (`tests/budget-contracts.test.ts:484`) pins
  `.length === 4`, which is preserved by the explicit
  `= undefined` default on `kind`. If a future contributor
  switches back to `kind?` (TS optional), the test will fail with
  "5 !== 4" — a regression that surfaces immediately.
- S1 changes the public signature of `wireDispatchSubscription`
  (an internal module). The single call site
  (`dispatch.ts:705`) is updated atomically; no other callers
  exist in `src/` or `tests/`.
- S2 moves `isLedgerEntry` from a `function` (file-local) to
  `export function` (module surface). The import in `policy.ts`
  uses the named import; no other consumers exist.

## Verdict

Clean — all should-fix items applied. Informational findings
(S4-S8) are documented for future waves.
