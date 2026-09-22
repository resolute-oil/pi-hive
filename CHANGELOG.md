# Changelog

All notable changes to pi-hive are documented here. Release headings match the
version in `package.json`; the release workflow refuses to publish a version
without a corresponding section.

## [Unreleased]

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

## [0.1.0] - 2026-07-05

### Added

- Hierarchical multi-agent orchestration for opted-in Pi projects.
- OpenSpec-backed planning, review, approval, and execution gates.
- Local-only telemetry collection and a prebuilt React dashboard.
- Project-scoped policy enforcement, lifecycle management, and privacy controls.

[Unreleased]: https://github.com/demetere/pi-hive/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/demetere/pi-hive/releases/tag/v0.1.0
