# Wave LLM tool gap — after-action

**Branch:** `refactor/llm-tool-gap`
**Base:** `a468a4d` (FF-merged from `refactor/budget`)
**Date:** 2026-10-05
**Scope:** Close the structural mismatch between the engine's 12 operator
commands and the LLM-callable tool surface. Before this wave, the
dashboard's 11+1 buttons were the only path to drive `end` / `compact` /
`respawn` / `pause` / `snapshot` / `restore` / `resume` /
`abort-compaction` / `force-kill` / `force-end` / `tear-down-all` /
`hive_reload_agent_config`. After this wave, the Orchestrator LLM in
/hive mode can call them directly from chat via 12 new LLM tools, plus
2 introspection tools for policy and last-rejection diagnostics.

## Commits

| Hash | Subject |
|------|---------|
| `7ab241c` | `feat(extension): register 12 operator commands as LLM-callable tools (LLM tool gap)` |

(One commit — the operator tools, introspection tools, prompt
addition, and the tests are tightly coupled; splitting them would
have produced four commits that touch the same `buildHiveTools`
function for no clarity gain.)

## Per-section status

### 1. 12 operator command tools — DONE

All 12 LLM tools are registered in `src/agents/tools.ts`, gated to
`callerType === "lead"` so only the orchestrator (and any other
`agentType: "lead"` agent) sees them. The tools are:

| LLM tool | Engine function | Consumer command |
|----------|-----------------|------------------|
| `hive_end_worker` | `endWorkerSession` | `end` |
| `hive_compact_worker` | `compactWorkerSession` | `compact` |
| `hive_respawn_worker` | `respawnWorkerSession` | `respawn` |
| `hive_pause_worker` | `pauseWorkerSession` | `pause` |
| `hive_snapshot_worker` | `snapshotWorkerSession` | `snapshot` |
| `hive_restore_worker` | `restoreWorkerSession` | `restore` (defensive — see note) |
| `hive_resume_worker` | `resumeWorkerSession` | `resume` |
| `hive_abort_compaction` | `abortWorkerCompaction` | `abort-compaction` |
| `hive_force_kill_worker` | `forceKillWorkerSession` | `force-kill` |
| `hive_force_end_worker` | `forceEndWorkerSession` | `force-end` |
| `hive_tear_down_all` | `tearDownAllWorkers` | `tear-down-all` |
| `hive_reload_agent_config` | `hiveReloadAgentConfig` | `hive_reload_agent_config` |

The names follow the existing `hive_*` convention; the descriptions
follow the existing tools' style ("Use when ...", actionable
guidance). Each tool takes the same parameters as the engine
function (worker name; empty/omitted for `hive_tear_down_all`).

