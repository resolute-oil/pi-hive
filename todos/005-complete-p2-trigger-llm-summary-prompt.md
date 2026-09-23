---
status: complete
priority: p2
completion_date: "2026-09-23"
issue_id: "005"
tags: [pi-hive, mode-switch, llm-instruction, follow-up]
dependencies: ["001", "002", "003"]
---

# Trigger the LLM to summarize and call `hive_cycle_summary` on hive→normal

## Problem Statement

The mode-switch snapshot/restore design (Q4, Q7) requires the LLM
to write a handoff summary and call the `hive_cycle_summary` tool.
The trigger fires on hive→normal when a snapshot baseline exists.

Per the verified pi-context pattern (canonical reference), the LLM
is asked to call the tool **as part of a follow-up turn** sent
immediately after the mode switch. The branching then happens later,
in an `agent_settled` event handler (todo 006), when the LLM's turn
has ended and the tool's `execute` has stashed the summary in
`state.pendingHiveCycleRestore`.

This leaf:
- Sends the follow-up turn via `state.pi.sendUserMessage(...)`.
- Sets `state.pendingHiveCycleRestore = { snapshotLeafId }` BEFORE
  sending the message, so the tool's `execute` has somewhere to
  stash the summary.
- Does NOT block or await the LLM's response — `sendUserMessage` is
  fire-and-forget per pi-context's verification.

## Findings

