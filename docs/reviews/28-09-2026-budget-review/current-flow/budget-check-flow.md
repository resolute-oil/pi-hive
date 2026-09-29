# Current flow — budget check

When and how the budget layer says "no". This file documents the three places the budget is consulted: at dispatch time (pre-flight), at every `message_end` (mid-run), and at compaction events (token recalculation).

## 1. Pre-flight — `checkDispatchBudgets`

### Location

`src/engine/governance.ts:73-104`. Called twice during `dispatchAgent`:

1. `src/engine/dispatch.ts:252` — immediately after the `canDelegateTo` and running-status guards, BEFORE the worker slot is acquired.
2. `src/engine/dispatch.ts:302` — AFTER the slot is acquired, in case queueing changed the budget state.

### Sequence of checks

```ts
export function checkDispatchBudgets(state: HiveState, runtime: AgentRuntime, depth: number): GovernanceBlock | undefined {
  const limits = effectiveWorkerGovernance(state, runtime);
  const teamLimits: TeamBudgets = state.config?.settings.teamBudgets || {};
  const workerScope = limits.tokenBudgetScope ?? "all";
  const teamScope = teamLimits.tokenBudgetScope ?? "all";
  const team = teamUsage(state, teamScope);
  if (limits.maxDelegationDepth !== undefined && depth > limits.maxDelegationDepth) { ... }
  if (limits.maxRuns !== undefined && runtime.runCount >= limits.maxRuns) { ... }
  if (limits.tokenBudget !== undefined && workerConsumedTokens(runtime, workerScope) >= limits.tokenBudget) { ... }
  if (limits.costBudgetUsd !== undefined && workerConsumedCost(runtime) >= limits.costBudgetUsd) { ... }
  if (teamLimits.maxRuns !== undefined && team.runs >= teamLimits.maxRuns) { ... }
  if (teamLimits.tokenBudget !== undefined && team.tokens >= teamLimits.tokenBudget) { ... }
  if (teamLimits.costBudgetUsd !== undefined && team.costUsd >= teamLimits.costBudgetUsd) { ... }
}
```

The function returns the FIRST blocking condition in declaration order. There is no "most-severe block" logic; depth is checked before runs before tokens, regardless of which is closer to exhaustion.

### Worker vs team scope

Each check is scoped: `worker` blocks dispatch to that specific agent; `team` blocks dispatch to ANY non-orchestrator worker because the team total is taken into account.

```ts
const team = teamUsage(state, teamScope);  // sum across all non-orchestrator runtimes
```

`teamUsage` (lines 61-70) sums `workerConsumedTokens` and `workerConsumedCost` across every runtime in `state.runtimes` except the orchestrator.

### Token scope resolution

```ts
const workerScope = limits.tokenBudgetScope ?? "all";
const teamScope = teamLimits.tokenBudgetScope ?? "all";
```

Both worker and team can independently pick "input_output" or "all". This is per the budget-strategy plan v1: a project may want worker budgets on context-relevant tokens (input+output only) and team budgets on cumulative (including cache hits).

### Dispatcher integration

`src/engine/dispatch.ts:252-258`:

```ts
const delegationDepth = currentDelegationDepth() + 1;
const blocked = checkDispatchBudgets(state, runtime, delegationDepth);
if (blocked) {
  emitHiveEvent(state, "budget_exhausted", { agent: runtime.config.name, resource: blocked.resource, scope: blocked.scope, remaining: budgetRemaining(state, runtime) }, caller);
  return { output: `Delegation blocked: ${blocked.message}`, exitCode: 1, elapsed: 0 };
}
```

The `budget_exhausted` event carries `agent`, `resource`, `scope`, and `remaining`. The dashboard's Plans UI reads this event to display "X tokens remaining". The orchestrator sees the human-readable "Delegation blocked" string in its context.

### What `effectiveWorkerGovernance` resolves

`src/engine/governance.ts:20`:

```ts
return { ...(state.config?.settings.workerBudgets || {}), ...(runtime.config.governance || {}) };
```

