# Budget system

How `pi-hive` caps worker token spend, USD cost, run count, and delegation depth without races, leaks, or double-counting. This is the system overview — the YAML schema lives at [`tmp/budget-config-v2-template.md`](../tmp/budget-config-v2-template.md); the migration from v1 is at [`docs/migrations/budget-config-v2.md`](migrations/budget-config-v2.md).

## Overview

The budget subsystem sits between the `delegate_agent` dispatcher and the Pi `AgentSession` lifecycle. It enforces four resources — **tokens**, **cost (USD)**, **runs**, **delegation depth** — at two scopes — **per-worker** and **per-team** — by:

1. Resolving a `WorkerBudgetPolicy` (per-agent override of `settings.budgets:`) before each dispatch.
2. Restoring a per-worker `BudgetLedger` from the branch (`appendCustomEntry("pi-hive-budget-ledger", ...)` history).
3. Running the pre-flight gate (`checkBudgetPolicy`) that refuses to dispatch when caps are exceeded.
4. Subscribing to the worker's `AgentSession` events (`message_end`, `compaction_end`, `agent_settled`) and writing the ledger as cumulative spend changes.
5. Blocking the four mutating tools (`bash`, `edit`, `write`, `read`) at the `beforeToolCall` gate when the worker is exhausted.

### What bug class it eliminates

Three historical bug families drove the v2 design (per refactor-plan §1, §2.9):

- **Bug 1 — counter drift.** The old `runtime.inputTokens` etc. lived as mutable counters, patched by `subscribe(message_end)` deltas and reconciled on `agent_end`. A queued dispatch that drained between the initial check and session creation saw a different `getSessionStats()` than the check did. **Eliminated**: the ledger is a derived view; cumulative tokens/cost come from `session.getSessionStats()` only.
- **Bug 2 — dual-write races.** Subscribing to both `message_end` and `agent_end` opened two write paths that disagreed under abort. **Eliminated**: the canonical "Pi will not continue automatically" event is `agent_settled` (single finalization path, F4 / T4.1); `message_end` only updates the in-memory ledger and emits warnings/exhaustion.
- **Bug 3 — `fresh=true` not actually fresh.** The old `fresh` flag was a coupled 4-operation sequence with order-sensitive semantics. A bug at operation 3 of 4 left `runtime.* = 0` but `remaining.tokens = 0` after `fresh=true` abort. **Eliminated structurally**: a fresh session has no entries, `getBranch()` returns nothing, the ledger is empty, the run starts with zero spend. There is no counter to drift.

The new design makes the cap the cap: the only place tokens/cost are sourced is `session.getSessionStats()`, the only place caps are read is the resolved `WorkerBudgetPolicy`, and the only durable state is the `CustomEntry` ledger the SDK branches correctly across `/reload`, `/tree`, `/fork`.

## Lifecycle

The budget hooks attach in `createBudgetAwareSession` (`src/engine/budget/worker-tools.ts`) — the F2 spine called by `dispatchAgent` — and detach when the session disposes or the operator calls the unsubscribe returned by `installBudgetEventHooks`.

```
createBudgetAwareSession(state, agentName, { fresh? }, ctx, deps)
  │
  ├─ 1. resolveWorkerBudgetPolicy(state, agentName)  → WorkerBudgetPolicy
  ├─ 2. runBudgetPreflight(...)                      → throws BudgetExhaustedError on block
  │       │
  │       └─ checkBudgetPolicy(ledger, policy, branch, depth)
  ├─ 3. SessionManager.create(cwd) | .continueRecent(cwd) | .open(path)
  ├─ 4. BudgetLedger.restore(sessionManager, agentSlug, policy, ctx.signal)
  │       │
  │       └─ walks getBranch(), filters customType="pi-hive-budget-ledger",
  │          takes the latest entry for this agentSlug (or zeros for fresh)
  ├─ 5. createAgentSession({ sessionManager, cwd, ledger, ... })  via deps.createSession
  │       │
  │       └─ production deps.createSession adds model/tools/customTools/
  │          resourceLoader and merges the F5 worker-only tool set
  ├─ 6. installBudgetEventHooks(session, ledger, policy, sessionManager, controller)
  │       │
  │       └─ subscribes to the session; handler dispatches on event.type
  ├─ 7. if deps.installWorkerHooks: installWorkerBudgetHooks({ session,
  │       sessionManager, policy, ledger, controller, currentDelegationDepth })
  │       │
  │       └─ wires createBudgetToolCallGuard onto session.agent.beforeToolCall
  └─ 8. returns CreateBudgetAwareSessionResult { sessionId, session, sessionManager, ledger, controller }
```

