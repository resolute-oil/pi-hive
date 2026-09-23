# Changelog

All notable changes to pi-hive are documented here. Release headings match the
version in `package.json`; the release workflow refuses to publish a version
without a corresponding section.

## [Unreleased]

### Changed

- Replaced pi-hive's custom `ask_user` tool with the feature-rich
  `pi-ask-user` peer dep. The tool is no longer registered by pi-hive — install
  `pi-ask-user` to get `ask_user` with multi-choice options
  (`options[]` with `title`/`description`), freeform input (`allowFreeform`),
  optional user comments (`allowComment`), a configurable `timeout`, and
  `displayMode: "overlay" | "inline"`. Planners now see structured options
  rather than only freeform text. pi-hive's planner operating template and
  the plan-mode prompt were updated to document the new capabilities. The
  file-backed `questions.md` trail is no longer auto-populated by
  `ask_user`; `recordQuestion` and `enqueueQuestion` remain available for
  code paths that want to write to the trail explicitly.
- Flipped the `pi-ask-user` peer-dep `optional` flag from `true` to `false`.
  npm 7+ skips auto-install for optional peer deps (only their absence is
  tolerated), so `optional: true` left the dep out of `node_modules/` after
  `npm install` in the consuming project. Marking it required makes `npm
  install` auto-resolve and install `pi-ask-user` alongside pi-hive.

### Removed

- `ask_user` from `HIVE_TOOL_NAMES`, from `buildHiveTools` (src/agents/tools.ts),
  and from `PLAN_MODE_TOOLS` (src/ui/tui/widget.ts). Lifted to the `pi-ask-user`
  peer dep.
- `currentAgentName`, `enqueueQuestion`, `recordQuestion` imports from
  `src/agents/tools.ts` (only the `ask_user` tool referenced them). The
  `engine/questions.ts` module itself is unchanged.

### Added

- `pi-ask-user` listed under `peerDependencies` (optional, version `*`).
- Regression tests in `tests/questions.test.ts` that verify pi-hive does not
  register `ask_user` locally.

- Snapshot/restore for hive→normal mode switches. When the user exits hive or
  plan mode, the agent now resumes from a summary branch anchored at the
  cycle entry point rather than continuing with hive-mode history in context.
  Orphaned branches remain visible in `/tree` if the user wants to revisit
  them. Resolves the "agent still acts like an orchestrator after
  `/hive:normal`" symptom reported in the smoke test.
- New `hive_cycle_summary` tool, available in normal mode so the LLM can
  record a handoff summary in response to the follow-up turn fired on
  hive→normal. Calling it outside an active hive handoff returns
  `isError: true` without mutating state.
- New `pi.on("agent_settled", ...)` registration in
  `src/integration/hooks.ts`. The handler
  (`handleAgentSettledForHiveRestore`) performs the
  `branchWithSummary` → `branch(reset)` → `navigateTree` sequence,
  retries once with an empty summary on failure, and falls back to a
  best-effort log + UI notify on second failure. Mode switch itself
  is never rolled back; only the history restore is best-effort.

### Changed

- Hardened release publishing with protected-environment approval, npm trusted
  publishing, reproducibility checks, and attached software bills of materials.

### Fixed

- `canDelegateTo` now widens to any configured agent whose `agent-type` is in
  `{coder, tester, reviewer, planner}`, so the orchestrator can route
  read-only inspections directly to a typed specialist without going through a
  parent lead. `lead`-typed targets stay tree-bound. Orchestrator prompt,
  `route_agent`, and SETUP.md are updated to match.
- `filterBashPathTokens` is now resilient to sandbox-mediated `stat` calls. The
  filter retains its two-tier heuristic (path-or-parent existence is the
  primary signal; tokens with strong path-shape markers — absolute, `./`/
  `../` prefix, file extension, or dotfile basename — are kept via shape
  fallback when stat is inconclusive). Git-ref-like tokens without markers
  (`origin/main`, `feature/foo`, `master`) remain dropped. Fixes the deferred
  "may drop paths the agent could otherwise reach" limitation noted in
  HANDOFF.md and AGENTS.md.
