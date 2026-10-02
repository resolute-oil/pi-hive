---
title: F10 architecture-strategist review (Wave 5B)
date: 2026-09-30
type: review
reviewer: architecture-strategist
status: applied
---

# F10 architecture-strategist review

## Scope

Reviewed the implementation diff for the budget refactor
(`refactor/budget @ 6c51206` vs `main @ 9f252f2`), focused on:

- Layer boundaries (caller vs callee; dispatch vs handler)
- Single responsibility per file
- Hidden coupling (closures, module-level state)
- Missing seams (test hooks, factory patterns)
- Leaky abstractions (SDK types leaking past seams)

Source files reviewed: `src/engine/budget/*.ts` (7 files, 1,776 LOC),
`src/engine/dispatch.ts` (752 LOC), `src/engine/dispatch-subscribe.ts`
(333 LOC), `src/engine/dispatch-lifecycle.ts` (195 LOC),
`src/engine/dispatch-end.ts` (120 LOC).

## Architecture Overview

The refactor replaces a single ~750 LOC `governance.ts` +
`budget-strategy.ts` pair with a layered module under
`src/engine/budget/`:

| Layer | Module | Purpose |
|---|---|---|
| Pure decision | `policy.ts` | `checkBudgetPolicy`, `teamUsage`, threshold helpers |
| Pure resolver | `strategy.ts` | `resolveWorkerBudgetPolicy`, `resolveWorkerBudgetStrategy` |
| Persistent state | `ledger.ts` | `BudgetLedger` class — restore, record, snapshot |
| Event hook | `events.ts` | `installBudgetEventHooks` (warning + abort + tool_call) |
| Cooperative tool factories | `worker-tools.ts` region 3D | `buildRequest*Tool` |
| Operator commands | `worker-tools.ts` regions 3B/3C | end/compact/pause/resume/etc. + respawn/snapshot/restore |
| Worker-only tools | `worker-only-tools.ts` | deferred-binding wrappers |
| Orchestrator | `worker-tools.ts` region 1 | `delegateAgent` |
| Legacy cutover | `remaining.ts` | `effectiveWorkerGovernance`, `budgetRemaining` shim |

The dispatcher (`src/engine/dispatch.ts`) was slimmed from 967 LOC to
752 LOC by extracting three helpers: `preflightCheck`,
`emitDelegationStart`, `emitSetupFailure` (inlined back into
`dispatch.ts`), and the larger `wireDispatchSubscription`,
`emitDelegationEnd`, and `runPromptAndFinalize` (in their own modules).

## Compliance Check

| Principle | Verdict | Notes |
|---|---|---|
| Single Responsibility | Pass | Each module owns one concern; regions 3B/3C/3D are byte-pinned per the wave-3 parallelization rule |
| Dependency Direction | Pass | `policy.ts` and `strategy.ts` are pure (no SDK I/O); `ledger.ts` depends on the SDK's `SessionManager.appendCustomEntry` only; `events.ts` depends on `ledger.ts`; `worker-tools.ts` composes the prior layers |
| Open/Closed | Pass | `DelegateAgentInternals` is the documented test seam; `events.ts:installBudgetEventHooks` is the production extension point |
| Liskov Substitution | Pass | `BudgetLedger` is a single concrete class; no subclass surface |
| Interface Segregation | Pass | `DelegateAgentOptions` (production), `DelegateAgentInternals` (test), `CreateSessionOptions` (session factory) are three narrow interfaces |
| Dependency Inversion | Pass | High-level modules (`events.ts`, `worker-tools.ts`) depend on abstractions (interfaces) for the test seam; the concrete impls are injected at the call sites |
| Hidden Coupling | **Concern** | `events.ts:75-86` module-level `budgetContextsByAgent` map; `worker-tools.ts:333-340` file-local `workerHandles` Map (intentional per F13 contract) |
| Leaky Abstractions | **Concern** | `worker-tools.ts:113-141` — `DelegateAgentInternals.createSession` typed as `(opts: CreateSessionOptions) => Promise<{ session: AgentSession }>` while the SDK's `createAgentSession` has a wider signature; the dispatcher casts `as never` at the call site |
| Premature Abstractions | **Concern** | `worker-tools.ts:154` — `defaultDelegateAgentInternals` is a module-local alias of `defaultInternals` with no consumer distinction (see A3) |
| Stale Documentation | **Concern** | `worker-tools.ts:144-152` comment claims `defaultDelegateAgentInternals` is exported and unused, but it is `const`, not `export const` (see A2) |
| Test Surface | Pass | 674 tests; `tests/wave-3-5-wiring.test.ts:367-389` explicitly pins the production-wrapper / test-seam naming pattern |

