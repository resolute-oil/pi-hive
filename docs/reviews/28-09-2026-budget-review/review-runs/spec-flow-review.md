# Spec-flow review — budget system refactor plan

**Skill applied:** `spec-flow-analyzer`
**Reviewer:** spec-flow-analyzer sub-agent
**Date:** 2026-09-28
**Artifacts under review:**
- Plan: `docs/reviews/28-09-2026-budget-review/04-refactor-plan.md` (1,473 LOC, 13 features, 52+ task checkboxes, 14 open questions)
- HTML: `docs/reviews/28-09-2026-budget-review/presentation/index.html` (1,218 LOC, 13 pages)
**Supporting evidence consulted:**
- `01-current-state-analysis.md` — 9 structural issues + 3 fresh=true bugs
- `raw-evidence/pi-sdk-session-api.md` — 555 LOC, verified Pi SDK behavior
- `pi-docs/extension-patterns-reference.md` — 480 LOC, verbatim Pi docs
- `raw-evidence/bug-history.md`, `test-coverage-analysis.md`, `code-line-ranges.md`
- Local Pi source at `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/` v0.87.1

This document follows the skill's four-artifact structure: **flow overview**, **permutation matrix**, **gap inventory**, and **prioritized clarifying questions**.

---

## 1. Flow overview

The plan claims to support thirteen end-to-end flows. Each flow is enumerated below with: trigger → steps → terminal state → owning feature. Flows the plan describes but does not actually wire up are flagged **UNWIRED**.

### Flow F-A — Orchestrator delegates a worker within budget

- **Trigger:** Orchestrator agent invokes `delegate_agent(name, task, fresh=false)` mid-conversation.
- **Steps (per `04-refactor-plan.md:191-220` + sequence diagram at `:761-799`):**
  1. `delegateAgent` resolves `WorkerBudgetPolicy` (pure function on `HiveState`).
  2. `BudgetLedger.restore(sessionManager, agentName, policy)` calls `SessionManager.getBranch()` and reduces over `CustomEntry`s with `customType === "pi-hive-budget-ledger"`.
  3. `checkBudgetPolicy(ledger, policy, branch)` returns `BudgetBlock | undefined`.
  4. If `BudgetBlock` returned → `throw new BudgetExhaustedError(reason, scope, resource)` (Pi-native refusal).
  5. Else → `SessionManager.continueRecent(cwd)` returns `AgentSession`.
  6. `installBudgetEventHooks(session, ledger, policy, controller)` subscribes to `message_end`, `compaction_end`, `agent_settled`.
  7. `session.prompt(task)` runs the worker loop.
  8. On `agent_settled` → final `appendCustomEntry("pi-hive-budget-ledger", snapshot)` with `marker: "checkpoint"`.
- **Terminal state:** worker session is `idle`, ledger has a final `checkpoint` entry, no in-flight hooks.
- **Owning feature:** F2 (`delegateAgent`), F3 (`message_end` live tracking), F4 (`agent_settled` finalization).

### Flow F-B — Orchestrator delegates a worker when budget is exhausted

- **Trigger:** Worker tokens/cost/runs already at or above cap.
- **Steps:**
  1. F-A steps 1–3 run.
  2. `checkBudgetPolicy` returns a `BudgetBlock`.
  3. `delegateAgent` throws `BudgetExhaustedError`.
- **Terminal state:** No `AgentSession` is opened. Per Pi docs §2 (cited at `04-refactor-plan.md:209`), throw produces a failed tool result; the orchestrator sees the error.
- **Owning feature:** F2 (`throw new BudgetExhaustedError`).
- **Underspecified:** how the orchestrator surfaces this to the LLM (no test asserts the error message text is in tool-result `details`); what happens if the orchestrator retries with a different `name`.

### Flow F-C — Worker crosses 20% remaining (warning emit)

- **Trigger:** `message_end` event with cumulative tokens between 20% and 0% remaining.
- **Steps (per `04-refactor-plan.md:312-330`):**
  1. `installBudgetEventHooks`'s `message_end` handler computes `ratioRemaining(cumulative.tokens, cap)`.
  2. `crossedThreshold(0.20)` returns `true` (latched by `${scope}:${resource}:${agent|team}` dedup key in ledger).
  3. `appendCustomMessageEntry("budget_warning", content, display=true, details=...)` writes a `CustomMessageEntry` that lands in LLM context.
  4. `ledger.maybeSnapshot(cumulative, policy)` writes a throttled `CustomEntry` snapshot.
- **Terminal state:** Worker's next model call sees the warning; ledger has a `"warning"` marker entry.
- **Owning feature:** F3 (`message_end` warning emit at 20%).
- **Underspecified:** the `crossedThreshold` function is defined in prose but the test plan in T3.2 asserts "warning emitted exactly once per `${scope}:${resource}:${agent|team}` (dedup works) — verified by a test that fires 100 message_end events past the 20% threshold and asserts exactly 1 warning emit." However, the **plan never specifies how dedup state survives across reload** — `getBranch()` is the only place it could live, and `alreadyWarned(ledger, "tokens")` is not defined. F8's T8.4 closure-capture audit doesn't include this state.

### Flow F-D — Worker crosses 0% remaining (exhaustion abort)

- **Trigger:** `message_end` event with cumulative tokens at/above cap.
- **Steps (per `04-refactor-plan.md:330-340`):**
  1. `workerTokensRemaining <= 0`.
  2. `sessionManager.appendCustomEntry("budget_exhausted", { scope, resource, ... })` writes a `CustomEntry`.
  3. `controller.abort(new Error("Worker token budget exhausted"))` cancels in-flight turn.
  4. SDK resolves `session.prompt()`; `agent_settled` fires.
- **Terminal state:** Worker is aborted; ledger has both `"exhausted"` and `"checkpoint"` markers.
- **Owning feature:** F3 (exhaustion abort), F4 (finalization).
- **Flagged:** **the plan's T3.3 says "abort at 0% via `controller.abort(reason)` AND emit `appendCustomEntry("budget_exhausted", ...)`" but does not pin the relative order of these two operations.** If `controller.abort()` causes the event loop to settle before `appendCustomEntry` lands, the `"exhausted"` marker is missing from the next ledger read. The plan's F3 completion guard checks the abort and the emit separately but does not test that both happen in a single `message_end` tick.

### Flow F-E — Operator ends a worker (graceful stop)

- **Trigger:** Operator invokes `/hive:end <agent>` or `endWorkerSession(agent, reason)` from dashboard.
- **Steps (per `04-refactor-plan.md:426-431`):**
  1. `endWorkerSession` calls `session.abort()` (per `pi-sdk-session-api.md:25-29`, "Stops the active operation and waits for the session to become idle").
  2. `appendCustomEntry("pi-hive-budget-ledger", { ..., marker: "checkpoint", data: { kind: "end" } })`.
- **Terminal state:** Session is idle; ledger snapshot saved with `kind: "end"`; worker slot released for next dispatch.
- **Owning feature:** F5 (T5.1).
- **Flagged:** per `pi-sdk-session-api.md:29-33`, **`session.abort()` waits for idle but does NOT remove listeners**; the plan's open question #6 ("`session.dispose()` on `endWorkerSession`") defaults to NOT disposing. If the same `AgentSession` is reused after `endWorkerSession`, the prior `installBudgetEventHooks` listeners stay attached. The plan has no test for "session reused after end".

### Flow F-F — Operator compacts a worker

- **Trigger:** Operator invokes `compactWorkerSession(agent, reason)`.
- **Steps (per `04-refactor-plan.md:432-435`):**
  1. `session.compact(customInstructions?)` (per `pi-sdk-session-api.md:42-46`, "Aborts the current agent operation first").
  2. `appendCustomEntry("pi-hive-budget-ledger", { ..., marker: "checkpoint", data: { kind: "compact" } })`.
  3. Worker slot preserved.
