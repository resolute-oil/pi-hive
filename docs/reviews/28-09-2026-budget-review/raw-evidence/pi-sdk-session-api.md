# Pi SDK session-related API reference

**Date:** 2026-09-28 (initial), re-validated against SDK 0.99.1 on 2026-09-29
**Source:** `node_modules/@earendil-works/pi-coding-agent/dist/core/` (worktree-local install; matches the SDK installed system-wide via npm)
**Purpose:** Ground the budget-strategies refactor in actual SDK behavior. Every method, type, and behavior cited below is verified against the local SDK install (`.d.ts` declarations and `.js` implementations). Cross-reference with `current-flow/`, `pi-docs/extension-patterns-reference.md`, and `01-current-state-analysis.md`.

The review's structural critique (Issues 1-9) and refactor-options would change if any of these behaviors are misstated. Read this before designing any budget refactor.

## 0. SDK version notes

- The original review (2026-09-28) was drafted against the SDK behavior assumed in the refactor plan (`UsageEntry` exists, `appendUsage()` is the canonical primitive, `getSessionStats()` counts explicit usage entries). That behavior corresponds to SDK 0.99.x.
- The implementation was verified against the project's devDependency pin `@earendil-works/pi-coding-agent@0.99.1` (bump from `0.80.7`, commit ea9c54a on `refactor/budget`).
- `getSessionStats()` implementation in §2.2 is the 0.99.1 version (iterates `getEntries()`, explicitly accumulates `UsageEntry` records). The earlier draft described a 0.80.x-era implementation that walked `getBranch()` and only counted `AssistantMessage.usage`; that implementation is now obsolete.
- §2.2 observation 3 was correct for 0.80.x (`CompactionEntry.usage` was not accumulated) but is **wrong** for 0.99.1 — `CompactionEntry.usage` IS accumulated if present. Updated below.

---

## 1. AgentSession — the central runtime object

`AgentSession` is the abstraction shared between all run modes (interactive, print, rpc). Source: `dist/core/agent-session.d.ts`. The class encapsulates agent state, event subscription, model/thinking-level management, compaction (manual and auto), bash execution, and session switching/branching.

### 1.1 Lifecycle methods the budget layer uses

| Method | Signature | Returns | Effect | Budget relevance |
|---|---|---|---|---|
| `prompt(text, options?)` | `(string, PromptOptions?) => Promise<void>` | `Promise<void>` | Send a prompt. Resolves after the run finishes (including automatic retries). During streaming, queues via `steer()` or `followUp()` per `options.streamingBehavior`. | The dispatcher's main entry point. The promise resolves when the worker is done; the dispatcher computes `delta` and accumulates `governanceTokens` AFTER this resolves. |
| `abort()` | `() => Promise<void>` | `Promise<void>` | "Stops the active operation and waits for the session to become idle." | Used by operator commands (`endWorkerSession`, `compactWorkerSession`, `respawnWorkerSession` at `src/engine/dispatch.ts:956, 992, 1028`). Distinct from the local `runController.abort()` (which only cancels the in-progress turn). |
| `dispose()` | `() => void` | `void` | "Remove all listeners and disconnect from agent. Call this when completely done with the session." | **Currently MISSING** in `respawnWorkerSession` (Issue 9 in `01-current-state-analysis.md`). The old session's `session.subscribe(...)` closure leaks because the dispose call is absent. |
| `waitForIdle()` | `() => Promise<void>` | `Promise<void>` | Waits for idle without aborting. | Useful for graceful shutdown; not currently used in budget code. |
| `compact(customInstructions?)` | `(string?) => Promise<CompactionResult>` | `Promise<CompactionResult>` | "Aborts the current agent operation first. Manual compaction never retries or continues the interrupted agent turn." | The budget strategy's `compact` strategy calls this. Returns the `CompactionResult` with `summary`, `firstKeptEntryId`, `tokensBefore`, `estimatedTokensAfter`. |
| `abortCompaction()` | `() => void` | `void` | Cancel in-progress manual or auto compaction. | Not used by budget code; the dispatcher aborts via `session.abort()` instead. |
| `abortBranchSummary()` | `() => void` | `void` | Cancel in-progress branch summarization. | Used by `compactWorkerSession`/`respawnWorkerSession` indirectly through `session.abort()`. |
| `abortRetry()` | `() => void` | `void` | Cancel in-progress retry. | Not used; budget code relies on `session.abort()` for full cancellation. |

### 1.2 State-read methods the budget layer uses

