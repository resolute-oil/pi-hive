---
title: Widen Orchestrator delegate_agent targets to non-lead agent types
type: fix
date: 2026-09-22
---

# Widen Orchestrator `delegate_agent` targets to non-lead agent types

## Overview

Allow the Orchestrator to delegate a read-only inspection task directly to
any configured agent whose `agent-type` is `coder`, `tester`, `reviewer`, or
`planner`, while keeping `lead`-typed agents reachable only via the existing
tree-derived mechanism (i.e. as direct reports).

The smoke test surfaced this when the orchestrator wanted to ask an idle
`frontend-coder` for a view-file inspection and was rejected. The fix is
implemented as a hard-coded engine rule on `canDelegateTo`; no user-facing
config flag is introduced (preserves ADR H1/Decision 7).

## Symptom reframe — required reading before implementation

The smoke-test symptom report says: *"the Orchestrator's `delegate_agent`
tool has a hard-coded allowlist of three targets."* **This premise is
incorrect** as a description of the mechanism. There is no hardcoded list of
`["engineering-lead", "validation-lead", "operations"]` anywhere in the
codebase or docs (verified by repo-research-analyst; no matches for those
literals in `src/`, `tests/`, or `SETUP.md`).

The real mechanism is:

- `delegate_agent` → `dispatchAgent` (`src/agents/tools.ts:207` →
  `src/engine/dispatch.ts:205-256`)
- `dispatchAgent` calls `canDelegateTo(state, caller, target)` at
  `src/engine/dispatch.ts:243`
- `canDelegateTo` (`src/engine/domain.ts:18-31`) checks
  `caller.config.allowedAgents` for a match
- `caller.config.allowedAgents` is **derived** from `members`/`children`
  nesting in `hive-config.yaml` at config-load time
  (`src/core/config.ts:235-260`)
- For the orchestrator, `allowedAgents` is the list of slugs of its
  top-level reports — in strata's tree these are the three leads

The smoke test's rejection message reads
*"Orchestrator can only delegate to: engineering-lead, validation-lead,
operations"* because those are the orchestrator's computed `allowedAgents`,
not because of a literal list. **Any fix must work for any tree shape
(N leads, N=0, custom names) — not assume three leads.**

This reframe matters because the proposed fix is a **second axis**
(agent-type) added to the existing single-axis (tree) gate, not a
replacement of one. See "ADR compliance" below.

## Problem statement