- **Terminal state:** Session is idle, compacted; ledger has a `"compact"` marker.
- **Owning feature:** F5 (T5.2).
- **Flagged:** **`session.compact()` aborts the active agent operation** — same effect as `session.abort()`. The plan does not state whether the prior in-flight `message_end` handler has completed before the `compact` snapshot is written. If `message_end` is mid-write and `session.compact()` resolves, the ledger write order is: `message_end` snapshot → compact snapshot → ... but the next prompt may see them in any order.

### Flow F-G — Operator respawns a worker (the headline EOL flexibility)

- **Trigger:** Operator invokes `respawnWorkerSession(agent, reason, newTask?)`.
- **Steps (per `04-refactor-plan.md:436-441` + sequence at `:801-820`):**
  1. `branchWithSummary(leafId, "Resumed by operator")` (per `pi-sdk-session-api.md:284-292`).
  2. `session.dispose()` (per `pi-sdk-session-api.md:29-33`, "Remove all listeners and disconnect from agent").
  3. `SessionManager.create(cwd)` → fresh `AgentSession` with empty branch.
  4. `installBudgetEventHooks(session, newLedger, policy, controller)`.
  5. `session.prompt(newTask || resumption context)`.
  6. `agent_settled` → final snapshot.
- **Terminal state:** Old session fully disposed; new session has clean ledger; budget starts fresh by construction.
- **Owning feature:** F5 (T5.3).
- **Note:** the sequence diagram at `:801-820` shows `OldSession → branchWithSummary → dispose`, then `SM → create`. The plan's T5.3 gate verifies `session.dispose()` was called, but **does not verify `branchWithSummary` was called first.** If the order is reversed, the respawn loses the resumption context.

### Flow F-H — Operator pauses a worker (new in v2)

- **Trigger:** Operator invokes `pauseWorkerSession(agent, reason)`.
- **Steps (per `04-refactor-plan.md:442-445`):**
  1. `session.waitForIdle()` (per `pi-sdk-session-api.md:33-36`).
  2. `appendCustomEntry("pause", ...)`.
- **Terminal state:** Session is idle but session reference retained; ledger has `"pause"` marker; next dispatch resumes from same session.
- **Owning feature:** F5 (T5.4).
- **Flagged:** **the plan does not specify how a paused worker is "resumed."** The plan introduces `pauseWorkerSession` but never defines `resumeWorkerSession`. Open question #5 defaults to "all 6 commands" but resume is implicit, not a 7th command. The current-state analysis does not document pause/resume semantics either.

### Flow F-I — Operator snapshots a worker (checkpoint)

- **Trigger:** Operator invokes `snapshotWorkerSession(agent, label)`.
- **Steps (per `04-refactor-plan.md:446-449`):**
  1. `session_manager.branchWithSummary(leafId, label)` (per `pi-sdk-session-api.md:288-291`).
  2. Ledger snapshot saved with `kind: "snapshot"`.
- **Terminal state:** Branch summary entry exists in session file; ledger has `"snapshot"` marker.
- **Owning feature:** F5 (T5.5).
- **Flagged:** **`snapshotWorkerSession` and `pauseWorkerSession` both write `"checkpoint"` markers but with different `kind` values.** The plan's marker schema (`:128`) has `marker: "warning" | "exhausted" | "checkpoint"` — there is no marker for `pause` or `snapshot`, yet the prose at `:442` says pause writes `marker: "checkpoint", kind: "pause"` (the `kind` field doesn't exist in the schema). This is an **internal inconsistency** — the marker schema only allows three values but the plan uses six (end, compact, respawn, pause, snapshot, restore). See Gap G-08.

### Flow F-J — Operator restores from snapshot

- **Trigger:** Operator invokes `restoreWorkerSession(agent, snapshotId)`.
- **Steps (per `04-refactor-plan.md:450-453`):**
  1. `SessionManager.createBranchedSession(leafId)` (per `pi-sdk-session-api.md:294-296`).
  2. New branched session automatically re-derives ledger from `getBranch()`.
- **Terminal state:** Branched session ready; ledger reconstructed.
- **Owning feature:** F5 (T5.6).
- **Flagged:** **`SessionManager.createBranchedSession` is per `pi-sdk-session-api.md:294` typed as `(leafId: string) => string | undefined` — it returns the session ID, not an `AgentSession`.** The plan assumes the caller can immediately install event hooks. F2's `delegateAgent` uses `SessionManager.continueRecent(cwd).toAgentSession()` and `SessionManager.create(cwd).toAgentSession()` — neither pattern is documented for `createBranchedSession`. See Gap G-09.

### Flow F-K — Worker calls `summarize_progress({ notes, compact? })` mid-task

- **Trigger:** Worker agent invokes `summarize_progress` tool mid-conversation.
- **Steps (per `04-refactor-plan.md:455-460`):**
  1. Tool validates input (preserved).
  2. `appendCustomMessageEntry("progress_note", content, display=false, details: { tokenCount: N })`.
  3. If `compact: true` AND strategy is `compact` → `session.compact()` is called.
- **Terminal state:** Progress note in worker context; possibly compacted.
- **Owning feature:** F5 (T5.7).
- **Flagged:** the plan does not specify the **interaction with the budget warning emit**. If a worker calls `summarize_progress` at the same tick as the 20% warning fires, both `appendCustomMessageEntry` calls land. The dashboard then shows the note but not the warning. The plan does not pin the relative order.

### Flow F-L — Worker calls `request_compaction` cooperatively

- **Trigger:** Worker agent invokes `request_compaction` tool.
- **Steps:** Tool calls `session.compact()`; ledger snapshot with `kind: "cooperative-compact"`.
- **Terminal state:** Worker compacts its own session.
- **Owning feature:** F5 (T5.x — referenced at `:464` but **not given a task ID**; see Gap G-12).
- **Flagged:** the plan mentions `request_compaction`, `request_end_session`, `request_snapshot` at `:464` as "agent-callable tools" but **no T5 task implements them and no test is named**. The completion guard at `:466-475` requires "verified by a smoke test that the agent can invoke them" but does not name a smoke test file.

### Flow F-M — User reloads mid-budget (reload-stable ledger)

- **Trigger:** User invokes `/reload` while a worker is mid-run.
- **Steps:**
  1. Pi persists the session file (JSONL).
  2. New session starts from `getBranch()` walk.
  3. `BudgetLedger.restore(sessionManager, agentName, policy)` re-derives from `CustomEntry`s.
  4. Budget state matches pre-reload exactly.
- **Terminal state:** Worker resumes with same cap state.
- **Owning feature:** F8 (T8.1–T8.4).
- **Flagged:** **the plan does not say what happens to an in-flight `message_end` handler mid-reload.** If the user hits `/reload` between the `message_end` firing and the throttled ledger write, the write is lost. The T7.5 test ("`/reload` mid-budget") exists but does not cover the case where the in-flight write is in a `setImmediate`-deferred state.

### Flow F-N — Two delegations fired in parallel

- **Trigger:** Orchestrator LLM emits two `delegate_agent` calls in the same turn.
- **Steps:** Two `delegateAgent` calls run concurrently; each `restore`s its own ledger; both check policy; both proceed if under budget.
- **Terminal state:** Two parallel worker sessions running.
- **Owning feature:** F7 (T7.2 race test).
- **Flagged:** the T7.2 test is named ("parallel delegation updates (both ledgers intact)") but **the plan never specifies how team-level totals are isolated.** The `CustomEntry` walk at `getBranch()` for the orchestrator's session sees the workers' `CustomEntry`s, but **two workers writing to the same team `CustomEntry` would race at append time.** The plan's BudgetLedgerEntry has `agentSlug` per entry (`:124`), so per-worker isolation works, but **team totals are derived by summing across `agentSlug`s — a concurrent write during the sum could land inconsistently.** The T7.2 test gates "both ledgers intact" but doesn't assert team totals.

### Cross-cutting flows the plan does NOT enumerate but should

