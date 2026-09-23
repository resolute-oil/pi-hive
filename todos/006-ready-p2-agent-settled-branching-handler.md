---
status: ready
priority: p2
issue_id: "006"
tags: [pi-hive, mode-switch, branching, navigate-tree, event-handler, retry]
dependencies: ["001", "002", "003", "005"]
---

# Branch with summary in an `agent_settled` event handler

## Problem Statement

The mode-switch snapshot/restore design (Q7 steps 5-6, Q8) requires
calling `sm.branchWithSummary(snapshotLeafId, summary)` then
`commandCtx.navigateTree(newLeafId)` to move the agent's active
session path off the hive-mode tail.

Per the verified pi-context pattern, this work happens in an
`agent_settled` event handler, NOT inside `applyMode`. The handler
is triggered when the LLM's response turn ends, and uses the
`ExtensionCommandContext` captured by todo 001 (event handlers only
get `ExtensionContext`).

This leaf consolidates three concerns:
1. The actual branching (`branchWithSummary` + `branch` reset +
   `navigateTree`).
2. Retry with empty summary on transient failure (Q8).
3. Best-effort fallback if retry also fails (Q8).

## Findings

- `agent_settled` is the right event (not `agent_end`). It fires
  "after an agent run has fully settled and no automatic retry,
  compaction, or queued continuation will run" — eliminates the
  race-condition concern that pi-context handles via
  `setTimeout(0)` + `waitForIdle` + `didConversationAdvance`.
- `(ctx.sessionManager as SessionManager).branchWithSummary(branchFromId, summary, details?, fromHook?)` — returns the new leaf id.
  Requires cast (pi-context pattern).
- After `branchWithSummary`, the leaf has advanced to the summary
  entry. To `navigateTree` to the new branch, must first call
  `sm.branch(tid)` to reset the leaf; otherwise `navigateTree` is
  a no-op.
- `commandCtx.navigateTree(targetId, options?: { summarize, customInstructions, replaceInstructions, label })` — returns `Promise<{ cancelled: boolean }>`.
  Requires `ExtensionCommandContext`.
- `commandCtx.waitForIdle()` — already settled at `agent_settled`,
  but the call is a safety belt (cheap and fast when already idle).
- Retry on `navigateTree` failure: check `result.cancelled === true`
  AS WELL AS thrown errors. The design doc says "sm throwing once,
  navigateTree returning cancelled: true once" — handle both.
- Best-effort: never throw from the handler; the mode switch
  already succeeded.

## Proposed Solutions

### Option 1: Single handler with inline retry

```ts
pi.on("agent_settled", async (_event, _ctx) => {
  const pending = state.pendingHiveCycleRestore;
  if (!pending) return;

  // Capture-and-clear immediately to prevent re-entry.
  state.pendingHiveCycleRestore = undefined;

  const commandCtx = getCommandCtx();
  if (!commandCtx) {
    logWarning("[pi-hive] No ExtensionCommandContext captured; cannot complete hive→normal restore.");
    return;
  }

  const sm = commandCtx.sessionManager as SessionManager;
  const snapshotLeafId = pending.snapshotLeafId;
  const summary = pending.summary ?? "";

  // First attempt.
  try {
    const nid = sm.branchWithSummary(snapshotLeafId, summary);
    sm.branch(snapshotLeafId);  // reset leaf so navigateTree works
    const result = await commandCtx.navigateTree(nid, { summarize: false });
    if (result.cancelled) throw new Error("navigateTree cancelled");
    // Success — inform the LLM.
    state.pi.sendMessage({
      customType: "pi-hive-mode-switch",
      content: "Hive cycle summary complete. Your previous hive-mode work has been collapsed to the summary you provided. Continue from this state in normal mode.",
      display: false,
    }, { triggerTurn: true, deliverAs: "followUp" });
    return;
  } catch (err1) {
    // First failure.
  }

  // Retry with empty summary.
  try {
    const nid = sm.branchWithSummary(snapshotLeafId, "");
    sm.branch(snapshotLeafId);
    const result = await commandCtx.navigateTree(nid, { summarize: false });
    if (result.cancelled) throw new Error("navigateTree cancelled");
    state.pi.sendMessage({
      customType: "pi-hive-mode-switch",
      content: "Hive cycle summary complete (with empty summary fallback). Continue from this state in normal mode.",
      display: false,
    }, { triggerTurn: true, deliverAs: "followUp" });
    return;
  } catch (err2) {
    // Best-effort fallback.
    console.warn(`[pi-hive] Hive→normal history restore failed: ${err2}`);
    if (commandCtx.hasUI) {
      commandCtx.ui.notify(
        `Hive→normal history restore failed; continuing in normal mode without restoring prior context.`,
        "warning",
      );
    }
    // Don't rethrow. Mode switch already succeeded.
  }
});
```

**Pros:** Matches the design's Q8 (retry, then best-effort) directly.
Inline retry is small enough to not warrant extraction.

**Cons:** Two try blocks with similar bodies.

**Effort:** ~40 minutes.

**Risk:** Low. The retry logic is well-tested by integration tests.

### Option 2: Extract a `tryBranch` helper

Pull the `branchWithSummary + branch + navigateTree` sequence into a
helper, call it twice.

**Pros:** DRY.