- `AgentStatus` now includes `"queued"`. The activity panel widget already
  rendered the state correctly (`statusIcon` defaults to `"•"`, `metaOf`
  returns `"queued"` for non-running non-done non-error with no elapsed/tools,
  and the row draws exactly one separator dash); the union just wasn't
  accepting the literal, which produced 3 typecheck errors in
  `tests/activity-panel.test.ts` on the previous baseline. Two casts in
  `src/engine/observability.ts` (`runtimeSummary`, `withOrchestratorUsage`)
  bridge the runtime vocabulary to the telemetry wire format where `"queued"`
  collapses to `"idle"` (both mean dormant, no work in flight; the dashboard's
  `statusKey()` already defaults unknown values to `"idle"`). Closes 3 of the
  12 remaining test typecheck failures.

### Added

- `buildBudgetVisibility` surfaces a worker's remaining budget in the system
  prompt at session start, so the agent can self-regulate before hitting the
  wall. Shows worker-tier (`runs`, `tokens`, `cost`, `distiller`) and
  team-tier (`runs`, `tokens`, `cost`) limits with `Math.max(0, limit - used)`
  remaining values. Returns "" when no budget is configured; `buildWorkerPrompt`
  omits the section in that case. Tokens are formatted with K/M suffix
  (e.g. `tokens=1.0M`, `tokens=250.0K`). An up-to-the-turn view is still
  available via `team_status`.

### Fixed

- `extractBashPathTokens` skips the first non-flag positional argument for
  `grep`, `egrep`, and `fgrep`. The pattern (the search regex/literal) is
  DATA, not a path; without this skip, a slash inside the pattern (e.g.
  `grep /tmp/foo file.txt`) would fire a domain check on the pattern as if
  it were a path under the agent's domain. Scope is intentionally limited to
  grep variants — awk and sed have similar inline-data-as-first-positional
  cases but commonly pair the script with `-f FILE` or `-e SCRIPT` flag-value
  pairs where the value IS a path, and distinguishing flag values from
  positional values requires per-flag-value knowledge that's documented as
  a deferred hardening. Addresses the AGENTS.md "Bare bash read paths may
  evade static domain extraction" accepted risk in a small, targeted way.
- `checkReservedPath` now projects a canonical path for non-existent
  candidates on every access type (was previously skipped for read/delete).
  The configured-secret check (`matchesConfiguredSecret`) was relying on
  canonical containment, but the canonical resolution was gated on the
  caller's `allowMissing` flag — a read of a missing configured secret
  path on a symlinked project root (e.g. macOS `/tmp` -> `/private/tmp`)
  silently bypassed enforcement. SECURITY.md §"Path and symlink semantics"
  requires "all authorization is based on canonical containment, never
  string-prefix matching"; this restores that guarantee for the
  configured-secret case.
- macOS realpath artifacts in test fixtures across `safe-path.test.ts`,
  `domain-routing.test.ts`, and `openspec.test.ts`. The source code uses
  `realpathSync.native()` to canonicalize paths (see `src/core/safe-path.ts`
  and `src/engine/openspec.ts`), so test assertions against `canonicalRoot`
  / `canonicalPath` must canonicalize the tmpdir the same way. On macOS
  (and CI setups where `/tmp` is symlinked), the OS exposes the real
  path as `/private/var/folders/...` rather than `/var/folders/...`,
  which previously caused 5 test failures. Each affected test now wraps
  `mkdtempSync(...)` in `realpathSync(...)` so the assertion matches
  what the source code computed. Closes 5 of the 17 pre-existing baseline
  test failures.

### Added

- Option B: `delegate_agent` now accepts an optional `isReadOnly` boolean.
  When set to `false`, the type-based widening in `canDelegateTo` is BLOCKED
  and only tree-match delegation succeeds. Default (omitted or `true`)
  preserves the PR #10 widening behavior so existing flows don't change.
  Use `isReadOnly: false` when the caller KNOWS the delegation is for a
  write-capable target and wants to keep it in the lead tree — e.g. the
  orchestrator explicitly routing a worktree-class task to `operations`
  rather than a `coder`. Threaded through `dispatchAgent` → `canDelegateTo`.
  Tree-match delegations are unaffected by the flag. `lead`-typed targets
  stay tree-bound regardless of the flag. Implements the deferred hardening
  flagged in the PR #10 plan.

## [0.1.0] - 2026-07-05

### Added

- Hierarchical multi-agent orchestration for opted-in Pi projects.
- OpenSpec-backed planning, review, approval, and execution gates.
- Local-only telemetry collection and a prebuilt React dashboard.
- Project-scoped policy enforcement, lifecycle management, and privacy controls.

[Unreleased]: https://github.com/demetere/pi-hive/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/demetere/pi-hive/releases/tag/v0.1.0