- **UNWIRED F-O — Operator cancels a compaction mid-flight.** Per `pi-sdk-session-api.md:48-51`, `session.abortCompaction()` exists. The plan does not wire it. F5's `compactWorkerSession` does not have a "cancel" path.
- **UNWIRED F-P — User invokes `/tree` to navigate branches mid-budget.** Per `pi-sdk-session-api.md:299-303`, `SessionManager.branch(branchFromId)` switches the leaf. The plan does not specify how the budget layer reacts to a tree switch (it should re-derive from the new branch).
- **UNWIRED F-Q — Worker invokes `delegate_agent` to spawn a sub-worker at depth 3.** The current-state analysis covers depth tracking; the plan claims depth is preserved (`tokens.depth.cap`) but does not test cross-worker depth attribution.
- **UNWIRED F-R — User changes config mid-session.** The plan's `defaults-enabled` flag defaults to off; what happens if config reload occurs mid-run? The plan does not address this.
- **UNWIRED F-S — Session is forked via `/fork`.** Per `pi-sdk-session-api.md:152-156`, `SessionManager.forkFrom` exists. Plan does not address fork semantics.
- **UNWIRED F-T — `ctx.signal` abort during ledger write.** F2's gate says `ctx.signal` is threaded; F3's gate does not assert abort mid-write. F7 T7.4 covers `session_start` racing with `CustomEntry` write but not `appendCustomEntry` racing with `controller.signal.aborted`.

---

## 2. Flow permutation matrix

The plan claims behavior across many axes. Each cell is evaluated as ✅ covered (by a specific feature task and its named test), ⚠ partially covered (the feature exists but the test matrix has a gap), ❌ uncovered (the plan claims support but no test or feature owns it).

### 2.1 Per-scope × per-resource × per-state

This is the core "does the budget layer do the right thing" matrix. 2 scopes × 5 resources × 5 states = 50 cells.

| Scope | Resource | running | aborted | settled | reloaded | respawned |
|---|---|---|---|---|---|---|
| worker | tokens | ✅ F3 T3.1-3 | ⚠ F3 T3.3 | ✅ F4 T4.1 | ✅ F8 T8.1 | ✅ F5 T5.3 |
| worker | cost-usd | ✅ F3 T3.1-3 | ⚠ F3 T3.3 | ✅ F4 T4.1 | ⚠ F8 (no cost test) | ✅ F5 T5.3 |
| worker | runs | ⚠ F2 T2.2 (only in pre-flight) | ❌ no per-state abort coverage | ⚠ F4 (not pinned) | ❌ | ❌ |
| worker | depth | ❌ no test | ❌ | ❌ | ❌ | ❌ |
| worker | queue | ❌ no test | ❌ | ❌ | ❌ | ❌ |
| team | tokens | ⚠ F2 T2.2 (in `checkBudgetPolicy`) | ❌ | ⚠ F4 (final snapshot) | ⚠ F8 (no team test) | ⚠ F5 (ledger restore for new agentSlug) |
| team | cost-usd | ⚠ F2 T2.2 | ❌ | ⚠ F4 | ❌ | ⚠ F5 |
| team | runs | ❌ no test | ❌ | ❌ | ❌ | ❌ |
| team | depth | n/a | n/a | n/a | n/a | n/a |
| team | queue | ❌ no test | ❌ | ❌ | ❌ | ❌ |

**Findings:**
- "depth" resource has zero test coverage in the plan. The plan keeps `depth.cap` in the config schema (`04-refactor-plan.md:222`) but no T2, T3, T5, or T8 task names a depth test.
- "queue" resource — the current-state analysis mentions `queue` as one of five resources (`01-current-state-analysis.md:7`) but the plan's BudgetPolicy (`:235-260`) only covers tokens, cost, runs; no queue gate.
- Team totals under abort are ❌ — no test verifies team ledger is consistent after a worker aborts at 0%.
- Per-state coverage of runs (worker/team) is asymmetric: pre-flight yes, end-of-run no.

### 2.2 Per-strategy × per-event

The plan keeps `default` and `compact` strategies; C5 (conditional) adds structured `strategies: { on-approaching-limit, on-exhaustion }`.

| Strategy | `message_end` (warning) | `message_end` (exhaustion) | `agent_settled` | `compaction_end` | `tool_call` |
|---|---|---|---|---|---|
| default | ✅ F3 T3.2 (`appendCustomMessageEntry`) | ✅ F3 T3.3 (`controller.abort`) | ✅ F4 T4.1 (snapshot) | ⚠ F2 T2.1 (handler installed) | ❌ no test |
| compact | ⚠ no test for compact-strategy warning emit | ⚠ no test for compact-strategy abort path | ⚠ same | ⚠ F2 T2.1 (handler installed) | ❌ |
| wrap-up (C5) | ⚠ only if user approves C5 | n/a | ⚠ | n/a | ❌ |
| abort (C5) | n/a | ⚠ only if user approves C5 | ⚠ | n/a | ❌ |

**Findings:**
- The `compact` strategy is the headline feature of `feat/budget-strategy` (per `01-current-state-analysis.md:60-67`) but the plan only wires event handlers generically; **no F3 task pins the compact-strategy-specific emit text or behavior**. Compare `tests/budget-strategy.test.ts` (38 tests in current code, per `test-coverage-analysis.md`) which does test compact strategy behavior.
- `tool_call` is named in the plan's TL;DR as a Pi Best Practice (`04-refactor-plan.md:22`) but **zero tasks implement `tool_call` blocking**. The plan's F2 uses throw-to-refuse in `delegate_agent.execute()` (pre-tool-call equivalent) but never installs a `tool_call` handler that gates mid-run. Per `extension-patterns-reference.md:158-160`, `tool_call` is the documented primitive for gating expensive operations; the plan claims alignment but does not implement it. See Gap G-01.

### 2.3 Per-window × per-resource

C6 introduces explicit `window:` values: `per-session`, `per-run`, `per-day`, `per-team-lifetime`.

| Window | tokens (worker) | tokens (team) | cost-usd (worker) | cost-usd (team) | runs |
|---|---|---|---|---|---|
| per-session | ✅ F6 T6.5 (default) | n/a (team default is `per-team-lifetime`) | ⚠ default but no explicit test | n/a | ⚠ default |
| per-run | ⚠ schema accepts (F6 T6.8) but no test exercises | n/a | ⚠ schema accepts no test | n/a | ❌ |
| per-day | ⚠ schema accepts no test | n/a | n/a (not in T6.8 valid list) | n/a | n/a |
| per-team-lifetime | n/a | ✅ F6 T6.5 (default) | n/a | ⚠ default but no test | ⚠ default |

**Findings:**
- `per-day` window is in the F6 T6.8 schema spec (`:1083`) but **no test exercises a per-day cap roll-over**. C6 is rated "Land" but its behavior is unverified.
- `per-run` window is in the schema but no test asserts that `runs` resets at run boundaries.

### 2.4 Per-operator-command × per-runtime-state

| Command | running | paused | settled (idle, never paused) | respawning (mid-cleanup) | disposed |
|---|---|---|---|---|---|
| endWorkerSession | ✅ F5 T5.1 | ⚠ no test for pause→end | ✅ F5 T5.1 | ⚠ no test | n/a |
| compactWorkerSession | ✅ F5 T5.2 | ⚠ | ✅ F5 T5.2 | ⚠ | n/a |
| respawnWorkerSession | ✅ F5 T5.3 (verified dispose called) | ⚠ | ✅ F5 T5.3 | ❌ | n/a |
| pauseWorkerSession | ✅ F5 T5.4 | n/a (already paused?) | ⚠ no test for pause an idle session | ⚠ | n/a |
| snapshotWorkerSession | ✅ F5 T5.5 | ⚠ | ✅ F5 T5.5 | ❌ | n/a |
| restoreWorkerSession | ✅ F5 T5.6 | ⚠ | ✅ F5 T5.6 | ❌ | n/a |
| (undefined) resumeWorkerSession | ❌ | ❌ | n/a | n/a | n/a |

