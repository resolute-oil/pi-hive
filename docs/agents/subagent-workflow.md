# Subagents in this project

> **For future sessions:** `@tintinweb/pi-subagents` is installed globally in this environment and is loaded by Pi on every session. The `Agent` and `SubagentWorkflow` tools are available to you. Use them — they are first-class for parallelizable, isolated, well-scoped work. This document explains how.

## What this is

`pi-subagents` is the global Pi extension that gives you Claude Code-style autonomous sub-agents. You can spawn a subagent with one tool call, it runs in its own session with its own tools and model, and you can monitor, steer, and resume it from this conversation.

It is **complementary** to this project's own delegation model (`pi-hive` orchestrator → leads → members). The two are not the same system:

| | `pi-subagents` (this doc) | `pi-hive` |
|---|---|---|
| Activation | Always loaded (global package) | Only when `.pi/hive/hive-config.yaml` exists in the project |
| Topology | Flat spawns from any session | Hierarchical tree with policy-enforced delegation |
| Lifecycle | You spawn / steer / resume | Hive config declares the team; cycle modes with `Ctrl+Alt+T` |
| Best for | Ad-hoc exploration, one-off parallel work, scripts | Project-shaped multi-agent work with spec → execute flow |

This project does not currently opt into pi-hive mode (no `hive-config.yaml`), so for the work you actually do here, `pi-subagents` is the only delegation mechanism you have.

## When to reach for it

Use a subagent when **all** of these hold:

- The task is well-scoped and can be described in one prompt.
- It can run with a narrower tool set than your full session (e.g. read-only research).
- It does not need the running context of this conversation.
- Parallelizing it would actually save wall-clock time or isolate risk.

Do **not** use a subagent when:

- You only need to read a single file or run a single command — just do it.
- The work needs iterative back-and-forth with the user (the subagent is on its own).
- The task depends on facts established earlier in *this* conversation's turns.
- The task would only take one or two tool calls; the spawn/result overhead is not worth it.

A useful rule of thumb: if you can write the entire prompt in one paragraph and the result is a self-contained answer, it's a subagent candidate. If it would take five follow-up turns from you to converge, do it yourself.

## Quick start

Spawn one in a single tool call:

```
Agent({
  subagent_type: "Explore",
  prompt: "Find every file under src/agents/ that registers a custom command. List each path and the command name.",
  description: "Find custom command registrations",
  run_in_background: true,
})
```

You get back an `agent_id` immediately. The agent runs in the background and you receive a structured `<task-notification>` when it finishes, with a result preview and the path to the full transcript. To pull the full output instead of the preview, use `get_subagent_result(agent_id)`.

For blocking calls (you need the answer before your next move), pass `run_in_background: false`. The tool call waits and returns the agent's full output inline.

## Default agent types

Three built-in types are always available:

| Type | Tools | Model | Use for |
|---|---|---|---|
| `general-purpose` | All seven (read, bash, grep, find, ls, edit, write) | Inherits your model | Anything your main session can do, but isolated |
| `Explore` | read, bash, grep, find, ls | Haiku (falls back to inherit) | Fast read-only codebase exploration |
| `Plan` | read, bash, grep, find, ls | Inherits your model | Implementation planning, design docs |

`Explore` is the right default for research: it's read-only, fast, and uses a cheap model. `Plan` is for tasks where you want a structured plan before any work. `general-purpose` is for anything that needs to mutate or run commands — it's a parent twin, so it inherits your system prompt and project conventions.

All three can be **overridden** by dropping a same-named `.md` file under `.pi/agents/` (project) or `~/.pi/agent/agents/` (global), or **disabled** per-project with `enabled: false` in frontmatter.

## The Agent tool