`hive_restore_worker` is registered for symmetry with the dashboard
button but currently returns a clear error from the consumer
("restore requires a snapshot id — not yet supported by the
consumer"). The dashboard has no snapshot-id input flow either; the
tool's description documents this so the LLM does not retry.

### 2. Producer — Node-safe queue helper

`src/engine/budget/operator-command-queue.ts` is the new
Node-runtime-safe producer. It mirrors the dashboard's
`writeOperatorCommandRequest` (`db.ts`, Bun-only) byte-for-byte:

- Same path resolution: `process.env.HIVE_TELEMETRY_DB` →
  `<dir>/operator-command-pickup.jsonl`. Falls back to
  `~/.pi/agent/hive/telemetry.db` when unset.
- Same row shape: `{id, agent, command, requestedAt}` JSON line,
  newline-terminated, mode 0o600.
- Same 12-command allow-list (`OPERATOR_COMMAND_NAMES`).
- Same 120-char cap on the agent name.

A future consolidation (move the dashboard's
`writeOperatorCommandRequest` into this file) is straightforward
but out of scope; both writers append to the same file and the
pickup consumer does not see the origin.

The helper also validates the agent against the configured roster
(`state.config.agents`) before writing. The dashboard HTTP handler
validates only the agent's name length; the LLM tool adds the
roster check because the LLM is more likely to guess a wrong name
than a human clicking a dashboard button.

### 3. System prompt — DONE

`src/agents/prompts.ts` now appends two sections to the
orchestrator's system prompt:

- **Operator surface (LLM-callable)** — lists all 12 tools with
  one-line descriptions, the cooperative-vs-operator distinction,
  and the recommended remediation ladder
  (respawn → compact → force-kill).
- **Introspection (read-only)** — lists `hive_read_policy` and
  `hive_explain_rejection` so the model knows the read path before
  it reaches for the write path.

The pre-flight gate / budget section was already present; this
wave kept it intact and added the operator surface as a separate
section so the prompt does not balloon.

### 4. Tests — DONE (22 cases)

`tests/llm-tools.test.ts` covers:

- All 12 tools are registered for the orchestrator (Test 1).
- Each tool's description is non-trivial and includes "when to
  use" guidance (Test 2).
- Workers (coder / tester / reviewer / planner) do NOT see any
  of the 12 tools (Test 3).
- `TYPE_SCOPED_TOOL_NAMES` includes all 12 (Test 4) — pins the
  dispatch union.
- Each of the 12 tools writes the correct row to
  `operator-command-pickup.jsonl` (Test 5 — the load-bearing
  end-to-end check).
- Allow-list enforcement: unknown command (Test 6), unknown
  agent (Test 7), over-long agent name (Test 8), `tear-down-all`
  with empty agent (Test 9).
- `hive_reload_agent_config` is the only command that does not
  require a live worker handle (Test 10).
- System prompt includes the operator surface section and lists
  every one of the 12 tools (Tests 11, 12).
- The row written by the LLM tool is byte-identical (modulo
  `id` and `requestedAt`) to what `writeOperatorCommandRequest`
  in `db.ts` would write — the cross-process contract
  (Test 13).
- Path resolution matches the consumer's expectation (Test 14).
- The 12 LLM tool names map 1:1 to the 12 engine functions and
  the helper rejects any unknown command name (Test 15).
- Introspection tools: registered (Test 16), gated from workers
  (Test 17), `hive_read_policy` returns the resolved policy with
  per-agent overrides winning over global defaults (Test 18),
  clear error for unknown agent (Test 19), `hive_explain_rejection`
  returns null for fresh agents (Test 20), returns structured
  rejection when one is recorded (Test 21), clear error for
  unknown agent (Test 22).

### 5. Introspection tools (should-have) — DONE

`hive_read_policy(agent?)` and `hive_explain_rejection(agent)` are
both registered and gated to `callerType === "lead"`.

`hive_read_policy` resolves the effective `WorkerBudgetPolicy` via
`resolveWorkerBudgetPolicy` (per-agent override → global
defaults → unlimited) and surfaces the `strategies` block
(`onApproachingLimit.threshold`, `onExhaustion.action`,
`summary.maxTokens`). Use case: the LLM can predict whether a
delegation will pass the pre-flight gate BEFORE calling
`delegate_agent`.

`hive_explain_rejection` reads `runtime.lastRejection` (a new
optional field on `AgentRuntime` populated by the dispatch
catch on `BudgetExhaustedError` and cleared on the next
successful delegation). The field carries the full
`BudgetBlock` shape (scope, resource, remaining, limit,
timestamp) so the LLM gets a structured explanation when
`delegate_agent` fails with "Delegation blocked: ...".

The runtime field is a small, focused addition: one type
declaration, two lines in the dispatch catch (set on
rejection, `delete` on success).

### 6. Cooperative tool trigger (should-have) — SKIPPED

Investigated and intentionally deferred. The 3 cooperative
tools (`request_compaction`, `request_end_session`,
`request_snapshot`) are worker-self-call wrappers that close
over `o.session`, `o.policy`, `o.ledger` — they need a live
`AgentSession` to operate on, and the orchestrator does not
have a handle into a worker's session (it lives in the
worker's process, not the orchestrator's). The cooperative
tool registry (`cooperativeToolRegistry`,
`src/engine/budget/worker-tools.ts:586-591`) is a test-only
artifact (`Set<CooperativeToolName>` asserted to contain
exactly the 3 cooperative names).

Possible workarounds and why each was rejected:

1. **Send a prompt to the worker asking it to call the
   cooperative tool.** Fragile: depends on the worker's
   compliance with the request, and the cooperative tool
   only fires when the worker is actively in a tool-call
   loop. Not an operator surface.
2. **Re-use the JSONL pickup pattern for cooperative
   commands.** Would require the worker to poll the same
   file, which it does not. The current consumer is
   parent-pi only.
