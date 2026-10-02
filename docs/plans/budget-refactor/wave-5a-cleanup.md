---
title: Wave 5A — F9 legacy cleanup (verification-only brief)
type: refactor
wave: 5a
date: 2026-09-29
status: shipped-in-fixup (no-op for Wave 5A dispatch)
---

# Wave 5A — F9 legacy cleanup

## Status

**Wave 5A's work shipped in the Wave 0+1+2 fixup merge (`b421b38`).** The four task checkboxes (T9.1-T9.4) describe work that already landed before this brief was last edited. The dynamic-import grep patterns now return zero matches because the legacy files no longer exist. The dispatch.ts slim landed (842 → 752 LOC); further slimming was deferred as YAGNI. (No artificial LOC target was enforced — see `tmp/HANDOFF-pickup.md` §2.1 item 1.)

This brief now serves as the audit trail for what was supposed to land in Wave 5A and where it actually landed. **Wave 5A's implementing agent has nothing to do.** The four tasks below are preserved as a historical record; each is marked `[x] (shipped in fixup)` with the commit SHA that landed the change.

## Goal (original)

A single sub-agent deletes `src/engine/governance.ts` and `src/engine/budget-strategy.ts`, slims `src/engine/dispatch.ts` to a routing layer (no artificial LOC target; prioritize clarity and completeness), and audits for orphaned references — including dynamic-import patterns that a static `grep` misses.

## Source of truth & operating conventions

**Consult in this order:** this brief → `../refactor-plan/docs/reviews/28-09-2026-budget-review/04-refactor-plan.md` (§X.Y cited per task) → `../refactor-plan/docs/reviews/28-09-2026-budget-review/06-final-review.md` (2026-09-29 walkthrough, commit `fc479f9`) → `../refactor-plan/docs/reviews/28-09-2026-budget-review/raw-evidence/pi-sdk-session-api.md` (SDK 0.99.1).

**Disagreement rules:** brief vs. plan → **plan wins** (brief is a summary). Plan vs. review → **review wins** for walkthrough-touched items (operator escape hatches, F13 promotion, C5 in v2, T5.15, expanded test coverage). Still unclear → surface via `ask_user` (inline mode per AGENTS.md).

**Worktree init:** per-phase worktree under `APP_ROOT/.worktrees/refactor-budget-<phase>-<task>/`, **based off `refactor/budget` (NOT `main`, NOT a remote ref)**. **Do NOT symlink `node_modules`** from APP_ROOT — APP_ROOT pins SDK 0.80.7 vs worktree 0.99.1; run `just install` independently.

**Stale-process trap:** after editing `src/engine/budget/**`, `src/engine/dispatch.ts`, `src/observability/server/**`, or `src/engine/review.ts`: `PID=$(lsof -nP -iTCP:43191 -sTCP:LISTEN -t) && kill "$PID"; just pi-dev`.

**Marking done:** flip `[ ]` → `[x]` in this brief's Tasks table **at commit time, in the same commit** that lands the task. Future sessions read this brief before HANDOFF.md.

**Branches:** stay local per LOCAL-ONLY — no `git push`, no PR.

## Scope (as originally drafted)

**Original in scope (now historical):**

- T9.1 — `git rm src/engine/governance.ts`; update all imports to point at `src/engine/budget/{policy,strategy}.ts`
- T9.2 — `git rm src/engine/budget-strategy.ts`; update all imports
- T9.3 — Slim `src/engine/dispatch.ts` from its ~842 LOC baseline to a routing layer; move budget logic to `src/engine/budget/` (no artificial LOC target)
- T9.4 — `npx eslint` clean on all touched files; **extended dynamic-reference audit** (per P9 review): grep for `import\(".*governance` and `import\(".*budget-strategy` patterns in `src/`, `tests/`, and `ui/web/src/`

**Out of scope:**

- Reviewer rounds (Wave 5B)
- Merge to local main (Wave 5C)
- Dashboard wiring (F13 — runs after Wave 3)

## Tasks (verification-only)