Per-agent `governance:` (in the agent's `.md` frontmatter) overrides `settings.workerBudgets` (in `hive-config.yaml`). Omitted fields inherit. Unset fields = unlimited.

## 2. Mid-run — `message_end` event handler

### Location

`src/engine/dispatch.ts:646-708`. Every time the SDK finishes an assistant message, this handler runs.

### What it does

```ts
const usage = message?.usage;
if (usage) {
  const u = extractUsage(usage);
  runtime.inputTokens += u.input;
  runtime.outputTokens += u.output;
  runtime.cacheReadTokens += u.cacheRead;
  runtime.cacheWriteTokens += u.cacheWrite;
  runtime.reasoningTokens += u.reasoning;
  runtime.costUsd += u.cost;

  const remaining = budgetRemaining(state, runtime);
  const teamLimits = state.config?.settings.teamBudgets || {};
  const warn = (left: number | undefined, limit: number | undefined, scope: "worker" | "team", resource: "tokens" | "cost") => {
    if (left === undefined || limit === undefined || left <= 0 || left / limit > 0.2) return;
    const warningKey = `${scope}:${resource}:${scope === "worker" ? agentSlug(runtime.config) : "team"}`;
    const warnings = state.budgetWarnings ||= new Set<string>();
    if (warnings.has(warningKey)) return;
    warnings.add(warningKey);
    emitBudgetWarning(state, runtime, { scope, resource, remaining: left, limit });
  };
  warn(remaining.worker.tokens, governance.tokenBudget, "worker", "tokens");
  warn(remaining.worker.costUsd, governance.costBudgetUsd, "worker", "cost");
  warn(remaining.team.tokens, teamLimits.tokenBudget, "team", "tokens");
  warn(remaining.team.costUsd, teamLimits.costBudgetUsd, "team", "cost");

  const exhausted = remaining.worker.tokens === 0 ? { scope: "worker", resource: "tokens" }
    : remaining.worker.costUsd === 0 ? { scope: "worker", resource: "cost" }
    : remaining.team.tokens === 0 ? { scope: "team", resource: "tokens" }
    : remaining.team.costUsd === 0 ? { scope: "team", resource: "cost" }
    : undefined;
  if (exhausted && !runController.signal.aborted) {
    emitHiveEvent(state, "budget_exhausted", { agent: runtime.config.name, ...exhausted, remaining }, runtime.config.name);
    runController.abort(new Error(`${exhausted.scope} ${exhausted.resource} budget exhausted`));
  }
}
```

### Three effects

1. **Increment the live counters** (`runtime.inputTokens += u.input`, etc.). This is the value `workerConsumedTokens` reads when `status === "running"` (Bug 2 fix in `3be33f6`).

2. **Emit `budget_warning`** when remaining is ≤20% of limit, deduped by `${scope}:${resource}:${agent|team}`. This is the `state.budgetWarnings` Set — it persists for the worker's lifetime and prevents re-warning on every message.

3. **Emit `budget_exhausted` AND abort** when remaining is 0. The `runController.abort(...)` cancels the in-progress turn via the `AbortController` that owns the worker's run. The error string is the model-facing reason.

### Live refresh of `effectiveTokens`

Just before the usage block, this guard runs:

```ts
if (typeof runtime.contextTokens === "number" && (runtime.effectiveTokens === undefined || runtime.contextTokens < runtime.effectiveTokens)) {
  runtime.effectiveTokens = runtime.contextTokens;
}
```

When the SDK reports a smaller context fill than the current `effectiveTokens`, `effectiveTokens` is updated. This is the "current context load" tracking. After a `compaction_end`, this guard is the path that updates the team total (compaction_end debits `effectiveTokens`; message_end prevents it from drifting back up).

### The mid-run abort trap

When the abort fires at `0% remaining`, the rest of the run still completes:

- `session.prompt()` returns/throws.
- The end-of-run code runs (`getSessionStats` overwrite, `lifecycle.close`, the `finally` block).
- The `governanceTokens += delta` accumulation runs.

The next `checkDispatchBudgets` for the same runtime will see the new `governanceTokens` value (which may be > limit). This is by design — the abort does not roll back the consumed budget.

## 3. Compaction — `compaction_end` event handler

### Location

`src/engine/dispatch.ts:600-633`. Runs when the SDK finishes compacting the context window.

### What it does

```ts
const tokensBefore = finiteOrUndef(result.tokensBefore ?? event.tokensBefore);
const estimatedTokensAfter = finiteOrUndef(result.estimatedTokensAfter ?? event.estimatedTokensAfter);
if (tokensBefore != null && estimatedTokensAfter != null && tokensBefore > estimatedTokensAfter) {
  const savings = tokensBefore - estimatedTokensAfter;
  const prior = workerConsumedTokens(runtime);
  runtime.effectiveTokens = Math.max(0, prior - savings);
  emitHiveEvent(state, "team_budget_recalculated", {
    agent: runtime.config.name,
    cause: "compaction",
    tokensBefore,
    tokensAfter: estimatedTokensAfter,
    savings,
    team: budgetRemaining(state, runtime).team,
  }, runtime.config.name);
}
```

The `effectiveTokens` is debited by `(tokensBefore - estimatedTokensAfter)`. The team total (`team.tokens`) is updated to reflect the smaller worker contribution. Cost is NOT recalculated.

### Why `effectiveTokens` and not `governanceTokens`

`governanceTokens` is the frozen-at-`agent_end` total that survives respawn. `effectiveTokens` is the live "current context load" that compaction can shrink. The split is intentional:

- Cumulative budget accounting (`governanceTokens`) doesn't refund — a worker that consumed X tokens can't get them back even after compacting.
- Live context-load accounting (`effectiveTokens`) does shrink — a worker whose context window is now smaller contributes less to the team total.

### When the recalc is a no-op

If `tokensBefore == null || estimatedTokensAfter == null || tokensBefore <= estimatedTokensAfter`, no recalc fires. A failed compact (aborted, errored, no result fields) is silently ignored. Tests at `tests/budget-strategy.test.ts` (compaction recalc section) pin this no-op behavior.

## 4. Operator intervention — three dispatch commands

`src/engine/dispatch.ts:929-1099`. Three exported commands:

- `endWorkerSession(state, agentName, reason)` — aborts the worker's session and emits `session_ended_by_operator` with `action: "end"`. Notes preserved on `runtime.progressNotes`.
- `compactWorkerSession(state, agentName, reason)` — aborts the current session, then calls `session.compact(progressNotes || "")`. Emits `session_ended_by_operator` with `action: "compact"` (or `action: "compact_failed"` on error).
- `respawnWorkerSession(state, agentName, reason, newTask?, ctx?, dispatch?, loadRuntime?)` — aborts the old session, emits `team_budget_recalculated` with `cause: "respawn"` and `savings: workerConsumedTokens(runtime)`, removes the runtime from `state.runtimes`, creates a new runtime via `loadRuntime`, sets it in `state.runtimes`, then fires-and-forgets a `dispatch(state, agentName, taskToUse, ctx, true)` (the `true` = fresh).

### Strategy gating

None of the three commands gate on strategy. The dashboard's UI is the only layer that filters by strategy, via the `interventionAvailable` flag on `budget_warning`. The dispatch `state` table itself does not check the strategy.

This is by design per `tmp/budget-strategy-plan.md#3-operator-intervention-surface-is-strategy-conditional-clarification`: "All three dispatch commands (`endWorkerSession`, `compactWorkerSession`, `respawnWorkerSession`) live in `src/engine/dispatch.ts`. The dashboard intervention UI ... reads `interventionAvailable` plus the worker's runtime strategy to decide which commands to expose. The dispatch commands themselves don't gate on strategy."

## 5. Tests pinning the contract

| File / test | What it pins |
|---|---|
| `tests/governance.test.ts:1-60` | "worker governance is unlimited when omitted" — no cap means no block |
| `tests/governance.test.ts:62-90` | worker + team budgets block independently; `effectiveWorkerGovernance` precedence |
| `tests/governance.test.ts:92-100` | monotonic governance prevents fresh transcript reset from bypassing budget |
| `tests/governance.test.ts:102-135` | FIFO queue semantics + cancellation |
| `tests/governance.test.ts:137-167` | `tokenBudgetScope: "input_output"` excludes cache; `"all"` includes it |
| `tests/dispatch-usage.test.ts:385-430` | **Bug 1 regression:** fresh=true zeros counters BEFORE checkDispatchBudgets |
| `tests/dispatch-usage.test.ts:489-535` | **W1.1 regression:** fresh-delta uses fresh session's usage, not clamped to 0 |
| `tests/budget-strategy.test.ts` | 38 new tests for the budget-strategy feature (default + compact, summarize_progress, operator commands, compaction recalc) |

## Key observations

1. **Three events (`message_end`, `compaction_end`, `agent_end`) all touch the budget counters.** Each event has its own semantics for which counter to update and when to emit telemetry. The event-by-event treatment is correct in isolation but the cumulative effect across an abort-then-end sequence is what creates the "third mystery bug" (see `fresh-true-bug-timeline.md`).

2. **The dual-counter system (`governanceTokens` frozen + `runtime.*` live + `effectiveTokens` mid) is the source of complexity.** Every consumer (`checkDispatchBudgets`, `budgetRemaining`, mid-run check) has to pick the right counter for the right moment. The current pick is "live while running, frozen after end, fallback to context load if frozen is missing". Three layers of ?? fallthrough. The bug lives in the order in which these get written.

3. **The warning dedup key is `${scope}:${resource}:${agent|team}`.** This means a worker that gets a worker-tokens warning will not re-warn for worker-tokens, but a worker that gets both a worker-tokens warning AND a team-cost warning will see both. The dedup is correct; the implication is that multiple warning events per worker are expected.

4. **`emitBudgetWarning` mutates `runtime.systemPrompt` — which is NOT the SDK's read-only `session.systemPrompt`.** This side effect happens in `src/engine/budget-strategy.ts:91-117`. The strategy hint text is appended to `runtime.systemPrompt` with a sentinel-dedup check.

   **Important distinction:** `runtime.systemPrompt` is a field on `AgentRuntime` (`src/core/types.ts:223`). It is pi-hive's own string copy that `buildWorkerPrompt` assembles from and then passes to `session.prompt(...)` as the worker prompt. It is NOT the SDK's `session.systemPrompt` accessor, which the docs (`sdk.md#session-management`) explicitly describe as "read-only and returns the current effective system prompt, including changes that have not yet been sent to the model." The mutation never touches the SDK's read-only accessor. If a future refactor switches to reading `session.systemPrompt` to inject the hint, it will fail because that accessor is read-only — the right Pi-pattern for an extension-side prompt mutation is `pi.sendMessage({...}, {triggerTurn: false, deliverAs: "followUp"})` (CustomMessage) per `extensions.md#work-with-events` (see `pi-docs/extension-patterns-reference.md#5-event-handlers`).

   Note: a worker that gets aborted, resets the prompt on the next session, and triggers another warning will see the hint again (the sentinel won't be there). This is intentional per the comment: "the hint is strategy-level (not warning-level)."

5. **The mid-run abort is `runController.abort(...)`, not `session.abort()`.** This is the local `AbortController` constructed at `src/engine/dispatch.ts:364`. The SDK session keeps running until the next model call hits the controller's `signal.aborted` check. The exception is the message that triggered the abort; subsequent messages never start. The end-of-run code (after `session.prompt()` returns/throws) still runs the full `getSessionStats` overwrite and `governanceTokens` accumulation.

   **Three different abort / dispose primitives in play** — chosen for three different lifecycle moments:

   | Primitive | What it does | Where it's used in budget code | Why this primitive |
   |---|---|---|---|
   | `runController.abort(reason)` (local `AbortController`) | Cancels the in-progress run; SDK session stays alive | `message_end` handler at `src/engine/dispatch.ts:696` (budget exhausted) | Mid-run abort — the dispatcher wants to stop the current turn without tearing down the session |
   | `session.abort()` (SDK) | "Stops the active operation and waits for the session to become idle" (`sdk.md#session-management`) | `endWorkerSession` (`src/engine/dispatch.ts:956`), `compactWorkerSession` (`src/engine/dispatch.ts:992`), `respawnWorkerSession` (`src/engine/dispatch.ts:1028`) | Operator-initiated end-of-worker — the dispatcher wants the session idle so the next dispatch (or `session.compact`) can take over |
   | `session.dispose()` (SDK) | "Aborts active work, invalidates extension contexts, disconnects from the agent, and removes event listeners" (`sdk.md#session-management`) | Not currently called | Reserved for the cleanup path that releases the runtime entirely. Currently the runtime is replaced via `state.runtimes.delete(...)` + `set(...)` in `respawnWorkerSession`, but the old session's listeners are not explicitly disposed. Worth a follow-up. |

   The bug class lives in `runController.abort()` semantics: the run-end code still runs the full accumulation math even though the run was aborted. Operator-driven `session.abort()` is fine because the operator explicitly ends the worker.

6. **The compaction recalc uses `prior = workerConsumedTokens(runtime)` as the basis.** If `runtime.status === "running"`, this returns `runtimeTokens(runtime, scope)` — the LIVE cumulative input+output+cache+reasoning. But `effectiveTokens` is supposed to be the live context load. The discrepancy is the "savings" math subtracts from a number that may differ from the assumed prior `effectiveTokens`. This is a second-order hazard that tests pin but doesn't fully exercise.

7. **Final-message accumulation is hooked on `agent_end`, not `agent_settled`.** The current handler at `src/engine/dispatch.ts:707-714` runs on `agent_end`, which per `sdk.md#subscribing-to-events` "marks the end of one low-level agent run, but automatic recovery or queued work can still follow." The cleaner event for "Pi will not continue automatically" is `agent_settled`. For the budget layer's purposes — finalizing counters, emitting `delegation_end`, releasing the worker slot — `agent_settled` would be more correct because any post-`agent_end` queued work could also consume budget. The current `dispatchAgent` finalization runs after `session.prompt()` resolves, which is close to `agent_settled` but not identical. Worth a follow-up if a future bug surfaces around budget accounting across multiple `agent_end` cycles in one worker session.