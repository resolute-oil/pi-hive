---
title: Implement mode-switch snapshot/restore for pi-hive
type: implementation
date: 2026-09-23
status: planning
design-doc: docs/2026-09-22-pi-hive-mode-switch-snapshot-restore-design.md
handoff: HANDOFF.md (next-session primary task)
branch: feat/mode-switch-snapshot-restore
---

# Implement mode-switch snapshot/restore for pi-hive

## Context

When the user switches the session from hive or plan mode back to normal,
the agent continues to act like an orchestrator — emitting hive-style
routing language and trying to invoke hive tools that pi-hive just
deactivated. The deactivation path (`setActiveTools(state.normalToolNames)`
plus the rebuilt system prompt) is correct; the failure is that the prior
hive-mode turns remain in the session tree, and the model is more strongly
influenced by that prior context than by the new system prompt.

The locked design (see `design-doc` above) is to branch the conversation
back to a baseline captured on the first transition out of normal, with an
LLM-written summary as the bridge. Hive-mode turns become orphaned branches
in the session JSONL (visible via `/tree` if the user wants to revisit
them, otherwise hidden). Runtime state in pi-hive is reset independently
inside `applyMode`.

This plan implements the design. The design's locked decisions are not
re-litigated here. Anything that contradicts the design is recorded in
the "Deviations from design" section, below.

## Locked decisions (from the design doc)

The full set lives in `docs/2026-09-22-pi-hive-mode-switch-snapshot-restore-design.md`.
What this plan inherits without re-deciding:

- **Q1 Scope** — conversation history only. Runtime state is reset
  independently; not part of the snapshot/restore scope.
- **Q2 Timing** — snapshot on every transition into hive/plan; restore on
  every transition out. One cycle per trip.
- **Q3 Entry points** — `applyMode` gains access to `ExtensionCommandContext`
  where needed. The four mode-switch commands (`/hive:normal`,
  `/hive:plan-mode`, `/hive`, `/hive:toggle`) and the internal caller
  `/hive:execute` provide it. Keyboard shortcut out of scope.
- **Q4 Summary content** — LLM writes it via a tool call argument.
- **Q5 Initial-mode** — no baseline → no-op restore on hive→normal.
- **Q6 Signature** — `applyMode(state, ctx, mode, options?)`; ctx is
  `ExtensionContext` (no signature change). The wider
  `ExtensionCommandContext` is captured from command handlers and used
  in event handlers.
- **Q7 Sequence** — mode change first (`setActiveTools`), label snapshot
  taken at entry, follow-up turn sent after mode switch,
  `branchWithSummary` + `navigateTree` happens in an `agent_settled`
  event handler (NOT in `applyMode`).
- **Q8 Failure** — retry once with empty summary; on retry failure,
  best-effort (log + continue in normal mode without history restore).
- **Q9 Tests** — integration tests with `SessionManager.inMemory()`.

## Architecture changes

### Overview

The flow is **event-driven**, not synchronous in `applyMode`:

1. User types `/hive:normal` (or hive→hive-mode cycle triggers normal).
2. `applyMode` runs synchronously:
   - Sets mode, calls `setActiveTools(normalToolNames)`.
   - If a snapshot baseline exists: sets
     `state.pendingHiveCycleRestore = { snapshotLeafId }` and fires
     `state.pi.sendUserMessage(<trigger text>, { deliverAs: "followUp" })`.
   - Returns true immediately (no wait).
3. LLM responds to the follow-up turn, calls the `hive_cycle_summary`
   tool with the summary text.
4. Tool's `execute` writes the summary into
   `state.pendingHiveCycleRestore.summary`.
5. `agent_settled` fires when the LLM's turn truly settles (no retries,
   no queued continuations).
6. pi-hive's `agent_settled` handler:
   - Captures and clears `state.pendingHiveCycleRestore`.
   - Tries `branchWithSummary` + `branch(reset)` + `navigateTree`.
   - On failure: retries once with empty summary.
   - On second failure: best-effort (log + continue in normal mode).
   - On success: sends a custom-type follow-up message to inform the
     LLM.

### Why event-driven, not synchronous