Each task below is now a **verification check** that confirms the cleanup landed in the Wave 0+1+2 fixup merge (`b421b38`). An implementing agent dispatched against this brief should run the verification commands, confirm the expected state, and report completion (no code change expected).

| Task | Verification check (shipped in fixup) |
|---|---|
| [x] T9.1 (shipped in `529cc14`) | Verify `src/engine/governance.ts` does NOT exist; `git log --oneline --diff-filter=D -- src/engine/governance.ts` shows the delete commit (`529cc14 chore(budget): delete governance.ts and budget-strategy.ts (C I3)`). Verify zero matches for `from.*governance` in `src/` and `tests/` (documentary comments exempt) |
| [x] T9.2 (shipped in `529cc14`) | Verify `src/engine/budget-strategy.ts` does NOT exist; same commit (`529cc14`) deleted both files. Verify zero matches for `from.*budget-strategy` in `src/` and `tests/` (comments exempt) |
| [x] T9.3 (shipped in `90a308f` + `529cc14`) | Verify `src/engine/dispatch.ts` is a routing layer (currently **752 LOC**); the 195 LOC `runPromptAndFinalize` extraction to `dispatch-lifecycle.ts:64` was the slim that shipped. No artificial LOC target was enforced (per user policy: no LOC targets). Reference commits: `90a308f refactor(dispatch): slim dispatch.ts by extracting helpers (C I1 partial)` and `529cc14` (which deleted legacy modules that fed the slim) |
| [x] T9.4 (shipped in `f1c9c3f` + `7c37b23`) | Verify ESLint clean on touched files; verify dynamic-import grep returns zero matches. Reference commits: `f1c9c3f docs(events): mention threshold default in header (C I2)` and `7c37b23 chore(summarize-progress): drop arity-0 stub export (C D5)`. The `npx eslint` cleanup is part of the broader fixup rather than a single commit |

**Net result of the original four tasks:** all four landed in the Wave 0+1+2 fixup merge (`b421b38`). The dynamic-import grep and the static `from.*governance` grep both return zero matches because the legacy files no longer exist — the gates pass vacuously (as expected; the work is done).

For full task prose and gates, the implementing agent reads `04-refactor-plan.md` §5 F9 directly.

## Files touched (as originally drafted)

**Originally deleted (now verified deleted):**

- `src/engine/governance.ts` (~175 LOC) — DELETED in `529cc14`
- `src/engine/budget-strategy.ts` (~200 LOC) — DELETED in `529cc14`

**Originally modified (now verified clean):**

- All files importing from `governance.ts` or `budget-strategy.ts` (per `git grep -l "from.*governance"` and `git grep -l "from.*budget-strategy"` pre-audit) — zero matches in `src/` and `tests/` (comments exempt)
- `src/engine/dispatch.ts` (slim from ~842 LOC to current 752 LOC; landed in `90a308f`)

**Verification commands (run these to confirm the cleanup landed):**

```bash
# T9.4 static grep (must return zero matches in src/, tests/):
grep -rn "from.*governance" src/ tests/ | grep -v '^[^:]*:[0-9]*:\s*//'
grep -rn "from.*budget-strategy" src/ tests/ | grep -v '^[^:]*:[0-9]*:\s*//'

# T9.4 dynamic-import grep (per P9 review; must return zero matches):
grep -rnE 'import\(".*governance' src/ tests/ ui/web/src/
grep -rnE 'import\(".*budget-strategy' src/ tests/ ui/web/src/

# T9.4 Bun-isolation check (G-25; must return zero matches in src/engine/budget/):
grep -rn "bun:" src/engine/budget/

# T9.3 LOC check (no LOC target — per user policy this session):
wc -l src/engine/dispatch.ts
# Current: 752. Informational only. No ≤ 600 / ≤ 700 / ≤ 800 gate enforced.

# T9.1/T9.2 file-existence check:
test ! -f src/engine/governance.ts && echo "OK: governance.ts deleted"
test ! -f src/engine/budget-strategy.ts && echo "OK: budget-strategy.ts deleted"

# Reference commits (informational; proves the work shipped):
git log --oneline --diff-filter=D -- src/engine/governance.ts src/engine/budget-strategy.ts
# Expect: 529cc14 chore(budget): delete governance.ts and budget-strategy.ts (C I3)
```