**Findings:**
- `pauseWorkerSession` invoked on an idle session is not tested (does the ledger still get the marker? does the waitForIdle resolve immediately?).
- `respawnWorkerSession` from a paused state is not tested (must it dispose first? does the `branchWithSummary` work on a paused session?).
- **No `resumeWorkerSession` exists** — the plan introduces pause without resume. See Gap G-04.

### 2.5 Config validation: per-old-key × per-new-key × per-schema-version

The plan accepts old format during a one-release dual-format window (`:282-286`).

| Old key | New key | Schema version 1 (current) | Schema version 2 (dual-format) | Schema version 3 (nested only) |
|---|---|---|---|---|
| `token-budget` | `tokens.cap` | ✅ accepts | ✅ accepts both (F6 T6.2) | ⚠ not specified |
| `token-budget-scope: input_output` | `tokens.include: [input, output]` | ✅ | ✅ F6 T6.5 | ⚠ |
| `cost-budget-usd` | `cost-usd.cap` | ✅ | ✅ F6 T6.2 | ⚠ |
| `max-runs` | `runs.cap` | ✅ | ✅ F6 T6.2 | ⚠ |
| `max-delegation-depth` | `depth.cap` | ✅ | ⚠ not in F6 explicit tasks | ⚠ |
| `governance:` (per-agent) | `budgets:` | ✅ | ✅ F6 T6.4 | ⚠ |
| `budget-strategy: compact` | `strategies.on-exhaustion.action: compact` | ✅ | ⚠ conditional on C5 | n/a |
| `worker-budgets` | `per-worker` | ✅ | ⚠ F6 T6.1 introduces nested but rename is in C1 | ⚠ |
| `team-budgets` | `per-team` | ✅ | ⚠ same | ⚠ |

**Findings:**
- **No schema-version field is defined.** The plan talks about "one release dual-format" then "the following release hard break" but does not commit to a `schema_version: 2` field. Without a version marker, the second-release cutover has no signal to determine which format to expect.
- **`max-delegation-depth` migration path is not in F6's explicit task list.** F6 T6.2 covers `token-budget` and `cost-budget-usd`; T6.5 covers `tokens.include`. No T6.x explicitly says "old `max-delegation-depth` → new `depth.cap`."
- **`worker-budgets` → `per-worker` rename** is in C1 but the F6 task list treats C1 as just the per-agent rename. Plan inconsistency — see Gap G-08.

### 2.6 Per-Pi-event × per-payload-aspect

The plan wires `message_end`, `compaction_end`, `agent_settled`. It does not wire `tool_call`, `before_agent_start`, `agent_before_settle`, `turn_start`, `turn_end`, `entry_appended`, `queue_update`.

| Pi event | Plan wires it? | Plan tests it? | Documented Pi purpose | Plan's alignment |
|---|---|---|---|---|
| `message_end` | ✅ F2 T2.1 | ✅ F3 T3.1-3 | Live token accumulation | ✅ matches |
| `compaction_end` | ✅ F2 T2.1 | ⚠ F3 (no dedicated test) | Compaction-recalc | ⚠ tested only for `effectiveTokens` removal |
| `agent_settled` | ✅ F2 T2.1 | ✅ F4 T4.1 | Finalization | ✅ matches |
| `tool_call` | ❌ F2 doesn't install | ❌ | Gate expensive ops | ❌ claimed in TL;DR but not implemented |
| `before_agent_start` | ❌ | ❌ | Inform agent of budget | ❌ plan uses `appendCustomMessageEntry` instead |
| `agent_before_settle` | ❌ | ❌ | End the run | ⚠ plan uses `controller.abort` instead |
| `turn_end` | ❌ | ❌ | Per-turn boundary | n/a |
| `entry_appended` | ❌ | ❌ | React to own writes | ⚠ useful for self-throttling |
| `queue_update` | ❌ | ❌ | Queue depth changes | n/a |
| `tool_execution_end` | ❌ | ❌ | Tool-side usage attribution | ⚠ could replace `message_end` accumulation |
| `auto_retry_start` / `auto_retry_end` | ❌ | ❌ | Retry lifecycle | ⚠ affects `agent_end` vs `agent_settled` ordering |

**Findings:**
- **The plan claims four-tier state model + tool_call blocking + agent_before_settle alignment** (`:22`) but only implements three of the events. The implementation is partial relative to the claimed Pi Best Practices coverage.
- **`auto_retry_start` / `auto_retry_end` interaction with `agent_settled` is not analyzed.** Per `agent-session.d.ts:96-110`, `agent_settled` is the canonical "no automatic retry" event, but the plan does not verify this for retry sequences.

### 2.7 Per-mode × per-feature

Per `extension-patterns-reference.md:401` and AGENTS.md, extensions must be mode-independent (TUI, RPC, print, JSON).

| Feature | TUI | RPC | print | JSON |
|---|---|---|---|---|
| `delegateAgent` (F2) | ✅ mode-agnostic | ✅ | ✅ | ✅ |
| `installBudgetEventHooks` (F2) | ✅ | ✅ | ✅ | ✅ |
| `endWorkerSession` (F5) | ✅ | ⚠ F13 covers dashboard | ⚠ | ⚠ |
| 6th command (`pauseWorkerSession`) | ⚠ F13 | ⚠ | ⚠ | ⚠ |
| 7th command (resume) — not defined | n/a | n/a | n/a | n/a |

**Findings:**
- F13's T13.3 explicitly tests mode-independence for the dashboard, but the engine-side EOL commands are mode-agnostic by virtue of being plain TypeScript functions. The matrix shows F13 is the only mode-dependent feature.

### 2.8 Per-telemetry-consumer × per-event-shape

The plan claims telemetry event names unchanged (`04-refactor-plan.md:1398`, "Telemetry event names unchanged (dashboard doesn't break)"). This is a risk (Risk 7 at `:1417`).

| Event name (current) | Event shape (current) | Plan keeps name? | Plan keeps shape? |
|---|---|---|---|
| `budget_warning` | `{ runtime, scope, resource, ... }` | ⚠ name same, shape changed (now includes ledger snapshot ref) | ❌ |
| `budget_exhausted` | `{ runtime, scope, resource, ... }` | ⚠ name same | ❌ shape simplified |
| `worker_compaction` (compact strategy) | `{ phase, runtime }` | ⚠ | ❌ no phase field in new design |
| `worker_progress` | `{ notes, tokenCount }` | ⚠ | ⚠ custom-message-entry replaces it |
| `worker_end` / `worker_respawn` / `worker_compact` | various | ⚠ | ❌ |

**Findings:**
- **The plan claims telemetry event names unchanged** but the shape changes. Dashboards that read `worker_compaction.phase` will break. Open question #7 (`:1433`) acknowledges this and recommends "emit both old and new shapes for one release," but no F2/F5 task implements the dual-shape emit.

### 2.9 Per-test-fixture × per-claim

The plan claims ~50 new tests pass deterministically (no `Math.random`, no `Date.now`, no `setTimeout`). Verification gate at `:1393`.

| Claim | Test file named? | Test covers claim? |
|---|---|---|
| "Bug 3 structurally impossible" | ❌ no F7 test asserts the bug class is gone | ❌ |
| "Branch-aware ledger" | ✅ T8.1 | ⚠ only one assertion |
| "Reload-stable" | ✅ T8.1-T8.4 | ✅ |
| "Race-safe accounting" | ✅ F7 (6 tests) | ⚠ F7 gate says 100 consecutive runs, but no assertion that races are deterministic |
| "6 EOL commands have unique markers" | ✅ F5 T5.x | ⚠ |
| "Throttle ≤10 writes per 1000 events" | ✅ F3 T3.1 | ✅ |

**Findings:**
- **The Bug 3 claim is structural and un-testable directly**, but the plan never proposes a test that exercises the specific Bug 3 symptom (`runtime.* = 0` but `remaining.tokens = 0` after fresh=true abort). The plan can ship "Bug 3 impossible" while a similar bug class emerges in the new ledger code. See Gap G-03.

