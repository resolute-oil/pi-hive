---
status: complete
priority: p2
completion_date: "2026-09-23"
issue_id: "002"
tags: [pi-hive, mode-switch, tools, llm-instruction]
dependencies: []
---

# Register `hive_cycle_summary` tool that stashes the LLM's summary in pending state

## Problem Statement

The mode-switch snapshot/restore flow (per the design doc Q4) requires
the LLM to provide a handoff summary. Per the verified pi-context
pattern, the LLM delivers this summary as a **tool call argument**,
not as prose in its reply. The tool's `execute` stashes the summary
in `state.pendingHiveCycleRestore` so the `agent_settled` handler
(todo 006) can pick it up and do the branching.

This leaf defines and registers the tool. It is a small but
load-bearing piece: it's the contract that the trigger prompt (todo
005) and the event handler (todo 006) both depend on.

## Findings

- Tool registration pattern in `src/agents/tools.ts` (existing tools
  like `route_agent`, `recall_agents` for shape).
- The tool's `execute` function does NOT block or do work. It just
  captures the LLM's argument and stores it.
- The `agent_settled` handler (todo 006) reads
  `state.pendingHiveCycleRestore` after the LLM's turn ends.
- The tool's `description` must be specific enough that the LLM only
  calls it when the system has explicitly asked it to summarize
  (i.e., during a hive→normal handoff follow-up turn). Wrong context
  → wrong call → wasted branching.

## Proposed Solutions

### Option 1: Tool stashes directly in `state.pendingHiveCycleRestore`

```ts
state.pendingHiveCycleRestore = state.pendingHiveCycleRestore ?? {
  snapshotLeafId: state.hiveCycleSnapshotLeafId ?? "",
};
state.pendingHiveCycleRestore.summary = args.summary;
```

**Pros:** Direct. The agent_settled handler reads the same field;
no intermediate state.

**Cons:** The tool needs to handle the "no pending restore" case
gracefully (return an error if there's no pending restore). Means the
tool needs to know the state shape.

**Effort:** ~25 minutes (tool definition + register + state mutation
+ tests).

**Risk:** Low. State coupling is acceptable since the tool is
purpose-built.

### Option 2: Tool returns the summary; `applyMode` captures it

Tool's `execute` returns the summary text; `applyMode` captures via
some other mechanism.

**Pros:** Tool stays stateless.

**Cons:** There's no clean way to capture a tool's return value
from the synchronous command handler. This is exactly what
pi-context avoids by stashing in module state. Don't do this.

**Effort:** N/A — pattern is wrong.

**Risk:** High — would require inventing a new mechanism.

## Recommended Action

**Option 1.** Tool directly mutates `state.pendingHiveCycleRestore`.
The state shape is small and well-defined; tool ↔ state coupling is
fine for a purpose-built tool.

## Technical Details

**Affected files:**
- `src/agents/tools.ts` — add `hive_cycle_summary` tool definition.
- `src/core/types.ts` — add `pendingHiveCycleRestore?: { snapshotLeafId: string; summary?: string }`
  to `HiveState`.

**Tool shape:**
```ts
{
  name: "hive_cycle_summary",
  label: "Hive Cycle Summary",
  description: "Call this with a concise summary of the hive or plan-mode work you just completed. pi-hive will branch the conversation at this point so the user can continue in normal mode without re-reading the hive-mode tail. Call only when explicitly asked (e.g., immediately after exiting hive or plan mode).",
  parameters: Type.Object({
    summary: Type.String({
      description: "Concise handoff summary of the work done in hive/plan mode. Restore current task/state, decisions/constraints, important side effects (changed files, processes, remote state), validation status, and explicit next step. If no work was done, pass an empty string.",
    }),
  }),
  execute: async (_id, args, _signal, _onUpdate, _ctx) => {
    if (!state.pendingHiveCycleRestore) {
      return {
        content: [{
          type: "text",
          text: "No pending hive cycle restore is active. This tool should only be called immediately after exiting hive or plan mode.",
        }],
        details: {},
        isError: true,
      };
    }
    state.pendingHiveCycleRestore.summary = args.summary;
    return {
      content: [{
        type: "text",
        text: `Handoff summary recorded (${args.summary.length} chars). pi-hive will branch the conversation on the next agent_settled event.`,
      }],
      details: {},
    };
  },
}
```

**State field on HiveState:**
```ts
pendingHiveCycleRestore?: {
  snapshotLeafId: string;
  summary?: string;
};
```

Set by `applyMode` (todo 005). Cleared by the event handler (todo 006)
immediately after capture-and-branch.

**Tool registration scope:**
- Available in the normal tool set so the LLM can call it from a
  follow-up turn after `applyMode("normal")` runs.
- The tool description makes it clear that calling outside a hive
  handoff is wrong; the execute function returns an error in that case.

## Resources

- Design doc: Q4 (LLM writes summary), Q7 (follow-up sequence).
- Plan doc: Architecture changes → "API surface map".
- pi-context's `context_compact` tool (`src/index.ts`) — canonical
  reference for the "tool stashes params, event handler acts on it"
  pattern.

## Acceptance Criteria

- [x] `hive_cycle_summary` tool registered in the extension factory.
- [x] Tool's `parameters` accepts `{ summary: string }`.
- [x] Tool's `execute` writes the summary into
      `state.pendingHiveCycleRestore.summary`.
- [x] If `state.pendingHiveCycleRestore` is undefined when the tool
      is called, the tool returns an error result
      (`isError: true`) and does NOT mutate state.
- [x] Tool's `description` is explicit about when to call it (only
      after a hive/plan→normal handoff).