### Event hook contract (`src/engine/budget/events.ts`)

| Event | Ledger write | Side effect |
|---|---|---|
| `message_end` | `recordEvent("message_end", cumulative, signal)` (always); `maybeSnapshot(cumulative, policy, signal)` (throttled: every 10 messages OR ≥ 5% spend change vs cap) | If `policy.strategy === undefined` (the default today, C5 placeholder), call `evaluateThresholds(...)`. The worker-scope (worker.tokens, worker.costUsd) and team-scope (team.tokens, team.costUsd) pairs each check `crossedThreshold(ratio, threshold)` against `WARNING_REMAINING_RATIO = 0.20` and `EXHAUSTED_REMAINING_RATIO = 0`. |
| `message_end` (warning crossed) | `markWarning(cumulative, signal)` (always) | `appendCustomMessageEntry("budget_warning", ..., display: true, { scope, resource, remaining, cap, interventionAvailable: true })`. Dedup key: `${scope}:${resource}:${agentSlug\|"team"}`. |
| `message_end` (exhaustion crossed) | `markExhaustion(cumulative, signal)` (always) | `appendCustomMessageEntry("budget_exhausted", ..., true, { ..., interventionAvailable: false })`. `session.abort()` fires synchronously **before** `agent_settled` (G-02). |
| `compaction_end` | `recordCompaction(savings, signal)` — in-memory only | None. Defensive no-op for non-finite `tokensBefore` / `estimatedTokensAfter`. |
| `agent_settled` | `snapshot(stats, policy, "checkpoint", signal)` (always) | Final write. Reads `session.getSessionStats()` for the post-final-message totals. |
| `tool_call` (via `agent.beforeToolCall`) | none | `createBudgetToolCallGuard(...)` returns `{ block: true, reason: JSON.stringify(BudgetBlock), terminate: false }` when the policy refuses; only `bash`, `edit`, `write`, `read` pass through the gate (others are always allowed). The SDK marks the tool result with `isError: true` carrying the `BudgetBlock` JSON (discriminated-union serialization). |

`controller.signal` (per-call `AbortController`) is threaded into every write. The `session.subscribe(...)` path does not surface `tool_call` events; tool interception uses `agent.beforeToolCall` instead. `session.abort()` does NOT synchronously abort the controller in every SDK mode — the dedup set `ledger.warnedKeys` guarantees "second message_end at the cap does NOT re-emit" (T3.6 / case 16 of `tests/budget-events.test.ts`).

## Strategies

The structured-strategy block (`budgets.strategies:` with `on-approaching-limit.action`, `on-exhaustion.action`, `summary.max-tokens`, etc.) is **deferred to v3** (decision C5). The v2 schema rejects any concrete `strategies:` value — it's `Type.Never()` at the validator (`src/core/schema.ts`).

What you get today:

- A **flat default strategy** is the only mode: warning at ≤ 20% remaining (with a `summarize_progress` hint visible to the worker via `appendCustomMessageEntry`), exhaustion at 0% (abort). The `WorkerBudgetStrategy` type carries `readonly _placeholder: never`, so `resolveWorkerBudgetStrategy` always returns `undefined` (`src/engine/budget/strategy.ts`).
- The cooperative tool `summarize_progress` (preserved from v1, see `src/agents/tools/summarize-progress.ts`) records the worker's completion intent in a `progress_note` CustomMessageEntry. The dashboard timeline renders operator + cooperative actions uniformly because both write `CustomEntry`s with the same shape — the operator-driven kinds use bare names (`end`, `compact`, …) and the cooperative ones use the `cooperative-*` prefix (see Operator commands below).
- `strategyRequestsWrapUp(strategy)` / `strategyRequestsCompactOnExhaustion(strategy)` always return `false` today. The hooks only consult `policy.strategy === undefined` to gate the default-path emit — structured strategies will hook in once C5 lands.