- `state.pi.sendUserMessage(content, { deliverAs?: "steer" | "followUp" })`
  is the right call. `pi.sendMessage` (the design doc's sketch) is for
  custom-typed messages; `pi.sendUserMessage` is for user prompts.
  pi-context confirms: uses `sendUserMessage` for the user-prompt
  trigger.
- `sendUserMessage` always triggers a turn (no `triggerTurn` option).
- `deliverAs: "followUp"` queues the message after the current turn
  ends, which is what we want — the LLM shouldn't see the trigger
  until the mode switch has settled.
- `state.pendingHiveCycleRestore` shape (added in todo 002):
  `{ snapshotLeafId: string; summary?: string }`.
- `state.hiveCycleSnapshotLeafId` (set in todo 003) is the leaf id
  to capture. May be undefined on session that started directly in
  hive/plan (todo 004's no-op case).
- `state.pi` is `ExtensionAPI` (or a compatible wrapper). Already
  used by `applyMode` for `setActiveTools`.

## Proposed Solutions

### Option 1: Send the trigger from `applyMode`'s hive→normal branch

```ts
if (mode === "normal" && state.hiveCycleSnapshotLeafId) {
  state.pendingHiveCycleRestore = {
    snapshotLeafId: state.hiveCycleSnapshotLeafId,
  };
  state.pi.sendUserMessage(
    "You have exited hive or plan mode and the user wants to continue in normal mode. " +
    "Write a concise handoff summary of the work you did in this cycle and call the " +
    "`hive_cycle_summary` tool with that summary. The user will not re-read the hive-mode " +
    "tail; the summary is their only window into what happened. " +
    "If no meaningful work happened, call `hive_cycle_summary` with an empty string.",
    { deliverAs: "followUp" },
  );
}
```

**Pros:** All mode-switch logic stays in `applyMode`. The follow-up
turn is just another step in the same code path.

**Cons:** None material.

**Effort:** ~20 minutes (one new branch in `applyMode`, plus the
trigger message text).

**Risk:** Low. The trigger text is the only judgment call.

### Option 2: Trigger from a separate post-`applyMode` hook

Have `applyMode` set a flag, and a separate `agent_end` /
`agent_start` handler picks it up and sends the trigger.

**Pros:** Decouples trigger from `applyMode`.

**Cons:** More moving parts. The flag would be cleared by the
event handler that sends the trigger; if that handler never fires
(no agent turns), the flag leaks. Not worth the complexity.

**Effort:** ~45 minutes.

**Risk:** Medium. Stale-flag risk.

## Recommended Action

**Option 1.** Trigger inline in `applyMode`'s hive→normal branch.
Clean, no flag-leak risk, matches the synchronous "this happens as
part of the mode switch" semantic.

## Technical Details

**Affected files:**
- `src/ui/tui/widget.ts:131` (`applyMode`) — in the hive→normal
  branch, after `setActiveTools(normalToolNames)`, add the
  pending-state-set and the `sendUserMessage` trigger.

**Trigger message text** (final wording — load-bearing):
> "You have exited hive or plan mode and the user wants to continue in normal mode. Write a concise handoff summary of the work you did in this cycle and call the `hive_cycle_summary` tool with that summary. The user will not re-read the hive-mode tail; the summary is their only window into what happened. If no meaningful work happened, call `hive_cycle_summary` with an empty string."

The wording is engineered to:
1. Identify the situation (just exited hive/plan).
2. Specify the action (write a summary, call the tool).
3. Explain why (the user's only window).
4. Handle the edge case (no work → empty string).

**Where exactly in `applyMode`:**

After `state.mode = "normal"`, after `state.pi.setActiveTools(state.normalToolNames)`.
Before `if (ctx.mode === "tui") { ctx.ui.setWidget("hive-tree", undefined); updateHiveActivityWidget(state); }`.
The existing widget cleanup is fine; the trigger should fire after the
mode change but doesn't need to wait for widget cleanup.

**No-op restore case:** the trigger fires only if
`state.hiveCycleSnapshotLeafId` is set. If undefined (no baseline),
skip the trigger entirely (todo 004's case).

**Edge case: LLM doesn't call the tool.** `state.pendingHiveCycleRestore.summary`
will be undefined. The agent_settled handler (todo 006) handles this
case by branching with empty string.

**Edge case: LLM calls the tool multiple times.** Each call
overwrites the previous `summary` field; only the LAST call's summary
is used. Acceptable.

## Resources

- Design doc: Q4 (LLM writes summary), Q7 (after-switch follow-up
  turn).
- Plan doc: Architecture changes → "Restore sequence inside
  applyMode" (steps 1-2).
- pi-context's `src/index.ts` — canonical reference for the
  follow-up turn pattern (uses `pi.sendUserMessage` with
  `deliverAs: "followUp"`).

## Acceptance Criteria

- [x] On hive→normal with `state.hiveCycleSnapshotLeafId` set,
      `applyMode` sets
      `state.pendingHiveCycleRestore = { snapshotLeafId }` before
      sending the trigger.
- [x] `applyMode` calls
      `state.pi.sendUserMessage(<trigger text>, { deliverAs: "followUp" })`
      with the documented message text.
- [x] `applyMode` returns `true` immediately after the trigger fires
      (no await).
- [x] On hive→normal with `state.hiveCycleSnapshotLeafId` undefined,
      the trigger is NOT sent and `state.pendingHiveCycleRestore` is
      NOT set.
- [x] On hive→hive or normal→normal, no trigger fires and no pending
      state is touched.
- [x] `just typecheck` passes.
- [x] A unit test asserts:
  - On hive→normal with a baseline, `sendUserMessage` is called once
    with the documented text.
  - `state.pendingHiveCycleRestore.snapshotLeafId` equals
    `state.hiveCycleSnapshotLeafId`.
  - `state.pendingHiveCycleRestore.summary` is undefined at this
    point (the tool hasn't fired yet).
- [x] `just test` shows the existing tests still pass plus the new
      trigger tests.

## Work Log

### 2026-09-23 — Leaf written (rewritten from previous "sendMessage + Promise" sketch)


**Actions:**
- Replaced the original sketch (`pi.sendMessage` + Promise to await
  the tool call result) with the pi-context pattern
  (`pi.sendUserMessage` + state stash + fire-and-forget).
- Identified that `applyMode`'s signature does NOT need to widen to
  `ExtensionCommandContext` — `state.pi.sendUserMessage` works
  through state.
- Drafted the trigger message text with explicit instructions for
  the LLM.

**Learnings:**
- The "block applyMode until LLM responds" sketch was wrong on
  multiple counts: pi.sendMessage isn't the right call,
  sendUserMessage is fire-and-forget, and the right place to do
  work after the LLM responds is an event handler.
- The trigger message wording matters: it must be specific enough
  that the LLM reliably calls the tool with the right content.

### 2026-09-23 — Implemented

**Actions:**
- Inserted the trigger block in `src/ui/tui/widget.ts` inside
  `applyMode`'s hive→normal branch, after `setActiveTools` and
  before the TUI widget cleanup. Sets
  `state.pendingHiveCycleRestore = { snapshotLeafId }` and fires
  `state.pi.sendUserMessage(<verbatim trigger>, { deliverAs:
  "followUp" })`. Diff: +24/−1 in widget.ts.
- Added `tests/trigger-summary-prompt.test.ts` with 4 cases:
  hive→normal with baseline (positive), hive→normal without
  baseline (todo 004's no-op), hive→hive mid-cycle, and
  normal→normal. The trigger text is pinned by exact equality
  against a constant in the test file so wording drift fails
  loudly.
- Verified: `just typecheck` clean (5/5 sub-recipes);
  `just test` shows 383/383 passing (379 baseline + 4 new).

**Refinement on the proposal (within acceptance):**

The proposal shipped to the user used `if (state.hiveCycleSnapshotLeafId)`
as the trigger gate. I added `&& changesMode` to it. Rationale:
the leaf's own acceptance criterion says "on hive→hive or
normal→normal, no trigger fires," but without `changesMode` the
no-op normal→normal re-call (user types `/hive:normal` while
already in normal) would re-fire the trigger and clobber
`pendingHiveCycleRestore`. This isn't a deviation from the plan
or the design — it makes the implementation satisfy the
acceptance criterion the proposal cited. Documented inline as a
block comment in `applyMode`.

**Learnings:**
- Acceptance text vs literal code can disagree even in a
  well-reviewed proposal. The right move is to align the code with
  the acceptance, not the other way around, and log the
  one-token refinement so the next reviewer can audit it.
- `agent_settled` is still TODO 006's job. This leaf only sets up
  the trigger and the state stash; the actual `branchWithSummary` +
  `branch(reset)` + `navigateTree` sequence lands next.