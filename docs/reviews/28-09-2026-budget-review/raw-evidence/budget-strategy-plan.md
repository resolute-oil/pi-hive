# Budget-strategy feature — implementation plan

This document captures the final agreed plan for the budget-strategy feature
that was designed (not yet coded) in the handoff session. The next session
should open a worktree off `main` (currently at `2d721a9`) and implement
this plan as a single PR.

## Background

Two questions surfaced during this session:

### Q1 — How are agents/teams notified of an approaching budget limit?

Yes, there's a mechanism in `src/engine/dispatch.ts:597-620`:

```ts
const warn = (left, limit, scope, resource) => {
  if (left === undefined || limit === undefined || left <= 0 || left / limit > 0.2) return;
  const warningKey = `${scope}:${resource}:${scope === "worker" ? agentSlug(runtime.config) : "team"}`;
  const warnings = state.budgetWarnings ||= new Set<string>();
  if (warnings.has(warningKey)) return;
  warnings.add(warningKey);
  emitHiveEvent(state, "budget_warning", { agent: ..., scope, resource, remaining: left, limit }, ...);
};
```

Two thresholds:
- **80% consumed** (≤20% remaining) → emits `budget_warning` to telemetry. Deduped
  by `${scope}:${resource}:${agent|team}` so each warning fires once per
  agent/scope/resource combination.
- **0% remaining** → emits `budget_exhausted` AND aborts the run controller via
  `runController.abort(new Error(...))`.

**Caveat**: events go to the telemetry stream (dashboard's live feed), NOT to
the agent's own prompt/context. The worker doesn't get a system message
saying "you're at 80% of your token budget — wrap up." It only finds out by
getting aborted at the limit.

This is what the new feature fixes.

### Q2 — Rename for consistency

Done in PR #53: `settings.worker` → `settings.workerBudgets` (TS + YAML
`worker:` → `worker-budgets:`), `tokenBudgetScope` → `token-budget-scope`
(YAML key only; TS field stays camelCase).

## Final agreed plan: budget-strategy feature

### Config

```yaml
settings:
  worker-budgets:
    token-budget: 300000
    budget-strategy: default    # default | compact (respawn dropped — see rationale)
    progress-summary-token-limit: 2000  # shared cap for summarize_progress notes
```

Field shape on `WorkerGovernance`:

```ts
interface WorkerGovernance {
  // ... existing fields ...
  budgetStrategy?: "default" | "compact";
  progressSummaryTokenLimit?: number;  // default 2000
}
```

Schema validation: `budgetStrategy` must be `"default"` or `"compact"` if
provided. Any other value (including the legacy `"respawn"`) hard-fails at
config load.

### Strategies

Only two strategies ship in this PR. `respawn` was discussed and dropped —
see "Why respawn was dropped" below.

#### `default` (current behavior, made explicit + extended)

- **At ≤20% remaining**: emit `budget_warning` event to telemetry WITH a
  new optional field `interventionAvailable: true`. Append a prompt hint:

  ```
  ## Budget approaching limit
  Less than 20% of your worker token budget remains. Wrap up your
  current work and call `summarize_progress({ notes: "..." })` to
  record wrap-up state — the operator has been notified and may end
  the session, trigger /compact, or respawn you at this point. The
  notes travel with you regardless of which action is taken.
  ```

- **`summarize_progress` tool** under this strategy: stores notes on
  `runtime.progressNotes` only (the `compact: true` flag is silently
  ignored). Operator drives the intervention.

- **At 0% remaining**: abort the run controller with `budget exhausted`.
  Notes preserved on `runtime.progressNotes` for operator inspection.

#### `compact`

- **At ≤20% remaining**: emit `budget_warning` event WITHOUT
  `interventionAvailable`. Append a different prompt hint:

  ```
  ## Budget approaching limit
  Less than 20% of your worker token budget remains. You will be
  force-compacted at 0%. To control the compact timing:
    • Reach a natural stopping point in your task
    • Call `summarize_progress({ notes: "..." })` to record wrap-up notes
    • Call `summarize_progress({ notes: "...", compact: true })` to record AND compact now
    • Otherwise the system force-compacts at 0% with the last recorded notes
  Keep notes tight (default cap: 2000 tokens) so the new context window
  isn't dominated by the report.
  ```