If you need auto-compact at exhaustion today, the workaround is to give the worker a generous `tokens.cap` plus a tight `cost-usd.cap` so exhaustion triggers abort at the cost ceiling long before the worker runs out of tokens. The next PR (C5) introduces structured strategies; nothing in v2 is forward-incompatible with that landing.

### v1 → v2 mapping for users coming from the old flat enum

The v1 schema exposed a flat `worker-governance.budget-strategy: default | compact` enum plus `progress-summary-token-limit`. The mapping to v2:

| v1 setting | v2 equivalent |
|---|---|
| `worker-governance.budget-strategy: default` | No config needed — the default strategy IS default. |
| `worker-governance.budget-strategy: compact` | C5 placeholder today: no equivalent. Drop the setting; the worker will abort at exhaustion instead of auto-compacting. C5 will reintroduce structured strategies. |
| `worker-governance.progress-summary-token-limit` | C5 placeholder today: no equivalent. The worker's own `request_compaction({ notes })` call carries the notes inline; the `limit` field is derived from the runtime's context window. |

Do NOT migrate these settings into v2 YAML — they will fail validation. The v2 loader hard-throws on any unknown `settings.*` or frontmatter key. If a project still relies on `compact` behavior, leave it pinned to the last v1 release until C5 lands.

## Operator commands + cooperative tools

All eight operator commands + the three cooperative tools live in `src/engine/budget/worker-tools.ts` and write a `CustomEntry` with the `kind` listed below. The result envelope is `{ sessionId, ledgerSnapshot }` where `ledgerSnapshot` is the most-recent `BudgetLedgerEntry` (customType `pi-hive-budget-ledger`).

### Operator commands (driven from outside the worker)

| Command | When to call | Return shape | Ledger `kind` | SDK primitive |
|---|---|---|---|---|
| `endWorkerSession(agent, reason)` | Worker is stuck or no longer needed; you want to release the slot. | `{ sessionId, ledgerSnapshot }` | `"end"` | `session.abort()` (session preserved — do NOT dispose, per G-06) |
| `compactWorkerSession(agent, reason, customInstructions?)` | Worker is approaching the token ceiling; reclaim context without losing state. | `{ sessionId, ledgerSnapshot, compaction }` | `"compact"` | `session.compact(customInstructions?)` |
| `respawnWorkerSession(agent, reason, newTask?)` | Worker has built up state you want to discard; start over with the same agent. | `{ ok: true, oldSessionId, newSessionId, ledgerSnapshot }` | `"respawn"` (on OLD SM) | `session.dispose()` + `SessionManager.create(cwd)` + `branchWithSummary(leafId, summary)` + `createAgentSession({ sessionManager })` |
| `pauseWorkerSession(agent, reason)` | Pause for review; later resume continues the same session. | `{ sessionId, ledgerSnapshot }` | `"pause"` | `session.waitForIdle()` (session stays open) |
| `snapshotWorkerSession(agent, label)` | Save a navigable checkpoint; later `restoreWorkerSession` opens it. | `{ ok: true, sessionId, branchPath, ledgerSnapshot }` | `"snapshot"` | `SessionManager.branchWithSummary(leafId, summary)` (no new session) |
| `restoreWorkerSession(agent, snapshotId)` | Resume from a previously-snapshotted branch. | `{ ok: true, sessionId, ledgerSnapshot }` OR `{ isError: true, code: "restore_failed", reason }` | `"restore"` | `SessionManager.createBranchedSession(leafId)` → `SessionManager.open(path)` → `createAgentSession({ sessionManager })`. In-memory source SMs return `undefined` — the error path is the documented outcome. |
| `resumeWorkerSession(agent)` | Counterpart to `pauseWorkerSession`; re-attaches event hooks on a paused session. | `{ sessionId, ledgerSnapshot }` | `"resume"` | `installBudgetEventHooks` re-subscribed on the existing session reference; reads `session.getSessionStats()` so it works after long idle. |
| `abortWorkerCompaction(agent)` | Cancel in-flight manual or auto compaction; session continues. | `{ sessionId, ledgerSnapshot }` | `"compact-aborted"` | `session.abortCompaction()` |

### Cooperative tools (callable by the worker itself)

