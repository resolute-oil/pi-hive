---
status: complete
priority: p2
completion_date: "2026-09-23"
issue_id: "001"
tags: [pi-hive, mode-switch, applymode, refactor]
dependencies: []
---

# Widen command handlers and capture `ExtensionCommandContext` for event handlers

## Problem Statement

The mode-switch snapshot/restore feature (per the design doc) needs
`ExtensionCommandContext` in two places:

1. **In `applyMode`** — to call `setActiveTools`, `sendUserMessage`, etc.
   The current `applyMode(state, ctx: ExtensionContext, mode, options)`
   already works for these (they're on `ExtensionContext` /
   `ExtensionAPI`). Type widening is **not strictly required** here.
2. **In the `agent_settled` event handler** — to call
   `waitForIdle()` and `navigateTree(...)`. Event handlers receive
   `ExtensionContext` only; the wider type is only available from
   command handlers. The implementer must stash a
   `ExtensionCommandContext` somewhere accessible to event handlers.

This leaf:
- Updates the four mode-switch command handlers
  (`/hive:normal`, `/hive:plan-mode`, `/hive`, `/hive:toggle`) and
  `/hive:execute` to type their `ctx` parameter as
  `ExtensionCommandContext` (type widening only; runtime is already
  the wider type per the design doc's verification).
- Stashes the `ExtensionCommandContext` in a closure or `state` field
  on the first command call. Provides a getter for use by event
  handlers.
- Does **not** change `applyMode`'s signature — it stays
  `ExtensionContext`, since applyMode doesn't need the wider methods
  itself.

## Findings

- `ExtensionCommandContext extends ExtensionContext` (per
  `dist/core/extensions/types.d.ts:255`). Adds:
  `getSystemPromptOptions`, `waitForIdle`, `newSession`, `fork`,
  `navigateTree`, `switchSession`, `reload`.
- `pi.on("agent_settled", handler)` handler signature:
  `(event: AgentSettledEvent, ctx: ExtensionContext) => ...` — no
  `navigateTree` / `waitForIdle` access. Verified.
- `pi.on("agent_end", handler)` is the same — narrow `ExtensionContext`.
- `pi.setLabel(entryId, label)` is a public method on `ExtensionAPI`
  (`dist/core/extensions/types.d.ts:1077`). No cast needed.
- `(ctx.sessionManager as SessionManager).branchWithSummary(...)` is
  the standard pattern for write methods on `SessionManager` from
  extensions. `ctx.sessionManager` is typed `ReadonlySessionManager`
  but the runtime object IS the writable `SessionManager`. pi-context
  uses this cast throughout
  (`@ttttmr/pi-context/src/index.ts`).
- `ExtensionContext.sessionManager` is `ReadonlySessionManager`. So
  `ctx.sessionManager.getLeafId()` works without cast; write methods
  need cast.

## Proposed Solutions

### Option 1: Module-level CommandCtx stash

```ts
let commandCtx: ExtensionCommandContext | null = null;
function getCommandCtx(): ExtensionCommandContext | null { return commandCtx; }

// In each command handler:
pi.registerCommand("hive:normal", {
  handler: async (_args, ctx: ExtensionCommandContext) => {
    if (!commandCtx) commandCtx = ctx;
    await applyMode(state, ctx, "normal");
  },
});
```

**Pros:** Simple. Stash once, reuse. Mirrors pi-context's
`pendingCommandContext` pattern.

**Cons:** Module-level state. Across session replacements (e.g., a
`/new` command creates a new session), the captured ctx may go stale.
pi-context handles staleness by clearing `CommandCtx` on
`session_shutdown`. We should too.

**Effort:** ~30 minutes (4 handler type updates + stash + getter +
session_shutdown clear).

**Risk:** Low. Stale ctx risk is mitigated by session_shutdown clear.

### Option 2: Per-state CommandCtx stash

Store the captured ctx on `HiveState` (in-memory, not persisted).

**Pros:** Per-session isolation by construction.

**Cons:** More boilerplate. Doesn't really solve a different problem
than Option 1.

**Effort:** ~30 minutes (same).

**Risk:** Low.

## Recommended Action

**Option 1.** Module-level with `session_shutdown` clear. Matches
pi-context's pattern; less boilerplate than state-scoped.

## Technical Details

**Affected files:**
- `src/integration/commands.ts:39,43,52,57,70` — change handler
  parameter type from `ExtensionContext` to `ExtensionCommandContext`
  in all five handlers (`/hive:normal`, `/hive:plan-mode`, `/hive`,
  `/hive:toggle`, `/hive:execute`).
- `src/integration/commands.ts:62` — leave the keyboard shortcut alone
  (out of scope per Q3).
- `src/integration/commands.ts` (or a new file `src/integration/ctx.ts`)
  — add the `commandCtx` stash, `getCommandCtx()` getter, and the
  `session_shutdown` clear.

**Stash code shape:**
```ts
let commandCtx: ExtensionCommandContext | null = null;
export function getCommandCtx(): ExtensionCommandContext | null { return commandCtx; }

pi.on("session_shutdown", () => {
  commandCtx = null;
});

// In each command handler:
handler: async (_args, ctx: ExtensionCommandContext) => {
  if (!commandCtx) commandCtx = ctx;
  await applyMode(state, ctx, "normal");
}
```

**Why `applyMode`'s signature doesn't change:**
- `applyMode` calls `state.pi.setActiveTools` — `state.pi` is held
  on state, not ctx.
- `applyMode` calls `pi.sendUserMessage` — that's on `ExtensionAPI`,
  available to the command handler that called `applyMode`. If
  `applyMode` itself needs `sendUserMessage`, it can receive
  `pi` as a parameter, or access via the captured `commandCtx`. But
  since the trigger (todo 005) lives in `applyMode`, we DO need a way
  for `applyMode` to send the message. Recommendation: pass
  `pi.sendUserMessage` indirectly via a closure or via state.

Actually re-checking: the trigger (`pi.sendUserMessage`) happens in
`applyMode`. `applyMode`'s ctx is `ExtensionContext` (unchanged).
`ExtensionContext` does NOT include `sendUserMessage` — that's on
`ExtensionAPI`, which is NOT in the ctx tree.

So `applyMode` needs access to `pi` somehow. Options:
- Add `pi` to `applyMode`'s parameters.
- Access via `state.pi.sendUserMessage(...)` if `state.pi` is
  `ExtensionAPI`.

Looking at the existing code: `state.pi.setActiveTools(...)` is
called from inside `applyMode`. So `state.pi` is already
`ExtensionAPI` (or a compatible wrapper). `state.pi.sendUserMessage`
would work directly.

So no signature change to `applyMode` is needed for the trigger
either. The trigger calls `state.pi.sendUserMessage(...)`.

## Resources

- Design doc: Q3 (entry points), Q6 (signature).
- pi-context's `src/index.ts` — canonical reference for the
  `pendingCommandContext` pattern.
- Plan doc: Architecture changes → "API surface map".

## Acceptance Criteria

- [x] All four mode-switch command handlers
      (`/hive:normal`, `/hive:plan-mode`, `/hive`, `/hive:toggle`) and
      `/hive:execute` type their `ctx` parameter as
      `ExtensionCommandContext`.
- [x] Keyboard-shortcut path (`pi.registerShortcut`) left untouched.
- [x] A module-level `commandCtx` variable is set on the first
      command call.
- [x] A `getCommandCtx()` getter is exported.
- [x] A `session_shutdown` event handler clears `commandCtx` to
      `null`.
- [x] `just typecheck` passes.
- [x] `just test` shows the existing 373 tests still pass (no new
      tests required for this leaf — it's a type widening + one-line
      stash).
- [x] No new imports beyond `ExtensionCommandContext` from the existing
      `@earendil-works/pi-coding-agent` import.

## Work Log

### 2026-09-23 — Leaf written


**Actions:**
- Identified that the original todo 001 (applyMode signature
  widening) is largely unnecessary — applyMode doesn't need
  ExtensionCommandContext.
- Recognized the real need: capturing CommandCtx for use in event
  handlers (which only get ExtensionContext).
- Adapted Option 1 from pi-context's `pendingCommandContext` pattern.
- Verified the SDK signature for `agent_settled` and `agent_end`
  handlers — confirmed only ExtensionContext is available.

**Learnings:**
- pi-context's pattern of "capture CommandCtx from a command handler,
  stash it for event handlers" is the cleanest solution to the
  ExtensionCommandContext / ExtensionContext asymmetry.
- The `session_shutdown` clear is critical: without it, a stale
  CommandCtx from a previous session could leak into the new one.

### 2026-09-23 — Leaf implemented


**Actions:**
- Widened all 5 command handlers' `ctx` parameter to
  `ExtensionCommandContext`. Added module-level `commandCtx` stash,
  `getCommandCtx()` getter, `clearCommandCtx()` setter.
- Wired `commandCtx = ctx;` into each widened handler body.
- Added `clearCommandCtx();` to the `session_shutdown` handler in
  `src/integration/hooks.ts`, with a comment explaining why.
- Verified: `just typecheck` (5 sub-recipes incl. dashboard) passes;
  `just test` confirms 373/373 still pass (no new tests added).

**Learnings:**
- pi-context's pattern of capturing ExtensionCommandContext on
  every command call (not just first) is simpler and equivalent in
  behavior — session_shutdown clears the stash, so staleness is
  impossible.
- `just typecheck`'s dashboard sub-recipe requires `ui/web/node_modules`
  to be populated. The worktree's `ui/web/node_modules` was empty on
  first use; ran `npm install` to populate. This is an env setup step,
  not a code change.
- `just lint` shows 3 pre-existing errors and 62 warnings on the
  entry baseline (none in the files touched by 001). Out of scope
  for this feature; flagged in the plan-doc work log as a separate
  audit task.