---

## 3. Gap inventory

Gaps are organized by severity. Each gap cites the specific file, line, and feature ID that establishes its existence.

### Critical

**G-01 — `tool_call` blocking is claimed in TL;DR but not implemented.**
- *Where claimed:* `04-refactor-plan.md:22` ("tool_call blocking"); `:1402` (Side-by-side row "Source of truth for live context load" implies mid-run gating); `:399-403` (prose).
- *Where missing:* F2 T2.1 implements only `message_end`, `compaction_end`, `agent_settled`. No T2.x task installs a `tool_call` handler. Per `extension-patterns-reference.md:158-160` and `extensions/types.d.ts:745` (`type: "tool_call"`), `tool_call` is the documented primitive for "gate expensive operations." The plan uses throw-to-refuse in `delegate_agent.execute()` but this is the pre-dispatch equivalent, not mid-run gating.
- *Refactor goal threatened:* **Pi Best Practices (1)** — claimed but not delivered.
- *Should be owned by:* New F3 task, e.g., T3.4 "Wire `tool_call` handler that returns block result when `workerTokensRemaining <= 0`."
- *Severity:* critical because it is the headline Pi Best Practice the plan sells.

**G-02 — `agent_settled` and the new `message_end` `controller.abort` ordering is not pinned by a test.**
- *Where:* `04-refactor-plan.md:330-340` (T3.3 emits both `appendCustomEntry("budget_exhausted")` and `controller.abort(...)`); `:344-353` (F4 wires `agent_settled` to final snapshot).
- *Gap:* If the SDK fires `agent_settled` immediately on `controller.abort()` (which it may per `agent-session.d.ts:48`), the `agent_settled` handler will write the final snapshot before the `appendCustomEntry("budget_exhausted")` lands — meaning the `"exhausted"` marker comes AFTER the `"checkpoint"` marker, not before. The plan's F3 completion guard checks the abort and the emit separately (`:466-475`) but does not test that the exhausted emit precedes the checkpoint write.
- *Refactor goal threatened:* **Eliminate the bug class (4)** — the new design introduces a fresh ordering dependency that the plan doesn't pin.
- *Should be owned by:* F3 T3.3 + F4 T4.1 combined test: "After abort-at-0%, the ledger has `exhausted` marker entry ID earlier in the JSONL than the `checkpoint` marker."
- *Severity:* critical.

**G-03 — No regression test that exercises the original Bug 3 symptom.**
- *Where:* The plan claims Bug 3 is "structurally impossible" (`:31-34`, `:1395` "Bug 3 is structurally impossible to reintroduce"). The plan's F7 race tests (T7.1-T7.6) cover abort-then-`getSessionStats`, parallel delegations, compaction race, reload race, and `agent_settled`-after-abort. **None of them exercise the specific Bug 3 reproduction: fresh=true delegation → abort at 0% → check `remaining.tokens`.** The closest is F7 T7.1 ("abort-then-`getSessionStats()` race"), but per `pi-sdk-session-api.md:299-321`, the new design reads `getSessionStats()` for cumulative — not for the abort-side state. So the test name implies it tests the old bug, but the new code path doesn't run the old logic.
- *Refactor goal threatened:* **Eliminate the bug class (4)** — without a regression test, future refactors could reintroduce the bug class without detection.
- *Should be owned by:* New F7 task T7.7 "End-to-end fresh=true → abort → remaining-tokens regression test (reproduces Bug 3 verbatim)."
- *Severity:* critical.

**G-04 — `pauseWorkerSession` exists without `resumeWorkerSession`.**
- *Where:* `04-refactor-plan.md:442-445` defines `pauseWorkerSession` (uses `session.waitForIdle()` + ledger entry). No task defines how to resume a paused worker. Open question #5 (`:1431`) defaults to "all 6 commands" but lists only end/compact/respawn/pause/snapshot/restore — no resume.
- *Refactor goal threatened:* **Flexibility in EOL/respawn moments (3)** — pause without resume is a dead-end.
- *Should be owned by:* New F5 task T5.8 "Implement `resumeWorkerSession(agent)` using the existing session reference (no new `SessionManager.create`)."
- *Severity:* critical because the headline feature is incomplete.

### High

**G-05 — Plan does not wire `session.abortCompaction` for cancellation paths.**
- *Where:* F5 defines `compactWorkerSession` (T5.2 at `:432-435`) but no `abortCompaction` path. Per `pi-sdk-session-api.md:48-51`, `session.abortCompaction()` is the documented way to cancel an in-progress compaction. If the orchestrator (or a `compaction_end` handler that decides to cancel) needs to abort a compaction mid-flight, there is no plan path.
- *Refactor goal threatened:* **Pi Best Practices (1)**, **Flexibility in EOL (3)**.
- *Should be owned by:* New F5 task T5.9.
- *Severity:* high.

**G-06 — `restoreWorkerSession` assumes `createBranchedSession` returns an `AgentSession` directly; the SDK returns a session ID.**
- *Where:* `04-refactor-plan.md:450-453`. `pi-sdk-session-api.md:294-296` says `createBranchedSession(leafId) => string | undefined`. The plan's T5.6 calls `installBudgetEventHooks(session, restoredLedger, policy, controller)` immediately, but no `.toAgentSession()` call is shown — unlike `SessionManager.create()` and `SessionManager.continueRecent()` which the plan correctly calls `.toAgentSession()` on (`:212-213`).
- *Refactor goal threatened:* **Pi Best Practices (1)** — claims alignment with documented patterns but uses them wrong.
- *Should be owned by:* F5 T5.6 — must call `createBranchedSession(leafId).toAgentSession()` (if that method exists) or fetch the session via `findById` + `open(path).toAgentSession()`.
- *Severity:* high — likely implementation error caught only at runtime.

**G-07 — Cooperative tools `request_compaction` / `request_end_session` / `request_snapshot` are mentioned but no T5 task implements them.**
- *Where:* `04-refactor-plan.md:464` mentions the cooperative subset. F5's T5.1–T5.7 are about operator commands. The completion guard at `:466-475` says "Cooperative subset (`request_compaction`, `request_end_session`, `request_snapshot`) is exposed as agent-callable tools — verified by a smoke test that the agent can invoke them."
- *Gap:* No T5.x task. No smoke test file named. The guard is unfalsifiable.
- *Refactor goal threatened:* **Flexibility in EOL (3)** — agents can't cooperatively end without these tools.
- *Should be owned by:* New F5 task T5.10, T5.11, T5.12; new test file `tests/cooperative-eol.test.ts`.
- *Severity:* high.

**G-08 — Internal inconsistency: `marker` schema has 3 values, plan uses 6.**
- *Where:* `04-refactor-plan.md:128-134` defines `BudgetLedgerEntry.data.marker?: "warning" | "exhausted" | "checkpoint"`. Then `:428-453` uses `marker: "checkpoint", data: { kind: "end" }`, `kind: "compact"`, `kind: "respawn"`, `kind: "pause"`, `kind: "snapshot"` — six `kind` values inside a `"checkpoint"` marker. But the schema doesn't define a `kind` field at all (the schema only has `caps`, `cumulative`, `writtenAt`, `agentSlug`, `marker`).
- *Refactor goal threatened:* **Config shape changes in scope (5)** — schema is internally inconsistent.
- *Should be owned by:* Schema fix — add `kind?` to `BudgetLedgerEntry.data` (or replace `marker` with `kind`).
- *Severity:* high — type-system level inconsistency.

**G-09 — Team totals under parallel delegation are not pinned.**
- *Where:* F7 T7.2 ("parallel delegation updates (both ledgers intact)"). Plan's `BudgetLedgerEntry` has `agentSlug` per entry (`:124`). Team totals are derived by summing across `agentSlug`s. The T7.2 gate "both ledgers intact" doesn't assert team totals consistency.
- *Refactor goal threatened:* **Budget-constrained delegated agents (2)**.
- *Should be owned by:* F7 — augment T7.2 to assert team totals pre- and post- parallel dispatch.
- *Severity:* high.