Today, the orchestrator can only route tasks to its direct reports — the
top-level agents in its `hive-config.yaml`. For a typical strata-style tree
with three leads, the orchestrator can route only to those three leads.
Read-only inspection of a non-lead specialist (e.g. *"ask `frontend-coder`
to look at `ui/src/App.tsx` and report its prop shape"*) must go through the
parent lead, consuming the lead's context budget and adding latency.

This is over-restrictive. Read-only inspections don't need lead coordination
— they're cheap, side-effect-free, and a typed specialist can answer them
directly. The smoke test surfaced this as a workflow friction point.

## Proposed solution

Extend `canDelegateTo` (`src/engine/domain.ts:18-31`) with a second
allowance: in addition to the tree-derived `allowedAgents`, a caller may
also delegate to any configured agent whose `agent-type` is in
`{coder, tester, reviewer, planner}`.

```ts
// Existing tree-derived check, unchanged:
const allowed = caller.config.allowedAgents;
const target = resolveRuntime(state, targetName);
if (allowed && target && allowed.some((id) => agentMatches(target.config, id))) {
  return { ok: true };
}
// NEW: type-based widening for inspection-capable types.
const targetType = target.config.agentType;
if (targetType && ["coder", "tester", "reviewer", "planner"].includes(targetType)) {
  return { ok: true };
}
// Existing denial paths, with updated message (see "Denial message").
```

`lead`-typed agents are intentionally **not** in the widening set. They
remain tree-only — sub-leads stay tree-bound and the orchestrator's
coordination delegation continues to flow through top-level leads.

### ADR compliance (H1/Decision 7)

The decision recorded at `src/core/types.ts:103-107` and reinforced by
`SETUP.md:51,791` and `src/core/config.ts:31-46` forbids users from
**declaring delegation permissions** in YAML or frontmatter — the
delegation hierarchy is derived from `members`/`children` nesting.

This fix does **not** violate that ADR:

- No new user-facing field is introduced.
- The `agent-type` field is **already required** (config hard-fails if
  missing, per `SETUP.md:330`) and is documented as a **capability** axis
  distinct from delegation (`SETUP.md:332,791`).
- The widening is a hard-coded engine rule, not a config knob.
- The tree-derived rule is preserved; the widening is **additive**.

This is consistent with the existing precedent at `src/engine/dispatch.ts:221-241`
where agent-type already drives two target gates (plan-mode and hive-mode).

### Why option 1 over option 2 (`delegate_inspect`) and option 3 (docs-only)

The smoke-test report presented three options. Option 1 (this fix) is
recommended:

- **Option 2 (`delegate_inspect`)** sidesteps the H1 ADR concern but
  introduces a parallel tool that overlaps with `delegate_agent`. The
  existing `delegate_agent` is already the canonical routing tool;
  adding `delegate_inspect` would split routing into two tools that
  orchestrate differently and confuse the orchestrator. Not recommended.
- **Option 3 (docs-only, route everything through `engineering-lead`)**
  doesn't fix the friction. It just documents it. Not recommended for a
  fix-shaped smoke-test issue.

Option 1 is the smallest, most architecturally coherent change that
solves the reported problem.

## Technical approach

### Files to change

| File | Change |
|---|---|
| `src/engine/domain.ts` | Extend `canDelegateTo` (lines 18-31) with the type-based widening branch. Update denial-message construction to name both the tree-derived list and the allowed-types set. |
| `src/agents/prompts.ts` | Update the hardcoded prose at lines 48-49 ("You delegate ONLY to the team leads below…") to reflect the new policy. Keep the lead-routing guidance for HANDOFF cycle rotation, worktree, preflight, push, PR-open. |
| `src/integration/hooks.ts:265-266` | Review the orchestrator prompt guidance about `route_agent` + `delegate_agent`; tighten to match new policy. |
| `src/engine/routing.ts:14-17` | Add a parallel filter to `routeAgents` mirroring `dispatch.ts:236-241` — drop `coder`/`tester` recommendations when no execution gate is open — so routing recommendations match what `delegate_agent` will actually accept. |
| `SETUP.md:51` | Amend §1 "The one rule that drives the whole structure" to document the new policy. |
| `SETUP.md:328-348` | Add a §7.1.1 "Delegation reach" subsection explaining how agent-type interacts with `canDelegateTo`. |
| `SETUP.md:485-499` | Update the orchestrator template Operating Principles line 494 ("Delegate ONLY to the top-level team leads") to mention the read-only-inspection exception. |
| `SETUP.md:309` | Update the `delegate_agent` row's "Targets" column in the §7 tool table. |
| `SETUP.md:789-793` | Update §12 anti-patterns to reflect that `lead`-typed agents stay tree-bound even after the widening. |
| `tests/domain-routing.test.ts` | Add 5 new tests (T1–T5 in the spec-flow). |
| `tests/tools-branches.test.ts` | Add 2 new tests (T6, T7). |
| `tests/config.test.ts` | Add T10 — a test that asserts the default tree-derived `allowedAgents` is "leads-only" for a tree-shaped fixture. |
| `CHANGELOG.md` | One-line entry under the next unreleased section. |

### Tasks

Discrete units of work. Each task is small enough to be picked up,
checked off, and (if interrupted) handed off mid-flight. The worktree
branch carries the in-progress state; the task list doubles as the
checklist. Tasks are ordered for dependency, not necessarily for
execution — T6 and T9 can run in parallel with T1 if a session has the
bandwidth.

| ID | Task | Files | Deps | Done when |
|---|---|---|---|---|
| T1 | Extend `canDelegateTo` with type-based widening branch (after the existing tree-match) | `src/engine/domain.ts:18-31` | — | Tree-match still first (unchanged); lead-typed non-reports still rejected; non-direct-report coder/tester/reviewer/planner returns `{ ok: true }`; manually verified |
| T2 | Update `canDelegateTo` denial message to name both the tree-allowed list and the allowed-types set | `src/engine/domain.ts:18-31` | T1 | New wording matches Q5 default; existing "can only delegate to" prefix preserved |
| T3 | Mirror gate #4 in `routeAgents` — drop `coder`/`tester` recommendations when `isExecutionGateOpen` is false | `src/engine/routing.ts:14-17` | T1 | Routing recommendations match what `delegate_agent` will accept in both gate states |
| T4 | Add tests T1–T5 from the spec-flow | `tests/domain-routing.test.ts` | T1, T2 | All five pass; `just test` clean |
| T5 | Add tests T6, T7 (end-to-end + routing surface) | `tests/tools-branches.test.ts` | T1, T3 | Both pass; end-to-end `delegate_agent` to non-direct-report coder succeeds |
| T6 | Add test T10 — regression guard for default tree-derived `allowedAgents` | `tests/config.test.ts` | — | Default behavior preserved; tree-derived `allowedAgents` still leads-only for tree-shaped fixtures |
| T7 | Update orchestrator prompt at `prompts.ts:48-49` with Q6 default text | `src/agents/prompts.ts:48-49` | T1, T2 | New prose in place; old "Delegate ONLY to the team leads" line gone |
| T8 | Update hooks.ts orchestrator guidance about `route_agent` + `delegate_agent` to match new policy | `src/integration/hooks.ts:265-266` | T7 | Guidance reflects the read-only-inspection exception |
| T9 | Update SETUP.md §1 "The one rule that drives the whole structure" (line 51) | `SETUP.md:45-53` | T1 | Delegation-rule paragraph amended; preserved anti-pattern links |
| T10 | Add SETUP.md §7.1.1 "Delegation reach" subsection | `SETUP.md:328-348` | T1, T9 | New subsection present; references `canDelegateTo` and the dispatch flow |
| T11 | Update SETUP.md §9a orchestrator template Operating Principles (line 494) | `SETUP.md:485-499` | T7 | Line 494 reflects Q6 default; `operations`-preferred routing language matches the prompt |
| T12 | Update SETUP.md §7 tool table (line 309) and §12 anti-patterns (lines 789-793) | `SETUP.md:309`, `SETUP.md:789-793` | T1 | `delegate_agent` row's "Targets" column updated; anti-patterns reflect lead-stays-tree-bound |
| T13 | Update CHANGELOG.md with one-line entry | `CHANGELOG.md` | T1 | Entry under next unreleased section; conventional-commit style |
| T-Routing | Manual smoke test — `routeAgents` returns `operations` as top match for HANDOFF/worktree/push/PR task strings | (no file; runtime check) | T3, T7 | All four routing assertions hold for realistic task strings |

**Total: 13 code/doc tasks + 1 manual smoke test.**

### Session boundaries

Recommended groupings if work is split across sessions. Each grouping
ships as one PR. The plan is small enough that one session can do all
three groupings, but the groupings exist so handoff is clean if this
session ends.

**Grouping A — engine + tests (smallest viable code PR).** Tasks T1, T2,
T3, T4, T5, T6, T-Routing. Files: `src/engine/domain.ts`,
`src/engine/routing.ts`, three test files. This is the actual fix; if
nothing else ships, the smoke test passes acceptance criteria #1, #3,
#4 (where testable), #5.

**Grouping B — prompts and hooks.** Tasks T7, T8. Files:
`src/agents/prompts.ts`, `src/integration/hooks.ts`. Belongs with
Grouping A in the same PR (acceptance criterion #4 depends on the
prompt update).

**Grouping C — documentation.** Tasks T9, T10, T11, T12, T13. Files:
`SETUP.md`, `CHANGELOG.md`. Belongs with A+B in the same PR
(acceptance criterion #6 requires all five SETUP.md updates).

**Recommended:** ship A + B + C together as one PR. The combined diff
is small (~150 lines of code, ~80 lines of doc updates, ~200 lines of
tests), the prompts and docs reference the gate change directly, and
splitting them adds review overhead for marginal benefit.

**If interrupted mid-flight:** the next session reads the
"Handoff-ready" section below to pick up where this session stopped.

## Alternative approaches considered

- **`delegate_inspect` tool (option 2).** A separate tool restricted to
  inspection-only delegations against typed specialists. Adds a parallel
  routing surface; complicates the orchestrator's decision tree; doesn't
  match the existing single-tool routing model. Rejected.
- **Documentation-only (option 3).** Tell the orchestrator in strata's
  docs that all inspection goes through `engineering-lead`. Doesn't fix
  the friction, just codifies it. Rejected for a fix-shaped smoke-test
  issue.
- **Per-config flag (e.g. `orchestratorCanDelegateToAll`).** Violates the
  H1/Decision 7 ADR that forbids user-facing delegation declarations.
  Rejected.
- **Group-scoped widening.** Limit the type-based widening to agents in
  the caller's group. More restrictive but adds complexity (group names
  aren't a first-class concept in `canDelegateTo` today). Default to
  universal; revisit if smoke testing surfaces cross-group surprises.

## Acceptance criteria

The smoke-test report's criteria, with the ambiguities the spec-flow
surfaced resolved:

1. **The orchestrator can delegate a read-only task to `frontend-coder` (or
   any `coder`/`tester`/`reviewer`/`planner` agent) and the delegation
   succeeds.** Test must run with an approved plan active
   (`isExecutionGateOpen(changeId)` is true) or in plan mode for a
   `reviewer`/`planner` target. Hive-mode execution gate (gate #4) is
   **not** widened by this fix; that's a separate concern.
2. **`lead`-typed agents remain tree-bound.** A sub-lead (a `lead`-typed
   agent that is not a direct report of the caller) is rejected by
   `canDelegateTo` even after the widening. Test T2.
3. **`route_agent` surfaces the wider set** in hive mode (when execution
   gate is open) and in plan mode for plan-eligible types. Test T7.
4. **Orchestrator still routes HANDOFF cycle rotation, worktree create,
   preflight, push, and PR-open through `operations`.** This is enforced
   by the orchestrator prompt (which gets updated in phase 2), not by
   `canDelegateTo`. Test asserts `routeAgents` returns `operations` as
   the top match for realistic task strings containing these terms.
5. **`just typecheck && just lint && just test` clean.** No new lint
   warnings, no test regressions, no test failures. Pre-existing 17
   failures (per HANDOFF.md) are out of scope.
6. **SETUP.md documents the new policy** at §1, §7.1, §9a, §12.

## Open questions (need user input before implementation)

The spec-flow surfaced 8 questions. Below: each with its proposed default.
**Defaults are baked into the plan above; override any of them before
implementation begins.**

| # | Question | Default |
|---|---|---|
| Q1 | Does the widening apply in **plan mode** too? | **Hive mode only.** Plan mode targets stay `planner|lead|reviewer` (the existing `dispatch.ts:221-222` rule is load-bearing for the planning workflow). A future change could add a "read-only inspection in plan mode" flag. |
| Q2 | Does the widening apply **across groups** (orchestrator can reach any typed agent anywhere) or only within the caller's group? | **Universal.** A lead can reach any typed agent. Cleaner than group-scoped and matches H1 spirit (no user-configurable scoping). |
| Q3 | Is **gate #4 (hive execution gate)** also widened for read-only inspection? | **No.** Acceptance criterion #1 runs with an approved plan active. Widening gate #4 is a separate, larger change (would need an "isReadOnly" flag on `delegate_agent`). |
| Q4 | Should `route_agent`'s filter chain mirror gate #4 (drop `coder`/`tester` when no execution gate is open)? | **Yes.** Symmetry is better than asymmetry; otherwise routing recommendations mislead. Implemented in `routing.ts:14-17`. |
| Q5 | What is the exact new denial message in `canDelegateTo`? | `'${callerName} can only delegate to direct reports [a, b, c] or to typed specialists in {coder, tester, reviewer, planner}. ${name} is agent-type "${targetType || "unknown"}".'` |
| Q6 | What is the exact new orchestrator prompt language at `src/agents/prompts.ts:48-49` and `SETUP.md:494`? | *"Delegate to the top-level team leads for coordinated work. For read-only inspection tasks (e.g. surveying code state), you may also delegate directly to typed specialists (`coder`, `tester`, `reviewer`, `planner`). `operations` remains the preferred owner of HANDOFF cycle rotation, worktree create, preflight, push, and PR-open because that's its role — prefer routing those there. Coder and tester agents are write-capable by design and could perform those operations if delegated to; this is by capability, not a routing recommendation."* |
| Q7 | Is a sub-lead (`lead`-typed with members) reachable via the widening? | **No.** Sub-leads stay tree-bound. The widening adds only the four inspection-capable types. |
| Q8 | A `coder`-typed agent that is also a top-level direct report — already reachable today via tree. Widening is non-additive. | **No change.** Widening doesn't affect already-reachable targets. |

## Documentation plan

Per the files table above. Five `SETUP.md` sections need updates:

- **§1 (line 51)** — The canonical delegation-rule paragraph gains a
  follow-up sentence about the read-only-inspection widening.
- **§7.1** — New subsection "Delegation reach" explains how agent-type
  interacts with `canDelegateTo`.
- **§7 tool table (line 309)** — `delegate_agent` row's "Targets" column
  gains the widening note.
- **§9a (lines 485-499)** — Orchestrator template Operating Principles
  line 494 changes to allow inspection delegations and reaffirm the
  HANDOFF/worktree/push/PR-open lead-routing restriction.
- **§12 anti-patterns (lines 789-793)** — Add a note that `lead`-typed
  agents stay tree-bound even after the widening.

Plus `CHANGELOG.md`: one-line entry.

## Test plan

New tests in `tests/domain-routing.test.ts` (T1–T5):

- **T1.** `canDelegateTo(state, "Orchestrator", "Frontend Coder")` returns
  `{ ok: true }` after the widening when `Frontend Coder` is
  `agent-type: coder` and not a direct report.
- **T2.** Same call shape with target typed `lead` and not a direct
  report returns `{ ok: false }` (sub-leads stay tree-bound).
- **T3.** Widening covers all four inspection-capable types
  (`coder`, `tester`, `reviewer`, `planner`).
- **T4.** Denial reason names BOTH the tree-allowed list AND the
  type-allowed set.
- **T5.** Widening applies symmetrically for non-orchestrator callers
  (a lead can reach a typed coder in another group).

New tests in `tests/tools-branches.test.ts` (T6, T7):

- **T6.** `delegate_agent` end-to-end succeeds when targeting a
  non-direct-report coder (with execution gate open).
- **T7.** `routeAgents` surfaces the wider set.

New tests in `tests/config.test.ts` (T10):

- **T10.** A tree-shaped fixture's orchestrator `allowedAgents` is exactly
  the top-level agent slugs (default tree-derived behavior). Today no
  test asserts this; this is a regression guard for the widening
  preserving the existing tree-derived contract.

Plus a prompt-level test (manual or scripted, not unit):

- **T-Routing.** `routeAgents(state, "rotate the HANDOFF cycle", 5)`
  returns `operations` as top match. `routeAgents(state, "git worktree
  create for fix/foo", 5)` returns `operations`. Same for "open a PR".

## Out of scope

- Changing which agents are typed `lead` vs `coder` vs `tester` vs
  `reviewer` (strata config; engine change).
- Widening gate #4 (hive-mode execution gate) for read-only inspection.
  This is a separate, larger change that would need an "isReadOnly"
  flag on `delegate_agent` plus thread-through in dispatch. Deferred.
- Group-scoping the widening. Default is universal.
- A per-config flag (e.g. `orchestratorCanDelegateToAll`). Violates
  H1/Decision 7.
- Letting `lead`-typed agents run mutating bash. Already enforced by the
  bash policy (`src/engine/policy.ts:24-29` `WRITABLE_CLASSES` —
  `lead: []`, `reviewer: []`); no change needed.
- The citation cleanup at `domain.ts:445-451` (mentioned in the spec-flow
  as misleading). Documentation-only fix; will be addressed in a
  follow-up if it surfaces again.
- **Read-only classification of `delegate_agent` tasks (Option B from the
  security review).** This would gate the type-based widening on a
  per-call flag or task-content classification (e.g. only open the
  widening when the task contains read-only command verbs), enforcing
  an "inspection only" semantic at the gate level rather than relying
  on prompt-level routing preferences. See "Security model consistency"
  below for context. Deferred until/unless smoke testing surfaces a
  concrete misuse case (e.g. orchestrator delegating `git worktree add`
  to a `coder` when it shouldn't).

## Security model consistency

This section walks the plan against each invariant in `SECURITY.md` and
confirms alignment. The widening is a "policy control for cooperative
agents, not a sandbox" (SECURITY.md accepted risks §4) — same trust
model as the existing tree-derived gate.

| SECURITY.md invariant | Plan impact |
|---|---|
| **Trust boundaries** — opt-in via `.pi/hive/hive-config.yaml`; agent output/input untrusted | Plan doesn't change opt-in or trust model. The widening is constrained by the same policy layers as today. |
| **Approval integrity** — only attributable human creates approval; agents cannot forge | Plan doesn't touch approvals or any approval-creation path. |
| **Reviewer/lead read-only semantics** — explicit allowlist, fail-closed for mutations (`WRITABLE_CLASSES.reviewer/lead: []`) | Plan doesn't change `WRITABLE_CLASSES` or `readOnlyCommandDecision`. Reviewer/lead remain read-only. |
| **Path & symlink semantics** — canonical containment via `realpath` | Plan doesn't touch path resolution. |
| **Dashboard authentication** — bearer + nonce | Plan doesn't touch the dashboard. |
| **In-scope vulnerability classes** — tool-scope escalation, cross-project, approval forgery, write-domain escape, unauth dashboard access | Widening doesn't escalate any agent's tool set. A `coder` reached via widening has the same `WRITABLE_CLASSES.coder: ["code","docs","tasks"]` as one reached via tree. Same for tester (`["code","docs","tasks"]`), reviewer (`[]`), planner (`["spec","docs","tasks"]`). No agent acquires new capabilities. |
| **Accepted risks §4** — "Agent controls are not OS sandboxing. Domain and command policy constrain registered Pi tools." | The widening is a delegation permission, not a sandbox. The downstream bash/file policy (`enforceDomainForTool`, `WRITABLE_CLASSES`, `readOnlyCommandDecision`, `commit` field gate) still applies to the worker session regardless of who delegated to it. |

**Semantic clarification on the prompt-level "operations exclusively"
guidance (Q6 default).** SECURITY.md does **not** promise that
coder/tester can't run `git worktree add`, `git push`, or
`gh pr create` — these are write-capable agent types by design
(`WRITABLE_CLASSES.coder: ["code", ...]`). The reason `lead`/
`reviewer` can't run them is their empty write class, not a gate-level
restriction. So if the orchestrator delegated "git worktree add" to a
`coder` via the widening, it would succeed — the bash policy permits
it. The Q6 prompt text is therefore a **routing preference**
(operations owns these by role; route them there by default), not an
enforced boundary. If the smoke test later surfaces a real concern
about a `coder` running worktree ops it shouldn't, the follow-up is
Option B (read-only classification on `delegate_agent`) — see the
"Out of scope" section.

## Dependencies and risks

**Risks:**

- **Cross-group surprise (Q2 default = universal).** A lead can reach any
  typed agent, including in unrelated groups. This may surprise users who
  expect "my team only sees its own group." Mitigation: document
  explicitly in `SETUP.md` §7.1.1. If smoke testing surfaces issues,
  revisit with a group-scoped variant.
- **Orchestrator prompt drift.** The prompt at `src/agents/prompts.ts:48-49`
  is hardcoded prose; if it's not updated alongside the gate, the
  orchestrator won't know it can route to coders/testers/etc.
  Mitigation: phase 2 is part of the same PR; T-Routing test exercises
  the routing recommendation.
- **`route_agent` asymmetry (Q4 default = mirror gate #4).** Requires
  updating `routing.ts:14-17` to mirror the hive execution gate. If this
  is missed, `route_agent` may recommend a target that `delegate_agent`
  rejects — confusing UX. Mitigation: T7 + manual smoke test.
- **Existing tests don't lock in the "orchestrator cannot delegate to a
  leaf" invariant** (per spec-flow §7.3). After the fix, this invariant
  is partially removed (typed agents become reachable), so the absence
  of the test is fine. But T10 protects the tree-derived base case.

**Dependencies:** none. This is a self-contained change.

## Handoff-ready template

If this session ends before all tasks are complete, the next session
should fill in and commit this block to the worktree (or to a fresh
`HANDOFF.md`) so continuation is mechanical.

```markdown
## Orchestrator delegation widening — handoff

- **Branch:** `fix/orchestrator-delegate-targets`
- **Base:** `main` @ `<base-sha>`
- **Worktree:** `.worktrees/fix-orchestrator-delegate-targets`
- **Current HEAD:** `<commit-sha>`
- **Completed tasks:** T1, T2, T3, … (list IDs)
- **Remaining tasks:** T4, T5, … (list IDs)
- **Last verified:** `just verify` clean / `<N>` known failures (none new)
- **Open questions state:**
  - Q1: <accepted default / overridden to …>
  - Q2: <…>
  - … Q8: <…>
- **Smoke-test gate #4 status:** <not hit / hit with error message "…">
- **Notes:** <anything the next session needs to know — drift,
    rebase onto main if `main` moved, etc.>
```

### Research artifact paths

The three research artifacts produced for this plan live in the parent
checkout's `tmp/` directory (untracked, not committed):

- `<APP_ROOT>/tmp/orchestrator-delegation-research.md` (repo research)
- `<APP_ROOT>/tmp/orchestrator-delegation-learnings.md` (learnings)
- `<APP_ROOT>/tmp/orchestrator-delegation-specflow.md` (spec-flow)

`<APP_ROOT>` is `/Users/cgrant/.pi/agent/git/github.com/demetere/pi-hive`.

If the next session starts fresh (no parent checkout, or the parent
was cleaned), the artifacts need to be regenerated by re-running the
three subagents with the prompts documented in the commit message of
the plan-PR. The plan itself references enough line numbers that the
research is recoverable from the codebase + the plan + the spec-flow's
test designs (T1–T13) without re-running the agents.

## References and research

### Internal references

- Spec-flow analysis: `<APP_ROOT>/tmp/orchestrator-delegation-specflow.md`
  (in the parent checkout, untracked). See "Research artifact paths"
  in the Handoff-ready section for portability.
- Repo research: `<APP_ROOT>/tmp/orchestrator-delegation-research.md`.
- Learnings research: `<APP_ROOT>/tmp/orchestrator-delegation-learnings.md`.
- `src/engine/domain.ts:18-31` — `canDelegateTo` (target of the fix).
- `src/engine/dispatch.ts:205-256` — `dispatchAgent` and its gates.
- `src/engine/dispatch.ts:221-241` — existing agent-type target gates
  (precedent for the fix).
- `src/engine/routing.ts:14-17` — `routeAgents` filter chain.
- `src/core/types.ts:30` — `AgentType` union.
- `src/core/types.ts:103-107` — `allowedAgents` ADR H1/Decision 7.
- `src/core/config.ts:235-260` — `allConfiguredAgents` derivation.
- `src/core/config.ts:65-84` — `warnOnPlanningExecutionAgents`
  (agent-type-driven config validation precedent, warn-only).
- `src/engine/policy.ts:24-29` — `WRITABLE_CLASSES` (existing
  type-driven policy matrix).
- `src/agents/tools.ts:180-258` — `delegate_agent` tool definition.
- `src/agents/prompts.ts:22-49` — orchestrator prompt (leads list +
  hardcoded "delegate only to leads" prose).
- `SETUP.md:51` — delegation rule.
- `SETUP.md:328-348` — §7.1 agent types.
- `SETUP.md:485-499` — §9a orchestrator template.
- `tests/domain-routing.test.ts:139-178` — fixture pattern.
- `tests/tools-branches.test.ts:8-33` — fixture (no nesting).
- `tests/config.test.ts:245-269,295-310` — `allowedAgents` derivation
  tests.

### External references

None. This is an engine-internal change with all precedent in the
codebase.

### Related work

- All 8 PRs on `resolute-oil/pi-hive` are merged. Issues are disabled on
  the fork. No prior PR or issue references the delegation target list
  mechanism — this is greenfield.
- HANDOFF.md records six prior smoke-test fixes (PRs #1, #2, #3, #4, #6,
  #8) covering delegate_agent rendering (PR #1, #4), bash path
  extraction (PR #2), and token budget scope (PR #3, #6). None touch
  delegation policy.