- **`summarize_progress` tool** under this strategy: stores notes AND
  triggers `/compact` when `compact: true` is passed.

- **At 0% remaining**: force `/compact` using the last stored
  `runtime.progressNotes` (or empty notes if none were recorded).

### New tool: `summarize_progress({ notes, compact? })`

Registered for ALL workers regardless of strategy. Two effects:

1. **Always**: stores `notes` on `runtime.progressNotes` (new field on
   `AgentRuntime`). Overwrites previous notes — the latest call wins.

2. **Conditionally**: when `compact === true` AND strategy is `compact`,
   triggers `/compact` on the worker session. Prepends the stored notes
   to the next prompt:

   ```
   ## Context handoff (from before /compact)
   <notes>
   ```

   Under `default` strategy, the `compact` flag is silently ignored
   (tool returns success but doesn't trigger compact).

#### Validation

- `notes` must be a string. If non-empty, must be under
  `progressSummaryTokenLimit` tokens (default 2000). Over-cap returns
  an error so the worker can trim and retry.
- `compact` is optional, defaults to `false`.

### New runtime field

```ts
interface AgentRuntime {
  // ... existing fields ...
  // Last progress notes recorded via summarize_progress. Stays on the
  // runtime until the worker session is destroyed or replaced.
  // Available to operator-facing interventions (end / compact / respawn).
  progressNotes?: string;
}
```

Survives `/compact` (compact doesn't destroy the runtime). Available to
operator-facing interventions via `runtime.progressNotes`.

### Operator intervention (this PR)

For now, only **End** is wired as a real action. Compact and Respawn are
scaffolded but the actual UI / command surface is follow-up work.

- **End** — new dispatch command `endWorkerSession(agentName, reason)`:
  aborts the worker's run controller with a friendly "operator ended
  session" message. Emits a `session_ended_by_operator` event for
  telemetry. Notes preserved on `runtime.progressNotes`.

- **Compact** — uses the same `/compact` machinery `summarize_progress`
  triggers. Underlying mechanism is already there for the `compact`
  strategy; the operator-facing UI/command can land later.

- **Respawn** — deferred entirely. UI should hide the button or surface
  "not yet supported."

### Telemetry event change

`budget_warning` payload gains one optional field:

```ts
{
  agent: "...",
  scope: "worker",         // or "team"
  resource: "tokens",      // or "cost"
  remaining: 100,
  limit: 500,
  interventionAvailable: true,   // NEW; true ONLY for default strategy
}
```

Dashboard reads `interventionAvailable` to decide whether to show
"End / Compact / Respawn" buttons. The buttons themselves are follow-up
work — this PR just emits the flag.

## File list

**Modified:**
- `src/core/types.ts` — add `budgetStrategy`, `progressSummaryTokenLimit`
  to `WorkerGovernance`; add `progressNotes?: string` to `AgentRuntime`
- `src/core/schema.ts` — accept new fields, reject unknown strategy values
- `src/core/config-validation.ts` — extend `GOVERNANCE_KEYS` with
  `"budgetStrategy"` and `"progressSummaryTokenLimit"`
- `src/engine/dispatch.ts` — wire `applyBudgetStrategy` after `emitHiveEvent`
  in the existing `warn()` callback; emit `interventionAvailable` flag for
  `default` strategy
- `src/agents/tools.ts` — register `summarize_progress` for workers

**New:**
- `src/engine/budget-strategy.ts` — strategy application:
  - `applyBudgetStrategy(state, runtime, info)` — returns the prompt hint
    string for the strategy, or empty string
  - `triggerSummarizeProgress(state, runtime, notes)` — stores notes on
    runtime, optionally triggers `/compact`
- `src/agents/tools/summarize-progress.ts` — the tool implementation
- New dispatch command `endWorkerSession(agentName, reason)` — locate
  the agent's runtime, abort its run controller, emit
  `session_ended_by_operator` event

**Tests:**
- `tests/budget-strategy.test.ts` (new file) — strategy tests
- `tests/tools-branches.test.ts` — extend with `summarize_progress` tool tests

## Test list

1. `default` strategy emits "wrap up" hint at ≤20%
2. `compact` strategy emits "request compact" hint at ≤20%
3. `default` strategy emits `budget_warning` with `interventionAvailable: true`
4. `compact` strategy does NOT set `interventionAvailable`
5. `summarize_progress({ notes })` stores notes on runtime under both strategies
6. `summarize_progress({ notes, compact: true })` triggers `/compact` under
   `compact` strategy
7. `summarize_progress({ notes, compact: true })` ignores `compact` flag
   under `default` strategy (notes still stored)
8. `summarize_progress` rejects notes over `progressSummaryTokenLimit`
   tokens with clear error (current size + limit in message)
9. `compact` strategy at 0% force-compacts using last stored notes
   (or empty if none)
10. `default` strategy at 0% aborts (notes preserved on runtime)
11. Unknown `budgetStrategy` value (including `"respawn"`) rejected at
    config load with clear error message
12. Per-agent `governance:` override of `budgetStrategy` wins over
    `settings.worker-budgets.budgetStrategy`
13. `endWorkerSession` aborts the worker's run controller and emits the
    `session_ended_by_operator` event; notes remain on `runtime.progressNotes`

## Implementation order (suggested)

1. Types first: `src/core/types.ts` (budgetStrategy,
   progressSummaryTokenLimit, progressNotes)
2. Schema validation: `src/core/schema.ts` + `src/core/config-validation.ts`
   with config-load test
3. New tool: `src/agents/tools/summarize-progress.ts` + register in
   `src/agents/tools.ts` + tests for the tool alone (size cap, compact
   flag)
4. Strategy dispatch: `src/engine/budget-strategy.ts` (applyBudgetStrategy
   + triggerSummarizeProgress) + wire into `src/engine/dispatch.ts`
5. End-session command: `endWorkerSession` (dispatch command)
6. Run the full test matrix; commit + push + open PR

## Pitfalls to watch for

- **`runtime.progressNotes` lifetime**: stays on the runtime object across
  `/compact`. Make sure `/compact` doesn't blow away the runtime — only
  the conversation history. Verified by reading the Pi SDK compact
  implementation before assuming.

- **`compactHandoffLimit` → `progressSummaryTokenLimit` rename is
  intentional**: the cap applies to BOTH strategies under the new
  design. Don't be tempted to keep the old name for backward compat —
  the field is new in this PR.

- **Tool name `summarize_progress` not `request_compact`**: the rename
  is deliberate. `summarize_progress` separates "store notes" (works
  under any strategy) from "compact now" (only honored under `compact`).
  Earlier drafts used `request_compact({ handoff_notes })` which was
  tighter but didn't work for `default`.

- **Dispatch warning dedup**: the existing `state.budgetWarnings` Set
  keys dedupe on `${scope}:${resource}:${agent|team}`. Keep this
  mechanism. The new `state.pendingPromptWarnings` (if introduced) is
  NOT part of this PR — we discussed it in the prior turn but didn't
  ship it. The strategy's prompt hint fires once via the same dedup.

- **Stale process**: after editing `src/engine/dispatch.ts`,
  `src/agents/tools.ts`, or anything in `src/observability/server/**`, the
  running `pi -e .` won't pick up changes. Restart:
  ```sh
  PID=$(lsof -nP -iTCP:43191 -sTCP:LISTEN -t) && kill "$PID" && just pi-dev
  ```

## Out of scope for this PR

- Dashboard intervention UI (the "End / Compact / Respawn" buttons).
  The `interventionAvailable` flag is emitted; the UI consumes it later.
- Respawn strategy / UI. Dropped per discussion (see below).
- Mid-conversation budget intervention. The compact/abort only fires at
  turn boundaries; the prompt hint won't reach a worker mid-stream.
- Auto-compact at `agent_end` turn boundaries. Worker drives the
  timing under `compact` strategy; system backstops at 0%.

## Why respawn was dropped

If we had kept it:

```yaml
settings:
  worker-budgets:
    budget-strategy: respawn
```

Behavior would have been: at ≤20%, snapshot worker state to a sidecar,
abort, spawn new session with fresh context, re-prime with the task.

Reason for dropping: respawn loses conversation continuity even if the
new session is told the task. The worker has to re-derive conclusions it
drew mid-task from tool outputs — exactly the noise `/compact` is
designed to summarize. And the Pi SDK session-restart machinery isn't a
one-liner — it touches session lifecycle, hooks, and event sequencing.
Cleaner to ship `default` + `compact` first and revisit `respawn` only if
operators actually hit the case where `/compact` leaves them stranded.

## Open questions for next session (none blocking)

The plan is complete enough to start coding. If during implementation you
hit something that wasn't anticipated (e.g., the Pi SDK doesn't expose a
clean way to abort a specific worker session, or the strategy needs to
fire before the warning dedup), surface it and we can adjust.

## Files referenced for orientation

- `src/engine/dispatch.ts:597-620` — existing warn() callback (where the
  strategy dispatch hooks in)
- `src/engine/prompts.ts:128` — existing buildBudgetVisibility function
  (NOT modified by this PR; the strategy's prompt hint is a separate
  block)
- `src/core/types.ts:191-205` — `WorkerGovernance` interface (where the
  new fields go)
- `src/core/schema.ts:68-86` — `validateAgent` (where new field
  validation goes)
- `src/agents/tools.ts` — tool registry (where `summarize_progress`
  gets registered)

## Branch + worktree plan

```
main:        2d721a9 (current)
worktrees:   APP_ROOT only, on main
open PRs:    none

Next session:
1. cd /Users/cgrant/.pi/agent/git/github.com/demetere/pi-hive
2. git worktree add .worktrees/feat-budget-strategy -b feat/budget-strategy main
3. ln -s "$APP_ROOT/node_modules" "$APP_ROOT/.worktrees/feat-budget-strategy/node_modules"
4. ln -s "$APP_ROOT/ui/web/node_modules" "$APP_ROOT/.worktrees/feat-budget-strategy/ui/web/node_modules"
5. Implement per the file/test lists above
6. Commit + push + open PR
7. Wait for user merge approval (per AGENTS.md — don't merge yourself)
```

---

## v2 changes

Three additions to the existing plan, plus a clarification on operator intervention.

### 1. Team-budget recalculation across compact and respawn (NEW)

Today's accounting: `team.tokens = Σ workerConsumedTokens(runtime)` where `workerConsumedTokens` returns the cumulative session-lifetime tokens. Compacts shrink `runtime.contextTokens` but leave `runtime.inputTokens` etc. unchanged, so today a compact frees zero team budget. The user wants this fixed.

Accounting model: **effective-context (option a)**. The worker's contribution to the team budget is its current context load, not cumulative API tokens. A worker that has used 100K cumulative but compacted down to 20K context now contributes 20K, not 100K.

**Cost is not recalculated.** Real API charges don't refund. Only the tokens budget gets the savings credit. The `costUsd` budget accounting stays cumulative.

Implementation:

- New field on `AgentRuntime` (`src/core/types.ts:225-273`):
  ```ts
  // Current context load. What this worker contributes to the team
  // token budget RIGHT NOW. Defaults to runtimeTokens(runtime). At
  // compaction_end, debited by (tokensBefore - estimatedTokensAfter).
  // Refreshed from runtime.contextTokens at message_end when available.
  effectiveTokens?: number;
  ```
- Modify `workerConsumedTokens` in `src/engine/governance.ts:55-60`:
  ```ts
  const prior = runtime.governanceTokens ?? runtime.effectiveTokens ?? runtimeTokens(runtime, scope);
  ```
  (`governanceTokens` still wins for the freeze-after-run case. The new `effectiveTokens` is the live path.)
- Drop the running-delta branch in `workerConsumedTokens` once `effectiveTokens` is the path — `effectiveTokens` is always authoritative; no `runStart*` subtraction needed.
- In `src/engine/dispatch.ts:542-555`, the existing `compaction_end` handler:
  ```ts
  } else if (event.type === "compaction_end") {
    const result = event.result || {};
    const tokensBefore = finiteOrUndef(result.tokensBefore ?? event.tokensBefore);
    const estimatedTokensAfter = finiteOrUndef(result.estimatedTokensAfter ?? event.estimatedTokensAfter);
    if (tokensBefore != null && estimatedTokensAfter != null && tokensBefore > estimatedTokensAfter) {
      const savings = tokensBefore - estimatedTokensAfter;
      const current = runtime.effectiveTokens ?? runtimeTokens(runtime);
      runtime.effectiveTokens = Math.max(0, current - savings);
      emitHiveEvent(state, "team_budget_recalculated", {
        agent: runtime.config.name,
        cause: "compaction",
        tokensBefore,
        tokensAfter: estimatedTokensAfter,
        savings,
        team: budgetRemaining(state, runtime).team,
      }, runtime.config.name);
    }
    // ... existing telemetry event ...
  }
  ```
- At every `message_end` in `src/engine/dispatch.ts` (around line 597), refresh: if `runtime.contextTokens` is set and `runtime.contextTokens < (runtime.effectiveTokens ?? Infinity)`, set `runtime.effectiveTokens = runtime.contextTokens`. Keeps the live number fresh between compacts.
- New telemetry event `team_budget_recalculated` (`src/shared/telemetry.ts`) with payload `{ agent, cause, tokensBefore, tokensAfter, savings, team }`. Dashboard reads this to surface "team budget freed by compact N tokens" in the UI.

Tests for compact recalc (add to `tests/budget-strategy.test.ts`):

1. `compaction_end` with `tokensBefore=80_000`, `estimatedTokensAfter=20_000` debits 60K from `runtime.effectiveTokens`.
2. `team.budgetRemaining.team.tokens` reflects the debit immediately (next `budgetRemaining` call shows the larger remaining).
3. Team that was at-budget can dispatch a new worker after a compact frees enough.
4. Multiple sequential compactions accumulate: 100K → 30K → 10K = 90K total savings.
5. Cost budget is NOT debited — `runtime.costUsd` and team cost are unchanged by compact.
6. `compaction_end` without `tokensBefore`/`estimatedTokensAfter` is a no-op (no crash, no debit).

### 2. Respawn as an operator intervention (NEW)

The user clarified: **respawn is one of three operator actions under the default strategy**, alongside End and Compact. It is NOT a strategy of its own. The compact strategy is fully automatic — no operator actions exposed there (see point 3).

Implementation: new dispatch command `respawnWorkerSession(agentName, reason, newTask?)` in `src/engine/dispatch.ts`. Lives next to `endWorkerSession` from the original plan.

- Locate the runtime by agentName (same lookup pattern as `endWorkerSession`).
- If the runtime is currently running, abort it via `runController.abort(new Error("respawned by operator"))` — same teardown pattern as `endWorkerSession`.
- Archive the old session (existing fresh=true archive logic at `dispatch.ts:278` already handles this).
- Remove the old runtime from `state.runtimes` (this is what makes the team total drop — it's no longer iterated by `teamUsage`).
- Emit `team_budget_recalculated` with `cause: "respawn"`, `savings: runtime.effectiveTokens ?? workerConsumedTokens(runtime)`, `team`: budgetRemaining snapshot at the moment of destruction.
- Create a new runtime for the same agent (call into the existing `loadAgentRuntime` + `dispatchAgent` chain — verify the hook into `dispatchAgent` doesn't already require a "create new runtime" entrypoint; if it does, factor one out).
- Dispatch the new runtime with the same task (or `newTask` if provided), `fresh=true`, the same `delegationDepth`, and caller recorded as `"operator"` (or a new `OperatorDelegation` parent type if the dispatch machinery doesn't accept arbitrary caller names — check `dispatchAgent`'s signature).
- New runtime starts with `effectiveTokens` undefined → `workerConsumedTokens` falls back to `runtimeTokens` which is 0 at creation. Team total naturally reflects the drop.

Tests for respawn (add to `tests/budget-strategy.test.ts`):

7. `respawnWorkerSession` on a finished worker: old runtime gone from `state.runtimes`, new runtime present, new runtime's `effectiveTokens` undefined, team total drops by the old runtime's contribution.
8. `respawnWorkerSession` on a running worker: in-progress `runController` aborted, session archived, new runtime created.
9. `respawnWorkerSession` with `newTask`: re-dispatches with the new task string.
10. `respawnWorkerSession` without `newTask`: re-dispatches with the original `runtime.task`.
11. `team_budget_recalculated` event emitted with `cause: "respawn"` and the pre-respawn worker's effective tokens as savings.

Edge cases the next session should design for (open questions, not blockers):

- What if the agent name has no runtime yet? Return a clear error.
- What if the operator respawns twice in quick succession? The second one targets the NEW runtime — is that the right semantic, or should we record "this is the second respawn of an originally-respawned session"?
- Respawn + compact strategy: the operator shouldn't be able to trigger a respawn under compact strategy anyway (no operator commands wired — see point 3). Document this.

### 3. Operator intervention surface is strategy-conditional (CLARIFICATION)

The user clarified: under the compact strategy, the operator gets NO action items. The strategy is automatic — `summarize_progress({ compact: true })` is the worker's tool, and the system backstops at 0% with a forced compact. No End / Compact / Respawn buttons.

Under the default strategy, the operator gets all three: End / Compact / Respawn.

Implementation:

- The `interventionAvailable: true` flag on `budget_warning` (already in the original plan) is set ONLY for default strategy. compact strategy does NOT set it. This is the gate the dashboard reads to decide whether to show the buttons.
- All three dispatch commands (`endWorkerSession`, `compactWorkerSession`, `respawnWorkerSession`) live in `src/engine/dispatch.ts`. The dashboard intervention UI (out of scope for this PR per the original plan) reads `interventionAvailable` plus the worker's runtime strategy to decide which commands to expose. **The dispatch commands themselves don't gate on strategy** — that's a UI concern, not an engine concern. Document this in the plan so the future dashboard work doesn't try to add strategy checks to the dispatch commands.

The original plan mentioned `compactWorkerSession` only as "scaffolded, follow-up work." With this change it's a real command in scope. Wire it the same way as `respawnWorkerSession` but instead of creating a new runtime, it triggers `/compact` on the existing session. Verify the Pi SDK exposes a clean way to invoke `/compact` from outside the session (likely through `session.compact()` or sending a `/compact` slash command — check `node_modules/@earendil-works/pi-coding-agent` for the method name before designing).

Tests for the strategy-conditional intervention (add to `tests/budget-strategy.test.ts`):

12. compact strategy emits `budget_warning` WITHOUT `interventionAvailable` (already in the original plan as test #4).
13. default strategy emits `budget_warning` WITH `interventionAvailable: true` (already in the original plan as test #3).
14. (UI concern, not engine — note in plan that dashboard intervention UI must check strategy before exposing buttons.)

### Updated file list (delta from original plan)

**Modified:**
- `src/core/types.ts` — add `effectiveTokens?: number` to AgentRuntime (after the `governanceTokens` block at line ~245)
- `src/engine/governance.ts` — modify `workerConsumedTokens` to use `effectiveTokens`; drop the running-delta branch since `effectiveTokens` is always authoritative
- `src/engine/dispatch.ts` — refresh `effectiveTokens` from `runtime.contextTokens` at `message_end`; debit at `compaction_end` (point 1); add `compactWorkerSession` and `respawnWorkerSession` dispatch commands (point 2)
- `src/shared/telemetry.ts` — add `team_budget_recalculated` event type
- `budget-strategy-plan.md` (this file, in `raw-evidence/`) — append the v2 sections above; bump the test count from 13 to ~22

**New:**
- (None — all the recalc and respawn logic lives in existing files. The `budget-strategy.ts` module from the original plan is still new.)

**Tests:**
- `tests/budget-strategy.test.ts` (new, from original plan) — extend with the 11 new test cases listed above

### Updated branch + worktree plan + verification gates

```
main:        2d721a9 (current)
worktrees:   APP_ROOT only, on main
open PRs:    none

Next session:
1. Append v2 sections to `budget-strategy-plan.md` (this file, now in `raw-evidence/`; was originally in `tmp/` of APP_ROOT)
2. cd /Users/cgrant/.pi/agent/git/github.com/demetere/pi-hive
3. git worktree add .worktrees/feat-budget-strategy -b feat/budget-strategy main
4. ln -s "$APP_ROOT/node_modules" "$APP_ROOT/.worktrees/feat-budget-strategy/node_modules"
5. ln -s "$APP_ROOT/ui/web/node_modules" "$APP_ROOT/.worktrees/feat-budget-strategy/ui/web/node_modules"
6. Implement per the file/test lists above
7. Commit + push + open PR
8. Wait for user merge approval (per AGENTS.md — don't merge yourself)

Verification gates at end:
- ~489-491 server tests pass (baseline 467 + 13 from original plan + ~11 new from v2 = ~491). The user's v2 message arithmetic ("was 461 + 13 + 11 = ~478") is inconsistent with the HANDOFF.md live baseline of 467/467 server; treat 467 as the actual baseline. (The plan-update author wasn't sure whether the user meant a different baseline or made an arithmetic slip — verified by HANDOFF.md that 467 is current main.)
- 49/49 dashboard tests pass (no dashboard changes in this PR)
- just typecheck clean
- npx eslint <touched files> exit 0
- just review-vendor-verify pass (no review src changes, but verify)
- node scripts/check-package-budgets.mjs pass
- dashboard build NOT required (no ui/web/src changes)
```

### Pitfalls to flag (v2)

- `runtime.contextTokens` is only populated at run end today (see `dispatch.ts:670-674`). For live `effectiveTokens` to be useful, it needs to refresh at `message_end` too. Verify `session.getContextUsage()` is callable mid-run — if not, only refresh at `compaction_end` and accept that the live number lags during a run.

- The existing `workerConsumedTokens` while-running logic uses `governanceTokens + (runtimeTokens(now) - runtimeTokens(runStart))`. After switching to `effectiveTokens`, this branch becomes redundant — `effectiveTokens` is always authoritative, so the function simplifies to: `return governanceTokens ?? effectiveTokens ?? runtimeTokens(runtime, scope)`. No delta math.

- **Respawn must destroy the old runtime BEFORE creating the new one.** If both exist transiently, `teamUsage` double-counts during the gap. Either (a) do the destroy + create inside a single synchronous block (no awaits between them), or (b) gate the new runtime's `effectiveTokens` at 0 until the old one is gone.

- Respawn's session archive uses the existing `fresh=true` archive logic at `dispatch.ts:278`. Verify that path doesn't crash when the run was aborted by `runController.abort()` — there may be ordering assumptions (e.g., assumes the session completed cleanly).

- **Pi SDK /compact API surface:** confirm the method exists on session (`session.compact()`?) before designing `compactWorkerSession`. If it's a slash command instead, the dispatch command needs to inject it as a user message — different wire entirely. Check `node_modules/@earendil-works/pi-coding-agent/dist/` for the type.

- Stale-process trap still applies (pitfall #1 in HANDOFF.md). Changes to `src/engine/dispatch.ts` and `src/engine/governance.ts` require killing the `pi -e .` process. Standard `PID=$(lsof -nP -iTCP:43191 -sTCP:LISTEN -t) && kill "$PID" && just pi-dev`.

- **Operator command availability is NOT gated by strategy in the dispatch layer.** All three commands (`endWorkerSession`, `compactWorkerSession`, `respawnWorkerSession`) accept any strategy. The dashboard UI is the only layer that filters by strategy (via `interventionAvailable`). Document this in the engine code so future dashboard work doesn't try to add strategy checks to the dispatch commands.