| Tool | When the worker calls it | Return shape | Ledger `kind` | SDK primitive |
|---|---|---|---|---|
| `request_compaction({ notes })` | Worker is approaching its cap and wants to reclaim context now. | `{ ok: true, compacted: true, estimatedTokens, limit }` OR `{ ok: false, reason: "no_runtime" \| "compact_failed", error? }` | `"cooperative-compact"` | `session.compact(notes)` |
| `request_end_session({ reason })` | Worker decides its task is done; graceful self-shutdown. | `{ ok: true }` OR `{ ok: false, reason: "no_runtime" }` | `"cooperative-end"` | `session.abort()` |
| `request_snapshot({ label })` | Worker wants to checkpoint its progress for later restore. | `{ ok: true, snapshotId }` OR `{ ok: false, reason: "no_runtime" }` | `"cooperative-snapshot"` | `SessionManager.branchWithSummary(leafId, label ?? "")` |

The cooperative tools write their `kind: "cooperative-*"` ledger entry **before** invoking the SDK primitive, so the dashboard timeline captures intent even if the SDK call throws.

## Telemetry events

The dashboard reads two `CustomMessageEntry` types and one `CustomEntry` type.

### Worker-visible messages (`appendCustomMessageEntry`)

| `customType` | When | `details` payload | Source |
|---|---|---|---|
| `budget_warning` | `message_end` that crosses ≤ 20% remaining (dedup per `${scope}:${resource}:${agentSlug\|"team"}`). | `{ scope: "worker" \| "team", resource: "tokens" \| "costUsd", remaining: number, cap: number, interventionAvailable: true }` | `events.ts` `evaluateThresholds` |
| `budget_exhausted` | `message_end` that crosses 0% remaining. Fires synchronously BEFORE `agent_settled`. | `{ scope, resource, remaining: 0, cap, interventionAvailable: false }` | `events.ts` `evaluateThresholds` |

`interventionAvailable` is `true` for `budget_warning` (the default strategy emits the wrap-up hint + `summarize_progress` is callable) and `false` for `budget_exhausted` (the abort fires; no further action is possible in the current session). C5's structured strategies will diverge this per-strategy.

### Persistent ledger (`appendCustomEntry`)

Every ledger write is a `CustomEntry` with `customType: "pi-hive-budget-ledger"` and the `BudgetLedgerData` shape from `src/engine/budget/types.ts`:

```ts
{
  caps: { workerTokens?, workerCostUsd?, workerRuns?, workerDepth?, teamTokens?, teamCostUsd?, teamRuns? },
  cumulative: { tokens, costUsd, runs },
  writtenAt: number,                 // Date.now() — the only clock read in the ledger
  agentSlug: string,
  marker?: "warning" | "exhausted" | "checkpoint",
  kind?:   "end" | "compact" | "respawn" | "pause" | "snapshot" | "restore"
         | "resume" | "compact-aborted"
         | "cooperative-compact" | "cooperative-end" | "cooperative-snapshot",
}
```

Marker × kind write cadence:

| Trigger | Marker | Kind |
|---|---|---|
| Throttled `message_end` snapshot (≥ 10 messages OR ≥ 5% spend change vs cap) | — | — |
| `message_end` warning crossed | `warning` | — |
| `message_end` exhaustion crossed | `exhausted` | — |
| `compaction_end` | — | — |
| `agent_settled` | `checkpoint` | — |
| Operator action (8 commands) | `checkpoint` | `"end" \| "compact" \| "respawn" \| "pause" \| "snapshot" \| "restore" \| "resume" \| "compact-aborted"` |
| Cooperative tool (3 tools) | `checkpoint` | `"cooperative-compact" \| "cooperative-end" \| "cooperative-snapshot"` |

The G-08 `kind?: string` discriminator is typed stringly for forward compatibility — new operator / cooperative actions can add a kind without a schema change. `BudgetLedgerKind` (the union above) is the canonical list; legacy entries with unknown kinds are still readable (the resolver returns `undefined` for them).

## Race safety

The F7 invariants (`tests/budget-races.test.ts`) pin the load-bearing guarantees:

- **T7.1 — abort races `getSessionStats()`.** 100 consecutive runs of "abort during a `message_end` whose `getSessionStats()` is mid-call" must all produce a consistent ledger. The factory reads `session.getSessionStats()` exactly once per `message_end` (asserted by `message_end: getSessionStats() is called exactly once` in `budget-events.test.ts`).
- **T7.2 — parallel delegation (G-09).** Two scripted workers interleave deterministic events; team totals equal the sum of each worker's latest cumulative spend. The `teamUsage(branch)` walker reads the LATEST `CustomEntry` per `agentSlug` — older checkpoints for the same worker are not double-counted.
- **T7.3 — `compaction_end` racing `message_end`.** Both orderings (compaction before or after the next message_end) produce a consistent cumulative. `recordCompaction` adjusts the in-memory token total; the next `message_end` reads the post-compaction baseline.
- **T7.4 — `session_start` racing `CustomEntry` write.** Both orderings produce a consistent ledger. The `BudgetLedger.restore` walker sees the branch at a single point in time; later writes don't retroactively change the restored cumulative.
- **T7.6 — `agent_settled` after abort.** The checkpoint snapshot reflects the post-abort authoritative stats; no entries dropped. `getSessionStats()` is the single source of truth — the abort just stops further events.
- **T7.7 — Bug 3 regression (G-03).** `workerConsumedTokens=15134` (the original incident value) → `fresh=true` dispatch → `remaining.tokens` equals `tokensCap - 15134`, NOT 0. This pins the structural guarantee from §2.9: a new session has no entries, so there's no counter to drift.

**Single source of truth rule.** Cumulative tokens and cost are read from `session.getSessionStats()` only. The in-memory ledger is a derived cache (`recordEvent` updates it, but never from a delta — it copies the authoritative stats). `Date.now()` is read exactly once per write (in `BudgetLedger.writeEntry` to stamp `writtenAt`); `Math.random()` and `setTimeout()` are never used in production paths.

## Reload stability

The F8 invariants (`tests/budget-reload.test.ts`) pin that the ledger survives `/reload`, `/tree`, and `/fork`:

- **T8.1 — `/reload` re-derives the ledger from session state.** After reload, `BudgetLedger.restore` walks the branch from scratch and reconstructs cumulative spend from the latest `CustomEntry`. The in-memory `warnedKeys` Set is empty after reload (warnings can re-fire), but the throttling state (`lastSnapshottedTokens` etc.) is re-seeded from the branch so a reload does NOT immediately re-write on the next `message_end`.
- **T8.2 — pre-reload `BudgetExhaustedError` blocks post-reload.** The `BudgetExhaustedError` (duck-typed via `error.name`) is surfaced to the caller of `createBudgetAwareSession`; a reload between the block and the next attempt does not unblock it because the ledger persists the cumulative spend.
- **T8.3 — paused session resumes after `/reload`.** `resumeWorkerSession` re-attaches `installBudgetEventHooks` on the existing session reference. Fresh listeners consult `getSessionStats()` on each event, so any `message_end` fired after resume reads the current authoritative totals.
- **T8.4 — audit closure-captured state.** No mutable counters in `installBudgetEventHooks`. The factory closes over the `ledger` and `policy` parameters; tests assert the closures don't capture module-level state.
- **T8.5 — `/tree` re-derives from new branch (G-11).** Switching to a tree branch re-runs `BudgetLedger.restore` against the new branch. If the new branch has no matching entries, the ledger starts at zero (matches the "new branch starts fresh" intent).
- **T8.6 — `/fork` creates ledger-fresh branch (G-11).** A forked branch inherits the source branch's history up to the fork point; `restore` walks the new branch back through the fork, so the cumulative reflects the worker's pre-fork spend plus any post-fork events.

## Test coverage

The invariants above are pinned by dedicated test files. Run them with `just test` (Node) and the Bun variants for dashboard-touching code.

