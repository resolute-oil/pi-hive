# Budget config v2: migration guide

This guide covers the **hard cutover** from the flat `worker-budgets` / `team-budgets` config schema to the nested `budgets:` schema. The old format is unsupported the moment you upgrade. There is no deprecation window, no dual-format window, no `schema_version` field. If your project's `hive-config.yaml` or any agent's frontmatter still uses the old keys, the project will fail to load.

The migration is mechanical. Every example below is a literal before/after pair. Run through your config files once, apply the renames, and you're done. Estimated effort: a few minutes per project.

**Removed in:** the release that contains the budget refactor (no earlier version accepted this format; no later version accepts the old format).
**Migration window:** none. Hard cutover per gap-decision G-16.
**Automation:** none. This is a hand migration. There is no `pi-hive migrate-config` command and none is planned for v2.

## Full before/after at a glance

A typical project moves from this shape:

```yaml
# .pi/hive/hive-config.yaml (BEFORE)
settings:
  worker-budgets:
    token-budget: 3500
    token-budget-scope: input_output
    cost-budget-usd: 0.50
    max-runs: 3
    max-delegation-depth: 2
    budget-strategy: compact
    progress-summary-token-limit: 2000
  team-budgets:
    token-budget: 50000
    token-budget-scope: input_output
    cost-budget-usd: 5.00
    max-runs: 20
```

to this shape:

```yaml
# .pi/hive/hive-config.yaml (AFTER)
budgets:
  per-worker:
    tokens:
      cap: 3500
      include: [input, output]
    cost-usd:
      cap: 0.50
    runs:
      cap: 3
    depth:
      cap: 2
  per-team:
    tokens:
      cap: 50000
      include: [input, output]
    cost-usd:
      cap: 5.00
    runs:
      cap: 20
  strategies:
    on-approaching-limit:
      action: wrap-up
      threshold: 0.20
      hint: "Wrap up your work; call summarize_progress when done."
    on-exhaustion:
      action: compact
    summary:
      max-tokens: 2000
```

