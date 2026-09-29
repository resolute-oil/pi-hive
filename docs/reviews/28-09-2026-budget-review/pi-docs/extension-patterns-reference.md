# Pi-documented extension patterns relevant to budget enforcement

This file is part of the budget-enforcement redesign review (`docs/reviews/28-09-2026-budget-review/`). It captures the patterns Pi documents for extensions, quoted verbatim from the Pi docs at `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/`, with each pattern annotated for its applicability to budget enforcement in `pi-hive`.

The goal is not to summarize Pi; the goal is to make the source-of-truth visible so the redesign options can be evaluated against documented Pi behavior rather than inferred behavior. Every quote below is from a specific doc and section anchor. Quotes are preserved exactly; emphasis (italic in the source) is preserved.

## Table of contents

1. [Extension lifecycle](#1-extension-lifecycle)
2. [Custom tools](#2-custom-tools)
3. [Dynamic tool activation](#3-dynamic-tool-activation)
4. [State management](#4-state-management)
5. [Event handlers](#5-event-handlers)
6. [Errors and cleanup](#6-errors-and-cleanup)
7. [UI and modes](#7-ui-and-modes)
8. [Concurrency and ordering](#8-concurrency-and-ordering)
9. [Session lifecycle integration](#9-session-lifecycle-integration)
10. [Package distribution patterns](#10-package-distribution-patterns)
11. [Security](#11-security)
12. [2026-09-28 online SDK refresh — clarifications and additions](#12-2026-09-28-online-sdk-refresh--clarifications-and-additions)
13. [Implications for budget enforcement design](#implications-for-budget-enforcement-design)

---

## 1. Extension lifecycle

**Source:** `extensions.md#respect-the-runtime-lifecycle`, `extensions.md#extension-locations`

> "The factory can be synchronous or asynchronous. Pi waits for an asynchronous factory before startup continues, allowing it to fetch configuration or register providers needed during startup."

> "Do not start processes, sockets, watchers, or timers in the factory because some invocations load extensions without starting a session. Start long-lived resources from `session_start` or from the command or tool that needs them. Close session-scoped resources from an idempotent `session_shutdown` handler."

> "A run proceeds from input and `before_agent_start`, through model, message, and tool events, to `agent_end`. Automatic retries, recovery, compaction, or queued work can continue afterward."

> "Reload replaces the extension runtime, so code after `await ctx.reload()` must not reuse state from the old runtime. Only personal and explicit command-line extensions can participate in the `project_trust` event that runs before project extensions load."

### Application to budget enforcement

The Pi docs are explicit: budget accounting state (counters, in-flight trackers, the dashboard server process if it is started from the extension) must **not** be created in the factory. Every Pi invocation loads extensions, including invocations that never start a session (`pi --help`, `pi list`, `--no-session` runs, etc.). The dashboard or any other long-lived budget-tracker process therefore belongs in `session_start` or in the command/tool that needs it.

The reload caveat is also significant: if budget state lives in a closure captured by `pi.on()` handlers, it dies on `/reload` and the new runtime starts fresh. Anything that must survive reload — including the dashboard process, telemetry buffers, persisted counters — needs to be (a) external (filesystem, global DB), (b) re-derived from session entries on `session_start`, or (c) started from the command path that performs the reload. There is no in-memory bridge across the reload boundary.

The `project_trust` restriction is structural: a project-installed pi-hive cannot intercept `project_trust` itself. Any opt-in flow for "this project trusts pi-hive to enforce budgets" must be either personal-config or an explicit CLI flag, not a project-trust handler.

---

## 2. Custom tools

**Source:** `extensions.md#custom-tools` (anchor `custom-tools`, also `register-tools`), `sdk.md`, `message-types.md#toolresultmessage`

> "A custom tool defines a name, model-facing description, TypeBox parameter schema, and `execute()` function. Its result requires model-facing `content` and a `details` field for rendering or state reconstruction. Use `details: undefined` when there are no structured details. If the tool makes nested model calls, include their `usage` in the result so session totals remain accurate."

> "Throw from `execute()` to produce a failed tool result. Returning an object does not mark it as an error. Return `terminate: true` only when the agent should skip its automatic follow-up after every completed tool in that batch agrees to terminate."

> "Use sequential execution when tools share mutable in-memory state. File-mutating tools should wrap the complete read-modify-write operation with `withFileMutationQueue()`. Truncate large model-facing results and tell the model where to read the complete output."

From `message-types.md#toolresultmessage`:

> "`details` is tool-specific. Optional `usage` reports nested model work performed by the tool and contributes to full-session statistics, but it is not part of the main model-call usage."

From `extensions.md#extensioncontext`:

> "`ExtensionContext` provides the working directory, mode, UI, session manager, model runtime, abort signal, context usage, and controls for compaction and shutdown. Use `ctx.modelRegistry.streamSimple()` for provider-neutral nested model calls."

### Application to budget enforcement

Three patterns matter for a budget enforcement redesign:

1. **Throw vs. return for blocked operations.** "Throw from `execute()` to produce a failed tool result. Returning an object does not mark it as an error." A budget-gated tool that wants to refuse a call must throw (or return `{isError: true}` content), not return a successful-looking object the model will treat as success. This is the canonical way to make a budget cap abort a delegated agent call.

2. **Nested model usage must be reported.** "If the tool makes nested model calls, include their `usage` in the result so session totals remain accurate." This is critical: if `delegate_agent` (or any worker spawn) makes nested model calls, the result's `usage` field must carry the worker spend or it silently disappears from session totals. A budget enforcer that reads session usage as the source of truth for "what has been spent" must look at *both* `AssistantMessage.usage` (top-level agent loop) and `ToolResultMessage.usage` (nested worker calls). Anything that aggregates only top-level usage under-counts the team budget.

3. **`terminate: true` for batch-terminated runs.** "Return `terminate: true` only when the agent should skip its automatic follow-up after every completed tool in that batch agrees to terminate." This is the documented hook for ending a turn early. A budget enforcer should *not* set `terminate: true` on its own tool unless every other completed tool in the same batch also opted into termination — otherwise the agent will keep going.

The "truncate large model-facing results and tell the model where to read the complete output" rule applies to budget reporting tools: a status response that returns the full per-agent breakdown will overflow context. The tool should return a compact summary plus a pointer to the dashboard or session telemetry file.

---

## 3. Dynamic tool activation

**Source:** `extensions.md#activate-tools-dynamically`

> "Register every tool first, keep optional tools inactive, and use `pi.setActiveTools()` from a loader tool to select the desired active tools. Names must already be registered; unknown names are ignored."

> "Pi records the initial prompt and tool set in the transcript's first system message, then appends tool and prompt changes before the next model request. Providers that cannot represent the transition receive a complete transcript checkpoint, which can invalidate the cached prefix."

### Application to budget enforcement

The activation model is **register-then-activate**, not "register on demand". This has two consequences for budget enforcement:

1. **A budget-aware loader must enumerate worker tools upfront.** All `delegate_*` tools and their variants (e.g., `delegate_agent`, `delegate_researcher`) must be `registerTool()`-ed at extension load, then toggled inactive. They cannot be registered lazily from inside another tool's `execute()` and become visible to the next model call. Pi records the tool set in the leading system message; once that system message is on disk, changing which tools are registered later is not the supported path. The supported path is `setActiveTools()`.

2. **`setActiveTools` takes a name list, not a "mode".** "Names must already be registered; unknown names are ignored." If the budget enforcer wants to swap the worker pool based on remaining budget, it must toggle the existing registered toolset between presets — it cannot register a new tool name on the fly. Any "shrink the worker pool" design needs preset tool lists, not ad-hoc tool generation.

The cache invalidation footnote is the cost of the feature: every `setActiveTools` call can invalidate the provider's prompt cache prefix. A budget enforcer that toggles tools on every run will defeat prompt caching. This is a reason to keep the toolset stable across a session and let the budget decisions live in tool results and event handlers, not in tool-set churn.

---

## 4. State management

**Source:** `extensions.md#state-management` (anchor `state-management`, also `persist-state`)

> "Choose storage based on how state participates in the conversation:
>
> | State | Storage |
> |---|---|
> | Tool state that follows the active branch | Tool-result `details` |
> | Durable data excluded from model context | `pi.appendEntry()` |
> | Custom content stored and sent to the model | `pi.sendMessage()` |
> | Data outside one session | External storage |"

> "Reconstruct branch-sensitive state from `ctx.sessionManager.getBranch()` during `session_start`. Do not rebuild it from every file entry because abandoned branches represent alternative histories. Register an entry or message renderer when custom stored content should appear in the transcript."

### Application to budget enforcement

Pi prescribes a four-tier model. The four tiers map directly to budget accounting:

- **Tool-result `details`** is the place for "this tool's run spent X tokens, took Y ms, used model Z". It is branch-sensitive: a `/tree` navigation to a branch that did not run the tool restores the world where those tokens were never spent. This is the correct tier for *per-call* spend attribution.

- **`pi.appendEntry()`** is the place for budget state that must persist across the session but should not enter the model context. This is where cumulative counters belong: `total spent`, `calls remaining`, `cumulative cache writes`. They must survive `/tree`, `/fork`, and `/clone` correctly because `appendEntry` is part of the entry tree.

- **`pi.sendMessage()`** (CustomMessage / CustomMessageEntry in `session-format.md`) is the place for budget *context* the agent itself needs to see — e.g., "you have 12% of your budget remaining, prefer cheaper tools." This enters model context, so it must be concise and on-purpose.

- **External storage** is the place for anything cross-session: a per-user cost ledger, the global agent registry, the dashboard's database. The Pi docs are explicit that "Data outside one session → External storage."

The `getBranch()` advice is the key instruction for any "load my counters back" logic: rebuild from the active branch only, not from the entire JSONL. Walking the file linearly would replay abandoned branches and double-count. The current pi-hive budget reset bug (`fresh=true` not resetting) is most likely a failure to honor this distinction; the redesign must define where counter state lives such that `getBranch()` returns exactly the spend relevant to the branch the user is currently on.

---

## 5. Event handlers

**Source:** `extensions.md#events` (anchor `events`), `extensions.md#agent_start--agent_end--agent_before_settle--agent_settled`, `message-types.md`

From `extensions.md#events`:

> "Handlers run in extension load and registration order. `pi.on()` returns a function that unsubscribes that registration; changes do not affect a dispatch already in progress."

> "`before_agent_start` exposes both the current prompt and its structured `systemPromptOptions`. Prefer changing prompt sections, selected tools, or guidelines so Pi can append a transcript delta. Returning `systemPrompt`, or setting `forceSystemPrompt`, replaces the whole prompt for that run while the transcript continues recording the structured sections. Providers receive the forced text as their leading system prompt."

> "`message_end` can replace a finalized message while preserving its role. `tool_call` can mutate input or block execution. `tool_result` handlers compose, with each handler seeing prior changes."

> "`turn_end` and `agent_before_settle` are actionable boundaries. Their handlers can chain proposed `custom`, `custom_message`, `context_edit`, or `compaction` entries and return `continue: true` for one next model request. Guard continuation conditions because an unconditional continuation can loop."

From `extensions.md#agent_start--agent_end--agent_before_settle--agent_settled`:

> "`agent_before_settle` is the final actionable boundary: it can append entries and request one continuation. `agent_settled` is final and notification-only; use it when an integration needs to know Pi will not continue automatically."

From `message-types.md#custommessage`:

> "Pi converts its content to a user message for model requests. `display` controls terminal rendering; `details` is not sent to the model."

### Application to budget enforcement

Each Pi event has a defined mutability contract, and budget enforcement must respect it:

| Event | Mutates what | Notification-only? | Use for budget |
|---|---|---|---|
| `before_agent_start` | prompt sections, tools, guidelines (preferable); whole prompt (replaces transcript delta, expensive) | mutating | Inject a "remaining budget" instruction via `sendMessage` (CustomMessage) or `systemPromptOptions`; do **not** force the full prompt because that defeats the transcript delta |
| `tool_call` | input or block execution | mutating | The cleanest place to **gate** an expensive call — returning a block result short-circuits before the tool runs |
| `tool_result` | composes with prior handlers | mutating | The cleanest place to **attribute** spend: rewrite `usage` or `details` to carry the tool's cost into the entry tree |
| `message_end` | replace finalized message preserving role | mutating | Final attribution point for assistant-token cost; can append `usage` corrections |
| `agent_before_settle` | append entries; request one continuation | mutating (last actionable) | The place to **end the run** when budget is exhausted; chain a `custom_message` that explains why and return `continue: false` (or no continuation) |
| `agent_settled` | none — final | yes | A safe place to flush buffers, emit a telemetry event, or release transient resources |
| `turn_end` | append entries; request one continuation | mutating | Same as `agent_before_settle` but earlier; useful for per-turn budget checks |
| `cache_warming_decision` | override idle cache refresh | mutating | Optional lever — if `cache_warm` events cost real money, return `{action: "stop"}` when budget is tight |

The key takeaways:

1. **Mutation happens in tool_call/tool_result, not in agent_end.** Budget enforcement that wants to *prevent* spend should hook `tool_call` (block before execution) or `agent_before_settle` (refuse continuation). Enforcement that wants to *record* spend should hook `message_end` and `tool_result`.

2. **`before_agent_start` is the right place to *inform* the agent about remaining budget**, not to mutate the prompt wholesale. Use `sendMessage` (CustomMessage) — Pi converts it to a user message for the model and does not include `details` in model input. `details` is the local-only place to attach the budget numbers for the renderer.

3. **`agent_settled` is the safe teardown point** — the docs explicitly call it "final and notification-only". A budget enforcer that needs guaranteed cleanup after every run should hook this (in addition to `session_shutdown`), because `session_shutdown` may not fire on every abort path.

4. **`continue: true` from `agent_before_settle` is dangerous.** "Guard continuation conditions because an unconditional continuation can loop." A budget enforcer that uses `agent_before_settle` to inject "budget warning, please be efficient" and requests continuation will spin the agent forever. The redesign must always set `continue: false` (or omit the continuation) at `agent_before_settle` so the loop has a single, safe exit.

---

## 6. Errors and cleanup

**Source:** `extensions.md#errors-and-cleanup` (anchor `error-handling`, also `handle-errors-and-shutdown`)

> "Pi reports handler errors and continues where possible. A `tool_call` handler failure blocks the tool as a fail-safe; a tool execution failure becomes an error result for the model."

> "Release resources in `session_shutdown` even when normal operation attempted cleanup. Keep cleanup idempotent because cancellation, reload, session replacement, and process exit can converge on the same path. Use `ctx.shutdown()` to request an orderly process shutdown."

### Application to budget enforcement

Three operational rules for the redesign:

1. **A handler that throws is *better* than a handler that silently corrupts state.** If the budget enforcer's pre-check fails (counter file corrupt, dashboard unreachable, persisted state inconsistent), it should `throw` — `tool_call` handler failures block the tool as a fail-safe. This is the canonical "fail closed" path. A budget enforcer that swallows exceptions and lets an expensive call through has violated Pi's documented contract.

2. **Cleanup is idempotent by contract.** Cancellation, `/reload`, session replacement, and process exit can all converge on the same teardown. Any budget enforcer that holds a counter file, socket, or dashboard child process must treat cleanup as callable any number of times without double-release or zombie processes. The current pi-hive reload behavior (where budget state did not survive) is a symptom that this rule was not followed: state lived in closure rather than in appendEntry-backed storage that gets re-derived on `session_start`.

3. **`ctx.shutdown()` is the orderly exit.** When the budget is genuinely exhausted and the run should not continue, calling `ctx.shutdown()` from `agent_before_settle` is the documented way to terminate the process. The redesign should prefer `continue: false` (refuse the next model call) over `ctx.shutdown()` (kill the process) — `ctx.shutdown()` is for the case where the session itself is over, not for "skip this turn". A budget-exhausted enforcer that calls `ctx.shutdown()` on every cap will frustrate users who want to start a new session immediately.

---

## 7. UI and modes

**Source:** `extensions.md#ui-and-modes` (anchor `custom-ui`, `mode-behavior`, `interact-with-the-user`, `account-for-each-mode`), `tui.md`, `rpc-extension-ui.md`

From `extensions.md#ui-and-modes`:

> "`ctx.ui` provides dialogs, notifications, status text, widgets, titles, editor access, and custom components. Use `ctx.ui.custom()` only when the interaction needs its own rendering and input. See [Terminal UI](tui.md) for component, focus, overlay, theme, and performance guidance."

> "Extensions load in interactive, RPC, JSON, and print modes. Interactive mode provides the complete terminal UI. RPC can forward supported dialogs and notifications through the [RPC Extension UI protocol](rpc-extension-ui.md), but not custom terminal components; JSON and print modes have no UI. Guard terminal-only behavior with `ctx.mode === \"tui\"` and use `ctx.hasUI` for interactions supported by interactive and RPC clients."

> "Keep tool and event behavior independent from rendering so non-interactive modes remain functional."

From `rpc-extension-ui.md`:

> "`ctx.mode` is `\"rpc\"` and `ctx.hasUI` is `true` in RPC mode because the dialog and fire-and-forget methods are functional via the extension UI sub-protocol. Use `ctx.mode === \"tui\"` to guard TUI-specific features like `custom()` that require a real terminal."

From `rpc-extension-ui.md#limitations`:

> "`custom()` returns `undefined`. `onTerminalInput()` returns a no-op unsubscribe function. `setWorkingMessage()`, `setWorkingVisible()`, `setWorkingIndicator()`, `setHiddenThinkingLabel()`, `setFooter()`, `setHeader()`, `addAutocompleteProvider()`, `setEditorComponent()`, and `setToolsExpanded()` are no-ops."

### Application to budget enforcement

The budget UI surface must respect the four-mode contract:

- **TUI mode** is the only mode where `ctx.ui.custom()` works. Any budget dialog (e.g., "approve spending more?") that wants a custom rendering must guard on `ctx.mode === "tui"`.
- **RPC mode** supports dialog and notify methods through the extension UI sub-protocol, but `custom()` is `undefined`. A budget enforcer running in RPC must fall back to `select`/`confirm`/`input` if it wants user input.
- **JSON and print modes** have no UI at all. Any budget enforcement hook that calls a UI method must check `ctx.hasUI` first; otherwise the call is undefined or a no-op and the budget decision happens silently.
- **Non-rendering behavior must be mode-independent.** The Pi docs are explicit: "Keep tool and event behavior independent from rendering so non-interactive modes remain functional." The budget enforcer must enforce caps in `--print` and RPC modes just as it does in TUI mode. The dashboard server, the per-call usage tracking, the counter persistence — none of these can be conditional on `ctx.mode === "tui"`.

This is also relevant to the dashboard itself: any budget widget that wants to be visible should use `setWidget` (which works in RPC mode) rather than `custom()`. Custom components that draw budget sparklines or live counters must be TUI-only — RPC clients will see nothing for them.

---

## 8. Concurrency and ordering

**Source:** `extensions.md#events` (anchor `events`, also `work-with-events`)

> "Handlers run in extension load and registration order. `pi.on()` returns a function that unsubscribes that registration; changes do not affect a dispatch already in progress. Some events notify; others transform data, replace results, or cancel an operation. Use each event's declared result type rather than assuming every return value has an effect."

> "Tool calls from one assistant message can run in parallel. Do not assume a sibling call or result exists when another tool event runs. Use `ctx.signal` for nested work owned by an active turn; commands and idle session events often have no operation signal."

> "A `user_bash` handler that returns `undefined` passes the command to the next handler and then to local execution if no handler handles it. Returning `operations` or `result` stops propagation. A handler failure blocks the command rather than falling through to local execution."

### Application to budget enforcement

The concurrency rules that directly apply:

1. **Parallel tool calls mean budget attribution can race.** "Tool calls from one assistant message can run in parallel. Do not assume a sibling call or result exists when another tool event runs." If `delegate_agent` is invoked twice in the same turn, the two `tool_result` events fire in some order — and the budget counter update that happens in `tool_result` cannot assume the other call's result has been recorded yet. The counter must be per-call (via `details` or an appendEntry that lands in the right place in the entry tree), not aggregated in a shared in-memory `let` that is read by a sibling handler.

3. **Handler execution order is load order, not registration order.** "Handlers run in extension load and registration order." A budget enforcer that wants to run **before** another extension's `tool_call` handler must register first. If two extensions both mutate `tool_call` arguments, the later one sees the earlier one's output (this matches the `tool_result` composing rule from §5). The redesign should explicitly position its handlers relative to the existing `hive-policy` checks so it does not get overridden silently.

3. **`ctx.signal` is the abort signal for in-turn work; commands and idle events often have none.** "Use `ctx.signal` for nested work owned by an active turn; commands and idle session events often have no operation signal." Any budget enforcer that starts a dashboard request, telemetry flush, or counter read from inside a `tool_call`/`tool_result` handler must pass `ctx.signal` so the work is aborted when the user hits Ctrl+C. The same work started from `session_start` or a `/` command may have no signal — budget-enforcer code that wants to be aborted must check `signal.aborted` before each step.

4. **`user_bash` is a separate channel with its own fail-closed rule.** If the budget enforcer gates `bash` (via the `user_bash` event), it should return `operations` or `result` to stop propagation; "A handler failure blocks the command rather than falling through to local execution" means throwing from the handler is also fail-closed. The redesign should not rely on returning `undefined` to "let it through" — that continues propagation.

---

## 9. Session lifecycle integration

**Source:** `sessions.md`, `session-format.md`

From `sessions.md#manage-conversation-context`:

> "The model receives the active branch, not every branch in the session file. Pi combines that history with the system prompt, discovered context files, available tools, and loaded skill descriptions."

From `session-format.md#usageentry`:

> "Records model-attributed usage that is not an assistant message and does not participate in LLM context. `kind` is an arbitrary string identifying the operation; for example, cache warming uses `\"cache_warm\"`."

> "Usage entries contribute to session token and cost totals. Pi hides them from the conversation tree. Consumers should treat unknown `kind` values as normal usage rather than rejecting them."

From `session-format.md#compactionentry`:

> "`firstKeptEntryId` is required. It identifies the first entry retained from before the compaction entry. When rebuilding context, Pi replaces older summarized entries with the compaction summary and keeps the range beginning at this entry."

> "Optional fields: ... `usage`: LLM usage from generating the summary; included in session token and cost totals ... `details`: Implementation-specific data (e.g., `{ readFiles: string[], modifiedFiles: string[] }` for default, or custom data for extensions) ... `fromHook`: `true` if generated by an extension, `false`/`undefined` if pi-generated (legacy field name)"

From `session-format.md#branchsummaryentry`:

> "Optional fields: `usage`: LLM usage from generating the summary; included in session token and cost totals ... `details`: File tracking data (`{ readFiles: string[], modifiedFiles: string[] }`) for default, or custom data for extensions"

From `session-format.md#customentry`:

> "Extension state persistence. Does NOT participate in LLM context. ... Use `customType` to identify your extension's entries on reload. Interactive mode can render custom entries via `pi.registerEntryRenderer(customType, renderer)`, but they still do not participate in LLM context."

From `session-format.md#custommessageentry`:

> "Extension-injected messages that DO participate in LLM context. ... `display`: `true` = show in TUI with distinct styling, `false` = hidden ... `details`: Optional extension-specific metadata (not sent to LLM)"

From `session-format.md#contexteditentry`:

> "Append-only edit of one earlier context-producing entry. It changes only future model context; the target entry and its metadata remain unchanged in raw history, UI, exports, and session accounting. ... `replacement: null` omits the target from model context. A non-null `replacement` replaces only the target message content. ... If several edits target the same entry, the latest edit on the active branch wins. Edits are branch-relative: navigating to a point before the edit reveals the target's original contribution again."

### Application to budget enforcement

The session-format entries are the persistence vocabulary for budget enforcement. Five entry types are directly relevant:

1. **`UsageEntry` (`{type: "usage", kind: "...", usage: {...}}`)** — the canonical place to record spend that is not a top-level assistant call. Pi explicitly says "Usage entries contribute to session token and cost totals" and "Pi hides them from the conversation tree". This is the natural home for *worker-attributed* usage (i.e., what a delegated agent spent that is not in the parent's assistant message), and for *enforcer-attributed* usage (cache-warming attempts that were stopped by the budget enforcer). A redesign that does not write `UsageEntry` for nested worker spend is under-counting; a redesign that uses a sidecar JSON file for the same data is duplicating what the session file already supports.

2. **`CustomEntry` (`{type: "custom", customType: "...", data: {...}}`)** — "Does NOT participate in LLM context." This is where persistent budget state belongs: cumulative spend, caps, per-tier limits, "remaining" calculations. The `customType` field is the reload-stable identifier. Any state written here will be in the session tree, will be restored on `/resume`, will be fork-aware (because it lives on the active branch), and will not pollute model context. This is the answer to the `fresh=true` bug: if the budget counter is a `CustomEntry` and the `getBranch()` re-derives it on `session_start`, then "fresh" can mean "new session" (no entries) or "continuation" (entries present) and the distinction is enforced by the file, not by a flag that may or may not propagate.

4. **`CompactionEntry` `details` / `BranchSummaryEntry` `details`** — both support an extension-specific `details` object. A budget enforcer could attach a `details: { budgetSpentBeforeCompaction: N }` to either entry so the compaction/summarization pipeline carries forward the budget context that existed at the boundary. Without this, compaction may "lose" budget context the model needed to know about.

5. **`ContextEditEntry`** — the documented way to retroactively remove a message from model context without mutating the entry. If the budget enforcer wants to redact an oversize tool output before the next model call, `context_edit` with `replacement: null` is the right primitive. (Redaction is a side benefit, not a budget lever, but it is in the same toolkit.)

6. **`session_start` + `ctx.sessionManager.getBranch()`** — the explicit instruction from `extensions.md#state-management`: "Reconstruct branch-sensitive state from `ctx.sessionManager.getBranch()` during `session_start`. Do not rebuild it from every file entry because abandoned branches represent alternative histories." The redesign's `session_start` handler should walk only the active branch and re-derive the counter. Walking the whole JSONL will sum abandoned branches and double-count.

---

## 10. Package distribution patterns

**Source:** `packages.md`

> "Pi packages install and distribute extensions, skills, prompt templates, and themes as one unit. Use a package when a customization should be shared through npm or git, or when several resources belong together."

> "Pi supplies these packages to extensions and skills: `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`. Declare imported Pi packages in `peerDependencies` with a `\"*\"` range and do not bundle them. Other Pi packages used as dependencies must be included in the published tarball and referenced through their `node_modules` resource paths."

> "Installed packages load with separate module roots. Do not rely on two packages sharing one dependency instance or one package resolving another package's undeclared dependency."

> "Project packages are installed and loaded only after project trust is resolved. Packages can execute extension code and can include skills that instruct the model to run programs. Review third-party package source before installing it. Review project package declarations before granting project trust."

> "Use the object form in settings to narrow which resources load from a package: ... `extensions: [\"extensions/*.ts\", \"!extensions/legacy.ts\"]` ... For each resource type: Omit the property to load everything allowed by the package. Use `[]` to load none of that type. Use `!pattern` to exclude glob matches. Use `+path` to include one exact allowed path. Use `-path` to exclude one exact path."

### Application to budget enforcement

The package-level rules have direct consequences:

1. **Peer dependencies, not bundled.** "Declare imported Pi packages in `peerDependencies` with a `\"*\"` range and do not bundle them." pi-hive's `package.json` must list `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` as peer deps with `"*"`, not in `dependencies`. Bundling causes version skew at install time and breaks when Pi upgrades.

2. **No shared module roots.** "Installed packages load with separate module roots. Do not rely on two packages sharing one dependency instance or one package resolving another package's undeclared dependency." If pi-hive depends on another Pi package, it must declare it explicitly. There is no transitive resolution between Pi packages. This also means the dashboard server (if it is a sibling Pi package) does not share types or globals with the extension.

3. **Project packages require trust.** pi-hive cannot be silently activated from `.pi/packages/` in a project the user has not trusted. The opt-in is project trust, not just file presence. The extension is currently correctly guarded by `.pi/hive/hive-config.yaml`, but the docs make clear that even presence-based loading would require trust for a project-installed package.

4. **Resource filtering is the supported way to load only some files.** If the redesign wants to ship *experimental* budget code that loads only behind an opt-in, the supported mechanism is the object form in settings (`extensions: ["!extensions/experimental.ts"]`) — not a runtime `process.env` flag inside the extension. The dashboard prebuilt assets live under `ui/web/dist/` and are committed; the docs' "do not require users to build the dashboard at install time" advice is consistent with this.

---

## 11. Security

**Source:** `security.md`

> "Treat model-generated commands and code as untrusted. Pi can read, change, and execute files with the permissions of the account that started it, and it does not ask for approval before every tool call. Extensions, package installers, language servers, and other child processes run with those same permissions unless an operating-system or virtualization boundary restricts them."

> "Files, comments, instructions, command output, and model responses can steer the model through prompt injection. Project trust controls which project resources load at startup, but it does not make that content or the resulting actions safe."

> "Project trust is not a complete startup boundary. Pi reads the project `sessionDir` setting while selecting or creating a session, before it resolves project trust. Declining trust prevents the remaining project settings and protected resources from loading, but it cannot undo that initial session-directory lookup."

> "Project trust does not limit what tool calls can access or affect. After Pi starts, enabled tools still use the operating-system permissions of the Pi process. Instructions and other content in the folder can also influence the model."

From `security.md#how-pi-chooses-a-trust-decision`:

> "User-level and command-line extensions can handle the `project_trust` event. The first extension that returns yes or no owns the decision. ... Print, JSON, and RPC modes cannot show the built-in trust prompt. ... Use `--approve` or `--no-approve` when an automated run needs an explicit one-time decision."

### Application to budget enforcement

Three rules apply:

1. **The extension is a trusted peer of Pi.** "Extensions, package installers, language servers, and other child processes run with those same permissions." A budget enforcer that decides "block this call" is making a permission-equivalent decision at the model layer — but it does **not** run in a sandbox. If the enforcer is compromised (prompt injection in a comment in a loaded file, a malicious dependency in the package), it has the same OS permissions as the user. Any code path that touches the filesystem, runs subprocesses, or opens sockets should be treated as if it were a direct user action. The dashboard server, the telemetry writes, the `appendEntry` calls — all of these run with full user permissions.

2. **Project trust is a startup boundary, not a runtime boundary.** "Project trust does not limit what tool calls can access or affect." A user who grants project trust to `.pi/hive/` is not granting permission for the agent to do anything; they are only granting permission for the extension code to load. The budget enforcer's gates (refuse `bash`, block expensive tools, etc.) are runtime decisions and operate on top of the trust grant. The redesign should not conflate the two — opting into pi-hive is not opting into "the agent may now spend money".

3. **`project_trust` is only available to personal/CLI extensions.** If pi-hive were ever to make a `project_trust`-style decision for its own activation (e.g., "this project's hive config is trusted"), it must be installed at user level or via `--extension`. A project-installed extension cannot intercept `project_trust` to gate its own loading. This is why the project's current opt-in is a config file (`hive-config.yaml`) inside the project — that is the supported boundary for project-loaded extensions to declare their own scope.

4. **Prompt injection is in scope.** "Files, comments, instructions, command output, and model responses can steer the model through prompt injection." A budget enforcer that reads worker output, command output, or file content to make a "should this be allowed?" decision is reading attacker-controlled input. The decision logic must not be reversible by an injected prompt — i.e., it should not "ask the model" whether the budget allows the next call. The budget cap is a code-side constant, not a model-side judgment.

---

## Implications for budget enforcement design

The Pi-documented patterns above reduce to a short list of design constraints the redesign must respect. The current pi-hive code either follows each rule, conflicts with it, or ignores it. This closing section summarizes that audit. The detailed point-by-point application lives in the sections above.

### Patterns the redesign should follow

- **State lives in session entries, not in closure.** Per-call spend → `ToolResultMessage.details` or `details` of `tool_call`. Cumulative counters → `CustomEntry` with a stable `customType`. Cross-session data → external storage. Worker-attributed usage → `UsageEntry` with a `kind` like `"worker_call"`. (See §4, §9.)
- **Reload and `session_start` rebuild from `getBranch()`.** The budget counter is reconstructed from the active branch at `session_start`, not maintained in a closure that dies on `/reload`. This is the structural fix for the `fresh=true` bug: "fresh" is a property of the branch, not a flag that has to propagate through every callsite. (See §1, §4, §9.)
- **Long-lived resources (dashboard server) start in `session_start`, not in the factory.** The factory is invoked even when no session starts; the dashboard must be lazy and per-session. (See §1.)
- **Throw to refuse an expensive tool.** A budget-gated `delegate_agent` that hits the cap throws from `execute()` — Pi turns it into an error result for the model. (See §2.)
- **Nested worker `usage` is reported in the tool result.** Without it, session totals are wrong. (See §2.)
- **`tool_call` blocks before execution; `agent_before_settle` ends the run.** Use the right event for the right decision. Use `agent_before_settle` only with `continue: false` — never `true` — to avoid loops. (See §5.)
- **`ctx.signal` for in-turn work; idempotent `session_shutdown`.** Cleanup runs from many paths and must be safe to call repeatedly. (See §6, §8.)
- **Mode-independent behavior.** Budget caps apply in print, JSON, and RPC modes. UI widgets use `setWidget` (RPC-friendly); custom components are TUI-only. (See §7.)
- **Peer dependencies with `"*"` ranges.** `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox` are peers, not bundled deps. (See §10.)

### Patterns the redesign should not violate

- **No `terminate: true` unless the whole batch agrees.** A budget enforcer that sets `terminate: true` on its own tool will be ignored unless every other completed tool in the batch opts in too. (See §2.)
- **No cache-busting `setActiveTools` churn.** Toggling the worker pool every run invalidates the prompt cache. Keep the toolset stable; let budget decisions live in tool results and event handlers. (See §3.)
- **No `custom()` calls outside TUI mode.** `custom()` returns `undefined` in RPC and is not available in print/JSON. Any user-facing budget dialog must guard on `ctx.mode === "tui"`. (See §7.)
- **No silent in-memory counter race.** Parallel tool calls mean two `tool_result` events can fire in any order. The counter cannot be a shared `let` mutated by sibling handlers — it must be a per-call `details` field or a `CustomEntry` that lands at the right point in the tree. (See §8.)
- **No `ctx.shutdown()` on every cap.** `ctx.shutdown()` kills the process; the budget enforcer should refuse the next turn (set `continue: false` from `agent_before_settle`), not the whole process. Reserve `ctx.shutdown()` for "the session itself is over." (See §6.)
- **No asking the model whether the budget allows the next call.** The cap is a code-side constant. Letting the model vote on its own budget cap is a prompt-injection hole. (See §11.)
- **No walking the JSONL linearly to reconstruct state.** "Abandoned branches represent alternative histories." The redesign's `session_start` uses `ctx.sessionManager.getBranch()`. (See §4, §9.)

### Patterns Pi documents that pi-hive currently appears to ignore

These are gaps that a redesign must address:

- **`UsageEntry` for worker-attributed spend.** Pi provides a built-in entry type for exactly this. If pi-hive writes a sidecar JSON file for per-worker usage instead, it is duplicating what the session file already supports and making the data invisible to `/session` totals and the dashboard's session view.
- **`CustomEntry` for cumulative counters.** The `fresh=true` reset bug is most likely a counter that lives in closure or in a mutable variable inside `pi-hive-core`, not in a `CustomEntry` on the active branch. A redesign that uses `CustomEntry` removes the bug class entirely.
- **`ctx.signal` propagation.** If the budget enforcer makes dashboard calls or filesystem writes from inside `tool_call`/`tool_result` handlers, those calls must take `ctx.signal` so Ctrl+C cancels them. The current implementation should be audited for signal propagation.
- **`session_shutdown` cleanup.** The "Do not start processes in the factory" rule plus "Release resources in `session_shutdown`" together imply a teardown hook. If the dashboard child process is started in `session_start`, there must be a matching `session_shutdown` handler that releases it, and it must be idempotent.
- **`project_trust` semantics.** Project-installed pi-hive cannot intercept `project_trust`. Its current opt-in is a config file inside the project; that is the supported pattern and should be documented as such, not advertised as a trust-gate.
- **`tool_call` blocking as the gate primitive.** If the current implementation refuses expensive tools via an in-loop check rather than a `tool_call` handler that returns a block result, the redesign should migrate to the documented primitive.

### Patterns that are ambiguous or under-specified in Pi docs

A small number of behaviors are not nailed down by the docs and the redesign will need to make a defensible call:

- **Compaction `details` shape.** Pi says `details` is "implementation-specific data" for extensions but does not prescribe a schema. The redesign can put anything in `CompactionEntry.details` and `BranchSummaryEntry.details`; documenting the field name (e.g., `budgetSpentBeforeCompaction`) in the project is enough.
- **`UsageEntry.kind` values.** Pi says "Consumers should treat unknown `kind` values as normal usage rather than rejecting them." The redesign can introduce new `kind` values (`"worker_call"`, `"cache_warm_blocked"`, etc.) without coordinating with Pi's internal consumers. This is permission, not a contract.
- **Ordering between extension handlers.** "Handlers run in extension load and registration order." The redesign must control its load order relative to other extensions by managing the load order — there is no priority API.
- **Branch-aware `UsageEntry`.** The docs say usage entries "contribute to session token and cost totals" but do not say whether totals are branch-aware. A redesign that needs strict per-branch accounting must empirically verify and may need a fallback.

These ambiguities should be tracked as known unknowns; they are not blockers for the redesign but they affect how confidently the migration plan can be specified.

---

*End of reference. The patterns above are the source of truth Pi publishes. The redesign options in `refactor-options/` should be evaluated against these constraints, and the migration plan in `refactor-plan/` should be checked against each "follow" and "do not violate" item above before it ships.*

---

## 12. 2026-09-28 online SDK refresh — clarifications and additions

This section captures differences between the locally installed Pi docs (at `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/`, dated Sep 22 per the directory mtime) and the latest online docs at `https://pi.dev/docs/latest/sdk` (fetched 2026-09-28). The two sources are substantively identical; this section records the few clarifications that matter for budget enforcement design.

### 12.1 `steer()` and `followUp()` return values (NEW)

**Source:** online `sdk.md` (not in local `sdk.md`).

The online docs explicitly document the return contract:

> "`steer()` and `followUp()` expose those behaviors directly and return `'queued'` if the input was queued (including after an extension transformed it), or `'handled'` if an extension consumed it."

The local docs only say: "`steer()` and `followUp()` expose those behaviors directly." The return-value contract is new.

#### Application to budget enforcement

A future budget feature that calls `session.steer()` or `session.followUp()` to redirect a worker mid-task (e.g., a budget-aware "switch to cheaper tools" message) must handle the `queued` / `handled` return. If an extension consumed the steered input (the rare `handled` case), the budget layer's subsequent assumption that "the message reached the worker" is wrong. Most budget code should treat `handled` as "the operator (or another extension) took over; abort the budget tracking for this turn."

### 12.2 `session.abort()` vs `session.dispose()` (NEW emphasis)

**Source:** both `sdk.md` versions, but the online version puts them on separate paragraphs for emphasis.

> "`abort()` stops the active operation and waits for the session to become idle. `waitForIdle()` waits without aborting it."
>
> "`session.dispose()` aborts active work, invalidates extension contexts, disconnects from the agent, and removes event listeners. Call it when the session is no longer needed."

The local docs have both quotes but in one paragraph; the online docs separate them.

#### Application to budget enforcement

Three lifecycle primitives, three use cases:

| Primitive | What it does | When to use in budget code |
|---|---|---|
| `runController.abort(reason)` (local `AbortController`) | Cancels the in-progress run; SDK session stays alive | Mid-run budget abort at 0% remaining (`src/engine/dispatch.ts:696`) |
| `session.abort()` | "Stops the active operation and waits for the session to become idle" | Operator-initiated end (`endWorkerSession`, `compactWorkerSession`, `respawnWorkerSession`) — the dispatcher wants the session idle for the next dispatch or `session.compact()` |
| `session.dispose()` | "Aborts active work, invalidates extension contexts, disconnects from the agent, and removes event listeners" | Runtime replacement in `respawnWorkerSession` — currently MISSING. The old session's listener closure leaks because the dispose call is absent. Tracked as Issue 9 in `01-current-state-analysis.md`. |

### 12.3 `agent_settled` vs `agent_end` (NEW emphasis)

**Source:** both `sdk.md` versions, but the online version puts it on its own paragraph.

> "`agent_end` contains the authoritative completed message. `agent_end` marks the end of one low-level agent run, but automatic recovery or queued work can still follow."
>
> "Use `agent_settled` when the host needs to know that Pi will not continue automatically."

#### Application to budget enforcement

The current `agent_end` handler at `src/engine/dispatch.ts:707-714` does final-message text accumulation. For the budget layer's purposes — finalizing counters, emitting `delegation_end`, releasing the worker slot — `agent_settled` is more correct because any post-`agent_end` queued work could also consume budget. The current `dispatchAgent` finalization runs after `session.prompt()` resolves, which is close to `agent_settled` but not identical. Tracked as Issue 8 in `01-current-state-analysis.md`.

### 12.4 `session.systemPrompt` is read-only (confirmed in both)

**Source:** both `sdk.md` versions.

> "`session.systemPrompt` is read-only and returns the current effective system prompt, including changes that have not yet been sent to the model. Tool changes are declared to the model before the next request."

#### Application to budget enforcement

The budget strategy code's `emitBudgetWarning` (`src/engine/budget-strategy.ts:91-117`) mutates `runtime.systemPrompt` to append the strategy hint. **This is NOT a violation of the read-only `session.systemPrompt` contract** — `runtime.systemPrompt` is a field on `AgentRuntime` (`src/core/types.ts:223`), not the SDK accessor. pi-hive's copy is assembled by `buildWorkerPrompt` and passed to `session.prompt(...)`. The mutation never touches the SDK's read-only accessor.

If a future refactor switches to reading `session.systemPrompt` to inject the hint, it will fail because that accessor is read-only. The Pi-documented alternative for extension-side prompt mutation is `pi.sendMessage({...}, {triggerTurn: false, deliverAs: "followUp"})` (CustomMessage) per `extensions.md#work-with-events` (see section 5 above). Tracked in `current-flow/budget-check-flow.md` Key observation 4.