## Findings

### A1 — Dead `checkDispatchBudgets` export in `remaining.ts` (informational; not applied)

**File:** `src/engine/budget/remaining.ts:26, 106-139`

`checkDispatchBudgets` and its `GovernanceBlock` return type are
exported but have no production caller. `dispatch.ts:346, 451`
explicitly state "the legacy checkDispatchBudgets call is gone" and
"the legacy checkDispatchBudgets call is replaced by
`delegateAgent`". The function also falls off the end without an
explicit `return undefined;` (relies on TypeScript's implicit-return
behavior — works because `noImplicitReturns` is not set, but the
shape is unusual).

The function IS tested by 5 cases in
`tests/budget-remaining.test.ts:39-135` (`worker governance is
unlimited`, `worker and team budgets block independently`,
`monotonic governance usage`, `tokenBudgetScope input_output`,
`tokenBudgetScope all default`). The new `checkBudgetPolicy` path
in `policy.ts` covers the same shape but reads the nested
`WorkerBudgetPolicy` instead of the legacy flat `WorkerGovernance`.

**Decision: not applied.** Removing the function requires deleting
or rewriting the 5 test cases. Test count would drop by 5,
violating the F10 gate "Test count should not decrease." Defer
to a future wave that explicitly authorizes a test-count delta, or
to a follow-up that rewrites the cases against
`checkBudgetPolicy` from `policy.ts`.

### A2 — Stale comment block about "the export is unnecessary" (applied)

**File:** `src/engine/budget/worker-tools.ts:144-152`

```ts
// Module-private default internals used by `delegateAgent` below. Tests that
// need to stub internals pass a custom `DelegateAgentInternals` object
// directly to `delegateAgentWithInternals`; the production function never
// sees the seam, and no caller spreads these defaults, so the export is
// unnecessary.
const defaultDelegateAgentInternals: DelegateAgentInternals = defaultInternals;
```

The comment refers to "the export" but the binding is `const`, not
`export const` (no caller can reach it). The comment is also
duplicative with the preceding `defaultInternals` definition.

**Fix:** drop the duplicate binding (A3) and the comment in one
edit; the merged definition is self-explanatory.

### A3 — `defaultInternals` / `defaultDelegateAgentInternals` aliasing (applied)

**File:** `src/engine/budget/worker-tools.ts:141-155`

Two `const` bindings point at the same `DelegateAgentInternals`
object: `defaultInternals` (line 141) and
`defaultDelegateAgentInternals` (line 155). Only
`defaultDelegateAgentInternals` is read (line 220, inside
`delegateAgent`); `defaultInternals` is referenced only by the
second binding. The double name adds noise without adding a
seam — there's exactly one production site that reads the
default.

**Fix:** collapse to a single `defaultInternals` binding and update
the call site to use it directly.

### A4 — Two-name `registerWorkerHandle*` / `unregisterWorkerHandle*` API (informational; not applied)

**File:** `src/engine/budget/worker-tools.ts:333-393`

The same file-local `workerHandles` Map is exposed under two name
pairs:
- `__registerHandle` / `__unregisterHandle` (test seams)
- `registerWorkerHandleForProduction` /
  `unregisterWorkerHandleForProduction` (production seams)

The comment block (lines 329-352) explains the dual naming is
intentional: "test code uses the underscored aliases to make the
'this is a test seed' signal explicit at the call site."

`tests/wave-3-5-wiring.test.ts:367-389` explicitly tests that
`registerWorkerHandleForProduction` and `__registerHandle` point
at the same Map. The convention is load-bearing for the test
suite.

**Decision: not applied.** The cost-benefit of a single-name
collapse is small (saves ~6 LOC, no test count change), and the
test pin is intentional. Leave for a follow-up.

### A5 — `WorkerHandleShape` exported but never used outside its module (applied)