`pi.sendUserMessage` is **fire-and-forget** — there is no return value,
and capturing a tool-call result from the synchronous command handler is
not a documented pattern. The canonical implementation reference
(pi-context's `context_compact`) uses an event-driven pattern: the LLM
calls a tool whose `execute` stashes params; an event handler does the
work when the agent settles.

This is **faster UX** than the design's synchronous-wait sketch:
`/hive:normal` returns immediately, mode switches immediately, branching
happens once the LLM responds.

### `applyMode` signature (unchanged)

```ts
export function applyMode(state: HiveState, ctx: ExtensionContext, mode: HiveMode, options: { notify?: boolean } = {}): boolean
```

No signature change. `applyMode` accesses `state.pi` for
`setActiveTools` and `sendUserMessage` — both available without ctx
widening.

### Command handler widening (todo 001)

The four mode-switch commands and `/hive:execute` type their `ctx`
parameter as `ExtensionCommandContext` (not `ExtensionContext`). This is
a type widening only — the runtime object is already the wider type per
the design doc's verification.

The keyboard-shortcut path (`pi.registerShortcut`) is left at
`ExtensionContext` per Q3 (out of scope).

### CommandContext capture (todo 001)

Event handlers receive `ExtensionContext` only — no `navigateTree`,
`waitForIdle`. To use those in the `agent_settled` handler, pi-hive
captures an `ExtensionCommandContext` from the first command call and
stashes it in module state. Cleared on `session_shutdown`. Mirrors
pi-context's `pendingCommandContext` pattern.

### State fields (added)

- `state.hiveCycleSnapshotLeafId?: string` — the leaf id captured on
  the most recent entry into hive/plan. Set on transition, read on
  hive→normal, cleared on next entry transition (so the field's
  existence reliably means "a snapshot was taken for this cycle").
- `state.pendingHiveCycleRestore?: { snapshotLeafId: string; summary?: string }`
  — set by `applyMode` when hive→normal with a baseline. Cleared by
  the `agent_settled` handler after capture-and-branch. `summary` is
  filled in by the LLM's `hive_cycle_summary` tool call.

### Restore sequence (event-driven)

On hive/plan entry (in `applyMode`):

1. Drain guard (existing).
2. If `mode !== "normal" && canonicalMode(previous) !== mode`:
   - `state.hiveCycleSnapshotLeafId = ctx.sessionManager.getLeafId()`.
   - `pi.setLabel(snapshotLeafId, "hive-cycle-<ISO-stamp>")` (public API,
     no cast needed).

On hive→normal (in `applyMode`):

1. `state.mode = "normal"`; `state.pi.setActiveTools(state.normalToolNames)`.
2. Existing widget cleanup (`setWidget("hive-tree", undefined)`,
   `updateHiveActivityWidget(state)`).
3. If `state.hiveCycleSnapshotLeafId` is undefined → return (no-op
   restore per Q5).
4. Set `state.pendingHiveCycleRestore = { snapshotLeafId }`.
5. `state.pi.sendUserMessage(<trigger text>, { deliverAs: "followUp" })`.
6. Return true (mode switch complete).

On `agent_settled` (event handler, registered in todo 006):

1. If `state.pendingHiveCycleRestore` is undefined → return early.
2. Capture-and-clear: `const pending = state.pendingHiveCycleRestore;
   state.pendingHiveCycleRestore = undefined;`.
3. If no `commandCtx` captured (no command call happened) → log
   warning, return early (best-effort).
4. First attempt:
   - `await commandCtx.waitForIdle()` (cheap when already idle).
   - `nid = sm.branchWithSummary(snapshotLeafId, summary)`.
   - `sm.branch(snapshotLeafId)` (reset leaf; required for `navigateTree`
     to work — pi-context pattern).
   - `result = await commandCtx.navigateTree(nid, { summarize: false })`.
   - If `result.cancelled === true` → treat as failure.
   - On success: `state.pi.sendMessage({ customType: "pi-hive-mode-switch", content: "Hive cycle summary complete...", display: false }, { triggerTurn: true, deliverAs: "followUp" })`.
5. On first-attempt failure: retry once with `summary = ""`.
6. On second failure: best-effort — log warning
   (`commandCtx.ui.notify` if UI, else `console.warn`), return without
   throwing. Mode switch itself succeeded.

## API surface map

The implementation uses four Pi SDK surfaces, each with its own
access pattern. Confusing these is the #1 source of implementation
errors.

| Operation | API | Lives on | Notes |
|---|---|---|---|
| Read current leaf id | `ctx.sessionManager.getLeafId()` | `ExtensionContext` (read-only) | Works everywhere. Returns `string \| null`. |
| Label a leaf | `pi.setLabel(entryId, label)` | `ExtensionAPI` | Public method. Use this; do NOT call `sm.setLabel` (doesn't exist). |
| Send user-prompt to LLM | `state.pi.sendUserMessage(content, { deliverAs })` | `ExtensionAPI` | Always triggers a turn. No `triggerTurn` option. |
| Send custom-type message | `state.pi.sendMessage({ customType, content, display }, { triggerTurn, deliverAs })` | `ExtensionAPI` | For metadata, not user prompts. |
| Set active tools | `state.pi.setActiveTools(toolNames)` | `ExtensionAPI` | Used for mode-switch tool gating. |
| Branch with summary | `(commandCtx.sessionManager as SessionManager).branchWithSummary(tid, summary)` | Cast needed; not on `ReadonlySessionManager`. | Returns new leaf id. |
| Reset leaf | `(commandCtx.sessionManager as SessionManager).branch(tid)` | Cast needed. | Required after `branchWithSummary` so `navigateTree` isn't a no-op. |
| Wait for idle | `commandCtx.waitForIdle()` | `ExtensionCommandContext` | Only available from command handlers and via the captured CommandCtx. |
| Navigate to branch | `await commandCtx.navigateTree(targetId, { summarize: false })` | `ExtensionCommandContext` | Returns `{ cancelled: boolean }`. |

**Cast pattern** (pi-context standard):
```ts
const sm = commandCtx.sessionManager as SessionManager;
sm.branchWithSummary(tid, summary);  // write methods
sm.branch(tid);  // write methods
```
TypeScript trusts us; the runtime object IS the writable
`SessionManager`. No runtime cost.

## Tree of work

Todos live in `todos/` and follow the file-todos convention
(`{NNN}-{status}-{priority}-{slug}.md`). Each leaf is independently
pick-up-able by a fresh session. Dependencies are explicit in the
frontmatter so a session can compute "what's unblocked now" without
reading this doc.

| # | Slug | Effort | Dependencies |
|---|---|---|---|
| 001 | `applymode-ctx-plumbing` | 30 min | — |
| 002 | `summary-capture-tool` | 25 min | — |
| 003 | `snapshot-capture-and-state` | 30 min | 001 |
| 004 | `no-prior-normal-no-op` | 15 min | 001, 003 |
| 005 | `trigger-llm-summary-prompt` | 20 min | 001, 002, 003 |
| 006 | `agent-settled-branching-handler` | 40 min | 001, 002, 003, 005 |
| 007 | `integration-tests` | 60 min | 001–006 |
| 008 | `changelog-verify-pr` | 30 min | 007 |

Total: ~4.2 hours of focused work across eight leaves.

001 and 002 are unblocked and parallelizable. Sessions can pick up
either first.

### Leaf brief

- **001 `applymode-ctx-plumbing`** — Widen the four mode-switch
  command handlers and `/hive:execute` to type `ctx` as
  `ExtensionCommandContext`. Add a module-level `commandCtx` stash and
  `getCommandCtx()` getter. Clear on `session_shutdown`. `applyMode`'s
  signature is **not** changed — it's still `ExtensionContext`.
  Affected: `src/integration/commands.ts:39,43,52,57,70`.

- **002 `summary-capture-tool`** — Register the `hive_cycle_summary`
  tool. Its `execute` writes `args.summary` into
  `state.pendingHiveCycleRestore.summary` if a pending restore is
  active; otherwise returns an error. Add `pendingHiveCycleRestore` to
  `HiveState` (in `src/core/types.ts`).

- **003 `snapshot-capture-and-state`** — On hive/plan entry, capture
  `ctx.sessionManager.getLeafId()` and label via
  `pi.setLabel(leafId, "hive-cycle-<stamp>")`. Persist in
  `state.hiveCycleSnapshotLeafId`. Skip on mid-cycle re-entry and on
  null leaf.

- **004 `no-prior-normal-no-op`** — Skip snapshot/restore when
  `state.hiveCycleSnapshotLeafId` is undefined (fresh session started
  in hive/plan). Restore becomes a no-op (no trigger, no branching).

- **005 `trigger-llm-summary-prompt`** — On hive→normal with a
  baseline, set `state.pendingHiveCycleRestore = { snapshotLeafId }`
  and fire `state.pi.sendUserMessage(<trigger text>, { deliverAs:
  "followUp" })`. `applyMode` returns immediately. The trigger text
  instructs the LLM to call `hive_cycle_summary` with the summary.

- **006 `agent-settled-branching-handler`** — Register
  `pi.on("agent_settled", async (...) => { ... })`. The handler
  performs the `branchWithSummary` + `branch(reset)` + `navigateTree`
  sequence, retries once with empty summary on failure, and falls
  back to best-effort logging on second failure. Sends a custom-type
  follow-up message on success.

- **007 `integration-tests`** — Tests with
  `SessionManager.inMemory()`. Cover: snapshot on first hive entry;
  tool stashes summary; trigger fires on hive→normal; restore via
  `agent_settled` handler; no-op restore when no baseline; retry with
  empty summary; best-effort fallback. 6-8 cases. Tests manually
  invoke the `agent_settled` handler since there's no real agent
  loop in test mode.

- **008 `changelog-verify-pr`** — Add a CHANGELOG entry mentioning
  the deviation. Run `just verify`. Commit with Conventional Commits.
  Push to fork. Open PR against `resolute-oil/pi-hive:main`. PR body
  references the design doc and lists leaves completed.

## Top-level acceptance criteria

The implementation is "done" when:

- [ ] Todos 001–008 all in `complete` status (file-todos rename).
- [ ] `just verify` clean (typecheck + lint + tests; 373 + new tests pass).
- [ ] Manual smoke: `/hive` then `/hive:normal` leaves the agent
      acting like normal Pi (no hive-style language, no attempts to
      call `delegate_agent` / `route_agent`).
- [ ] Manual smoke: `/tree` shows the hive-mode turns as an orphaned
      branch with the summary entry on the new branch.
- [ ] Manual smoke: starting a fresh session directly in `/hive` and
      switching back to normal leaves the user in normal mode without
      history branching.
- [ ] PR opened against `resolute-oil/pi-hive:main` and merged.

## Risks (implementation-specific, beyond the design doc's risks)

- **Stale `commandCtx` across session replacements.** Captured
  `ExtensionCommandContext` may reference the previous session. Mitigated
  by the `session_shutdown` clear (todo 001). Document the invariant:
  the stash is non-null only between the first command call and the
  next `session_shutdown`.
- **`branchWithSummary` clobbering existing branches.** If the user
  enters hive mode twice without an intervening hive→normal (shouldn't
  happen, but...), the second snapshot label overwrites the first.
  Mitigated by the mid-cycle check in 003 (only snapshot on actual
  transitions). Documented as accepted.
- **LLM doesn't call `hive_cycle_summary` at all.** `summary` stays
  undefined; the agent_settled handler branches with empty string.
  Less useful than a real summary, but better than no branching.
  Documented as accepted.
- **LLM calls `hive_cycle_summary` outside a hive handoff.** The
  tool's `execute` returns an error result if there's no pending
  restore, so the LLM gets a clear signal. Mitigated by the tool
  description being explicit about when to call.
- **Concurrent mode-switch attempts** — out of scope per design doc,
  but worth noting. The user's typing a `/hive:normal` after `/hive`
  is sequential today; if pi-hive ever supports programmatic
  switches, add a mutex.

## Test surface (for the implementer)

Reference points the implementer will need:

- `src/ui/tui/widget.ts:131` — current `applyMode`.
- `src/ui/tui/widget.ts:147` — drain guard (unchanged).
- `src/ui/tui/widget.ts:155-180` — `activateTeamRuntimes` (call site
  unchanged).
- `src/integration/commands.ts:39,43,52,57,70` — five handlers
  (widening + CommandCtx stash).
- `src/integration/commands.ts:62` — keyboard shortcut (out of scope).
- `src/agents/tools.ts` — existing tool registration pattern to
  mirror for `hive_cycle_summary`.
- `src/core/types.ts` — `HiveState` (add `hiveCycleSnapshotLeafId`,
  `pendingHiveCycleRestore`).
- `tests/activity-panel.test.ts` — example of a test file that builds
  a `HiveState` for unit testing (good model for the integration
  tests).
- `tests/register-ts-loader.mjs` — the test loader to use when
  running a single file (`node --import tsx --import
  ./tests/register-ts-loader.mjs --test tests/<file>.test.ts`).
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
  — the SDK type definitions (verified during planning).
- `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts`
  — `SessionManager` write methods.
- `@ttttmr/pi-context/src/index.ts` — canonical reference for the
  event-driven pattern (read this if any branch of the flow is
  unclear).

## Handoff-ready template

If a session ends before all todos are complete, the next session
should append a "Handoff" block to the **plan doc** (this file) — not
a fresh `HANDOFF.md`. That keeps the implementation state co-located
with the plan.

```markdown
## Handoff — <ISO-date>

- **Branch:** `<branch>` (worktree `<path>`)
- **Current HEAD:** `<commit-sha>`
- **Completed todos:** 001, 002, …
- **Remaining todos:** 003, 004, … (with their current status)
- **`just verify` state:** clean / `<N>` known failures (none new)
- **Discoveries / decisions since last handoff:**
  - <bullet>
  - <bullet>
- **Deviations from design:** <none / list with rationale>
- **Next session should start with:** todo <next-id>
```

Each todo's own Work Log also captures session-by-session actions and
learnings on the leaf itself. The plan doc's handoff block is for
cross-cutting context.

## Deviations from design

The implementation departs from the design doc's literal sketch in
three places. All three preserve the design's Q1-Q9 intent but use
the pi-context canonical pattern instead. Each deviation has a
rationale.

- **Deviation 1 — `pi.sendMessage` → `pi.sendUserMessage` for the
  trigger.** Q7 step 3 sketches
  `pi.sendMessage({...}, {triggerTurn: true, deliverAs: "followUp"})`
  for asking the LLM to summarize. `pi.sendMessage` is for
  **custom-typed** messages (system-tagged events the LLM sees as
  `<customType>` blocks). For a "summarize this" user prompt, the
  right call is **`pi.sendUserMessage(content, { deliverAs: "followUp" })`**.
  Verified against pi-context's `ensureCommandContext` block
  (`src/index.ts`), which uses `sendUserMessage`. The post-restore
  LLM notification IS a custom-type message and correctly uses
  `pi.sendMessage`.

- **Deviation 2 — Synchronous branching → event-driven branching.**
  Q7 steps 5-6 sketch branching immediately after the LLM responds,
  inside the command handler. `pi.sendUserMessage` is fire-and-forget;
  capturing a tool-call result synchronously in a command handler is
  not a documented pattern. The canonical reference
  (pi-context's `context_compact`) puts branching in an
  `agent_end` handler that runs after the LLM's turn ends. We use
  `agent_settled` (an even safer variant — fires after retries and
  queued continuations are done), which removes the need for
  pi-context's `setTimeout(0)` deferral and `didConversationAdvance`
  guard.

- **Deviation 3 — `ctx.sessionManager.setLabel` → `pi.setLabel`.**
  Q3's "verified facts" claim `ctx.sessionManager.setLabel` is a
  `SessionManager` method. `SessionManager` has no method by that
  name — the write method is `appendLabelChange(targetId, label)`
  and requires a cast. The clean alternative is **`pi.setLabel(entryId,
  label)`**, a public method on `ExtensionAPI` with no cast. For
  `branchWithSummary` and `branch`, no public alternative exists;
  the cast `ctx.sessionManager as SessionManager` is used (pi-context
  pattern).

## Work log (plan-level, cross-cutting)

Append-only. One entry per session or significant event. Per-leaf
actions go in each todo's Work Log, not here.

- 2026-09-23 — Plan written. Nine leaves identified. Initial sketch
  mirrored the design doc's literal Q7 sequence.
- 2026-09-23 — Plan revised after verifying against pi-context's
  `src/index.ts` and the Pi SDK type definitions. Eight leaves (retry
  folded into the event handler). Three deviations recorded above.
  All eight todos and the plan doc are now implementation-ready pending
  user sign-off.