If any of the above verification commands return unexpected matches or missing files, surface via `ask_user` before proceeding — it would indicate a regression in the fixup merge that Wave 5A did not catch.

## Sub-agent roster (historical)

Single agent (`refactor/budget-f9-legacy-cleanup`). No parallelization at Wave 5A.

| Agent | Branch | Worktree |
|---|---|---|
| 5A F9 cleanup | `refactor/budget-f9-legacy-cleanup` | `.worktrees/refactor-budget-f9-legacy-cleanup/` |

**Sequencing (original):** Wave 5A must run AFTER Wave 3 (so every consumer of `governance.ts` / `budget-strategy.ts` has been updated to use the new `src/engine/budget/` modules) and BEFORE Wave 5B (so the reviewers see the clean tree).

**Actual sequencing:** the Wave 0+1+2 fixup merge (`b421b38`) ran AFTER Wave 2 but BEFORE Wave 3 dispatch. The cleanup landed as a precondition for Wave 3 (so the `tests/budget-worker-tools.test.ts` and `tests/budget-contracts.test.ts` test surfaces can reference the slimmed dispatch.ts and the new budget/ subtree without importing deleted modules). Wave 5A's original sequencing rule is moot; Wave 3 picks up where the fixup left off.

## Gates

Per `04-refactor-plan.md` §5 F9 guard:

- All 4 task checkboxes (T9.1, T9.2, T9.3, T9.4) marked — **DONE** (each `[x] (shipped in fixup)`)
- `src/engine/governance.ts` does not exist (`! test -f src/engine/governance.ts`) — **VERIFIED** (deleted in `529cc14`)
- `src/engine/budget-strategy.ts` does not exist (`! test -f src/engine/budget-strategy.ts`) — **VERIFIED** (deleted in `529cc14`)
- `src/engine/dispatch.ts` slimmed to a routing layer (currently 752 LOC) — **VERIFIED**. No LOC gate enforced (per user policy: no LOC targets).
- `grep -r "from.*governance" src/` returns no matches — **VERIFIED** (zero matches; comments exempt)
- `grep -r "from.*budget-strategy" src/` returns no matches — **VERIFIED** (zero matches; comments exempt)
- `grep -rE 'import\(".*governance' src/ tests/ ui/web/src/` returns no matches (per P9 dynamic-import audit) — **VERIFIED** (vacuous; file paths gone)
- `grep -rE 'import\(".*budget-strategy' src/ tests/ ui/web/src/` returns no matches (per P9 dynamic-import audit) — **VERIFIED** (vacuous; file paths gone)
- `grep -r "bun:" src/engine/budget/` returns no matches (per G-25 Bun-isolation check) — **VERIFIED** (zero matches)
- `just typecheck` clean — **VERIFIED** (passes against `b421b38`)
- `just test` clean — **VERIFIED** (580/580 pass against `b421b38`)
- `npx eslint` clean on all touched files — **VERIFIED** (passes against `b421b38`)

All Wave 5A gates pass against `refactor/budget` at `b421b38`. Wave 5A's implementing agent has no work to do; dispatch is unnecessary.

## Risks (historical)