**File:** `src/engine/budget/worker-tools.ts:385`

```ts
export type WorkerHandleShape = { ... };
```

`WorkerHandleShape` is exported but the only consumers are the
three `registerWorkerHandleForProduction` /
`unregisterWorkerHandleForProduction` /
`lookupWorkerHandleForProduction` functions in the same file
(lines 386-393). The internal `WorkerHandle` interface (line 331)
is the same shape and is already used as the parameter type of
`registerWorkerHandle` (the file-local helper).

**Fix:** drop the export and re-use the existing file-local
`WorkerHandle` interface for the production wrapper signatures.
The file-local interface is structurally identical to the export,
so the call sites in `dispatch.ts:594-600` see no breaking change
(the wrapping is via structural compatibility, not by named type
reference).

### A6 — Stale comment block narrating "we cannot re-export" (informational; not applied)

**File:** `src/engine/budget/worker-tools.ts:329-352`

The comment explains the rationale for splitting the test/prod
names: "we cannot re-export them under the same identifier
without renaming the internals." The narrative buries a simple
mechanism. Could be tightened, but the comment is accurate; it's
a documentation-narrative smell, not a defect.

**Decision: not applied.** Cosmetic.

### A7 — Untyped event parameter in `buildBudgetToolCallHandler` (informational; not applied)

**File:** `src/engine/budget/events.ts:120-124`

The handler signature uses a structural
`{ toolName: string; input?: unknown }` for the event parameter,
even though the SDK exports `ToolCallEvent` (extensions/types.d.ts).
The comment mentions `ToolCallEvent` but types it as a structural
literal.

This is a deliberate decoupling: the structural literal
suppresses SDK churn, so adding a new field to `ToolCallEvent`
won't cascade into this handler. The cost is one layer of
indirection when reading the type.

**Decision: not applied.** The structural literal is the
documented choice in the comment and is consistent with the
narrow surface the handler actually reads (`toolName`).

### A8 — Module-level `budgetContextsByAgent` registry (informational; not applied)

**File:** `src/engine/budget/events.ts:75-86`

A module-private `Map<agentName, BudgetContext>` couples
`installBudgetEventHooks` (writer) to `buildBudgetToolCallHandler`
(reader) without an explicit argument. Tests must remember to
call `_resetBudgetContextsForTests` (or its renamed variant) or
the registry bleeds across cases.

The brief's design comment (events.ts:71-78) documents this as
intentional: "Module-private — the public surface is
`installBudgetToolCallHandler` and `getBudgetContextForAgent`."
The factory pattern (`buildBudgetToolCallHandler(agentName)`)
returns a closure that looks up the context by name, so the
handler is per-agent but reads from shared state.

**Decision: not applied.** The hidden coupling is documented and
the test seam (`__resetBudgetContextsForTests`) makes
hermetic tests possible. A per-call argument would require
threading the context through the resource-loader factory,
which is a larger refactor.

### A9 — Two parallel ledger-write paths (informational; not applied)

**File:** `src/engine/budget/worker-tools.ts:514-517` (region 3C)
vs `src/engine/budget/ledger.ts:236-282` (snapshot)

`writeKindLedgerEntry` (in `worker-tools.ts`) and
`BudgetLedger.snapshot(...)` (in `ledger.ts`) both produce a
`BudgetLedgerEntry` with `marker: "checkpoint"` and a `kind`
field. Region 3B's operator commands call
`ledger.snapshot(stats, policy, "checkpoint", signal, kind)`;
region 3C's respawn/snapshot/restore call `writeKindLedgerEntry`.

