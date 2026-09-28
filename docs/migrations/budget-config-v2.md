# Budget config v2 — migration guide

The budget refactor (Wave 1) restructures the resource-governance section of `hive-config.yaml` and each agent's `.md` frontmatter. If your project has no `worker:` / `team-budgets:` block under `settings:` and no `governance:` block in any agent's frontmatter, the refactor is a no-op.

## Hard cutover — what changed

There is **no dual-format support**, no `schema_version` field, no deprecation telemetry, no automatic conversion. The first release that ships the refactor accepts **only** the v2 shape. If `hive-config.yaml` still uses the v1 form, the loader rejects it at startup with a path-aware error. Edit the file by hand (decision G-16).

`settings.worker.*` and `settings.team-budgets.*` are gone. The new top-level key is `budgets:` with `per-worker:` and `per-team:` sub-blocks. Flat keys (`token-budget`, `cost-budget-usd`, `max-runs`, `max-delegation-depth`) become nested `{ cap: N }` objects under the matching resource (`tokens`, `cost-usd`, `runs`, `depth`). `governance:` in agent frontmatter is renamed to `budgets:`. `tokens.scope` becomes `tokens.include`. A new optional `window:` field makes the time period explicit.

> **`worker.timeout-ms` and `worker.distiller-runs`** stay where they are — they are not budget keys. Only `max-runs`, `token-budget`, `cost-budget-usd`, `max-delegation-depth` move.

Everything else (`shared_context`, `settings.subagent-output-limit`, `hive:`, `planning:`, `telemetry:`, `distiller:`) is unchanged.

## Detailed migrations

### 1. Simple worker budget

**Before** (v1):

```yaml
settings:
  worker:
    token-budget: 3500
```

**After** (v2):

```yaml
budgets:
  per-worker:
    tokens: { cap: 3500, window: per-session, include: [input, output] }
```

The default `window:` and `include:` values match v1's implicit behavior — you can omit them.

### 2. Team budget

**Before** (v1):

```yaml
settings:
  team-budgets:
    max-runs: 100
    token-budget: 5000000
    cost-budget-usd: 100
```

**After** (v2):

```yaml
budgets:
  per-team:
    tokens:  { cap: 5000000, window: per-team-lifetime, include: [input, output, cacheRead, cacheWrite] }
    cost-usd: { cap: 100,      window: per-team-lifetime }
    runs:    { cap: 100 }
```

### 3. Multiple caps (tokens + cost + runs)

Capping tokens, USD cost, and run count together — the common case.

**Before** (v1):

```yaml
settings:
  worker:
    token-budget: 1000000
    cost-budget-usd: 25
    max-runs: 20
```

**After** (v2):

```yaml
budgets:
  per-worker:
    tokens:  { cap: 1000000, window: per-session, include: [input, output] }
    cost-usd: { cap: 25,       window: per-session }
    runs:    { cap: 20 }
```

Each resource is its own object. The validator accepts only the four resource names (`tokens`, `cost-usd`, `runs`, `depth`).

### 4. The `include:` list (replacing `scope`)

Replaces `tokens.scope: input_output | all` with an explicit list of Pi `Usage` keys.

**Before** (v1):

```yaml
settings:
  worker:
    token-budget: 3500
    token-budget-scope: input_output   # counts input + output, not cache
  team-budgets:
    token-budget: 50000
    token-budget-scope: all            # counts everything
```

**After** (v2):

```yaml
budgets:
  per-worker:
    tokens:
      cap: 3500
      window: per-session
      include: [input, output]                              # matches v1 "input_output"
  per-team:
    tokens:
      cap: 50000
      window: per-team-lifetime
      include: [input, output, cacheRead, cacheWrite]       # matches v1 "all"
```

The defaults match v1: workers exclude cache, teams include everything.

### 5. The `window:` field (time-period semantics)

Makes the time period explicit (per-session for workers, per-team-lifetime for teams) and adds advanced windows (`per-run`, `per-day`, `per-hour`) for rate-limit use cases.

**Before** (v1, implicit):

```yaml
settings:
  worker:
    token-budget: 3500
  team-budgets:
    cost-budget-usd: 50
```

**After** (v2, with explicit `window:`):

```yaml
budgets:
  per-worker:
    tokens:
      cap: 3500
      window: per-session               # default for workers
  per-team:
    cost-usd:
      cap: 50
      window: per-team-lifetime         # default for teams
```

### 6. Depth cap