| Test file | What it pins |
|---|---|
| `tests/budget-constants.test.ts` | Named-export thresholds (`WARNING_REMAINING_RATIO = 0.20`, `EXHAUSTED_REMAINING_RATIO = 0`, `THROTTLE_MESSAGE_INTERVAL = 10`, `THROTTLE_SPEND_RATIO = 0.05`). |
| `tests/budget-display.test.ts` | `budgetRemaining` / `effectiveWorkerGovernance` shims for the legacy v1 contract (TUI header consumers). |
| `tests/budget-events.test.ts` | `installBudgetEventHooks` event dispatch: single source of truth (T3.1 spend trigger), warning at 20% (T3.2, dedup), exhausted at 0% + abort (T3.3), `createBudgetToolCallGuard` (T3.4 — blocks `bash`/`edit`/`write`/`read` only), `agent_settled` checkpoint (T4.1). |
| `tests/budget-events-ordering.test.ts` | T3.5 (warning × `summarize_progress` ordering, G-17) and T3.6 (abort fires before `agent_settled`, G-02). |
| `tests/budget-evaluate-thresholds.test.ts` | `evaluateThresholds` directly: independent team vs worker dedup keys, dedup guard re-fires, controller-already-aborted short-circuit. |
| `tests/budget-eol.test.ts` | T5.1, T5.2, T5.4, T5.8, T5.9 — operator commands (session lifecycle + snapshot `kind`). |
| `tests/budget-eol-branch-clone.test.ts` | T5.3, T5.5, T5.6 — respawn / snapshot / restore (branch + clone cluster; `restore_failed` error path). |
| `tests/budget-ledger.test.ts` + `tests/budget-ledger-unit.test.ts` | `BudgetLedger` class: `restore`, `recordEvent`, `maybeSnapshot` throttling, `recordCompaction`, `snapshot`, `markWarning`, `markExhaustion`, abort-signal short-circuit. |
| `tests/budget-policy.test.ts` | `checkBudgetPolicy` (pre-flight gate), `ratioRemaining`, `crossedThreshold`, `teamUsage`, `indexLedgerByAgent`, depth cap (T2.3), G-29 type-mismatch guard. |
| `tests/budget-preflight.test.ts` | `runBudgetPreflight` integration: throws `BudgetExhaustedError` on block; no-op fast path for empty policy; ledger restore against `ctx.sessionManager`. |
| `tests/budget-races.test.ts` | T7.1–T7.7 — race-safe accounting guarantees (100 consecutive runs, parallel delegation, G-09 coherence, Bug 3 regression at 15134). |
| `tests/budget-reload.test.ts` | T8.1–T8.6 — reload-stable ledger across `/reload`, `/tree`, `/fork`. |
| `tests/budget-strategy-resolver.test.ts` | C5 placeholder: `resolveWorkerBudgetStrategy` always returns `undefined`; `strategyRequestsWrapUp` / `strategyRequestsCompactOnExhaustion` always return `false`. |
| `tests/budget-tool-call-wiring.test.ts` | `createBudgetToolCallGuard` end-to-end: blocks the four mutating tools when exhausted, passes through everything else, returns `BudgetBlock` JSON in the `reason`. |
| `tests/budget-worker-tools.test.ts` | `createBudgetAwareSession` spine: pre-flight + open + restore + install hooks + return shape; dependency-injection seams for `sessionManagerFactory`, `createSession`, `installWorkerHooks`. |
| `tests/cooperative-eol.test.ts` | The three cooperative tools: `requestCompaction`, `requestEndSession`, `requestSnapshot` — write `cooperative-*` ledger entry BEFORE invoking the SDK primitive. |
| `tests/config-schema.test.ts` | The typebox `BudgetCapSchema` discriminated union (T6.7); v1 flat keys rejected; `cost-usd.window.kind: rolling` requires `duration`; `all-time` rejects `duration`. |

## Window resolver

`src/engine/budget/window-resolver.ts` is the seaming layer between the F6 schema (object form: `{ kind, duration? }`) and the F1 runtime (flat string: `"per-session" \| "per-run" \| "per-day" \| "per-team-lifetime" \| "per-hour"`). It's a pure function — same input, same output across processes; no clock reads, no SDK state.

```
YAML window form                       → Runtime flat string
─────────────────────────────────────────────────────────────────
absent (undefined)                     → undefined                  (no window = unlimited)
{ kind: "all-time" }                   → "per-team-lifetime"        (the only unbounded string)
{ kind: "per-day" }                    → "per-day"
{ kind: "rolling", duration ≤ 1h   }   → "per-hour"
{ kind: "rolling", duration ≤ 24h  }   → "per-day"
{ kind: "rolling", duration > 24h  }   → "per-session"               (best fallback)
```

The resolver is the single point of flattening — every consumer in F1/F2 calls `resolveWindow(...)` instead of duplicating the mapping. This means a future PR can change the runtime flat-string surface (or remove it entirely) without touching the YAML schema layer, and vice versa.

A common confusion: the runtime `BudgetWindow` type in `src/engine/budget/types.ts` lists `"per-run"` as a string value, but the YAML layer has no way to express it (`kind: "rolling"` with a tiny `duration` would map to `"per-hour"`, not `"per-run"`). `"per-run"` is a legacy string the Wave 0 contract carried; new code should rely on the `kind`/`duration` object form instead.