The two paths differ in WHERE the entry is written:
`ledger.snapshot` writes through `this.sessionManager` (the
ledger's session) and updates the ledger's `entries` array;
`writeKindLedgerEntry` writes through a passed-in
`sessionManager` and does NOT update any in-memory ledger.

This is a real seam: region 3C operates on a `WorkerContext`
where the ledger may be a fresh restore and the session manager
is the new (branched) one, not the ledger's original. So a
single helper that reads `ledger.sessionManager` would not
work for region 3C.

**Decision: not applied.** The duplication reflects a real
architectural split. The two paths COULD be consolidated by
adding a `sessionManager` parameter to `ledger.snapshot`, but
that is a wider refactor with no test count change.

### A10 — Dual `createSession` seam in `DelegateAgentOptions` and `DelegateAgentInternals` (informational; not applied)

**File:** `src/engine/budget/worker-tools.ts:113-141, 196-211, 234-238`

`createSession` lives on both `DelegateAgentInternals` (test path)
and `DelegateAgentOptions` (production path). The function body
(worker-tools.ts:236-238) bridges `options.createSession` into the
internals seam so the two paths point at the same function.

The dual location is a documented choice: production callers
"pass it via the options object; tests pass it via internals
directly" (comment at lines 234-237). The bridge is a 3-line
spread.

**Decision: not applied.** The dual location and bridge reflect
the production-vs-test split the brief explicitly requires
("Production-side seam: when supplied, delegateAgent uses it to
create the AgentSession instead of going through
SessionManager.create()"). The cost is 3 LOC of bridge; the
benefit is the test seam stays untouched.

### A11 — Underscore prefix inconsistent with project convention (applied)

**File:** `src/engine/budget/events.ts:84`

```ts
export function _resetBudgetContextsForTests(): void {
```

The project convention (per the cooperative-tool registry in
`worker-tools.ts:597`) is the double-underscore prefix
`__resetCooperativeToolRegistryForTests`. The single-underscore
form here is an outlier.

**Fix:** rename to `__resetBudgetContextsForTests` and update the
two call sites in `tests/budget-events.test.ts` and the test
imports in `tests/wave-3-5-wiring.test.ts`.

### A12 — `BudgetLedger.snapshot` dual overload (informational; not applied)

**File:** `src/engine/budget/ledger.ts:237-282`

The function is declared with two overloads:
- `(stats, policy, marker, signal, kind?)` (5-arg positional,
  "legacy")
- `(stats, policy, opts: { marker, signal, kind? })` (options
  object, "preferred for new code")

The comment (lines 222-232) says "the `(stats, policy, marker,
signal, kind?)` positional signature is kept (callers migrate at
their pace)". All 11 current call sites in `worker-tools.ts`
(operator commands in region 3B and cooperative tools in region
3D) use the 5-arg positional form. No call site uses the
options-object form. The "preferred for new code" is
aspirational; in practice the legacy form is the only form in
use.

**Decision: not applied.** The 11 call sites would need to
migrate to the options-object form to drop the overload — a
sweeping edit. The dual overload is harmless (the runtime
branch is 4 lines), and the comment accurately describes the
contract. The code-simplicity reviewer may flag this for
follow-up.

## Applied Fixes

| # | File | Lines | Change |
|---|---|---|---|
| A2 | `src/engine/budget/worker-tools.ts` | 144-155 | Drop misleading "the export is unnecessary" comment |
| A3 | `src/engine/budget/worker-tools.ts` | 141-155, 220 | Collapse `defaultInternals` + `defaultDelegateAgentInternals` to one binding |
| A5 | `src/engine/budget/worker-tools.ts` | 385-394 | Drop `WorkerHandleShape` export; re-use file-local `WorkerHandle` interface |
| A11 | `src/engine/budget/events.ts`, `tests/budget-events.test.ts`, `tests/wave-3-5-wiring.test.ts` | various | Rename `_resetBudgetContextsForTests` → `__resetBudgetContextsForTests` |

## Net Effect

- LOC: -20 (collapses ~25 LOC of duplicated comments/bindings; adds
  ~5 LOC of clear names).
- Test count: unchanged (A11 renames a test seam; no tests added or
  removed).
- Exports: -1 (`WorkerHandleShape` removed).
- Module-private duplicates: -1 (`defaultDelegateAgentInternals`
  removed).
- Naming convention: events.ts now matches `__resetXxxForTests`
  pattern.

## Risks

- The A11 rename touches test files; the test suite must still
  pass after the rename. Verified by `just typecheck && just test`.
- The A3 collapse moves the `defaultInternals` definition to where
  `delegateAgent` reads it. The single read site is at
  `worker-tools.ts:220`; the moved binding is structurally
  identical, so no call site changes.

## Verdict

Clean — all should-fix items applied or explicitly deferred with
rationale. Informational findings (A1, A4, A6-A10, A12) are
documented for future waves.