Full schema:

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `prompt` | string | yes | — | The task. Write it as if to a capable agent with no other context. |
| `description` | string | yes | — | 3–5 word summary; appears in the widget, FleetView, and notifications. |
| `subagent_type` | string | yes | — | Built-in (`general-purpose`, `Explore`, `Plan`) or a custom agent name. |
| `run_in_background` | bool | no | `true` | `false` blocks until the agent finishes and returns its full output inline. |
| `name` | string | no | — | Memorable alias; the agent is then addressable as `@name` in addition to its type-derived handle. |
| `model` | string | no | inherit | `provider/modelId` or fuzzy name (`"haiku"`, `"sonnet"`). |
| `thinking` | enum | no | inherit | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `resume` | string | no | — | An `agent_id` from a finished session — continues it from disk rather than starting fresh. |
| `isolated` | bool | no | `false` | No extensions, no skills, no inherited context. Built-in tools only. |
| `isolation` | enum | no | — | `"worktree"` runs the agent in an isolated git worktree; its changes are auto-committed to a branch on completion. |
| `inherit_context` | bool | no | `false` | Fork this conversation's messages into the agent's session. |
| `max_turns` | number | no | unlimited | Hard cap with a graceful wrap-up warning before abort. Set it for bounded dummy tasks. |

The tool returns immediately with `agent_id`, the agent type, a short description, the transcript path, and a hint that you can use `get_subagent_result` or `steer_subagent` to interact further.

### Background vs foreground

Default to background (`run_in_background: true`). The agent runs concurrently with whatever you do next; you get a notification when it finishes. This is how you parallelize.

Use foreground (`run_in_background: false`) only when the next thing you say to the user depends on the agent's output. Foreground agents block the conversation, so spawning three of them sequentially is the same wall-clock cost as running them in parallel and waiting for all three.

## Monitoring and interaction

### Above-editor widget

While agents are running, a widget above your input shows live status: spinner, description, turn count (`↻N`), tool uses, token count, context-window percentage, and elapsed time. By default it shows background agents only — foreground ones already render their full result inline.

### FleetView

Below the editor, when the prompt is empty, press `↓` (or `←`) to jump into a Claude Code-style list of every running agent and the main session. The selected row opens its live, auto-updating conversation overlay on `Enter`. `Esc` returns to the prompt. While the overlay is open:

- `Enter` opens a composer for sending a steering message to a running one.
- `x` (then `x`) stops a running agent.

### Agent mentions (`@handle`)

Every agent has a typeable handle — lowercase type name, numbered when instances collide (`explore`, `explore-2`). At your prompt, type `@` to see suggestions covering:

- **Live agents** — message them.
- **Finished agents with disk sessions** — resume them.
- **Startable agent types** — spawn a fresh one.

The mention routes to whichever state the agent is in. `@<agent-id>` and `@agent-<type>` both work as synonyms. `@main` is reserved for the main model. A leading `@` is the only form that routes; `@explore is great` in the middle of a sentence goes to the main model.

For `@` to start a fresh agent from a mention, the extension uses `model` mode by default: it clones the current conversation off-screen, the clone writes a context-rich prompt, and the agent starts with full context. There is no visible turn in your chat.

## Mid-run steering

Inject a message into a running agent to redirect it without restarting:

```
steer_subagent({
  agent_id: "<id>",
  message: "Stop the search there — also include any tests covering those files.",
})
```

The message appears as a user message in the agent's session and the agent picks it up after its current tool finishes. Steering is the right tool when the agent is on the right track but missing a constraint, not when it's gone off the rails — for the latter, `x` from the FleetView overlay.

## Session resume

Every finished agent writes a persisted session. Pass its `agent_id` to `resume`:

```
Agent({
  resume: "<id-from-previous-run>",
  prompt: "Also check src/integration/.",
  description: "Continue the exploration",
  run_in_background: true,
})
```

The agent picks up where it left off with full conversation context. You can resume an agent weeks later — the file lives on disk under the agent's session directory.

## Custom agents

Define project-specific agents under `.pi/agents/<name>.md` (project) or `~/.pi/agent/agents/<name>.md` (global). Frontmatter configures scope and behavior; the markdown body is the system prompt.

Minimal example — a read-only security auditor:

```markdown
---
color: red
description: Security-focused code reviewer
tools: read, grep, find, bash
model: anthropic/claude-sonnet-4-6
thinking: high
max_turns: 30
---

You are a security auditor. Review code for vulnerabilities including:
- Injection flaws (SQL, command, XSS)
- Auth/authz issues
- Sensitive data exposure
- Insecure configurations

Report findings with file paths, line numbers, severity, and remediation advice.
```

Spawn it like any built-in:

```
Agent({
  subagent_type: "security-auditor",
  prompt: "Audit the auth module under src/agents/auth/.",
  description: "Audit auth module",
  run_in_background: true,
})
```

Discovery precedence (highest wins):

1. `.pi/agents/<name>.md` (project — authoritative; where the `/agents` menu writes)
2. `.agents/agents/<name>.md` (project — cross-tool workspace convention)
3. `~/.pi/agent/agents/<name>.md` (global)

Project overrides global; if both project locations define the same name, `.pi/agents/` wins. Two files claiming the same `name:` (frontmatter) — the later load wins, matching filename-clash behavior.

### Frontmatter reference

| Field | Default | What it does |
|---|---|---|
| `name` | filename | The agent's type identifier — what `subagent_type` and `@handle` address. |
| `display_name` | the type | Cosmetic label in the UI. |
| `description` | filename | One-line description in tool listings. |
| `color` | — | Badge color in tool headers, widget, FleetView. Named (`red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink`, `cyan`) or `"#RRGGBB"`. |
| `tools` | all 7 | Built-in tool allowlist. Comma-separated names, `*`/`all`, `none`, or `ext:<extension>` / `ext:<extension>/<tool>` for extension tools. |
| `extensions` | `true` | Which extensions load. `true` (all), `false` (none), or an explicit list (`[mcp, "*", "/abs/path.ts"]`). |
| `exclude_extensions` | — | Extension denylist applied after `extensions:`. Plain names only. |
| `skills` | `true` | `true` inherits; comma list preloads only those. |
| `memory` | — | `project`, `local`, or `user` for persistent agent memory. Read-only agents get read-only auto-detection. |
| `disallowed_tools` | — | Comma-separated denylist applied after `tools:` and extension loading. |
| `isolation` | — | `"worktree"` to run in an isolated git worktree; `"off"` to refuse one even when callers pass it. |
| `model` | inherit | `provider/modelId` or fuzzy (`"haiku"`, `"sonnet"`). Resolved tolerantly; falls back across providers. |
| `thinking` | inherit | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `max_turns` | unlimited | Hard cap with a graceful wrap-up before abort. |
| `persist_session` | `rememberAgents` | Override the project's `rememberAgents` default for this agent. |
| `output_transcript` | `true` | Write this agent's `.output` transcript. `false` writes nothing. |
| `session_dir` | pi default | Optional session directory when `persist_session: true`. |
| `allowed_subagents` | none | Opt into nested `Agent`, `get_subagent_result`, `steer_subagent` for this agent's children. Comma list, `all`, or omit for none. |
| `prompt_mode` | `replace` | `replace` swaps the parent's prompt; `append` adds the body on top of the parent's prompt (the `general-purpose` default). |
| `inherit_context` | `false` | Fork this conversation into the agent. |
| `run_in_background` | — | Pin this agent to background or foreground. Omit to follow `backgroundByDefault`. |
| `isolated` | `false` | Hermetic: no extensions, no skills, no inherited context. Built-ins only. |
| `enabled` | `true` | `false` to disable the agent (e.g. hiding a built-in per-project). |

Frontmatter is authoritative. If an agent file sets `model`, `thinking`, `max_turns`, `inherit_context`, `run_in_background`, `isolated`, or `isolation`, those values are locked for that agent. Caller-supplied parameters only fill fields the agent config leaves unspecified.

### Tool and extension scoping

`extensions:` decides **which extensions load**; `tools:` decides **which tools surface to the LLM**. They compose:

```yaml
# Default: all extensions load, all seven built-ins surface
tools: read, grep, find                # narrow to listed built-ins; extensions still load
tools: "*"                             # all seven built-ins (alias: `all`)
tools: none                            # zero built-ins (alias: `""`)
tools: "*, ext:mcp/search"             # built-ins plus one extension tool

extensions: false                      # no extensions load
extensions: [mcp]                      # only mcp loads
extensions: ["*", "/abs/foo.ts"]       # all defaults plus one path-loaded extension
exclude_extensions: pi-notify          # everything except pi-notify (with extensions: true)

isolated: true                         # hermetic: built-ins only, no extensions/skills/context
```

Plain `tools:` typos fail loudly with `tools-error:…`. `exclude_extensions:` wins over both `extensions:` and `ext:` selectors.

## SubagentWorkflow (deterministic scripts)

When the *number* of agents depends on something discovered at runtime — fan out over a file list, verify each finding before reporting — use the `SubagentWorkflow` tool. It runs a JavaScript script that calls `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, and `args`.

```
SubagentWorkflow({
  script: `
    export const meta = {
      name: 'auth-audit',
      description: 'Find routes missing auth checks, then verify each finding',
      phases: [{ title: 'Scan' }, { title: 'Audit' }],
    }

    phase('Scan')
    const listing = await agent('List every route file under src/routes/. One path per line.')
    const files = listing.split('\n').map(s => s.trim()).filter(Boolean)
    log('auditing ' + files.length + ' files')

    phase('Audit')
    return await pipeline(
      files,
      file => agent(\`Audit \${file} for missing auth checks.\`, { label: \`audit:\${file}\` }),
      (found, file) => agent(\`Try to REFUTE this finding about \${file}: \${found}\`, { label: \`verify:\${file}\` }),
    )
  `,
})
```

The tool returns a `task_id` immediately; the run continues in the background and notifies on completion. Each `agent()` spawns a real subagent with its own context window and tools — the script itself has no filesystem or network access.

Use the `Agent` tool for one delegated task or a handful you can name up front. Reach for `SubagentWorkflow` when:

- The number of agents depends on something discovered at runtime.
- Work flows through stages with verification between them.
- You want findings independently verified before you believe them.

Three things to know about the script:

- The script must begin with `export const meta = { name, description }`.
- It runs in a `node:vm` sandbox on a worker thread. `Date.now()`, `Math.random()`, and `eval` throw.
- The script is written to disk in your temp directory; to iterate, edit the file and re-call `SubagentWorkflow` with `scriptPath`.

### `pipeline()` vs `parallel()`

`pipeline(items, stage1, stage2, ...)` runs each item through all stages independently — **no barrier between stages**. Item A can be in stage 3 while item B is still in stage 1. Wall-clock equals the slowest single-item chain.

`parallel(thunks)` is a barrier: it waits for all thunks before returning. Use it only when a stage genuinely needs every prior-stage result (e.g. dedup before an expensive verification step).

For most "fan out and verify" workflows, `pipeline()` is what you want.

### Verifying with `gate`

`agent()` accepts a `gate: "<command>"` option that runs the command after the agent finishes. A non-zero exit fails the agent; the script can retry it. This is stronger than asking another LLM whether the fix worked — for tasks with a runnable check (tests, lint, typecheck), prefer gating over re-reviewing.

```js
let fixed = await agent('Find and fix the failing test.', { label: 'fix', gate: 'npm test' })
if (fixed === null) {
  fixed = await agent('`npm test` is still failing. Fix the cause.', { label: 'fix', resume: 'fix' })
}
```

## Settings

Project-wide configuration lives in `subagents.json` at the project root:

```json
{
  "rememberAgents": true,
  "backgroundByDefault": true,
  "widgetMode": "background",
  "outputTranscript": true,
  "maxConcurrent": 10,
  "maxSubagentDepth": 2,
  "fallbackSubagent": "general-purpose",
  "workflowsEnabled": true
}
```

The most-used keys:

- `rememberAgents` (default `true`) — persist agent sessions to disk for later resume.
- `backgroundByDefault` (default `true`) — the default for `run_in_background`.
- `widgetMode` (`"background"` / `"all"` / `"off"`) — what the above-editor widget shows.
- `outputTranscript` (default `true`) — write `.output` transcripts per agent.
- `maxConcurrent` (default `10`) — session-wide concurrency cap.
- `maxSubagentDepth` (default `2`) — max nesting depth for `allowed_subagents`.
- `fallbackSubagent` (`"general-purpose"` or `"none"`) — what to use when a `subagent_type` doesn't resolve to exactly one enabled agent.
- `workflowsEnabled` (default `true`) — whether the `SubagentWorkflow` tool is registered.

Settings also live at `~/.pi/agent/subagents.json` (global) and can be edited from `/agents → Settings`.

## Common patterns

### Parallel exploration

```js
const [tree, deps, tests] = await Promise.all([
  Agent({ subagent_type: "Explore", prompt: "Map src/ into a tree.", description: "Map source tree", run_in_background: true }),
  Agent({ subagent_type: "Explore", prompt: "List every runtime dependency and where it's used.", description: "Map runtime deps", run_in_background: true }),
  Agent({ subagent_type: "Explore", prompt: "Find every test file and what it covers.", description: "Map test coverage", run_in_background: true }),
])
```

Three concurrent reads, one wall-clock.

### Long-running dummy tasks for testing

Bounded sleeps that exercise the widget/FleetView without doing real work:

```
Agent({
  subagent_type: "general-purpose",
  prompt: "Run `sleep 45 && date -u +%FT%TZ` with bash and report the timestamp. Nothing else.",
  description: "Sleep 45 then report time",
  run_in_background: true,
  max_turns: 5,
})
```

Always set `max_turns` on dummy tasks so a failure in the sleep can't loop forever.

### Resume a finished agent

```
Agent({
  resume: "<id-from-previous-finish>",
  prompt: "Also check the integration tests.",
  description: "Continue exploration",
  run_in_background: true,
})
```

### Stop a misbehaving agent

From the FleetView overlay, press `x` then `x` to confirm. From the tool surface, the agent's own session shutdown on stop is graceful — it gets a wrap-up warning before hard abort.

## Things to avoid

- **Spawning an agent for a one-tool-call task.** The spawn overhead exceeds the savings.
- **Setting `inherit_context: true` for a fresh agent.** You'll fork the entire conversation into the new session, often for no reason.
- **Forgetting `max_turns` on long tasks.** Without it, an agent that gets stuck can run until the wall-clock budget is gone.
- **Trusting fallthrough subagent types.** An unknown `subagent_type` falls back to `general-purpose` by default (or is refused under `fallbackSubagent: "none"`). Verify the type actually exists — a typo silently routes to the wrong agent.
- **Pushing the same work twice.** Background completions arrive via `<task-notification>`; the extension tells you explicitly "Do not duplicate this agent's work."
- **Steering after the agent has already finished.** Steering messages to a finished agent are refused; use `resume` instead.

## Where this leaves data

- **Transcript files** — `<os-tmpdir>/pi-subagents-<uid>/<cwd-hash>/<session-id>/tasks/<agent-id>.output`. Owner-only `0700`. Cleared on reboot.
- **Persisted sessions** — written under pi's normal session location when `rememberAgents` is true (the default). Visible in `/resume`.
- **Schedules** — `<cwd>/.pi/subagent-schedules/<session-id>.json`. Session-scoped; restored on `/resume`, reset on `/new`.

## Pointers

- Upstream docs: `~/.pi/agent/npm/node_modules/@tintinweb/pi-subagents/README.md` — the canonical reference, ~50KB / 1000 lines. This document is the project-oriented subset.
- Workflow docs: `~/.pi/agent/npm/node_modules/@tintinweb/pi-subagents/docs/workflows.md` — full guide to `SubagentWorkflow`, the runtime model, and the inspector UI.
- RPC docs: `~/.pi/agent/npm/node_modules/@tintinweb/pi-subagents/docs/rpc.md` — cross-extension RPC for spawning/stopping from other extensions.

For exhaustive parameter tables and edge cases, read the upstream README. For project conventions and patterns specific to this codebase, this document is the primary reference.