**G-10 — `per-day` window accepted by schema but no test exercises cap roll-over.**
- *Where:* `04-refactor-plan.md:1083` (T6.8 lists `per-day` as valid for tokens); no test in F6 covers day-rollover.
- *Refactor goal threatened:* **Config shape changes in scope (5)** — C6 is rated "Land" but its behavior is unverified.
- *Should be owned by:* New F6 task T6.10 "Test `per-day` window rolls over at UTC midnight."
- *Severity:* high.

**G-11 — Plan does not address `SessionManager.branch` / `SessionManager.forkFrom` interaction with the ledger.**
- *Where:* F8 covers `/reload` (T8.1-T8.4). No coverage of `/tree` (which calls `branch(branchFromId)` per `pi-sdk-session-api.md:289`) or `/fork` (`forkFrom` per `:152-156`).
- *Refactor goal threatened:* **Pi Best Practices (1)** — branch-aware claim not exercised for tree/fork.
- *Should be owned by:* New F8 task T8.5 "Verify `/tree` re-derives ledger from new branch."
- *Severity:* high.

### Medium

**G-12 — F5 cooperative subset has no task IDs.**
- *Where:* `:464`. See G-07.
- *Severity:* medium (covered by G-07).

**G-13 — `depth` resource has zero test coverage in any F-task.**
- *Where:* Plan's `BudgetPolicy` at `:235-260` covers tokens, cost, runs. `04-refactor-plan.md:222` keeps `depth.cap` in schema. No F2, F3, F5, F6, F7, F8 task names a `depth` test.
- *Refactor goal threatened:* **Budget-constrained delegated agents (2)** — depth-cap is unenforced.
- *Should be owned by:* F2 T2.3 (or augment F6 T6.1 to add depth-cap test).
- *Severity:* medium.

**G-14 — `queue` resource is dropped without rationale.**
- *Where:* Current-state analysis lists `queue` as one of five resources (`01-current-state-analysis.md:7`). Plan's `BudgetPolicy` (`:235-260`) only covers tokens, cost, runs, depth (depth not in `:235-260` but in schema at `:222`). No plan section explains the queue removal.
- *Refactor goal threatened:* **Refactor scope completeness** — the plan silently drops a tracked resource.
- *Should be owned by:* A "What stays" entry should explain queue removal OR F6 should add queue back.
- *Severity:* medium (silent scope change).

