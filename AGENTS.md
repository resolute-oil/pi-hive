# pi-hive Development Guide

## Project purpose

`pi-hive` is a Pi package that provides a hierarchical multi-agent orchestration extension plus a local telemetry dashboard.

The extension must stay safe to install globally: it should do nothing unless the current project opts in with `.pi/hive/hive-config.yaml`.

## Pi package rules

- Package entrypoint is `index.ts` and must remain declared in `package.json` under `pi.extensions`.
- Runtime Pi imports belong in `peerDependencies` with `"*"` ranges: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`.
- Do not require users to build the dashboard at install time. Keep `ui/web/dist/` committed and included in the package.
- After editing `ui/web/src/**`, run `just dashboard-build` before packaging.
- Before publishing or tagging, run `just ci`.

## Extension behavior

- Do not register commands, tools, hooks, background servers, file watchers, or UI widgets unless `.pi/hive/hive-config.yaml` exists in the active project.
- Do not start long-lived processes from the extension factory. Start them from commands/session hooks. Clean up session-owned processes on session shutdown; deliberately shared daemons must provide authenticated explicit teardown and a bounded idle timeout.
- Guard TUI-specific behavior with `ctx.mode === "tui"`; guard user prompts/notifications with `ctx.hasUI`.
- Custom tools that mutate files must use Pi's file mutation queue.
- Tool output must be bounded/truncated so it cannot flood model context.

## Telemetry/dashboard

- The dashboard server is local-only by default: `127.0.0.1:43191`.
- Keep telemetry files under `.pi/hive/sessions/` for project state and `~/.pi/agent/hive/` for the global registry/database.
- Do not send telemetry to third-party services.
- Keep Bun-specific code isolated to dashboard/server paths so the core extension can load even when Bun is unavailable.

## Policy enforcement limits (accepted risk)

- The bash policy classifies mutations by matching known commands (`rm`, `mv`, `git restore`, `find -delete`, `dd of=`, `rsync`, …). File changes made *through* a general-purpose interpreter — `node -e`, `python -c`, `sh script.sh`, `npm run <script>` — are **statically unpoliceable**: the enforcer cannot see writes hidden inside interpreted code. This is a known, accepted limit, stated in the worker operating-contract prompt so agents treat it as a trust boundary, not a loophole. Do not rely on the bash classifier to contain a hostile interpreter invocation.
- Bash **read** checks fail OPEN on bare filenames. `extractBashPathTokens` only recognizes path-like tokens containing a `/` (or an absolute path), so `cat secrets.env` / `less .env` (no slash) produce no token and skip the read-domain check. Mutations still fail CLOSED (classification keys off the command verb, not the path). Tightening this would false-positive on ordinary bash arguments — every word looks like a filename — so it is left as documented accepted risk, alongside the interpreter limit.

## Repository hygiene

- Do not commit `node_modules/`, `.tgz` package artifacts, runtime sessions, logs, or local telemetry databases.
- Use Conventional Commits for commit messages, for example `feat: add hive policy checks`, `fix(dashboard): preserve runtime counters`, or `docs: update setup guide`.
- For audit remediation backlog tasks (`Txx`), completion includes committing, pushing, and opening a PR after required checks pass. Do not begin the next task until that PR exists.
- Do not add AI attribution trailers or generated-by notices to commits, docs, package text, or release notes.
- Prefer complete, production-ready changes: no TODO placeholders, no debug logs, and no unexplained temporary behavior.
- **All file edits go in a git worktree, never in the main working tree.** Even single-line docs changes, chore updates, and small fixes must be done in a worktree under `APP_ROOT/.worktrees/`, not as siblings of `APP_ROOT` and not directly on `main`. The `.worktrees/` directory is gitignored so `git add .` from a parent path can't drag a sibling checkout into a commit. Create with `git worktree add .worktrees/<branch> <base>` from `APP_ROOT`, then symlink `node_modules` if the worktree needs to run tests.

  **Symlink target is `../../node_modules`**, not `../node_modules`. The worktree lives at `APP_ROOT/.worktrees/<branch>/` — two levels deep from `APP_ROOT` — so the relative symlink target must be `../../node_modules` to resolve to `APP_ROOT/node_modules`. The shorter `../node_modules` resolves to the non-existent `APP_ROOT/.worktrees/node_modules` and creates a dangling symlink that breaks every test and lint command in the worktree. As an alternative, use an absolute path: `ln -s "$APP_ROOT/node_modules" "$APP_ROOT/.worktrees/<branch>/node_modules"`.

  Clean up with `git worktree remove .worktrees/<branch>` after the branch merges. This rule applies to every agent session that touches this repo, including the one writing this rule.

- **`bash` and `edit` tool calls default to the main working tree.**
  Each `bash` invocation starts in `APP_ROOT` (the bare checkout on
  `main`); the cwd resets between calls, so prefix any in-worktree
  command with `cd APP_ROOT/.worktrees/<branch>` — `cd` does not
  persist. The `edit` tool must use the absolute worktree path; never
  pass an APP_ROOT path. Applies to every shell command (`sed`,
  `git mv`, `rm`, `mv`, `npm install`, etc.) and to `edit`. The rule
  above is about *where* work happens; this one is about *not losing
  your place* while doing it. Failing it silently pollutes `main`'s
  working tree.

## Browser testing

- A remote ChromeDriver is available at `http://localhost:9515` (W3C WebDriver). The Pi sandbox cannot launch Chrome locally, so any layout, CSS, or DOM-behavior check must drive this driver. `GET /status` returns `{ready: true}` once it has a browser booted.
- Sessions are created by `POST /session` with `capabilities.alwaysMatch.browserName: "chrome"` and `goog:chromeOptions.args: ["--headless=new", "--disable-gpu", "--no-sandbox", "--window-size=W,H"]`. The response wraps the new id under `value.sessionId` (W3C shape, not the legacy top-level `sessionId`).
- Script results from `POST /session/{id}/execute/sync` are wrapped: numbers/booleans come back as `{value: N}`, but objects are returned as the plain object. `JSON.stringify` the script return value before parsing so the protocol's coercion does not produce `[object Object]` on error paths.
- The dashboard serves content-addressed assets (`/pl-review/assets/review.{html,css,js}`) with `cache-control: public, max-age=31536000, immutable`, so a CSS or JS fix requires a dashboard-server restart, not just a browser reload, to clear the in-memory `cachedReviewAssets`. Hit `POST /shutdown` with the daemon bearer to stop a test server, then start a fresh one on a free port (e.g. `HIVE_TELEMETRY_PORT=43195`) so the user's 43191 instance keeps running.
- `POST /review-sessions` requires the dashboard bearer token from `GET /bootstrap.json` plus matching `host`, `origin`, and `referer` headers; without all four the mint is rejected before any HTML is served. The minted URL embeds the nonce — if the proposal file changes, the nonce is invalidated (409 "review artifact changed"), so re-mint before re-running a browser check.

## Useful commands

```sh
just dashboard-build
just verify
just pack-dry-run
just pi-dev

# Worktree (from APP_ROOT) — required for ALL file edits
git worktree add .worktrees/<branch> <base>
# Worktree is at APP_ROOT/.worktrees/<branch>/ — two levels deep — so the
# node_modules symlink target is ../../node_modules (NOT ../node_modules,
# which resolves to a non-existent directory and breaks every test command).
ln -s ../../node_modules .worktrees/<branch>/node_modules
# Or use an absolute path to avoid the relative-path trap:
# ln -s "$APP_ROOT/node_modules" "$APP_ROOT/.worktrees/<branch>/node_modules"
git worktree remove .worktrees/<branch>   # after the branch merges
```