- [x] `state.pendingHiveCycleRestore` is added to the `HiveState`
      type with the documented shape.
- [x] `just typecheck` passes.
- [x] A unit test asserts:
  - Calling the tool with a summary sets
    `state.pendingHiveCycleRestore.summary`.
  - Calling the tool without a pending restore returns an error
    result.
- [x] `just test` shows the existing 373 tests still pass.

## Work Log

### 2026-09-23 — Leaf written (revised from original sketch)


**Actions:**
- Replaced the original "tool returns summary, applyMode captures it"
  sketch (Option 2) with the pi-context pattern: tool mutates state
  directly.
- Added state shape to `HiveState`.
- Documented tool description carefully — wrong context → wrong call
  → wasted branching.

**Learnings:**
- The "tool returns value, caller captures" pattern doesn't work
  here because the caller's event handler doesn't have synchronous
  access to the tool's return value. The tool stashes directly.
- Tool description wording is load-bearing: the LLM must understand
  when (and only when) to invoke this tool.

### 2026-09-23 — Implemented

**Actions:**
- Added `pendingHiveCycleRestore?: { snapshotLeafId: string;
  summary?: string }` to `HiveState` in `src/core/types.ts`.
- Registered `hive_cycle_summary` tool at the end of the `baseTools`
  array in `src/agents/tools.ts`. Body: `Type.Object` parameters with
  one `summary: string` field; `execute` stashes the summary into
  `state.pendingHiveCycleRestore.summary` and returns an `isError: true`
  result (without mutating state) when no pending restore is active.
- Added `tests/summary-capture-tool.test.ts` with two cases:
  stashing-on-pending-restore and isError-without-pending-restore.
- Verified: `just typecheck` clean across all 5 sub-recipes;
  `just test` shows 375/375 passing (373 baseline + 2 new).

**Learnings:**
- Inserting the new tool in `baseTools` (rather than `typeScopedTools`)
  keeps it available to the LLM regardless of mode — exactly what's
  needed for the post-hive-handoff follow-up turn. The tool's own
  `isError` return guards against misuse outside that window.
- `HIVE_TOOL_NAMES` from `src/core/constants.ts` does not need this
  tool added: it is not gated by `setActiveTools`, so it is always in
  `state.normalToolNames` after `captureNormalTools` runs.
- `buildHiveTools(state, callerName)` returns the full tool list and
  is the right entry point for test discovery — `tools.find((t) =>
  t.name === "hive_cycle_summary")` is enough; no separate export.
- The `edit` tool failed to match the closing `  });\n  ];` anchor
  on first attempt (likely a whitespace edge case in the tool's exact-
  match protocol). Falling back to a small Python script that walks
  lines and inserts at the matching `]` is reliable when `sed`/`edit`
  misfire.