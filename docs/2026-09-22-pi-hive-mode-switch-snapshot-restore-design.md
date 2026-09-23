# pi-hive mode-switch snapshot/restore

## Summary

When the user switches the session from hive or plan mode back to normal, the agent continues to act like an orchestrator — emitting hive-style routing language and trying to invoke the hive tools that pi-hive just deactivated. Investigation showed the pi-hive deactivation path is correct (`setActiveTools(state.normalToolNames)` rebuilds the system prompt without the hive overlay; the active tool set removes `delegate_agent`, `route_agent`, etc.); the failure is that the prior hive-mode turns remain in the session tree, and the model is influenced by that prior context more than by the new system prompt.

This design adds a snapshot/restore mechanism that branches the conversation back to a baseline captured on the first transition out of normal, with an LLM-written summary of the hive-mode work as the bridge. On returning to normal, the agent sees the baseline path plus the summary; the hive-mode turns become orphaned branches in the session JSONL (visible via `/tree` if the user wants to revisit them, otherwise hidden). Runtime state in pi-hive (`state.activeChangeId`, `state.orchestratorRuntime` token counters) is reset independently inside `applyMode` since it does not depend on conversation history.

## Terms

- **snapshot** — The captured reference point in session history that we intend to return to on exit from hive/plan mode. Avoid: *backup*, *save state*.
- **restore** — Moving the session's leaf pointer (and the agent's active path) back to the snapshot point so subsequent turns append there, not to the hive-mode tail. Avoid: *revert*, *rewind*.
- **summary branch** — A new branch created by `sm.branchWithSummary()` that carries an LLM-written handoff summary of the abandoned path. pi-context's `context_compact` is the canonical example. Avoid: *summary entry*.
- **ExtensionCommandContext** — The `ctx` object passed to command handlers and tool executions. Has `navigateTree()`, `waitForIdle()`, `sessionManager`, and other methods needed to drive the agent. The regular `ExtensionContext` given to event hooks is a strict subset. Avoid: *ctx*.

## Why

> "I switch from hive/plan mode to normal mode and the agent still acts as though I am in one of the non-normal modes. Can you investigate why that would happen?"

> "More specifically, I switch to normal mode, and instead of letting the session act as though pi-hive isn't loaded (the intended effect), it still wants to route jobs through pi-hive workflows/tools (unwanted behavior)."

The user-reported symptom is the model continuing to use hive-mode behavior after the user has switched back to normal mode. The fix needs to be more thorough than a system-prompt injection because the model is strongly influenced by conversation history; a stronger solution is to actually reshape the history.

## Locked decisions

### Q1 — What is the scope of state we snapshot and restore?

**Decision: A — Conversation history only.** Snapshot the leaf pointer and the hive-mode tail, restore by branching back to the snapshot with a summary of the hive-mode work. Runtime state in pi-hive (`runtimes`, `activeChangeId`, `budgets`) is re-initialized from the config and from in-memory defaults.

Rejected options:
- **B (conversation + pi-hive runtime state)**: would also clear `state.activeChangeId` and reset `state.orchestratorRuntime` token counters on hive→normal restore. Most of this is already handled by `activateTeamRuntimes` and the drain guard; the two residual resets are tiny enough to add later as a separate small rule if they turn out to matter. Treating them as part of the snapshot/restore scope conflates two unrelated concerns.
- **C (full session replacement via `createAgentSessionRuntime`)**: would change the user's visible session identity during hive mode. Breaks the mental model of "one continuous session." Too invasive for the symptom.

### Q2 — When is the snapshot taken, and when is the restore applied?

**Decision: B — Snapshot on every transition to hive/plan; restore on every transition to normal.** Each cycle is independent — re-entering hive creates a fresh snapshot anchored at the current leaf. The conversation tree accumulates one summary entry per cycle rather than one big summary over a multi-cycle stint. The cost is more bookkeeping per cycle (one label slot, one `branchWithSummary` call); the benefit is that the user can return to plain Pi, do more work, then enter hive again and have the previous hive stint be a clean discrete unit visible in `/tree`.

Rejected options:
- **A (single baseline snapshot, reused across cycles)**: rejected by user. The bookkeeping difference is small and the per-cycle model is more honest about the conversation structure.
- **C (lazy snapshot inside restore)**: defers the label but complicates the restore path with a "first time" branch.

### Q3 — How do we access SessionManager from inside applyMode?

**Decision: B — Targeted refactor.** `applyMode` gains an optional `ctx` parameter; the four mode-switch commands (`/hive:normal`, `/hive:plan-mode`, `/hive`, `/hive:toggle`) pass their `ExtensionCommandContext` in. The one internal call site (`/hive:execute`) already passes its parent `ctx`. The keyboard-shortcut path is out of scope per the user's preference.