3. **Add new engine functions for the cooperative
   operations.** Functionally redundant with the existing
   `compactWorkerSession` / `endWorkerSession` /
   `snapshotWorkerSession` operator commands, which the
   orchestrator can already drive via the 12 LLM tools
   this wave added.

The cooperative tools' purpose is to let a worker
gracefully ask for its own compaction when its context
fills. That is a worker-self-call path; the orchestrator
already has the equivalent operator surface via the 12
new LLM tools. A future wave that wants to add a
cooperative-trigger tool (e.g., to send a polite
"please compact" prompt to a worker) is straightforward
but does not require the cooperative registry to be
modified — the prompt is just a normal delegation.

## Test count delta

| Lane | Pre-wave | Post-wave | Delta |
|------|----------|-----------|-------|
| Node (`just test`) | 693 | 715 | +22 |
| Vitest (`ui/web npm run test:unit`) | 63 | 63 | 0 |
| Bun (`just test-db`) | 12 | 12 | 0 |

All 715 Node tests pass; all 63 vitest tests pass; all 12 bun
tests pass; `just typecheck` is clean.

## Verification

```sh
cd /Users/cgrant/code/pi-hive/.worktrees/refactor-llm-tool-gap
just typecheck
just test
just dashboard-build
cd ui/web && npm run test:unit
```

All four commands pass cleanly.

## Confirmation: an LLM in /hive mode can now manage workers

The end-to-end call flow:

1. The user is in /hive mode. The orchestrator's pi session has
   `buildHiveTools(state, "Orchestrator")` registered (via
   `registerTools(pi, state)` in `index.ts:40`). `callerType`
   resolves to `"lead"` because the orchestrator's configured
   name is "Orchestrator".
2. The orchestrator LLM calls `hive_respawn_worker(agent="builder")`.
3. The tool's `execute` validates the agent against the
   configured roster (clear error if not found), validates the
   command against the 12-name allow-list, then calls
   `queueOperatorCommand(state, "builder", "respawn", requestedAt)`.
4. `queueOperatorCommand` appends one row to
   `operator-command-pickup.jsonl`:
   `{"id":"<ms>-<rand>","agent":"builder","command":"respawn","requestedAt":"<iso>"}`.
5. The tool returns `{ok: true, status: "queued", ...}` to the
   LLM (action is async).
6. The parent pi's pickup consumer (started in
   `startOperatorCommandPickup` during `session_start`, polling
   every 250ms) reads the row, looks up the worker handle for
   `builder`, invokes `respawnWorkerSession(ctx, "operator: respawn")`,
   and unlinks the file.
7. The LLM can call `team_status` on the next turn to see the
   updated worker state. The dashboard's 11-button UI continues
   to work in parallel (same JSONL, same consumer).

The same flow applies to all 12 operator tools and the 2
introspection tools. The only difference between LLM-driven and
dashboard-driven operator commands is the producer half — both
write the same row shape; the consumer is origin-agnostic.

## Follow-ups

- **`hive_restore_worker` snapshot-id input.** The tool is
  registered but the consumer rejects restores without a
  snapshot id. A future wave could either add a `snapshotId`
  parameter to the LLM tool + extend the consumer's restore
  branch, or leave the LLM path as dashboard-only and document
  the limitation (which is what the tool's description does
  today).
- **Cooperative tool trigger for the orchestrator.** Deferred
  per the analysis above. If a future wave wants to add
  `hive_request_compaction_for_worker` and friends, the cleanest
  path is a new worker-side cooperative consumer (separate from
  `operator-pickup.ts`) that the worker polls. This wave did
  not introduce any cooperative registry changes.
- **Consolidate the two `writeOperatorCommandRequest` writers.**
  `db.ts` (Bun) and `operator-command-queue.ts` (Node) write
  the same row shape to the same file. A future cleanup could
  move the `db.ts` writer onto the shared helper and drop the
  Bun-specific copy. Out of scope for this wave.

## Deviations

- None. The brief's must-haves (12 tools, system prompt, tests)
  and both should-haves (introspection) were implemented; one
  should-have (cooperative trigger) was investigated and skipped
  with rationale above. The 22-test count exceeds the brief's
  minimum (which only required registration + JSONL write +
  allow-list + prompt).

## After-action location

`docs/plans/budget-refactor/agent-reports/wave-llm-tool-gap-after-action.md`