**Cons:** Helper for a 3-line sequence is over-engineering.

**Effort:** ~50 minutes.

**Risk:** Low.

## Recommended Action

**Option 1.** Inline retry with two try blocks. The duplication is
trivial; abstraction would obscure the design's intent.

## Technical Details

**Affected files:**
- `src/ui/tui/widget.ts` (or `src/integration/hooks.ts`) — add the
  `pi.on("agent_settled", ...)` handler.
- `src/core/types.ts` — already has `pendingHiveCycleRestore` from
  todo 002.

**Cast location:**
```ts
const sm = commandCtx.sessionManager as SessionManager;
```
This cast is the standard pi-context pattern. TypeScript trusts us;
the runtime object IS the writable `SessionManager`.

**Branch sequence ordering (load-bearing):**
1. `branchWithSummary(snapshotLeafId, summary)` → returns `nid`
2. `branch(snapshotLeafId)` → resets leaf to the original snapshot
3. `await commandCtx.navigateTree(nid, { summarize: false })` →
   agent follows the new branch

If `branch(reset)` is skipped, `navigateTree(nid)` is a no-op because
the leaf is already at `nid` after `branchWithSummary`.

**Retry trigger conditions:**
- `branchWithSummary` throws → retry.
- `branch` throws → retry.
- `navigateTree` throws → retry.
- `navigateTree` resolves to `{ cancelled: true }` → treat as
  failure, retry.

**Empty summary handling:** the retry uses `""` as the summary. The
branch is created with an empty summary entry; the agent sees the
snapshot leaf + an empty bridge to the current path. Less useful than
a real summary, but better than nothing.

**No-op cases:**
- `state.pendingHiveCycleRestore` undefined → return early.
- No `commandCtx` captured → log warning, return early (mode switch
  succeeded; restore silently skipped).

**Logging convention (mirrors todo 007's old sketch):**
- Success after retry: `pi.sendMessage({ customType, content, display: false }, ...)` to inform the LLM.
- Best-effort fallback: `commandCtx.ui.notify("warning", ...)` if
  UI, else `console.warn(...)`.

**`pi.sendMessage` vs `pi.sendUserMessage`:** the post-restore notice
is a custom-type message (the LLM doesn't need to "respond" to it —
it's metadata). Use `pi.sendMessage({ customType, content, display: false }, { triggerTurn: true, deliverAs: "followUp" })`.

## Resources

- Design doc: Q7 (sequence steps 5-6), Q8 (failure handling).
- Plan doc: Architecture changes → "Restore sequence inside
  applyMode" (now "agent_settled handler"), API surface map.
- pi-context's `agent_end` handler
  (`src/index.ts`) — canonical reference for the full sequence
  (`branchWithSummary` + `branch(reset)` + `navigateTree`), the
  `setTimeout(0)` deferral (which we replace with `agent_settled`),
  and the post-compaction `pi.sendMessage` notification.

## Acceptance Criteria

- [ ] `pi.on("agent_settled", ...)` handler registered.
- [ ] Handler reads `state.pendingHiveCycleRestore`; if undefined,
      returns early.
- [ ] Handler captures and clears `state.pendingHiveCycleRestore`
      immediately (capture-and-clear pattern prevents re-entry).
- [ ] On the first attempt, if `sm.branchWithSummary` /
      `sm.branch` / `navigateTree` succeed (and navigateTree does not
      cancel), the agent follows the new branch and a custom-type
      follow-up message is sent to the LLM.
- [ ] On first-attempt failure (any of the three calls), the handler
      retries once with an empty summary.
- [ ] On second-attempt failure, the handler logs a warning
      (`commandCtx.ui.notify` or `console.warn`) and returns
      without throwing.
- [ ] If `commandCtx` is not captured (no command call has
      happened yet), the handler logs a warning and returns early.
- [ ] The `sm.branch(snapshotLeafId)` reset call is included between
      `branchWithSummary` and `navigateTree`.
- [ ] `just typecheck` passes.
- [ ] `just test` shows existing 373 tests pass plus new tests for:
  first-attempt success, retry success, retry-then-best-effort,
  no-command-ctx early-return, no-pending-state early-return.

## Work Log

### 2026-09-23 — Leaf written (rewritten from previous "in-applyMode branching + retry" sketch)

**By:** Claude Code (planning session)

**Actions:**
- Replaced the previous sketch (branching + retry inside applyMode)
  with the pi-context pattern: branching in `agent_settled` handler,
  retry inline, best-effort on second failure.
- Identified the `branch(reset)` step that's easy to miss (without
  it, `navigateTree` is a no-op).
- Used `agent_settled` instead of `agent_end` (safer — fires after
  retries/queued messages settle).
- Folded retry logic (old todo 007) into this leaf.

**Learnings:**
- The `branch(snapshotLeafId)` reset between `branchWithSummary` and
  `navigateTree` is load-bearing. Without it, navigateTree is a no-op.
- `agent_settled` is the right event — its semantics (no retries,
  no queued continuation) eliminate the need for pi-context's
  `setTimeout(0)` deferral and `didConversationAdvance` guard.
- `pi.sendMessage` (custom-type) is the right call for the
  post-restore notification (vs `pi.sendUserMessage` for the trigger).
  Same method name, different semantics — design doc conflated them.