Rejected options:
- **A (full refactor to `createAgentSessionRuntime`)**: would guarantee SessionManager is everywhere but is a 200–400-line refactor of `index.ts`, tool/command/hook rebinding on every session, with no incremental functional gain given B.
- **C (use `ctx.sessionManager` only inside the `/hive:normal` command handler)**: punts on half the mode-switch entry points. The keyboard shortcut is out of scope per user, but `/hive:toggle` and programmatic callsites like `/hive:execute` would still need to be plumbed through.

### Q4 — How is the handoff summary content produced?

**Decision: A — The LLM writes it.** On hive→normal, pi-hive sends a follow-up turn asking the agent to summarize what happened in hive mode and call a pi-hive tool (or use pi-context's `context_compact` if installed) to produce the summary branch. Matches pi-context's pattern.

Rejected options:
- **B (deterministic template from runtime state)**: shallow; can't reconstruct WHY of hive-mode decisions, only WHAT.
- **C (user provides it via `/hive:normal [summary]`)**: too much friction for the common case.

### Q5 — What happens if the session starts directly in hive/plan mode?

**Decision: A — Skip the snapshot when there is no prior normal-mode history.** The restore on hive→normal becomes a no-op (just clear mode, no branching). The user gets the current "model acts orchestrator-like" behavior because there was no normal baseline to return to. Acceptable because they explicitly opted into hive mode from the start.

Rejected options:
- **B (synthesize a baseline at session_start)**: tries to manufacture a baseline that didn't exist. Restoring to a synthetic "no history" branch gives the user nothing useful.
- **C (refuse hive mode until user has been in normal mode at least once)**: adds friction and contradicts the user's expectation that mode switches are freely available.

### Q6 — What does the applyMode signature change look like?

**Decision: A — `applyMode(state, ctx, mode, options?)` — just pass the `ExtensionContext` (or `ExtensionCommandContext`) directly.** Internal callers that want restore use `ctx.sessionManager` and `ctx.navigateTree` directly inside `applyMode`. Simpler signature, less wrapping.

Rejected options:
- **B (wrap in a `SnapshotContext` object)**: over-engineering for a feature with one caller per code path.
- **C (stash the most recent `ExtensionCommandContext` in `state.commandContext`)**: brittle and creates hidden coupling if multiple commands overlap.

### Q7 — How is the LLM asked to write the handoff summary?

**Decision: A — After-switch follow-up turn.** Sequence under A:

1. `applyMode`: `state.mode = normal`; `pi.setActiveTools(state.normalToolNames)`. Hive tools are removed from the agent view.
2. `sm.setLabel(currentLeafId, snapshot-label)`. The session tree is unchanged; the leaf points to the same place as before.
3. `pi.sendMessage({...}, {triggerTurn: true, deliverAs: "followUp"})` asks the agent to summarize the hive/plan-mode work and call a pi-hive tool with the summary text.
4. The LLM responds. At this point, the LLM can still read the full conversation history (the hive-mode turns are still in the active path of the session tree — the branch has not been moved yet). It writes a summary based on what it sees.
5. pi-hive calls `sm.branchWithSummary(snapshotLeafId, summaryText)` — this is where the branch actually moves. The new branch starts at the snapshot point and contains the summary as its first entry.
6. `commandCtx.navigateTree(newLeafId)` — the agent now follows the new branch and loses visibility of the hive-mode turns (they become orphaned).

The mode change (step 1) and the branch change (steps 5–6) happen at different times. Between them, the LLM has access to the hive-mode context because the branch has not moved. The mode change only affects the active tool set; the conversation history is untouched until the `branchWithSummary`/`navigateTree` step.

Rejected options:
- **B (block `applyMode` until the agent writes the summary)**: introduces a synchronous wait inside `applyMode` that breaks the simple mode-switch UX (the user types `/hive:normal` and waits for a model turn before the switch happens).
- **C (build the summary automatically from runtime state)**: abandons the LLM-summary benefit and was rejected in Q4.

### Q8 — What happens if `sm.branchWithSummary` or `commandCtx.navigateTree` fails?

**Decision: C — Retry once with an empty summary, then fall back to A (best-effort).** The retry-with-empty-summary step catches transient failures (`sm` throwing once, `navigateTree` returning `cancelled: true` once) without leaving the user stranded in hive mode after they explicitly asked to leave. If the retry also fails, fall back to A — log the error, leave the user in normal mode (the switch itself succeeded), skip the conversation-history restore. The model continues with whatever conversation history it has. Two attempts balances resilience against the user being kept in hive mode against their explicit request.

Rejected options:
- **A (best-effort immediately, no retry)**: rejected by user. Adds resilience against transient failures without breaking the UX.
- **B (strict — fail the mode switch if restore fails)**: requires rolling back `state.mode` and re-emitting the hive-mode tool set, which is harder than just continuing in plain Pi without the conversation restore.

### Q9 — How do we test the snapshot/restore flow?

**Decision: B — Integration tests with a real `SessionManager.inMemory()` (no disk) but real `sm` operations.** Tests the branching/labeling logic end-to-end within `applyMode`, just without persistence. Catches integration bugs in pi-hive but not Pi SDK regressions. ~5–10 test cases covering: snapshot on first hive entry, restore on subsequent return, no-op restore when no baseline, summary branch creation, retry-then-fall-back on `sm` failure.

Rejected options:
- **A (unit tests with mocked SessionManager)**: catches the most likely bug (wrong arguments to `sm` methods) but misses the integration with Pi real behavior.
- **C (live integration tests with real disk)**: overkill — the SessionManager API is well-tested upstream, and pi-hive needs to verify its own usage not Pi internals.

## Verified facts

- `ctx.sessionManager` is available in command handler context. Verified by reading `packages/coding-agent/examples/sdk/13-session-runtime.ts` and `packages/coding-agent/src/core/extensions/loader.js` in the upstream Pi repo.
- `sm.setLabel`, `sm.branchWithSummary`, `sm.getLeafId` are the relevant `SessionManager` methods. Read from `packages/coding-agent/dist/core/session-manager.d.ts` (v0.84.2).
- `commandCtx.navigateTree` is the way to make the agent follow a new branch. Read from `packages/coding-agent/docs/sdk.md`.
- pi-context's `context_compact` tool (in `@ttttmr/pi-context`) uses the same Pi APIs (`sm.branchWithSummary` + `commandCtx.navigateTree` + `pi.sendMessage({triggerTurn: true})`) and is the canonical implementation reference. Read from `github.com/ttttmr/pi-context` at `src/index.ts`.
- pi-hive's existing `applyMode` already calls `activateTeamRuntimes` on every team-shape change, so the `runtimes` Map is reset implicitly. Verified in `src/ui/tui/widget.ts:155–180`.
- The drain guard in `applyMode` refuses the transition if `state.activeRuns > 0`, so `state.workerQueue` / `state.backgroundTasks` are typically empty by the time a restore fires. Verified in `src/ui/tui/widget.ts:147`.

## Risks

- **Orphaned branches accumulate in the session file.** Each hive-mode cycle creates one orphaned branch with its hive-mode turns. Over many cycles the session file grows. Not pruned automatically; users can `/tree` to revisit but the file accumulates linearly.
- **LLM summary quality is variable.** The agent may write a thin or inaccurate summary. There's no validation step. The user can re-enter hive mode and navigate the orphaned branch manually if the summary is unhelpful.
- **Rapid mode switches** (hive→normal→hive→normal in seconds). Each cycle is independent, so the user could create many small summary branches in quick succession. No concurrency guard on `sm` operations; in practice the operations are quick enough that race conditions are unlikely, but worth knowing.
- **Session crash mid-hive-mode.** If Pi crashes mid-hive-mode, the session file has partial hive-mode entries. On restart, pi-hive's `session_start` fires with mode `"normal"`. The user can navigate the session tree manually via `/tree`. No special recovery handling.
- **Telemetry on orphaned branches.** The hive-mode telemetry events stay in the session file and surface in the dashboard via `/tree` navigation. They are not pruned automatically. Acceptable for now.

## Deferred

- **Telemetry pruning on orphaned branches** — left alone for now; could be a follow-up if session files grow too large.
- **Visual diagram of the flow** — not requested during the grill; the design doc stands on its own. Could be added later as a `docs/2026-09-22-pi-hive-mode-switch-snapshot-restore-visual.html` companion if useful for review.
- **pi-context as a peer extension** — considered but rejected; pi-hive implements the mechanism directly using Pi SDK APIs. Users who also want pi-context's full agentic context management can install it independently.
- **Session crash recovery** — partial-hive-mode session files require manual `/tree` navigation. Could be improved with a "resume into the most recent hive-mode cycle" feature, but no current demand.
- **Concurrent mode-switch attempts** — only the user triggers mode switches today, so no concurrency guard is required. If pi-hive ever supports programmatic mode switching from multiple sources, add a mutex.

## Open threads

These are discussion points that ended without changing the answer. Recorded for context.

- **Q1 thread** ("What are the differences between A & B?") — clarified that B is mostly redundant with existing `applyMode` resets; the only residual gap is `state.activeChangeId` and `state.orchestratorRuntime` cleanup, which is a separate small concern rather than a scope question.
- **Q3 thread** ("Are you certain option B will give us everything we want without sacrificing snapshot/restore functionality?") — user clarified that the keyboard shortcut path is not in scope (they don't use it). This removed the only verification gate for B.
- **Q7 thread** ("In Option A, we switch modes first, then ask for a summary of what happened in hive/plan mode. Are you sure we can still access the context from that mode to get a summary?") — confirmed the mode change (active tool set) and the branch change (session tree) are separate operations at different times; the LLM has access to the hive-mode context in the window between them.