## Common patterns

A few recipes that show how the schema layers onto real workloads. The values are illustrative — calibrate for your model's pricing and your project's risk tolerance.

**Tight per-agent coder** (one-shot fixes, no delegation, low token cost):

```yaml
# .pi/hive/hive-config.yaml — global defaults
settings:
  budgets:
    per-worker:
      tokens: { cap: 25000 }                # ~25k tokens per session
      cost-usd: { cap: 0.50 }               # $0.50 ceiling
      runs: { cap: 1 }                      # one dispatch per session
      depth: { cap: 1 }                     # cannot delegate
```

**Loose per-team budget, tight per-worker default** (the common shape):

```yaml
settings:
  budgets:
    per-worker:
      tokens:
        cap: 500000
        window: { kind: per-day }            # resets at UTC midnight
        include: [input, output]             # exclude cache
      cost-usd: { cap: 10.00, window: { kind: per-day } }
      runs: { cap: 50 }
      depth: { cap: 3 }
    per-team:
      tokens: { cap: 5000000, window: { kind: all-time } }
      cost-usd: { cap: 200.00, window: { kind: all-time } }
      runs: { cap: 500 }
```

**Rate-limit window** (rolling 1-hour cap, useful for bursty workloads):

```yaml
settings:
  budgets:
    per-worker:
      tokens:
        cap: 100000
        window:
          kind: rolling
          duration: 3600000                  # 1 hour in ms
```

**Per-agent override** (one specialist gets a tighter cap):

```yaml
# .pi/hive/agents/engine-coder.md frontmatter
---
name: Engine Coder
agent-type: coder
budgets:                                    # overrides settings.budgets.per-worker for this agent
  tokens: { cap: 5000 }                     # tighter than the global 500k default
  cost-usd: { cap: 0.10 }
  runs: { cap: 1 }
  depth: { cap: 1 }                         # cannot delegate
---
```

**Operator recovery** (worker stuck, you want to abort and respawn):

```typescript
// From an operator-side caller that has the Worker's AgentRuntime handle:
const { ledgerSnapshot } = await endWorkerSession({ agent: "engine-coder", reason: "stuck on retry loop" }, ctx, handle);
const respawn = await respawnWorkerSession({ agent: "engine-coder", reason: "end-of-life; respawn with new task" }, ctx, {
  oldSession: handle.session,
  oldSessionManager: handle.session.sessionManager,
  oldLedger: handle.ledger,
  policy: handle.policy,
});
// respawn.newSessionId → the fresh session; respawn.ledgerSnapshot → the audit entry on the OLD SM
```

## References

- **Schema template (canonical).** [`tmp/budget-config-v2-template.md`](../tmp/budget-config-v2-template.md) — the complete reference for `settings.budgets:` and frontmatter `budgets:` blocks, including `window:` object semantics and the runtime-flat-string → YAML-object mapping.
- **Migration from v1.** [`docs/migrations/budget-config-v2.md`](migrations/budget-config-v2.md) — the side-by-side v1 → v2 examples, manual fix checklist, and rollback options.
- **Source code.** `src/engine/budget/` — `types.ts` (data contracts), `ledger.ts` (`BudgetLedger` class), `policy.ts` (`checkBudgetPolicy`, `teamUsage`, helpers), `events.ts` (`installBudgetEventHooks`, `createBudgetToolCallGuard`), `worker-tools.ts` (operator commands + cooperative tools + `createBudgetAwareSession` + `runBudgetPreflight`), `strategy.ts` (C5 placeholder), `window-resolver.ts` (`resolveWindow` — the object→string seaming layer), `display.ts` (legacy v1 contract shims for TUI consumers).
- **Authoritative spec.** [`.worktrees/review-budget-redesign/docs/reviews/28-09-2026-budget-review/04-refactor-plan.md`](../../.worktrees/review-budget-redesign/docs/reviews/28-09-2026-budget-review/04-refactor-plan.md) — the original refactor plan. §2.6 covers the mid-run handler, §2.7 the end-of-run, §2.8 the operator commands, §3 the workflow end-to-end, §6 the open risks (G-01..G-29) that motivated the design.