Per-agent frontmatter moves from `governance:` to `budgets:` (see [Example 3](#example-3-per-agent-frontmatter-governance--budgets)).

## Example 1: Global worker budgets flat → `budgets.per-worker.tokens.cap` (nested)

**Before** (`settings.worker-budgets.token-budget` is a flat key under the `worker-budgets` block):

```yaml
# .pi/hive/hive-config.yaml (BEFORE)
settings:
  worker-budgets:
    token-budget: 3500
    token-budget-scope: input_output
    cost-budget-usd: 0.50
    max-runs: 3
    max-delegation-depth: 2
```

**After** (per the §2.10 nested shape + the G-19 rename from `worker-budgets` to `budgets.per-worker`):

```yaml
# .pi/hive/hive-config.yaml (AFTER)
budgets:
  per-worker:
    tokens:
      cap: 3500
      include: [input, output]
    cost-usd:
      cap: 0.50
    runs:
      cap: 3
    depth:
      cap: 2
```

Notes:

- The top-level key moves from `settings.worker-budgets` to `budgets.per-worker` (the global rename per G-19 + C10 review).
- Each resource becomes a nested object with `cap:` as the only required field.
- `token-budget` becomes `tokens.cap`; `cost-budget-usd` becomes `cost-usd.cap`; `max-runs` becomes `runs.cap`; `max-delegation-depth` becomes `depth.cap` (see Examples 5 and 6).
- `token-budget-scope` becomes `tokens.include: [...]` (see Example 4).

## Example 2: Global team budgets flat → `budgets.per-team.tokens.cap` (nested)

**Before**:

```yaml
# .pi/hive/hive-config.yaml (BEFORE)
settings:
  team-budgets:
    token-budget: 50000
    token-budget-scope: input_output
    cost-budget-usd: 5.00
    max-runs: 20
```

**After** (per the §2.10 nested shape + the global rename):

```yaml
# .pi/hive/hive-config.yaml (AFTER)
budgets:
  per-team:
    tokens:
      cap: 50000
      include: [input, output]
    cost-usd:
      cap: 5.00
    runs:
      cap: 20
```

Notes:

- `team-budgets` is gone; the same shape now lives under `budgets.per-team`.
- Team configs do **not** have a `depth:` key. Depth is a per-worker concept (it limits delegation nesting for an individual worker, not a team total). If your old config set a team-level depth, drop it.
- The default `tokens.include` for teams is `[input, output, cacheRead, cacheWrite, reasoning]` (everything Pi reports). If you want the worker behavior (input + output only), set `include: [input, output]` explicitly.

## Example 3: Per-agent frontmatter `governance:` → `budgets:`

**Before** (`governance:` in an agent's `.pi/hive/agents/<name>.md` frontmatter):

```yaml
---
name: engine-coder
agent-type: coder
model: anthropic/claude-sonnet
thinking: medium
governance:
  token-budget: 1000
  cost-budget-usd: 0.25
  max-runs: 1
  max-delegation-depth: 1
---
```

**After** (`budgets:` replaces `governance:`; each value becomes a nested object per the §2.10 shape):

```yaml
---
name: engine-coder
agent-type: coder
model: anthropic/claude-sonnet
thinking: medium
budgets:
  tokens:
    cap: 1000
  cost-usd:
    cap: 0.25
  runs:
    cap: 1
  depth:
    cap: 1
---
```

Notes:

- The `governance:` frontmatter key is renamed to `budgets:` (per C1). The `governance:` key is no longer accepted anywhere: not in agent frontmatter, not in hive-config, not anywhere.
- The per-agent `budgets:` block does **not** have a `per-worker:` / `per-team:` wrapper. It's already an agent-level override, so the resources sit directly under `budgets:`.
- Omitted keys fall back to the global `budgets.per-worker.<resource>.cap` (and `budgets.per-team.<resource>.cap` for team totals). Same inheritance semantics as the old `governance:` block.

## Example 4: `tokens.scope: input_output` → `tokens.include: [input, output]`

**Before** (`scope:` is a two-value enum):

```yaml
# .pi/hive/hive-config.yaml (BEFORE)
settings:
  worker-budgets:
    token-budget: 3500
    token-budget-scope: input_output
  team-budgets:
    token-budget: 50000
    token-budget-scope: all
```

**After** (`include:` is a list of Pi `Usage` keys, extensible without enum churn, per C2):

```yaml
# .pi/hive/hive-config.yaml (AFTER)
budgets:
  per-worker:
    tokens:
      cap: 3500
      include: [input, output]
  per-team:
    tokens:
      cap: 50000
      include: [input, output, cacheRead, cacheWrite, reasoning]
```

Notes:

- `scope: input_output` becomes `include: [input, output]` (exclude cache hits and extended-thinking tokens).
- `scope: all` becomes the full list `include: [input, output, cacheRead, cacheWrite, reasoning]`. The prior code's `scope: all` counted all five `Usage` dimensions, so the migration preserves that behavior.
- Valid `include` values are the Pi `Usage` keys: `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`. Any other value fails the typebox schema at config-load with a structured error.
- If you omit `include:` entirely, the resolver applies a default: `[input, output]` for `per-worker` and `[input, output, cacheRead, cacheWrite, reasoning]` for `per-team`. These defaults preserve the prior `scope: input_output` / `scope: all` split.

## Example 5: `max-runs` → `runs.cap` (nested shape)

**Before** (flat scalar under `worker-budgets`):

```yaml
# .pi/hive/hive-config.yaml (BEFORE)
settings:
  worker-budgets:
    max-runs: 3
  team-budgets:
    max-runs: 20
```

**After** (each value moves under a `runs:` block with `cap:`):

```yaml
# .pi/hive/hive-config.yaml (AFTER)
budgets:
  per-worker:
    runs:
      cap: 3
  per-team:
    runs:
      cap: 20
```

## Example 6: `max-delegation-depth` → `depth.cap` (G-18 rename)

**Before** (flat scalar under `worker-budgets`):

```yaml
# .pi/hive/hive-config.yaml (BEFORE)
settings:
  worker-budgets:
    max-delegation-depth: 2
```

**After** (moved under a `depth:` block with `cap:`):

```yaml
# .pi/hive/hive-config.yaml (AFTER)
budgets:
  per-worker:
    depth:
      cap: 2
```

Notes:

- `depth:` only exists at the worker level (`budgets.per-worker.depth`). The team-level config has no depth. Depth is a per-worker concept. Drop `max-delegation-depth` from your team budget if it was there.
- The old `max-delegation-depth` key is removed in this release (per G-18). If your config still has it, the typebox schema rejects the whole config with a structured error pointing at the offending path.

## Example 7: `budget-strategy: compact` → `strategies.on-exhaustion.action: compact` (C5)

**Before** (`budget-strategy:` is a flat enum with two values: `default` or `compact`):

```yaml
# .pi/hive/hive-config.yaml (BEFORE)
settings:
  worker-budgets:
    token-budget: 300000
    budget-strategy: compact
    progress-summary-token-limit: 2000
```

**After** (per C5: the flat enum is replaced with a structured `strategies:` block that decouples the warning behavior from the EOL behavior):

```yaml
# .pi/hive/hive-config.yaml (AFTER)
budgets:
  per-worker:
    tokens:
      cap: 300000
  strategies:
    on-approaching-limit:
      action: wrap-up
      threshold: 0.20
      hint: "Wrap up your work; call summarize_progress when done."
    on-exhaustion:
      action: compact
    summary:
      max-tokens: 2000
```

Mapping of the old enum values to the new structure:

| Old `budget-strategy` | New `strategies.on-approaching-limit.action` | New `strategies.on-exhaustion.action` |
|---|---|---|
| `default` | `wrap-up` | `abort` |
| `compact` | `wrap-up` | `compact` |

Notes:

- `progress-summary-token-limit: 2000` becomes `strategies.summary.max-tokens: 2000`.
- The `strategies:` block is optional. If you omit it, the runtime falls back to the legacy `default` strategy (warn at 20%, abort at 0%).
- `on-approaching-limit.action` accepts `wrap-up`, `compact`, or `none`. `threshold` is a fraction (0.0–1.0) of the remaining budget at which the warning fires. `hint` is the text injected into the worker's prompt.
- `on-exhaustion.action` accepts `compact`, `abort`, or `none`. `custom-instructions` is optional and is used as the compaction prompt when `action: compact`.

## Example 9: Add a `context` cap (the LLM's current view)

The `context` cap is a separate constraint from the existing `tokens` cap. They measure different resources:

- `tokens` — cumulative session cost (input + output + cacheRead + cacheWrite + reasoning, scoped by the `include` list).
- `context` — what the LLM is currently looking at (the SDK's `ContextUsage.tokens`). A worker can have a low cumulative `tokens` count but be at 95% of its context window (because cache hits kept the cumulative low but the conversation is long). The `context` cap catches this; the `tokens` cap doesn't.

Set exactly one of `tokens:` (nominal) or `percent:` (fill on the 0–100 scale) — not both, not neither.

### 9a. Nominal tokens cap (stop at 100K tokens of context)

```yaml
# .pi/hive/hive-config.yaml
budgets:
  per-worker:
    context:
      tokens: 100_000   # stop when getContextUsage().tokens >= 100K
```

### 9b. Percentage cap (stop at 80% of the context window)

```yaml
# .pi/hive/hive-config.yaml
budgets:
  per-worker:
    context:
      percent: 80       # 80% of the context window (0–100 scale, NOT 0–1)
```

### 9c. Both `tokens` and `context` set (they are NOT collapsed into a single cap)

```yaml
# .pi/hive/hive-config.yaml
budgets:
  per-worker:
    tokens:
      cap: 3500
      include: [input, output]
    context:
      tokens: 100_000
```

When both are set, the worker is blocked when EITHER fires. The `include` list does NOT apply to `context` (the SDK's `getContextUsage().tokens` is a single coherent number — including the `include` list would be double-counting).

### 9d. Per-dimension exhaustion strategies

By default `onExhaustion.action` applies to BOTH dimensions (the global default). To set different strategies for tokens and context, use `onTokenExhaustion` and `onContextExhaustion` as overrides:

```yaml
# .pi/hive/hive-config.yaml
budgets:
  per-worker:
    tokens: { cap: 3500 }
    context: { tokens: 100_000 }
  strategies:
    on-approaching-limit:
      action: wrap-up
      threshold: 0.20
      hint: "Wrap up your work; call summarize_progress when done."
    on-exhaustion:
      action: abort          # global default
    on-token-exhaustion:
      action: abort          # explicit override for tokens
    on-context-exhaustion:
      action: compact        # auto-compact when context fills
    summary:
      max-tokens: 2000
```

The `interventionAvailable` flag is computed per-dimension: a worker in `tokens: abort, context: compact` mode has `interventionAvailable: true` for the token warning (operator can still rescue on the token side) and `false` for the context warning (system handles it). Each `budget_warning` event payload carries the flag for the dimension that fired.

### 9e. Additive guarantee (no breaking changes)

A config WITHOUT `context:` keeps working unchanged. The validator accepts the pre-wave shape; the resolver returns a policy without `worker.context` / `team.context`; the pre-flight gate and tool-call handler skip the context check when the field is absent. The existing `tokens` cap is untouched.

```yaml
# .pi/hive/hive-config.yaml (pre-wave config — still valid, no migration needed)
budgets:
  per-worker:
    tokens: { cap: 3500 }
  # no `context:` → no context constraint
```

## Example 8: `worker-budgets.queue` removed (per §2.15)

If you previously set `worker-budgets.queue`, remove it from your config. Queue depth is now visible via the SDK's `queue_update` event. It is no longer tracked as a budget resource.

```yaml
# .pi/hive/hive-config.yaml (BEFORE)
settings:
  worker-budgets:
    queue: 10
```

```yaml
# .pi/hive/hive-config.yaml (AFTER)
budgets:
  per-worker: {}
```

The `queue:` field was never enforced as a budget cap in the prior code (no test pinned it, per the coverage analysis in the refactor review). If you need queue length gating in the future, it will be a separate feature backed by the SDK's `queue_update` event listener, not a budget resource.

## The hard cutover (no deprecation window)

This is a **hard cutover** (per gap-decision G-16 in the refactor review):

- **No deprecation timeline.** The old format is unsupported the moment you upgrade. There is no `deprecation: true` flag, no warning-on-load, no grace period.
- **No dual-format window.** A config that mixes old (`worker-budgets:`) and new (`budgets:`) keys is rejected. Only the new schema parses.
- **No `schema_version` field.** There is no version negotiation. The only accepted schema is the v2 schema above.
- **No automatic migration.** There is no `pi-hive migrate-config` command, no auto-rewrite on load, no comment-preserving converter. You edit `hive-config.yaml` and any agent frontmatter by hand.
- **No telemetry deprecation event.** Nothing is emitted to telemetry to alert you that you have old keys. Config-load just fails with a structured error pointing at the offending path.

If your config has any old key (`worker-budgets:`, `team-budgets:`, `governance:`, `token-budget:`, `token-budget-scope:`, `cost-budget-usd:`, `max-runs:`, `max-delegation-depth:`, `budget-strategy:`, `progress-summary-token-limit:`, or `queue:`), the config-load throws and the project does not start. Fix the config and reload. There's no other path.

## What this example adds (and what it does NOT change)

The `context` cap is **purely additive**. The pre-existing `tokens` cap is untouched, and configs that don't set `context:` keep working unchanged. Do not consolidate `tokens` and `context` into a single "spend" cap — they measure different resources (cumulative cost vs LLM current view) and the user explicitly wants them as separate constraints.

## Rollback instructions

If the new schema breaks your project in a way you cannot fix in the moment, you can revert to the prior code via git.

### Option A: revert the refactor commit(s)

```sh
# Find the refactor PR's merge commit
git log --oneline -20
# Identify the merge commit for the budget refactor (look for "feat(refactor): budget config v2" or similar)

# Revert it
git revert -m 1 <merge-commit-sha>

# Restore your old hive-config.yaml (it was not touched by the refactor)
# Your previous config files are still in your working tree or your last commit.
# If you committed the migration edits, revert those edits in a separate commit.

git commit -m "revert: budget config v2 (temporarily)"
```

After the revert, your old `worker-budgets:` config works as it did before. The refactor PR is reverted wholesale, with no half-applied state.

### Option B: switch branches

If the refactor is on its own branch (typical for a multi-PR refactor):

```sh
git checkout main
npm install
```

`main` is the last commit before the refactor landed. Your old config is accepted there.

### What the rollback does **not** do

- The rollback does **not** rewrite your config. If you already migrated to the new format, you must hand-edit it back to the old keys before the rollback is useful.
- The rollback does **not** preserve any behavior added by the refactor (the new `strategies:` block, the per-agent `budgets:` key, the structured warning emission). You get the prior code's behavior verbatim.
- The rollback does **not** restore PR #54 (the prior `feat/budget-strategy` work). PR #54 was already closed in favor of the refactor (per `04-refactor-plan.md` §6.2).

If you find a real bug in the new schema, **report it before reverting**. The refactor ships with structured validation errors at config-load, so most "the new schema broke me" reports turn out to be specific keys you missed during the migration. The schema points at the offending path.

## Validation errors you may see

If you miss a key during migration, the schema validator surfaces the offending path. The errors look like this (format may vary slightly by release):

```
Error: hive-config.yaml.budgets.per-worker.tokens.cap must be a finite number
Error: hive-config.yaml.settings.worker-budgets.token-budget is no longer accepted;
  rename to budgets.per-worker.tokens.cap
Error: .pi/hive/agents/engine-coder.md frontmatter.governance is no longer accepted;
  rename to budgets
Error: hive-config.yaml.budgets.per-worker.tokens.include[0] must be one of
  input, output, cacheRead, cacheWrite, reasoning
Error: hive-config.yaml.budgets.strategies.on-approaching-limit.threshold must be
  between 0 and 1
```

The error always includes the exact YAML path to the offending field. Use it to find and fix the key.

## Field reference (new schema)

For quick lookup, here is every field in the new `budgets:` block:

| Field | Type | Where | Notes |
|---|---|---|---|
| `budgets.defaults-enabled` | boolean | top-level | Not implemented in v2 (C3 dropped per G-16). Reserved for a future release. |
| `budgets.per-worker.tokens.cap` | number ≥ 0 | worker | Per-worker token cap |
| `budgets.per-worker.tokens.window` | enum | worker | `per-session` (default), `per-run`, `per-day`, `per-team-lifetime` |
| `budgets.per-worker.tokens.include` | list of `Usage` keys | worker | Defaults to `[input, output]` |
| `budgets.per-worker.cost-usd.cap` | number ≥ 0 | worker | Per-worker USD cap |
| `budgets.per-worker.cost-usd.window` | enum | worker | `per-session` (default) or `per-team-lifetime` |
| `budgets.per-worker.runs.cap` | number ≥ 0 | worker | Max runs per worker |
| `budgets.per-worker.depth.cap` | number ≥ 0 | worker | Max delegation depth per worker |
| `budgets.per-team.tokens.cap` | number ≥ 0 | team | Per-team token cap |
| `budgets.per-team.tokens.window` | enum | team | `per-team-lifetime` (default), `per-session`, `per-run`, `per-day` |
| `budgets.per-team.tokens.include` | list of `Usage` keys | team | Defaults to `[input, output, cacheRead, cacheWrite, reasoning]` |
| `budgets.per-team.cost-usd.cap` | number ≥ 0 | team | Per-team USD cap |
| `budgets.per-team.cost-usd.window` | enum | team | `per-team-lifetime` (default) or `per-session` |
| `budgets.per-team.runs.cap` | number ≥ 0 | team | Max runs per team |
| `budgets.per-worker.context.tokens` | number ≥ 0 | worker | Nominal cap on the LLM's current context (the SDK's `getContextUsage().tokens`); stop when fill >= cap |
| `budgets.per-worker.context.percent` | 0 ≤ n ≤ 100 | worker | Percentage cap on the context window; stop when `(ctx.tokens / ctx.contextWindow) * 100 >= percent` |
| `budgets.per-team.context.tokens` | number ≥ 0 | team | Nominal cap on team-level context (resolver passes through; enforcement is per-worker) |
| `budgets.per-team.context.percent` | 0 ≤ n ≤ 100 | team | Percentage cap on team-level context |
| `budgets.strategies.on-token-exhaustion.action` | enum | strategies | `compact`, `abort`, or `none` (overrides `on-exhaustion.action` for tokens) |
| `budgets.strategies.on-context-exhaustion.action` | enum | strategies | `compact`, `abort`, or `none` (overrides `on-exhaustion.action` for context) |
| `budgets.strategies.on-approaching-limit.action` | enum | strategies | `wrap-up`, `compact`, or `none` |
| `budgets.strategies.on-approaching-limit.threshold` | 0 ≤ n ≤ 1 | strategies | Fraction of remaining budget that triggers the warning |
| `budgets.strategies.on-approaching-limit.hint` | string | strategies | Text injected into the worker's prompt on warning |
| `budgets.strategies.on-exhaustion.action` | enum | strategies | `compact`, `abort`, or `none` |
| `budgets.strategies.on-exhaustion.custom-instructions` | string? | strategies | Compaction prompt when `action: compact` |
| `budgets.strategies.summary.max-tokens` | number ≥ 0 | strategies | Token cap for `summarize_progress` notes |

## Field reference (old schema, for find-and-replace)

Every old key, mapped to its new home. Use `grep -rn` with these patterns to find any leftover old keys in your project:

| Old key | New key |
|---|---|
| `settings.worker-budgets.token-budget` | `budgets.per-worker.tokens.cap` |
| `settings.worker-budgets.token-budget-scope` | `budgets.per-worker.tokens.include` (list) |
| `settings.worker-budgets.cost-budget-usd` | `budgets.per-worker.cost-usd.cap` |
| `settings.worker-budgets.max-runs` | `budgets.per-worker.runs.cap` |
| `settings.worker-budgets.max-delegation-depth` | `budgets.per-worker.depth.cap` |
| `settings.worker-budgets.budget-strategy` | `budgets.strategies.on-approaching-limit.action` + `budgets.strategies.on-exhaustion.action` |
| `settings.worker-budgets.progress-summary-token-limit` | `budgets.strategies.summary.max-tokens` |
| `settings.worker-budgets.timeout-ms` | (removed. The new budget system does not gate runs by wall-clock; use operator intervention to end stuck sessions.) |
| `settings.worker-budgets.distiller-runs` | (removed. The per-worker distiller-run cap is not carried into v2. The team-level `runs.cap` is the closest analog, but its semantics apply to a different run set.) |
| `settings.worker-budgets.queue` | (removed per §2.15) |
| `settings.team-budgets.token-budget` | `budgets.per-team.tokens.cap` |
| `settings.team-budgets.token-budget-scope` | `budgets.per-team.tokens.include` (list) |
| `settings.team-budgets.cost-budget-usd` | `budgets.per-team.cost-usd.cap` |
| `settings.team-budgets.max-runs` | `budgets.per-team.runs.cap` |
| `<agent>.governance.*` (frontmatter) | `<agent>.budgets.*` (frontmatter, nested) |