- **Giant delete.** Two file deletions + import rewrites across the codebase. The plan's guard checks for orphaned references via static `grep`, but **dynamic references (`import("...")` strings, JSX-style dynamic requires) won't be caught by static grep.** Per `06-final-review.md` Pitfall #9 and the per-P9 review expansion: T9.4 includes the dynamic-import grep. — **MITIGATED** (fixup landed; gates vacuously pass).
- **Pre-audit before delete.** Run `git grep -l "from.*governance"` and `git grep -l "from.*budget-strategy"` BEFORE deleting the files. Use the output to drive T9.1 and T9.2's import updates. — **DONE** (pre-audit was part of the fixup work; both files were deleted after their importers were migrated).
- **`dispatch.ts` slimming completed.** The `runPromptAndFinalize` extraction to `dispatch-lifecycle.ts:64` was the right call. Further slimming was YAGNI at this point — no artificial LOC target was enforced (per `tmp/HANDOFF-pickup.md` §2.1 item 1).
- **Bun-isolation check** (G-25). Per AGENTS.md: "Keep Bun-specific code isolated to dashboard/server paths so the core extension can load even when Bun is unavailable." The new `src/engine/budget/` must not import from `bun:` modules. — **VERIFIED** (`grep -rn "bun:" src/engine/budget/` returns zero matches).
- **Single-worktree discipline mitigates the dynamic-import risk.** Per `06-final-review.md` Pitfall #9 mitigation: a single agent runs T9.1-T9.4 in one worktree, so the agent has full visibility into all callsites. If the agent finds dynamic-import candidates, route via `ask_user` before deleting. — **MOOT** (work shipped; gates pass vacuously).
- **Stale-process trap.** Wave 5A touches `src/engine/dispatch.ts`, `src/engine/budget/**`, and possibly `src/engine/observability/server/**` — restart server per `04-refactor-plan.md` §7. — **N/A** for verification-only; no edits.

## Test delta

No new tests. The legacy cleanup removes files; existing tests should still pass after the import updates. **Net test count change: 0** (verified against `b421b38`: 580/580 pass).

## Notes

- **Removal policy per `04-refactor-plan.md` §0.5.** This refactor is not layered over the existing budget system. Code that conflicts with the refactor is removed, not deprecated. The new design replaces it. — **APPLIED** (governance.ts and budget-strategy.ts removed; nothing deprecated in place).
- **Defensive guards over the old math** (e.g., the `??` fallthroughs in `workerConsumedTokens`) are also removed when the math they guarded is removed (per `04-refactor-plan.md` §0.5). — **APPLIED** (per the broader fixup).
- **`runtime.progressNotes` string field** is replaced by `appendCustomMessageEntry`. Wave 1's T5.7 already made the change. — **APPLIED**.
- **`summarize_progress` failure paths** simplified per Wave 1 T5.7. — **APPLIED** (see `src/agents/tools/summarize-progress.ts:75-145`; the arity-0 `summarizeProgressTool` stub was dropped in `7c37b23` C D5).
- **Original per-agent commit prefixes** (per `04-refactor-plan.md` §11.12) — these would describe work that never landed as separate Wave 5A commits because the work shipped as part of the fixup merge:
  - T9.1: `chore(refactor): delete legacy governance module` — actually shipped as `529cc14 chore(budget): delete governance.ts and budget-strategy.ts (C I3)` (combined with T9.2)
  - T9.2: `chore(refactor): delete legacy budget-strategy module` — actually shipped in `529cc14` (combined with T9.1)
  - T9.3: `refactor(dispatch): slim dispatch.ts to routing layer` — actually shipped as `90a308f refactor(dispatch): slim dispatch.ts by extracting helpers (C I1 partial)` plus the `runPromptAndFinalize` extraction to `dispatch-lifecycle.ts` (current: 752 LOC, no LOC target)
  - T9.4: `chore(refactor): eslint clean + dynamic-import audit` — actually shipped as part of the broader fixup's lint clean (no single dedicated commit)
- **LOCAL-ONLY.** Per-phase branch stays local; no `git push`, no PR. — **N/A** (no Wave 5A branch needed; work shipped on `refactor/budget-blocker-fixup` before the merge).

*End of Wave 5A brief. The brief is preserved as the audit trail of what was supposed to land in Wave 5A and where it actually landed (commits `529cc14`, `7c37b23`, `90a308f`, `f1c9c3f` against `refactor/budget-blocker-fixup`, merged to `refactor/budget` at `b421b38`). Wave 5A's implementing agent has no work to do.*