Renames `max-delegation-depth` to `depth.cap`. No per-team depth cap.

**Before** (v1):

```yaml
settings:
  worker:
    max-delegation-depth: 2
```

**After** (v2):

```yaml
budgets:
  per-worker:
    depth: { cap: 2 }
```

### 7. Per-agent override (`governance:` → `budgets:`)

Renames the per-agent override key in agent `.md` frontmatter. The override uses the same nested shape as the global config and is shallow per-resource.

**Before** (v1, in `agents/engine-coder.md` frontmatter):

```yaml
---
governance:
  token-budget: 1000
  cost-budget-usd: 0.25
  max-runs: 1
---
```

**After** (v2):

```yaml
---
budgets:
  tokens:  { cap: 1000 }
  cost-usd: { cap: 0.25 }
  runs:    { cap: 1 }
---
```

### 8. Budget strategy (advanced)

Replaces the flat `budget-strategy: default | compact` enum with a structured `strategies:` block. Optional — most projects can omit `strategies:`.

**Before** (v1):

```yaml
settings:
  worker-governance:
    budget-strategy: compact
    progress-summary-token-limit: 2000
```

**After** (v2):

```yaml
budgets:
  strategies:
    on-approaching-limit:
      action: wrap-up           # wrap-up | compact | none
      threshold: 0.20           # fire when 20% remains
      hint: "Wrap up your work; call summarize_progress when done."
    on-exhaustion:
      action: compact           # compact | abort | none
    summary:
      max-tokens: 2000
```

The v1 `default` strategy maps to `on-approaching-limit.action: wrap-up, on-exhaustion.action: abort`. The v1 `compact` strategy maps to `on-approaching-limit.action: wrap-up, on-exhaustion.action: compact`.

## Manual fix checklist

1. Delete `worker:` and `team-budgets:` from `settings:`. Move every budget sub-key into the new top-level `budgets:` block per the examples above.
2. Rename `token-budget` → `tokens.cap`, `cost-budget-usd` → `cost-usd.cap`, `max-runs` → `runs.cap`, `max-delegation-depth` → `depth.cap`.
3. Replace `token-budget-scope: input_output` with `include: [input, output]` and `token-budget-scope: all` with `include: [input, output, cacheRead, cacheWrite]`.
4. Optional: add `window:` to each cap (defaults are `per-session` for workers, `per-team-lifetime` for teams).
5. Keep `worker.timeout-ms` and `worker.distiller-runs` where they are — they are not budget keys.
6. For each agent `.md` in `agents/`, rename `governance:` to `budgets:` and convert its sub-keys to the nested shape.

Run `just verify` after the edits. The loader is strict: quoted numbers, fractions for integer fields, zero, negatives, `NaN`, infinity, and unknown keys all fail at startup.

## Rollback to v1

If the refactor breaks your project and you need to revert to v1 behavior, **neither option requires touching your YAML**.

The last commit on `main` before any Wave 1 refactor work landed is:

```
d8ed026 Merge pull request #56 from resolute-oil/feat/hive-version-command
```

**Option A — pin pi-hive to the last v1 release.** Pin your installed version to that release (or to the corresponding `vX.Y.Z` tag). Your existing v1 YAML loads unchanged.

**Option B — revert the refactor PR locally.** If you need HEAD behavior but want v1 config support, revert the refactor commits in your checkout:

```sh
git revert <refactor-merge-sha>
just verify
```

Revert the merge commit that introduced Wave 1, run `just verify`, and the v1 loader is back. Your v1 YAML is accepted as-is.

If neither option fits, open an issue with the path-aware error message from the loader — a hand edit per the checklist above is usually faster than a rollback.

## If something still does not load

The config loader is path-aware — the error names the file, the line, and the offending key. Common failures after this refactor:

- `unknown key "worker"` under `settings:` — forgot to delete the v1 `worker:` block.
- `unknown key "token-budget"` under `budgets.per-worker:` — used a v1 flat name. Use `tokens.cap`, `cost-usd.cap`, `runs.cap`, or `depth.cap`.
- `unknown key "scope"` under `budgets.per-worker.tokens` — replace with `include: [Usage keys]`.
- `unknown key "governance"` in agent frontmatter — rename to `budgets:`.
- `invalid combination: window "per-day" on cost-usd` — `per-day` is valid for `tokens` only; `cost-usd` accepts `per-session` and `per-team-lifetime`.

For anything else, run with `HIVE_TELEMETRY_VERBOSE=1` for the full validation trace.