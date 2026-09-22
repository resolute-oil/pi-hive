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

## [0.1.0] - 2026-07-05

### Added

- Hierarchical multi-agent orchestration for opted-in Pi projects.
- OpenSpec-backed planning, review, approval, and execution gates.
- Local-only telemetry collection and a prebuilt React dashboard.
- Project-scoped policy enforcement, lifecycle management, and privacy controls.

[Unreleased]: https://github.com/demetere/pi-hive/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/demetere/pi-hive/releases/tag/v0.1.0