| Method | Returns | Notes | Budget relevance |
|---|---|---|---|
| `get model()` | `Model<any> | undefined` | Current model. | Used for context-window math (`runtime.contextWindow`). |
| `get thinkingLevel()` | `ThinkingLevel` | Current thinking level. | Used by the resolver for `runtime.thinkingLevels`. |
| `get systemPrompt()` | `string` | "Current effective system prompt, including changes not yet sent to the model." **Read-only.** | Confirmed read-only. `runtime.systemPrompt` (on `AgentRuntime`) is a DIFFERENT object that pi-hive mutates — see Key Observation 4 in `current-flow/budget-check-flow.md`. |
| `getActiveToolNames()` | `string[]` | Currently active tools. | Available if the budget layer wants to disable expensive tools mid-run. |
| `get isIdle()` | `boolean` | "Whether the session has no active agent run, compaction, branch summary, retry, or queued continuation." | The right gate for "safe to mutate runtime state". Currently the dispatcher uses `runtime.status` (pi-hive's own field) instead. |
| `get isStreaming()` | `boolean` | "Whether the session is currently processing an agent run or post-run continuation." | Useful for distinguishing "mid-run" vs "post-run" budget events. |
| `get isCompacting()` | `boolean` | "Whether compaction or branch summarization is currently running." | Useful for avoiding re-entrant budget math during compaction. |
| `get messages()` | `AgentMessage[]` | "All messages including custom types like BashExecutionMessage." | If the budget layer wants to read message history (e.g., for `assistant.usage`), this is the accessor. |
| `get sessionFile()` | `string | undefined` | Session file path, or undefined if sessions are disabled. | The dispatcher's `runtime.sessionFile` is set independently; this accessor is for the SDK's session. |
| `get sessionId()` | `string` | Current session ID. | — |

### 1.3 Statistics and context

| Method | Returns | Notes | Budget relevance |
|---|---|---|---|
| `getSessionStats()` | `SessionStats` | **Aggregates over ALL session entries (including history that was compacted away)**, so token/cost totals reflect what was actually billed across the session. | This is the budget code's overwrite source. See §3 below for the full implementation. |
| `getContextUsage()` | `ContextUsage \| undefined` | "Estimated context tokens, or null if unknown (e.g. right after compaction, before next LLM response)." | The dispatcher's `runtime.contextTokens` and `runtime.contextPct` read from this. Returns `{tokens: number\|null, contextWindow: number, percent: number\|null}`. |

### 1.4 Event subscription

```typescript
subscribe(listener: AgentSessionEventListener): () => void
```

`AgentSessionEventListener` is `(event: AgentSessionEvent) => void`. Multiple listeners are supported; the returned function unsubscribes this listener only.

#### `AgentSessionEvent` types (session-specific events)

From `dist/core/agent-session.d.ts:39-100`:

| Event | Payload | When fired | Budget layer usage |
|---|---|---|---|
| `agent_end` | `{ messages: AgentMessage[]; willRetry: boolean }` | End of one low-level agent run. "Automatic recovery or queued work can still follow." | `src/engine/dispatch.ts:707-714` — final-message text accumulation. **Note**: `willRetry: boolean` field exposes the retry intent; the budget layer doesn't currently check it. |
| `agent_settled` | `{}` (empty) | "When the host needs to know that Pi will not continue automatically." | **NOT used** (Issue 8 in `01-current-state-analysis.md`). The canonical "Pi will not continue automatically" event; better than `agent_end` for finalizing budget counters. |
| `message_update` | `{ assistantMessageEvent: AssistantMessageEvent }` | Per-message streaming event (text_delta, toolcall_start, etc.). | `src/engine/dispatch.ts:510-524` — text-delta accumulation. |
| `message_end` | `{ message: AssistantMessage \| ... }` | Authoritative completed message. | `src/engine/dispatch.ts:646-708` — live token accumulation + warning + abort at 0%. |
| `tool_execution_start` | `{ toolName, toolCallId, args, ... }` | Tool call started. | `src/engine/dispatch.ts:525-535` — telemetry. |
| `tool_execution_end` | `{ toolName, toolCallId, isError, result, ... }` | Tool call completed. | `src/engine/dispatch.ts:537-549` — telemetry. |
| `auto_retry_start` | `{ attempt, maxAttempts, delayMs, errorMessage }` | Retry starting (transient errors). | `src/engine/dispatch.ts:551-557` — telemetry. |
| `auto_retry_end` | `{ attempt, success, finalError }` | Retry ended. | `src/engine/dispatch.ts:559-569` — telemetry. |
| `compaction_start` | `{ reason: "manual" \| "threshold" \| "overflow" }` | Compaction starting. | `src/engine/dispatch.ts:571-573` — telemetry. |
| `compaction_end` | `{ reason, result: CompactionResult \| undefined, aborted: boolean, willRetry: boolean, errorMessage? }` | Compaction done. **Note the `aborted: boolean` field.** | `src/engine/dispatch.ts:575-633` — recalc `effectiveTokens` from `result.tokensBefore - estimatedTokensAfter`. |
| `queue_update` | `{ steering: string[], followUp: string[] }` | Steering/follow-up queue depth changed. | `src/engine/dispatch.ts:635-641` — telemetry. |
| `session_info_changed` | `{ name: string \| undefined }` | Session name changed. | `src/engine/dispatch.ts:643-645` — telemetry. |
| `entry_appended` | `{ entry: SessionEntry }` | A session entry was appended. | NOT used; would be useful for a `CustomEntry`-based budget ledger to react to its own writes. |
| `bash_execution_update` | `{ id?, delta: string }` | Bash execution streaming. | NOT used by budget code. |
| `summarization_retry_*` | Various | Compaction/branch-summary retry lifecycle. | NOT used by budget code. |
| `thinking_level_changed` | `{ level: ThinkingLevel }` | Thinking level changed. | NOT used. |

### 1.5 Steering / follow-up

```typescript
steer(text: string, images?: ImageContent[], options?: { source?: InputSource }): Promise<void>
followUp(text: string, images?: ImageContent[], options?: { source?: InputSource }): Promise<void>
```

Both return `Promise<void>` per the d.ts. The online docs (`https://pi.dev/docs/latest/sdk`) document a `queued`/`handled` return-value contract; the local d.ts does NOT include these return values (see `pi-docs/extension-patterns-reference.md#12-2026-09-28-online-sdk-refresh--clarifications-and-additions`). Practical implication for a future budget feature that uses these: any "I steered the worker" assumption may be wrong if an extension handler consumed the message.

`clearQueue(): { steering: string[]; followUp: string[] }` returns the cleared queues (useful for restoring on abort).

### 1.6 Custom messages

```typescript
sendCustomMessage<T = unknown>(
    message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }
): Promise<void>
```

`CustomMessage<T>` is `dist/core/messages.d.ts:35-44`:

```typescript
export interface CustomMessage<T = unknown> {
    role: "custom";
    customType: string;
    content: string | (TextContent | ImageContent)[];
    display: boolean;
    details?: T;
    timestamp: number;
}
```

This is the documented Pi pattern for extension-side prompt mutation: a `sendMessage` (CustomMessage) is converted to a user message for model requests; `display` controls TUI rendering; `details` is not sent to the LLM. **This is the right primitive for the budget strategy's prompt hint if a future refactor moves away from `runtime.systemPrompt` mutation** (see Issue 5 in `01-current-state-analysis.md`).

---

## 2. SessionStats — what `getSessionStats()` actually returns

Source: `dist/core/agent-session.d.ts:182-204` and `dist/core/agent-session.js:3043-3095` (verified).

### 2.1 The TypeScript declaration

```typescript
export interface SessionStats {
    sessionFile: string | undefined;
    sessionId: string;
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    toolResults: number;
    totalMessages: number;
    tokens: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    };
    cost: number;
    contextUsage?: ContextUsage;
}
```

`ContextUsage` is `dist/core/extensions/types.d.ts:194-200`:

```typescript
export interface ContextUsage {
    /** Estimated context tokens, or null if unknown. */
    tokens: number | null;
    contextWindow: number;
    /** Context usage as percentage of context window, or null if tokens is unknown. */
    percent: number | null;
}
```

### 2.2 The implementation (`getSessionStats` in `agent-session.js`) — SDK 0.99.1

```javascript
getSessionStats() {
    let userMessages = 0;
    let assistantMessages = 0;
    let toolResults = 0;
    let totalMessages = 0;
    let toolCalls = 0;
    const usageTotals = createUsageTotals();
    for (const entry of this.sessionManager.getEntries()) {
        if (entry.type === "usage") {
            addUsageToTotals(usageTotals, entry.usage);
        }
        else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
            addUsageToTotals(usageTotals, entry.usage);
        }
        if (entry.type !== "message")
            continue;
        totalMessages++;
        const message = entry.message;
        if (message.role === "user") {
            userMessages++;
        }
        else if (message.role === "toolResult") {
            toolResults++;
            if (message.usage) {
                addUsageToTotals(usageTotals, message.usage);
            }
        }
        else if (message.role === "assistant") {
            assistantMessages++;
            const assistantMsg = message;
            if (Array.isArray(assistantMsg.content)) {
                toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
            }
            addUsageToTotals(usageTotals, assistantMsg.usage);   // <-- INCLUDES ABORTED
        }
    }
    return {
        sessionFile: this.sessionFile,
        sessionId: this.sessionId,
        userMessages,
        assistantMessages,
        toolCalls,
        toolResults,
        totalMessages,
        tokens: {
            input: usageTotals.input,
            output: usageTotals.output,
            cacheRead: usageTotals.cacheRead,
            cacheWrite: usageTotals.cacheWrite,
            total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
        },
        cost: usageTotals.cost,
        contextUsage: this.getContextUsage(),
    };
}
```

**Critical observations (SDK 0.99.1):**

1. **No filtering of `stopReason === "aborted"` or `"error"` on assistant messages.** The loop calls `addUsageToTotals(usageTotals, assistantMsg.usage)` on EVERY assistant message, including aborted ones. The `Usage` field on an aborted `AssistantMessage` may or may not be populated (depends on whether the provider's usage chunk arrived before the abort).

2. **Walks `getEntries()`, not `getBranch()`.** The 0.99.1 implementation iterates ALL session entries (the full append-only log), not just the active branch path. Implication for budget: `getSessionStats()` returns a cross-branch aggregate, so a worker that branched and came back will still report the same session-total usage. (The earlier 0.80.x implementation walked `getBranch()`, which gave per-branch totals; that was superseded.)

3. **`UsageEntry` records are accumulated explicitly.** Lines 2-3 of the new loop add `entry.usage` whenever `entry.type === "usage"` — i.e., every `SessionManager.appendUsage(...)` write contributes. **This is the canonical hook for a `UsageEntry`-based budget ledger: writing per-call usage via `appendUsage(kind, provider, model, usage)` makes `getSessionStats()` reflect those writes by construction.** See §5.2 and §8 below.

4. **`CompactionEntry.usage` and `BranchSummaryEntry.usage` ARE accumulated when present.** This is a behavior change vs. 0.80.x (the earlier implementation did not touch compaction entries). If a compaction records its own summary-call usage, that adds to the totals. For the budget refactor: this matters for cost attribution but not for "did the worker over-spend?" — compactions run inside the orchestrator, not the worker.

5. **`total` in `tokens` is computed as the sum of components** (not `usageTotals.total` directly), because `Usage.totalTokens` is the per-message native total which may include cost-only fields. The pi-hive budget code uses `stats.tokens.input` etc. (the components) for its accumulation — see `src/engine/dispatch.ts:797-803`.

6. **`cacheWrite` is correctly set to `usageTotals.cacheWrite`** (verified at `agent-session.js` in 0.99.1 — fixed from the 0.80.x `cacheRead` typo shown in the original draft). The `total` is also correct: `usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite`.

---

## 3. `Usage` shape (the per-message token accounting)

Source: `dist/core/usage-totals.d.ts` (the `UsageTotals` interface) and inferred from `Usage` references in `dist/core/compaction/compaction.d.ts` and provider stream implementations.

### 3.1 `UsageTotals` (the aggregate shape used by `getSessionStats`)

```typescript
export interface UsageTotals {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
}
```

### 3.2 `Usage` (the per-message shape, from provider streams)

From the Mistral stream implementation in `dist/node_modules/@earendil-works/pi-ai/dist/api/mistral-conversations.d.ts` (verified by reading the source):

```typescript
output.usage = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    };
};
```

Additional fields referenced elsewhere:
- `cacheWrite1h?: number` (one-hour cache TTL) — see `compaction.d.ts:191`
- `reasoning?: number` — see `compaction.d.ts:193` and `compaction.ts:387` (`first.reasoning`)

### 3.3 How `Usage` is populated for an aborted message

**Critical for understanding Bug 3.** When the SDK's stream is interrupted (e.g., by `runController.abort()`), the provider's stream loop terminates with:

```javascript
output.stopReason = options?.signal?.aborted ? "aborted" : "error";
output.errorMessage = formatMistralError(error);
stream.push({ type: "error", reason: output.stopReason, error: output });
stream.end();
```

The `output.usage` field retains whatever `chunk.usage` populated it with. For an aborted stream:
- If the abort happens AFTER a usage chunk arrived → usage has values, `stopReason = "aborted"`.
- If the abort happens BEFORE any usage chunk arrived (early abort, e.g., before first response) → usage has all zeros, `stopReason = "aborted"`.

`addUsageToTotals(usageTotals, assistantMsg.usage)` then adds whatever is in `usage`, even if all zeros.

**Implication for Bug 3:** if the abort happens early enough that no usage chunk arrived, the aborted message contributes 0 to `getSessionStats()` totals. The budget code's live accumulation in `message_end` had a positive value, but the overwrite at end-of-run zeros `runtime.inputTokens` to match the (lower) session lifetime total.

---

## 4. `CompactionResult` — what `session.compact()` returns

Source: `dist/core/compaction/compaction.d.ts:23-33`.

```typescript
export interface CompactionResult<T = unknown> {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    estimatedTokensAfter?: number;
    /** Usage from the LLM call(s) that generated this summary, if available */
    usage?: Usage;
    /** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
    details?: T;
}
```

The budget code reads `result.tokensBefore` and `result.estimatedTokensAfter` at `src/engine/dispatch.ts:601-616` to compute the `effectiveTokens` debit. Note: the `details` field is typed `T = unknown` (default) — the budget code does not currently use it.

---

## 5. SessionManager — the JSONL-backed entry tree

Source: `dist/core/session-manager.d.ts`. **Critical for the refactor: this is the canonical source-of-truth for the session, and the file system is the durable backing store.** A `CustomEntry`-based budget ledger would live here.

### 5.1 Factory methods

```typescript
static create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager
static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager
static continueRecent(cwd: string, sessionDir?: string): SessionManager
static inMemory(cwd?: string, options?: NewSessionOptions, entries?: FileEntry[]): SessionManager
static forkFrom(sourcePath: string, targetCwd: string, ...): SessionManager
static findById(cwd: string, id: string, sessionDir?: string): string | undefined
static list(cwd: string, sessionDir?: string, onProgress?: SessionListProgress, signal?: AbortSignal): Promise<SessionInfo[]>
static listAll(onProgress?: SessionListProgress, signal?: AbortSignal): Promise<SessionInfo[]>
```

### 5.2 Append methods (write side)

```typescript
appendMessage(message: Message | CustomMessage | BashExecutionMessage): string
appendThinkingLevelChange(thinkingLevel: string): string
appendModelChange(provider: string, modelId: string): string
appendUsage(kind: string, provider: string, model: string, usage: Usage, note?: string): UsageEntry
appendCompaction<T = unknown>(summary: string, firstKeptEntryId: string | null, tokensBefore: number, details?: T, fromHook?: boolean, usage?: Usage): string
appendCustomEntry(customType: string, data?: unknown): string
appendSessionInfo(name: string): string
appendCustomMessageEntry<T = unknown>(customType: string, content: string | (TextContent | ImageContent)[], display: boolean, details?: T): string
appendContextEdit(targetId: string, replacement: ContextEditEntry["replacement"]): string
appendLabelChange(targetId: string, label: string | undefined): string
```

**Most relevant for the budget refactor:**

- `appendUsage(kind, provider, model, usage, note?)` — writes a `UsageEntry` with an arbitrary `kind` string (e.g., `"worker_call"`, `"budget_warning_resolution"`). The `UsageEntry` "contributes to session token and cost totals" (per session-format docs). **This is the canonical primitive for "record this worker's spend in the session file".**

- `appendCustomEntry(customType, data?)` — writes a `CustomEntry` with an arbitrary `customType` (e.g., `"pi-hive-budget-counter"`) and `data`. **Does NOT participate in LLM context**; used for persistent state across reloads.

- `appendCustomMessageEntry(...)` — writes a `CustomMessageEntry` that DOES participate in LLM context. Used for "this is what the worker should see".

- `appendContextEdit(targetId, replacement)` — replaces one earlier entry's contribution to model context without mutating the entry. Useful for "this redaction happens at this point".

### 5.3 Read methods

```typescript
getCwd(): string
getSessionDir(): string
usesDefaultSessionDir(): boolean
getSessionId(): string
getSessionFile(): string | undefined
getLeafId(): string | null
getLeafEntry(): SessionEntry | undefined
getEntry(id: string): SessionEntry | undefined
getChildren(parentId: string): SessionEntry[]
getLabel(id: string): string | undefined
getBranch(fromId?: string): SessionEntry[]
buildContextEntries(): SessionEntry[]
buildSessionProjection(): SessionProjection
buildSessionContext(): SessionContext
getHeader(): SessionHeader | null
getEntries(): SessionEntry[]
getTree(): SessionTreeNode[]
```

**Most relevant for the budget refactor:**

- `getBranch(fromId?)` — "Walk from entry to root, returning all entries in path order. Includes all entry types (messages, compaction, model changes, etc.). Use buildSessionContext() to get the resolved messages for the LLM." **This is the canonical "what has this worker consumed" walker for a CustomEntry-based ledger.**

- `buildSessionProjection()` and `buildSessionContext()` — return the resolved message list for the LLM, handling compaction summaries and following the path from root to current leaf. Documented as "The canonical projection has already selected the previous compaction's retained tail."

- `buildContextEntries()` — returns "the active, compaction-aware entry list for context/rendering."

### 5.4 Branch methods

```typescript
branch(branchFromId: string): void
resetLeaf(): void
branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromHook?: boolean, usage?: Usage): string
createBranchedSession(leafId: string): string | undefined
```

`branchWithSummary` appends a `branch_summary` entry that captures context from the abandoned conversation path. **This is the canonical pattern for the budget layer's hive→normal restore flow** (referenced in HANDOFF pitfall #29 and the 2026-09-22 mode-switch snapshot/restore design).

### 5.5 SessionEntry types (the JSONL contract)

From `dist/core/session-manager.d.ts:38-141`:

```typescript
type SessionEntry =
    | SessionMessageEntry       // { type: "message", message: AgentMessage }
    | ThinkingLevelChangeEntry  // { type: "thinking_level_change", thinkingLevel: string }
    | ModelChangeEntry          // { type: "model_change", provider, modelId }
    | UsageEntry                // { type: "usage", kind, provider, model, usage: Usage, note? }
    | CompactionEntry           // { type: "compaction", summary, firstKeptEntryId, tokensBefore, details?, usage?, fromHook? }
    | BranchSummaryEntry        // { type: "branch_summary", fromId, summary, details?, usage?, fromHook? }
    | CustomEntry               // { type: "custom", customType, data? }  — does NOT participate in LLM context
    | CustomMessageEntry        // { type: "custom_message", customType, content, details?, display } — DOES participate
    | ContextEditEntry          // { type: "context_edit", targetId, replacement: { content } | null }
    | LabelEntry                // { type: "label", targetId, label: string | undefined }
    | SessionInfoEntry          // { type: "session_info", name? }
```

**For a `CustomEntry`-based budget ledger:**
- `appendCustomEntry("pi-hive-budget-counter", { spent: 15134, cap: 3500 })` is the write.
- `getBranch()` on `session_start` rebuilds the ledger by reducing over `branch.filter(e => e.type === "custom" && e.customType === "pi-hive-budget-counter")`.
- The ledger is branch-aware automatically: a `/tree` navigation to a different branch restores that branch's spend.

---

## 6. `getContextUsage()` — current-context fill (NOT session lifetime)

Source: `dist/core/agent-session.js:3098-3130` (verified).

### 6.1 Implementation

```javascript
getContextUsage() {
    const model = this.model;
    if (!model) return undefined;
    const contextWindow = model.contextWindow ?? 0;
    if (contextWindow <= 0) return undefined;
    
    const projection = this.sessionManager.buildSessionProjection();
    const branch = this.sessionManager.getBranch();
    const latestCompaction = getLatestCompactionEntry(branch);
    
    if (latestCompaction) {
        // Only trust usage from assistants that responded AFTER the latest compaction.
        // Skips aborted and error messages.
        const projectedAssistants = new Set(projection.entries.flatMap((entry) =>
            entry.messages.some((message) =>
                message.role === "assistant" &&
                message.stopReason !== "aborted" &&
                message.stopReason !== "error" &&
                calculateContextTokens(message.usage) > 0
            ) ? [entry.sourceEntry.id] : []
        ));
        const compactionIndex = branch.findIndex((entry) => entry.id === latestCompaction.id);
        const hasPostCompactionUsage = branch.slice(compactionIndex + 1)
            .some((entry) => projectedAssistants.has(entry.id));
        if (!hasPostCompactionUsage) {
            return { tokens: null, contextWindow, percent: null };
        }
    }
    
    const estimate = estimateProjectedContextTokens(projection, branch);
    const percent = (estimate.tokens / contextWindow) * 100;
    return { tokens: estimate.tokens, contextWindow, percent };
}
```

### 6.2 Key observations

1. **`getContextUsage()` returns "current context load", NOT session lifetime.** This is the budget code's `runtime.contextTokens` and `runtime.contextPct`. Distinct from `getSessionStats().tokens`.

2. **Returns `{tokens: null, percent: null}` if no post-compaction assistant usage exists.** This is the documented "Estimated context tokens, or null if unknown (e.g. right after compaction, before next LLM response)." The budget code's `effectiveTokens` math handles this case by leaving `runtime.effectiveTokens` alone.

3. **Aborted and error assistant messages are EXCLUDED** (`stopReason !== "aborted" && stopReason !== "error"`). This is the OPPOSITE of `getSessionStats()` which INCLUDES them. The dispatcher's live accumulation in `message_end` may also have been skipped because the abort happened before `message_end` could fire for that specific message. **For Bug 3 analysis: `getContextUsage()` excludes aborted messages, while `getSessionStats()` includes them. The runtime.* state sits between these two views.**

---

## 7. End-of-run order in pi-hive's `dispatchAgent`

Source: `src/engine/dispatch.ts:727-870` (from HANDOFF's analysis and my own re-reads).

The order of operations at the END of one worker run, in `dispatchAgent`:

```
1. try {
     await session.prompt(...)   // line 727-758
     errorMessage = ...
     // final context usage poll (lines 763-790)
   } catch (error: any) {
     errorMessage = error?.message || String(error);
   }

2. try {
     const stats = session.getSessionStats?.();
     if (stats) {
       // overwrite runtime.inputTokens/outputTokens/cacheRead/cacheWrite/cost
       // from stats.tokens.input/output/cacheRead/cacheWrite + stats.cost
       // R3-1.3: do NOT overwrite runtime.toolCount
       // Reasoning is special-cased (only overwrite if positive)
     }
   } catch { /* keep incremental */ }

3. (out of any try)
   const delta = {
     inputTokens: nonneg(runtime.inputTokens - (runtime.runStartInputTokens ?? 0)),
     ...
   };
   runtime.governanceTokens = (runtime.governanceTokens || 0) + ...;
   runtime.governanceCostUsd = (runtime.governanceCostUsd || 0) + delta.costUsd;
```

### 7.1 What this means for Bug 3

The HANDOFF's hypothesis that "governanceTokens accumulates BEFORE the getSessionStats overwrite" is **WRONG about the order**. The overwrite happens BEFORE the delta computation. The accumulated delta uses the post-overwrite `runtime.*` values.

So if `getSessionStats()` returns 0 for the aborted message (because the SDK's `usage` field is all-zeros), the overwrite zeroes `runtime.inputTokens`. The delta becomes 0. `governanceTokens` accumulates 0.

**But the user reports `remaining.tokens=0` for the worker.** That requires `workerConsumedTokens(runtime) >= 3500`. After a fresh respawn, `governanceTokens`, `effectiveTokens`, and `runtime.*` should all be 0. So `workerConsumedTokens = 0`. `remaining.tokens = 3500`. **The symptom "remaining.tokens=0" should NOT happen with the current order.**

**Three plausible explanations:**

1. **The aborted message's `usage` IS populated in the SDK** (the provider sent the usage chunk before the abort). `getSessionStats()` returns the full session lifetime INCLUDING the abort-time usage. The overwrite preserves `runtime.inputTokens = abortTimeUsage`. `delta = abortTimeUsage - 0 = abortTimeUsage`. `governanceTokens += abortTimeUsage`. The display shows `runtime.inputTokens = abortTimeUsage` (not 0). But the user reports `tokens=0 in display`...

2. **The aborted message's `usage` is 0 in the SDK** (aborted before usage chunk arrived). `getSessionStats()` returns session lifetime MINUS the aborted usage. The overwrite zeroes `runtime.inputTokens` (or sets to the lifetime total up to the abort). `delta = lifetimeTotalUpToAbort`. `governanceTokens += lifetimeTotalUpToAbort`. **In this case, `governanceTokens` correctly reflects the abort-time spend.**

3. **There is ANOTHER call to `getSessionStats()` somewhere that the HANDOFF missed**, or the SDK itself records something on abort. The HANDOFF analysis is the user's best hypothesis; verification requires running the bug with the actual SDK and inspecting the stats return value.

For the refactor, the structural fix is: **the dual counter system is the bug class**. Whatever the exact Bug 3 mechanism, a redesign that makes the session file (`getBranch()` walking `UsageEntry` + `CustomEntry`) the source of truth eliminates this category of race.

---

## 8. Implication for the refactor design

Each finding in this document constrains the refactor options:

1. **`agent_settled` exists and is the canonical "Pi will not continue automatically" event.** The refactor should hook it for final budget accounting, replacing the current `agent_end` hook (Issue 8 in `01-current-state-analysis.md`).

2. **`session.dispose()` exists and is documented as "removes event listeners."** The refactor must call it in `respawnWorkerSession` to release the old session's listener closure (Issue 9).

3. **`getSessionStats()` in 0.99.1 explicitly accumulates `UsageEntry` records** (see §2.2 observation 3). This is the key alignment point for the refactor's prescription: writing per-call usage via `SessionManager.appendUsage(kind, provider, model, usage)` makes those writes show up in `getSessionStats()` by construction — no parallel in-memory counter needed for the post-run total. The refactor must decide whether to:
   - Trust `getSessionStats()` and let it overwrite `runtime.*` (current behavior, race-prone)
   - Skip the overwrite and use live accumulation as authoritative (less reliable, but avoids the race)
   - Replace the whole counter system with `UsageEntry` + `CustomEntry` walking via `getBranch()` (eliminates the race class entirely; naturally aligns with what 0.99.1's `getSessionStats()` does)

4. **`SessionManager.appendUsage()` is the canonical write primitive for per-call spend.** A `UsageEntry`-based ledger would write `kind: "worker_call"` per worker invocation. `getBranch()` on `session_start` walks them and aggregates. (Note: `getSessionStats()` aggregates from `getEntries()` across all branches in 0.99.1 — see §2.2 observation 2 — so a `UsageEntry` write is durable across branch navigation.)

5. **`SessionManager.appendCustomEntry()` is the canonical write primitive for cumulative counter state.** A `CustomEntry` with `customType: "pi-hive-budget-counter"` and `data: { tokens: number, cost: number, ... }` survives reload and is branch-aware.

6. **`session.compact(customInstructions?)` returns a `CompactionResult` with `summary`, `firstKeptEntryId`, `tokensBefore`, `estimatedTokensAfter`.** The budget code's compaction math uses `tokensBefore - estimatedTokensAfter` for the savings debit. Verified at `src/engine/dispatch.ts:601-616`.

7. **`compaction_end` event has an `aborted: boolean` field.** The refactor can check this to skip the `effectiveTokens` debit on a failed compact (current code ignores it; this is a latent bug if compactions ever fail mid-way). In 0.99.1, if the compaction completes successfully, its own summary-call `usage` is added to `getSessionStats()` totals (see §2.2 observation 4); failing compactions don't contribute.

8. **`UsageEntry.usage` has the same `Usage` shape as `AssistantMessage.usage` plus optional `reasoning` and `cacheWrite1h`.** The refactor's per-call write should populate `reasoning` from the live accumulator (pi-hive tracks it separately) and `cacheWrite1h` if the SDK reports it.

9. **No SDK bug found in `getSessionStats()` (0.99.1).** The `cacheWrite` field is correctly set to `usageTotals.cacheWrite`, and `total` correctly sums all four components. The budget code's overwrite at `src/engine/dispatch.ts:797-803` can trust these values for the four components (input, output, cacheRead, cacheWrite) and the `cost` total. **Note**: the overwrite does NOT touch `runtime.reasoningTokens` (pi-hive's live accumulation is more authoritative — the SDK's `Usage.reasoning` field is optional and may be absent).

10. **`createAgentSession` option rename: `modelRegistry` → `modelRuntime`.** 0.99.x dropped `ModelRegistry` from `CreateAgentSessionOptions`; the replacement is `ModelRuntime` (a richer class wrapping models + credentials). Production callers in `src/engine/dispatch.ts:393` and `src/engine/distiller.ts:37` were updated to omit the option (the SDK builds a default `ModelRuntime` from the same `auth.json`/`models.json` paths the extension already consults). The extension still reads `ctx.modelRegistry` directly for its own use (`hooks.ts`, `model-resolution.ts`); those usages are unaffected.

---

## 9. Source-of-truth citations

Every claim in this document is grounded in one of the following files (paths relative to `node_modules/@earendil-works/pi-coding-agent/`, the worktree's devDependency install):

- `dist/core/agent-session.d.ts` — `AgentSession` class, `AgentSessionEvent` types, `SessionStats`, `PromptOptions`, `CompactOptions`
- `dist/core/agent-session.js` — implementation of `getSessionStats()` and `getContextUsage()` (verified by reading the .js, not just the .d.ts; 0.99.1 quote in §2.2)
- `dist/core/session-manager.d.ts` — `SessionManager` class, all `append*` methods (including `appendUsage`, `appendCustomEntry`), `getBranch()`, `getEntries()`, `buildSessionContext()`, `SessionEntry` types (including `UsageEntry`)
- `dist/core/session-manager.js` — implementation of `appendUsage`, `getEntries()`, etc.
- `dist/core/messages.d.ts` — `CustomMessage`, `BranchSummaryMessage`, `CompactionSummaryMessage`, `BashExecutionMessage`
- `dist/core/compaction/compaction.d.ts` — `CompactionResult`, `CompactionSettings`, `findCutPoint`, `estimateTokens`, `getLastAssistantUsage`
- `dist/core/usage-totals.d.ts` — `UsageTotals`, `addUsageToTotals`, `getUsageCostBreakdown`
- `dist/core/extensions/types.d.ts:194-200` — `ContextUsage` interface
- `dist/core/model-runtime.d.ts` — `ModelRuntime` class (replacement for `ModelRegistry` in `CreateAgentSessionOptions` as of 0.99.x)
- `dist/node_modules/@earendil-works/pi-ai/dist/api/mistral-conversations.d.ts` — `Usage` shape, abort handling
- The session entry types in `session-manager.d.ts:36-130` are the canonical JSONL contract; `pi-docs/extension-patterns-reference.md` covers the same shapes with the broader pi-docs context.

If a refactor option claims a behavior not verified against one of these files, treat it as unverified and either confirm against the SDK source or run a test before relying on it.