**G-15 — HTML and Markdown disagree on number of open questions.**
- *Where:* Plan §6 (`:1419-1435`) lists **14 open questions** (7 base + 7 config-shape C1-C6 = 13, plus the config-shape summary). HTML page 11 lists **13** open questions (`:1043-1090`). Plan TL;DR says "14 open questions for the user" (`:7`). HTML page 1 says "13 open questions" (`:78`). Plan §0 TL;DR line 7 says "14 open questions for the user."
- *Refactor goal threatened:* **Refactor scope completeness** — user-visible disagreement.
- *Should be owned by:* Fix HTML to match markdown (count: 13 base + 7 config-shape = 20? Or is §6 listing them as 13 with C1-C6 counted as 7 of the 13?). Looking at §6: items 1-7 are base + items 8-13 are C1-C6 = 13 total. The markdown says 14; HTML says 13. **Off-by-one inconsistency** — pick a count, commit to it, fix both files.
- *Severity:* medium (confuses the user but doesn't block implementation).

**G-16 — Plan does not commit to a `schema_version` field for migration cutover.**
- *Where:* §2.10 at `:282-286` says "one release dual-format, then Option B in the following release." No version field defined.
- *Refactor goal threatened:* **Config shape changes (5)** — second-release cutover is ambiguous without a version marker.
- *Should be owned by:* F6 T6.11 "Add `schema_version: 1 | 2` discriminator; emit deprecation warning when version < 2 after cutover release."
- *Severity:* medium.

**G-17 — `summarize_progress` × budget warning emit ordering not pinned.**
- *Where:* F5 T5.7 (`:455-460`) preserves `summarize_progress`. F3 T3.2 emits `appendCustomMessageEntry("budget_warning", ..., display=true)`. If both fire in the same tick, the worker's next prompt context shows whichever landed last.
- *Refactor goal threatened:* **Worker visibility into budget (2)**.
- *Should be owned by:* F3 / F5 combined test.
- *Severity:* medium.

**G-18 — `max-delegation-depth` → `depth.cap` migration is not in F6's explicit task list.**
- *Where:* F6 T6.2 covers `token-budget` and `cost-budget-usd`. T6.5 covers `tokens.include`. No T6.x maps `max-delegation-depth` to `depth.cap`.
- *Refactor goal threatened:* **Config migration (5)**.
- *Should be owned by:* F6 T6.12.
- *Severity:* medium.

**G-19 — `worker-budgets` → `per-worker` rename is in C1 but not in F6 explicit tasks.**
- *Where:* C1 at `:930-942` describes the rename. F6's T6.1 introduces nested schema but doesn't include the rename. T6.4 covers per-agent rename. Global rename is implicit.
- *Refactor goal threatened:* **Config migration (5)**.
- *Should be owned by:* F6 T6.13.
- *Severity:* medium.

**G-20 — `summarize_progress` plan does not address the existing `compact_failed` path.**
- *Where:* Per `test-coverage-analysis.md:48`, the existing code has `no_runtime / over_cap / compact_failed` paths. Plan's T5.7 (`:455-460`) says "preserved, but the notes storage changes." Doesn't mention the failure paths.
- *Refactor goal threatened:* **Behavior preservation** — may regress existing tests.
- *Should be owned by:* F5 T5.7 augmentation.
- *Severity:* medium.

**G-21 — `entry_appended` not wired for self-throttling.**
- *Where:* Plan uses `message_end` for throttling but `entry_appended` (per `agent-session.d.ts:62`) would be the right hook for "react to my own `appendCustomEntry` landing." Not wired.
- *Refactor goal threatened:* **Pi Best Practices (1)**.
- *Should be owned by:* F3 T3.4 (alternative throttling strategy).
- *Severity:* medium.

**G-22 — Telemetry dual-shape emit is in Open Question #7 but no F2/F5 task implements it.**
- *Where:* `:1433` recommends "emit both old and new shapes for one release." No task in F2 or F5 implements this dual-emit.
- *Refactor goal threatened:* **Telemetry event names unchanged** (`:1398`) — claim is contradicted by plan content.
- *Should be owned by:* New F2/F5 task.
- *Severity:* medium.

### Low

**G-23 — Plan does not specify what happens when `controller.signal.aborted` is true inside `appendCustomEntry`.**
- *Where:* F2's gate says `ctx.signal` threaded through every write. F3 doesn't assert abort-mid-write.
- *Severity:* low.

**G-24 — Plan does not address the `cacheWrite1h` and `reasoning` `Usage` fields.**
- *Where:* Per `pi-sdk-session-api.md:151-156`, `Usage` has optional `cacheWrite1h` and `reasoning`. The plan's `include: [Usage keys]` list at `:957` includes `cacheRead, cacheWrite` but not `cacheWrite1h` or `reasoning`.
- *Severity:* low (most providers don't populate these).

**G-25 — Plan's `Bun-specific code` isolation rule is referenced in pitfalls but not enforced as a gate.**
- *Where:* HTML page 10 pitfall "Bun-only code" at `:1174`; AGENTS.md rule. F2-F10 don't include a Bun-isolation check in any completion guard.
- *Severity:* low.

**G-26 — `appendUsage` is mentioned in TL;DR but never wired in any task.**
- *Where:* `04-refactor-plan.md:5` lists `appendUsage` as a primitive; `:21` cites it as a Pi Best Practice source. But no T1, T2, T3, T4, T5 task calls `SessionManager.appendUsage()`. The plan uses `appendCustomEntry` exclusively.
- *Gap:* Per `pi-sdk-session-api.md:158-160`, `appendUsage(kind, provider, model, usage, note?)` "contributes to session token and cost totals." This means `getSessionStats()` would include the budget layer's per-call writes — i.e., the budget layer's own writes would inflate the spend it's measuring. **Using `appendUsage` for the ledger is incorrect; `appendCustomEntry` (which doesn't contribute to LLM context nor session totals) is correct.** The plan does the right thing by using `appendCustomEntry`, but the TL;DR listing `appendUsage` as a primitive is misleading.
- *Severity:* low (the plan does the right thing; just mislabels).

**G-27 — HTML presentation's progress counter starts at `0/0 tasks (0/0 features)`.**
- *Where:* HTML line 39 `<span id="progress-counter">0/0 tasks (0/0 features)</span>`. This is the initial state — JS likely updates it on checkbox toggle, but for the first render the counter is wrong.
- *Severity:* low (cosmetic).

**G-28 — `restoreWorkerSession` is the only EOL command that does not write a ledger snapshot in the plan's table.**
- *Where:* `:392-399` lists 6 commands; the `restoreWorkerSession` row says "(none — destination session emits)" — meaning the destination session's own event hooks write the snapshot. This is correct but couples restore to the destination session's hooks being correctly installed.
- *Severity:* low.

**G-29 — No test for what happens when `policy.ts` is asked about a cap that doesn't apply (e.g., team cost on a per-worker query).**
- *Where:* `04-refactor-plan.md:235-260` — `checkBudgetPolicy` takes `policy: WorkerBudgetPolicy`. What if a caller passes a TeamBudgetPolicy by mistake? Typebox narrowing should catch this but the plan's T1.3 doesn't pin it.
- *Severity:* low.

**G-30 — `interventionAvailable` flag referenced in HTML page 11 (open question) but not in plan §6.**
- *Where:* HTML `:1057-1087` mentions `interventionAvailable` on `budget_warning` events. Plan §6 doesn't list this flag. F13 T13.2 covers it. Mismatch.
- *Severity:* low.

---

## 4. Prioritized clarifying questions

These are questions the plan SHOULD have asked but didn't. Each is sorted by priority and includes: why it matters, what the answer changes, and a default assumption if not answered.

### Critical (4)

**Q1 — Should the plan implement `tool_call` blocking (Pi docs §5), or is throw-to-refuse in `delegate_agent.execute()` the only gating point?**
- *Why it matters:* The plan's TL;DR claims `tool_call` alignment (`:22`) but no task implements it. `tool_call` blocking is the documented primitive for "block an expensive call mid-run" per `extension-patterns-reference.md:158-160`. Without it, the plan is incomplete relative to its stated Pi Best Practices goal.
- *What the answer changes:* If yes → add F3 T3.4 wiring `tool_call` handler that returns block result. If no → revise TL;DR to remove the claim.
- *Default if not answered:* Implement `tool_call` blocking for `bash`, `edit`, `write`, `read` when `workerTokensRemaining <= 0`.

**Q2 — What is the resume path for `pauseWorkerSession`?**
- *Why it matters:* Pause without resume is a dead-end. The plan introduces 6 commands; the 6th (`pause`) has no complement. The "flexibility in EOL/respawn moments" goal (per user's stated goals) requires a clear pause → resume cycle.
- *What the answer changes:* Either (a) add `resumeWorkerSession(agent)` as a 7th command, or (b) redefine `pauseWorkerSession` semantics to be auto-resumed on next prompt.
- *Default if not answered:* Add `resumeWorkerSession` as a 7th operator command (no new SDK primitive; just remove the pause marker from ledger).

**Q3 — How should the implementation reproduce Bug 3 to verify the structural fix?**
- *Why it matters:* The plan claims "Bug 3 structurally impossible" but provides no regression test that exercises the specific symptom (`runtime.* = 0` but `remaining.tokens = 0` after fresh=true abort). Without such a test, the claim is unfalsifiable.
- *What the answer changes:* Either (a) add F7 T7.7 reproducing the exact Bug 3 scenario and asserting the new ledger-based math returns correct `remaining.tokens`, or (b) accept that the structural fix is unverifiable and document the risk.
- *Default if not answered:* Add T7.7 — a fresh=true delegation with budget at 99%, manual abort at 0%, then `restore` and assert `remaining.tokens` reflects actual spend.

**Q4 — Should `agent_settled` snapshot include a final `getSessionStats()` read or rely on the last `message_end` snapshot?**
- *Why it matters:* Per `pi-sdk-session-api.md:299-321`, `getSessionStats()` returns the full session lifetime including aborted messages. The plan uses `getSessionStats()` as the source (`:111`). But the `agent_settled` handler at `:344-353` only calls `ledger.snapshot(stats, policy, "checkpoint", signal)` — which writes the snapshot, but the read of `stats` is not specified. Is the read happening at `agent_settled` time, or is the snapshot just the last throttled write?
- *What the answer changes:* If read at `agent_settled` → `getSessionStats()` includes the final abort-side usage. If relying on throttled → may miss the final state.
- *Default if not answered:* Read `getSessionStats()` at `agent_settled` and write the result as the checkpoint.

### Important (8)

**Q5 — How should `summarize_progress({ notes, compact? })` interact with the 20% budget warning emit?**
- *Why it matters:* Both write `appendCustomMessageEntry` in the same tick potentially. The order in the worker's context depends on which lands last.
- *What the answer changes:* Either order them deterministically (warning first, then note) or merge them into a single entry.
- *Default if not answered:* Warning always emitted before any `summarize_progress` note for the same tick.

**Q6 — Should the plan wire `entry_appended` for self-throttling, or stick with `message_end`-driven throttling?**
- *Why it matters:* `entry_appended` (per `agent-session.d.ts:62`) fires for every session entry, including `appendCustomEntry` itself. Wiring it would let the ledger react to its own writes — useful for "did the warning CustomEntry land?" introspection. Not wiring keeps the simpler `message_end`-driven model.
- *What the answer changes:* If wired → add F3 T3.4 wiring `entry_appended` filter on `customType === "budget_warning"`. If not → keep as-is.
- *Default if not answered:* Don't wire `entry_appended` — keep the simpler design.

**Q7 — What happens when two parallel `delegateAgent` calls exceed team budget mid-flight?**
- *Why it matters:* Per Flow F-N (parallel delegations), team totals are derived by summing across workers. If two workers both write to team ledger simultaneously and the team cap is crossed between the two writes, the second worker may have started already.
- *What the answer changes:* Either (a) pre-flight check only (current design), accepting mid-flight overrun, or (b) live team ledger check in `message_end` handler that aborts the offender.
- *Default if not answered:* Pre-flight check only; document the mid-flight overrun as accepted behavior.

**Q8 — Should `request_compaction` / `request_end_session` / `request_snapshot` be a separate feature (F5.x) or rolled into F5?**
- *Why it matters:* Per Gap G-07, the cooperative subset is mentioned but not implemented. Three agent-callable tools need their own task IDs and tests.
- *What the answer changes:* Either (a) expand F5 with T5.10, T5.11, T5.12, or (b) split into F5-coop.
- *Default if not answered:* Expand F5 with three new tasks.

**Q9 — Should the dashboard migration be part of the refactor PR or separate?**
- *Why it matters:* Open question #3 (`:1423`) defaults to "separate PR after refactor lands." F13 is already in Phase 4 (non-blocking). But the dashboard's current code reads old telemetry event shapes (Risk 7 at `:1417`); without dual-shape emit during the transition, the dashboard breaks the moment the refactor lands.
- *What the answer changes:* If same PR → tighten the telemetry compat layer. If separate PR → keep dual-shape emit for one release.
- *Default if not answered:* Separate PR (per plan); dual-shape emit for one release.

**Q10 — What is the explicit `schema_version` field for migration cutover?**
- *Why it matters:* Per Gap G-16, the plan talks about "one release dual-format" then "hard break" without a version marker.
- *What the answer changes:* Either (a) add `schema_version: 1 | 2` discriminator, or (b) rely on key-name presence (`tokens.cap` present → v2).
- *Default if not answered:* Key-name presence detection.

**Q11 — Should `depth` resource have a per-delegation test, or is the existing `depth.cap` schema-only sufficient?**
- *Why it matters:* Per Gap G-13, depth has no tests in any F-task.
- *What the answer changes:* Either (a) add depth tests in F2/F7, or (b) document depth as "schema-only, not enforced in v2."
- *Default if not answered:* Add depth test to F2 (pre-flight check that `currentDepth + 1 <= policy.depth.cap`).

**Q12 — Should the plan address `SessionManager.branch` (tree navigation) and `forkFrom` (forking)?**
- *Why it matters:* Per Gap G-11, the plan claims branch-aware ledger (`:146-153`) but only covers `/reload`. Tree navigation and forking also exercise `getBranch()`.
- *What the answer changes:* Either (a) add F8 T8.5 and T8.6 for tree/fork coverage, or (b) document tree/fork as out-of-scope for v2.
- *Default if not answered:* Document as out-of-scope for v2.

### Nice-to-have (6)

**Q13 — Should the HTML's open-questions count (13) be reconciled with the Markdown's (14)?**
- *Why it matters:* Cosmetic but user-facing.
- *What the answer changes:* Pick a number, fix both files.
- *Default if not answered:* Use 13 (matches the 13 base + config-shape questions actually enumerated).

**Q14 — Should the plan include a Bun-isolation check in the F9 completion guard?**
- *Why it matters:* AGENTS.md requires Bun-specific code to be isolated to dashboard/server paths. F9's guard at `:1083-1097` doesn't include a Bun check.
- *Default if not answered:* Add `grep -r "bun:" src/engine/budget/` to F9's gate.

**Q15 — Should `cacheWrite1h` and `reasoning` be added to the `include:` list?**
- *Why it matters:* Some providers populate these; current scope is `[input, output]` or `[input, output, cacheRead, cacheWrite]`.
- *Default if not answered:* Don't add (most providers don't populate; premature enumeration).

**Q16 — Should `interventionAvailable` flag be a single boolean per warning or a per-command array?**
- *Why it matters:* F13 T13.2 surfaces this flag. Open question on shape.
- *Default if not answered:* Single boolean per warning (per F13).

**Q17 — Should the migration guide (T12.1) include rollback instructions that touch the running code, or only the schema?**
- *Why it matters:* Plan T12.3 says "rollback path is concrete" but doesn't say what code rollback looks like.
- *Default if not answered:* Schema-only rollback (git revert the config-validation.ts change).

**Q18 — Should the plan document the `appendUsage` vs `appendCustomEntry` decision explicitly?**
- *Why it matters:* Per Gap G-26, TL;DR lists `appendUsage` but the plan uses `appendCustomEntry`. Confusing.
- *Default if not answered:* Add a §2.14 note explaining: `appendUsage` participates in session totals (would inflate spend), `appendCustomEntry` doesn't (correct for ledger).

---

## 5. Recommended next steps

For the user:

1. **Answer Q1-Q4 before any implementation begins.** These four critical questions gate the structural correctness of the refactor. The plan as written has a critical gap on each of the four goals (Pi Best Practices, flexibility, bug-class elimination, config migration).
2. **Decide on `tool_call` blocking (Q1) before estimating LOC.** If yes, add ~150 LOC to F3 and 6+ new tests. If no, remove the TL;DR claim.
3. **Decide on `resumeWorkerSession` (Q2) before F5 implementation.** Either add the 7th command or redefine pause semantics.
4. **Adopt the regression-test-for-Bug-3 stance (Q3).** Either add T7.7 or accept the risk.
5. **Fix the internal `marker` schema inconsistency (G-08).** This is a one-line fix but blocks F5 implementation cleanly.
6. **Reconcile the open-question count (G-15).** Pick 13 or 14; fix HTML + Markdown to match.
7. **Decide on `schema_version` (Q10).** Without it, the second-release cutover is ambiguous.

For the implementation team:

1. **Wire `tool_call` blocking (or remove the claim).** Per Q1.
2. **Add `resumeWorkerSession`.** Per Q2.
3. **Pin the abort-then-`agent_settled` ordering.** Per G-02.
4. **Add a Bug 3 regression test.** Per G-03.
5. **Implement cooperative EOL tools.** Per G-07.
6. **Fix the `marker` schema.** Per G-08.
7. **Address the team-total race in F7.** Per G-09.
8. **Pin `per-day` window roll-over.** Per G-10.

---

## 6. Anything surprising

A few observations that didn't fit the gap inventory cleanly:

1. **The plan is internally consistent on three goals but inconsistent on its own fourth goal (config shape changes).** The plan claims all six C1-C6 land (`:1173-1192`), but the F6 task list (T6.1-T6.9) doesn't explicitly cover `max-delegation-depth` → `depth.cap` (Gap G-18), `worker-budgets` → `per-worker` (Gap G-19), or `schema_version` (Gap G-16). The plan sells config-shape completeness but doesn't deliver it in tasks.

2. **The plan is more conservative than the user's stated flexibility goal.** The user wants "flexibility in EOL/respawn moments" (per their stated goals); the plan delivers 6 commands but pause without resume (G-04) and cooperative tools not implemented (G-07). The literal plan delivers 4 fully-wired commands (end, compact, respawn, snapshot) plus 2 partially-wired (pause, restore).

3. **The plan removes `appendUsage` from the actual implementation despite listing it in TL;DR.** Gap G-26 is interesting because the plan does the right thing (uses `appendCustomEntry` which doesn't inflate session totals) but the TL;DR still lists `appendUsage` as a primitive used. Future readers will be confused.

4. **The plan's marker schema is internally inconsistent.** Gap G-08 (3 marker values vs 6 kinds) suggests the schema was written before the 6-command EOL design. Whoever implements F5 first will hit this immediately.

5. **The plan has more "How do I know" completion guards than it has verifiable gates.** Several guards assert internal consistency (e.g., "verify `session.dispose()` is called") that can only be tested via spy/mocking, not via real SDK behavior. The plan's quality bar is high but its testing strategy is implementation-aware rather than behavior-aware.

6. **The HTML and Markdown presentations agree on substance but disagree on count.** Gap G-15 is small but suggests the documents were not synced after a final edit. Future readers will notice.

7. **The plan does not address the bug class for `compaction_end`-side errors.** Per `agent-session.d.ts:75-79`, `compaction_end` has `aborted: boolean` and `errorMessage?` fields. The plan's F2 T2.1 wires `compaction_end` (`:335-340`) but doesn't check `event.aborted` — meaning a failed compaction triggers the `recordCompaction` ledger write even though no compaction happened. Bug class lurking.

8. **The plan claims `agent_settled` is "canonical" but doesn't cite the SDK source.** `pi-sdk-session-api.md:48` cites the local SDK's `agent-session.d.ts` definition, but the plan's prose at `:344-353` doesn't link back to that file. A reader without access to `pi-sdk-session-api.md` would have to take the claim on faith.

9. **The `pi-hive-budget-ledger` `customType` is a global constant but the plan never names its module location.** If multiple extensions use the same `customType`, collisions are possible. The plan should declare the `customType` as a const in `src/engine/budget/ledger.ts` and import it in every writer.

10. **The plan does not pin the order of `appendCustomEntry` writes during parallel `message_end` events.** If two `message_end` events fire back-to-back (worker emits two assistant messages in quick succession), the SDK writes their `appendCustomEntry` calls in the order the JavaScript event loop schedules them. The plan's ledger.reduce for team totals implicitly assumes order — but a test for "team totals after two concurrent message_end events" would catch any ordering surprise.

---

*End of review. Total findings: 30 gaps (4 critical, 7 high, 10 medium, 9 low); 18 clarifying questions (4 critical, 8 important, 6 nice-to-have).*
