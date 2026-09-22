// Bash path-token classification tests.
//
// `extractBashPathTokens` in `src/engine/domain.ts` decides which tokens in a
// bash command are checked against the agent's filesystem domain. The current
// implementation is a regex over the raw command string; it matches any
// token containing `/`, then asks the domain layer to authorize the
// resolved path.
//
// The regex is a known accepted limitation (SECURITY.md "Accepted risks" §2;
// documented at `domain.ts:118-132`). This file documents its current
// behavior on Operations' canonical commands plus a wide set of edge cases,
// so a future fix can be measured against the same matrix.
//
// Token classes:
//
//   REAL_PATH         - A filesystem path the agent might legitimately need.
//                       Either exists, parent exists, or the command creates it.
//   REF_ARG           - A git ref / branch name / remote-ref argument.
//                       Not a filesystem path; should NOT trigger a domain
//                       check.
//   URL               - URL or URL-like argument (filtered today by the
//                       http(s) prefix check; not checked for other schemes).
//   QUOTED            - Argument is wrapped in quotes (raw form has `"`/`'`
//                       chars that break the regex). Today: not extracted.
//   ENV_VAR           - Argument comes through a shell variable (`$VAR`,
//                       `$(...)`, etc.). Today: not extracted.
//   BARE              - Argument without a slash (regex never matches).
//                       Documented to fail open on read.
//
// Layout of the test file:
//
//   1. Operations canonical commands (Phase A/B/C of the smoke-test plan).
//   2. Git argument shapes — the false-positive class.
//   3. Shell expansion shapes — confirmed bypass patterns and one broken one.
//   4. Edge cases that hint at the right fix shape.
//   5. Summary matrices — what a correct fix MUST preserve and MUST drop.
//
// The "summary — a correct fix must DROP ref-arg extraction" test is the
// only test in this file that fails on the current code. It asserts the
// post-fix desired behavior so it will start passing once the regex
// stops extracting ref-arg tokens; the failure today is intentional and
// documents the gap.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { extractBashPathTokens, filterBashPathTokens } from "../src/engine/domain.ts";

interface BashFixture {
  cwd: string;
  worktree: string;
  payloadFile: string;
}

// Build a fresh per-fixture cwd so every test starts from a clean slate.
function freshFixture(): BashFixture {
  const cwd = join(tmpdir(), "pi-hive-bash-path-fixture-" + Math.random().toString(36).slice(2, 8));
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(cwd, ".worktrees"), { recursive: true });
  mkdirSync(join(cwd, "app"), { recursive: true });
  mkdirSync(join(cwd, "app/models"), { recursive: true });
  mkdirSync(join(cwd, "engines/catalog/app"), { recursive: true });
  mkdirSync(join(cwd, "engines/catalog/test"), { recursive: true });
  writeFileSync(join(cwd, "Gemfile"), "source 'https://rubygems.org'");
  writeFileSync(join(cwd, "CONTEXT.md"), "# Project context");
  writeFileSync(join(cwd, "AGENTS.md"), "# Agent rules");
  writeFileSync(join(cwd, "package.json"), "{}");
  return {
    cwd,
    worktree: join(cwd, ".worktrees/feature-ops-smoke-test-publish"),
    payloadFile: join(cwd, ".worktrees/feature-ops-smoke-test-publish/tmp/payloads/smoke-test.md"),
  };
}

function cleanup(fx: BashFixture): void {
  try { rmSync(fx.cwd, { recursive: true, force: true }); } catch { /* noop */ }
}

function sortTokens(tokens: string[]): string[] {
  return Array.from(new Set(tokens)).sort();
}

function assertExtracts(cmd: string, expected: string[]): void {
  const actual = sortTokens(extractBashPathTokens(cmd));
  const exp = sortTokens(expected);
  assert.deepEqual(actual, exp, cmd + " :: actual=" + JSON.stringify(actual));
}

interface Scenario {
  description: string;
  command: string;
  expected: string[];
  classByToken?: Record<string, "REAL_PATH" | "REF_ARG" | "URL" | "QUOTED" | "ENV_VAR" | "BARE">;
}

// ─────────────────────────────────────────────────────────────────────────
// Operations canonical commands (the smoke-test plan).
// ─────────────────────────────────────────────────────────────────────────

const OPERATIONS_SCENARIOS: Scenario[] = [
  {
    description: "Phase A — worktree create with branch + ref args (false positives today)",
    command: "git -C . worktree add .worktrees/feature-ops-smoke-test-publish -b feature/ops-smoke-test-publish origin/main",
    expected: [
      ".worktrees/feature-ops-smoke-test-publish",
      "feature/ops-smoke-test-publish",
      "origin/main",
    ],
    classByToken: {
      ".worktrees/feature-ops-smoke-test-publish": "REAL_PATH",
      "feature/ops-smoke-test-publish": "REF_ARG",
      "origin/main": "REF_ARG",
    },
  },
  {
    description: "Phase A — worktree create with branch names without slashes (no false positive)",
    command: "git -C . worktree add .worktrees/feature-ops-smoke-test-publish -b feature-ops-smoke-test-publish main",
    expected: [
      ".worktrees/feature-ops-smoke-test-publish",
    ],
    classByToken: {
      ".worktrees/feature-ops-smoke-test-publish": "REAL_PATH",
    },
  },
  {
    description: "Phase A — worktree remove (target worktree exists)",
    command: "git -C . worktree remove .worktrees/feature-ops-smoke-test-publish",
    expected: [
      ".worktrees/feature-ops-smoke-test-publish",
    ],
  },
  {
    description: "Phase A — worktree force-remove (orchestrator-approved)",
    command: "git -C . worktree remove --force .worktrees/feature-ops-smoke-test-publish",
    expected: [
      ".worktrees/feature-ops-smoke-test-publish",
    ],
  },
  {
    description: "Phase B — push from inside the worktree",
    command: "git -C .worktrees/feature-ops-smoke-test-publish push origin feature/ops-smoke-test-publish",
    expected: [
      ".worktrees/feature-ops-smoke-test-publish",
      "feature/ops-smoke-test-publish",
    ],
    classByToken: {
      ".worktrees/feature-ops-smoke-test-publish": "REAL_PATH",
      "feature/ops-smoke-test-publish": "REF_ARG",
    },
  },
  {
    description: "Phase B — gh pr create with body-file (real path under worktree)",
    command: "gh pr create --body-file .worktrees/feature-ops-smoke-test-publish/tmp/payloads/smoke-test.md",
    expected: [
      ".worktrees/feature-ops-smoke-test-publish/tmp/payloads/smoke-test.md",
    ],
  },
  {
    description: "Phase C — branch delete (branch name has slashes)",
    command: "git -C . branch -d docs/handoff-after-pr-348",
    expected: [
      "docs/handoff-after-pr-348",
    ],
    classByToken: {
      "docs/handoff-after-pr-348": "REF_ARG",
    },
  },
  {
    description: "Phase C — push --delete a remote branch",
    command: "git -C . push origin --delete docs/handoff-after-pr-348",
    expected: [
      "docs/handoff-after-pr-348",
    ],
    classByToken: {
      "docs/handoff-after-pr-348": "REF_ARG",
    },
  },
  {
    description: "Phase C — read prior cycle HANDOFF.md via git show",
    command: "git -C . show origin/docs/handoff-after-pr-348:HANDOFF.md",
    expected: [
      "origin/docs/handoff-after-pr-348",
    ],
    classByToken: {
      "origin/docs/handoff-after-pr-348": "REF_ARG",
    },
  },
];

test("Operations canonical commands — current extraction matrix", () => {
  const fx = freshFixture();
  try {
    for (const scenario of OPERATIONS_SCENARIOS) {
      assertExtracts(scenario.command, scenario.expected);
    }
  } finally {
    cleanup(fx);
  }
});

test("Operations canonical commands — token classes (documentation only)", () => {
  // Documents which extracted tokens are REAL_PATH vs REF_ARG. A fix is
  // expected to drop the REF_ARG entries from the extracted set so the
  // domain layer never sees them.
  const fx = freshFixture();
  try {
    for (const scenario of OPERATIONS_SCENARIOS) {
      if (!scenario.classByToken) continue;
      const actual = extractBashPathTokens(scenario.command);
      for (const token of actual) {
        assert.ok(
          scenario.classByToken[token] !== undefined,
          scenario.description + " :: unclassified token " + JSON.stringify(token),
        );
      }
    }
  } finally {
    cleanup(fx);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Git argument shapes — the false-positive class.
// ─────────────────────────────────────────────────────────────────────────

test("git ref arguments — every common shape extracts as a 'looks like a path' token", () => {
  const fx = freshFixture();
  try {
    const cases: Array<[string, string[]]> = [
      // Branch names with slashes (most common).
      ["git log feature/foo", ["feature/foo"]],
      ["git log docs/handoff-after-pr-348", ["docs/handoff-after-pr-348"]],
      ["git log release/2026/Q3", ["release/2026/Q3"]],
      // Remote-tracking refs.
      ["git log origin/main", ["origin/main"]],
      ["git log origin/feature/foo", ["origin/feature/foo"]],
      // Full ref syntax.
      ["git log refs/heads/main", ["refs/heads/main"]],
      ["git log refs/remotes/origin/main", ["refs/remotes/origin/main"]],
      ["git log refs/tags/v1.0.0", ["refs/tags/v1.0.0"]],
      // Reflog syntax. The `{` breaks the regex char class, so the leading
      // ref does NOT extract.
      ["git log main@{1}", []],
      ["git log feature/foo@{2.days.ago}", ["feature/foo@"]], // leading ref still matches; `@` is in the class.
      // Annotated / peeled refs. The `^` breaks the char class.
      ["git show v1.0.0^{commit}", []],
      // Compare with a tag with a slash (e.g. release/v1).
      ["git diff release/v1 main", ["release/v1"]],
    ];
    for (const [cmd, expected] of cases) assertExtracts(cmd, expected);
  } finally {
    cleanup(fx);
  }
});

test("git worktree subcommand — worktree, branch, and ref all extract identically", () => {
  const fx = freshFixture();
  try {
    const cases: Array<[string, string[]]> = [
      ["git worktree add .worktrees/foo -b bar/baz main", [".worktrees/foo", "bar/baz"]],
      ["git worktree add --detach .worktrees/foo", [".worktrees/foo"]],
      ["git worktree add .worktrees/foo main", [".worktrees/foo"]],
      ["git worktree add .worktrees/foo HEAD", [".worktrees/foo"]],
      ["git worktree add -B new/branch .worktrees/foo origin/main", [".worktrees/foo", "new/branch", "origin/main"]],
      ["git worktree list", []],
      ["git worktree prune", []],
    ];
    for (const [cmd, expected] of cases) assertExtracts(cmd, expected);
  } finally {
    cleanup(fx);
  }
});

test("git push/pull/remote variants — ref and remote both look like paths", () => {
  const fx = freshFixture();
  try {
    const cases: Array<[string, string[]]> = [
      ["git push", []],
      ["git push origin", []],
      ["git push origin main", []],
      // `:` not in char class — refspec colon breaks the match.
      ["git push origin main:dev", []],
      ["git push origin feature/foo", ["feature/foo"]],
      // `:` breaks the match for the empty-source refspec syntax.
      ["git push origin :feature/foo", []],
      ["git push --delete origin feature/foo", ["feature/foo"]],
      ["git pull origin main", []],
      ["git pull origin feature/foo", ["feature/foo"]],
      // `git@github.com:user/repo.git` — the `:` breaks the match. SSH
      // remotes pass without extraction.
      ["git remote add upstream git@github.com:user/repo.git", []],
      // `:` breaks the match for fetch refspec.
      ["git fetch origin main:main", []],
      ["git fetch origin feature/foo:dev", ["feature/foo"]],
    ];
    for (const [cmd, expected] of cases) assertExtracts(cmd, expected);
  } finally {
    cleanup(fx);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Shell expansion shapes — today's behavior + what should still apply after a
// fix. These document that quoted/escaped/variable-wrapped args do not get
// extracted and SHOULD continue to bypass the regex (the security model
// treats bare read failures as accepted limitations).
// ─────────────────────────────────────────────────────────────────────────

test("shell expansions — quoted, variable, and escaped args bypass the regex today", () => {
  const fx = freshFixture();
  try {
    const cases: Array<[string, string[], string]> = [
      // Branch name behind a `$VAR` (the env-var workaround from
      // `docs/hive-permissions-domain-fix`).
      [
        "WP='.worktrees/foo' B='feature/foo' REF='origin/main' git -C . worktree add \"$WP\" -b \"$B\" \"$REF\"",
        [],
        "env-var inline assignment",
      ],
      // Branch name inside `$(...)` with NO spaces between the
      // substitution and the inner value. Today the regex's char class
      // does not stop at `$(`, so the inner ref is still extracted if it
      // is preceded by whitespace inside the substitution. With the
      // value adjacent to a non-whitespace char, the regex correctly
      // skips it.
      [
        "git -C . worktree add .worktrees/foo -b \"$(printf '%s/branch' feature)\" \"$(printf '%s/ref' origin)\"",
        [".worktrees/foo"],
        "command substitution (no inner whitespace)",
      ],
      // Branch name inside `$(echo foo)` — the lexer-based extractor now
      // treats the quoted argument as data, so this no longer false-positives
      // on the inner ref. The $(...) form is now a reliable workaround
      // alongside the env-var form.
      [
        "git -C . worktree add .worktrees/foo -b \"$(echo feature/foo)\" \"$(echo origin/main)\"",
        [".worktrees/foo"],
        "command substitution (inner whitespace — now correctly treated as data)",
      ],
      // Quoted path. Today the quote char breaks the match; same behavior
      // should hold for any fix.
      ["cat \"./some/file.txt\"", [], "double-quoted path"],
      ["cat './some/file.txt'", [], "single-quoted path"],
      // Backslash-escaped path. The lexer strips the escape so the token
      // becomes `/etc/passwd` (which bash actually uses), and the path
      // regex correctly extracts it. Old behavior missed it because the
      // raw `\` broke the anchor.
      ["cat \\/etc/passwd", ["/etc/passwd"], "backslash-escaped path (lexer strips the escape)"],
      // Tilde-prefixed.
      ["cat ~/foo/bar.txt", [], "tilde-prefixed"],
      // $HOME-prefixed.
      ["cat $HOME/.bashrc", [], "dollar-HOME variable"],
      ["cat \"$HOME\"/.bashrc", [], "quoted-dollar-HOME variable"],
      // SSH URL: the `:` breaks the match, so the path component is not
      // extracted. The dest argument IS extracted if it has a slash.
      ["git clone ssh://git@github.com/user/repo.git", [], "ssh:// clone"],
      ["git clone ssh://git@github.com/user/repo.git /tmp/repo", ["/tmp/repo"], "ssh:// clone with dest"],
      // S3-style URL: the `:` breaks the match for the bucket, but the
      // local-key dest still extracts.
      ["aws s3 cp s3://bucket/key ./local/key", ["./local/key"], "s3:// (local dest still extracts)"],
    ];
    for (const [cmd, expected, label] of cases) assertExtracts(cmd, expected);
  } finally {
    cleanup(fx);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Edge cases that hint at the right fix shape.
// ─────────────────────────────────────────────────────────────────────────

test("paths to be CREATED by the command — token exists only as an intent", () => {
  const fx = freshFixture();
  try {
    // The worktree-create case is the canonical "path doesn't exist yet
    // but should still be authorized" scenario. Today the regex extracts
    // the target path; the engine classifies `worktree add` as `read`
    // (worktree not in GIT_MUTATION_COMMANDS); the read check then fails
    // because allowMissing=false on the non-existent path.
    //
    // A correct fix should authorize this: the path is a CREATE target
    // (the agent has upsert on `.worktrees/`).
    const cmd = "git -C . worktree add .worktrees/will-be-created -b feat/x main";
    const tokens = extractBashPathTokens(cmd);
    assert.deepEqual(
      sortTokens(tokens),
      [".worktrees/will-be-created", "feat/x"],
      cmd,
    );
    // The branch token `feat/x` MUST be excluded from any domain check
    // (it is a REF_ARG, not a filesystem path).
  } finally {
    cleanup(fx);
  }
});

test("paths with embedded refs (the canonical `git show origin/<branch>:HANDOFF.md` case)", () => {
  const fx = freshFixture();
  try {
    // The colon ends the ref name and starts the in-ref path. The regex
    // does not match past the colon (since `:` is not in its char class),
    // so the HANDOFF.md path itself is never extracted.
    //
    // What IS extracted is the leading `origin/<branch>` — and that is
    // exactly the false positive.
    const cmd = "git -C . show origin/docs/handoff-after-pr-348:HANDOFF.md";
    const tokens = extractBashPathTokens(cmd);
    assert.deepEqual(sortTokens(tokens), ["origin/docs/handoff-after-pr-348"]);
    // A correct fix would recognize `origin/<branch>` as a remote-tracking
    // ref and drop it from the extracted set.
  } finally {
    cleanup(fx);
  }
});

test("real paths under existing directories — must continue to extract", () => {
  const fx = freshFixture();
  try {
    const cases: Array<[string, string[]]> = [
      ["cat Gemfile", []],
      ["cat ./Gemfile", ["./Gemfile"]],
      ["cat ./app/models/user.rb", ["./app/models/user.rb"]],
      ["cat /etc/hosts", ["/etc/hosts"]],
      ["rm ./app/models/user.rb", ["./app/models/user.rb"]],
      ["mv ./src/foo.rb ./src/bar.rb", ["./src/foo.rb", "./src/bar.rb"]],
      ["cp -r ./src ./dst", ["./src", "./dst"]],
      ["touch /tmp/foo/bar.txt", ["/tmp/foo/bar.txt"]],
    ];
    for (const [cmd, expected] of cases) assertExtracts(cmd, expected);
  } finally {
    cleanup(fx);
  }
});

test("symlinks, dotfiles, deep paths, unicode, and embedded spaces — extract as expected", () => {
  const fx = freshFixture();
  try {
    const cases: Array<[string, string[]]> = [
      ["cat ./.hidden/file", ["./.hidden/file"]],
      ["cat ../sibling/file", ["../sibling/file"]],
      ["cat ./.../weird", ["./.../weird"]],
      // Space breaks the regex char class, so the path is split into two
      // tokens. Today both tokens are checked (and most likely denied).
      ["cat ./path with space/file.txt", ["./path", "space/file.txt"]],
      ["cat /tmp/file-with-dash/and.dot/file", ["/tmp/file-with-dash/and.dot/file"]],
      // Non-ASCII characters break the char class. `é` and `é` are not in
      // [A-Za-z0-9_./@-], so the match truncates at the first non-ASCII.
      ["cat ./Café/résumé.txt", ["./Caf"]],
    ];
    for (const [cmd, expected] of cases) assertExtracts(cmd, expected);
  } finally {
    cleanup(fx);
  }
});

test("URL filtering — http(s) filtered; ftp/file also currently slip through due to the // sequence", () => {
  const fx = freshFixture();
  try {
    const cases: Array<[string, string[]]> = [
      ["curl -fsS https://example.com/path", []],
      ["curl -fsS http://example.com/path", []],
      ["curl -fsS ftp://example.com/path", []],
      // ssh://user@host/path: the `://` after `ssh` means the regex never
      // gets a clean start at `user` (preceded by `/`). So nothing extracts.
      ["curl -fsS ssh://user@host/path", []],
      // file:///etc/passwd: the `://` again breaks the chain. The leading
      // `/` after `://` IS preceded by `/` not whitespace, so the regex
      // never extracts anything.
      ["curl -fsS file:///etc/passwd", []],
    ];
    for (const [cmd, expected] of cases) assertExtracts(cmd, expected);
  } finally {
    cleanup(fx);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Reserved-path and type-policy layers run BEFORE the regex path tokens. The
// regex does not need to know about reserved paths; it only needs to know
// about real vs. arg-like tokens. These tests confirm the layering.
// ─────────────────────────────────────────────────────────────────────────

test("regex does extract reserved-path-looking strings (reserved-path layer runs on top)", () => {
  // The reserved-path layer (`src/engine/reserved-paths.ts`) inspects every
  // bare shell word via `enforceReservedPath(state, runtime, ctx, token, cap)`
  // for any path token the domain loop yields. Tokens never reach that
  // layer without first passing `extractBashPathTokens`, so the regex
  // behavior for reserved-path-looking strings is part of the layered
  // enforcement. Document the current state here; no change in behavior
  // is expected from a fix that only narrows the regex.
  const fx = freshFixture();
  try {
    const cmd = "cat .git/config";
    const tokens = extractBashPathTokens(cmd);
    assert.deepEqual(sortTokens(tokens), [".git/config"]);
  } finally {
    cleanup(fx);
  }
});

test("multi-statement and piped commands extract from every clause independently", () => {
  const fx = freshFixture();
  try {
    const cases: Array<[string, string[]]> = [
      ["cd src && cat app/models/user.rb", ["app/models/user.rb"]],
      ["cat src/foo.txt | tee /tmp/out.txt", ["src/foo.txt", "/tmp/out.txt"]],
      // Both `old/branch` references extract (they look the same to the
      // regex; the engine then resolves both against the same scope).
      ["git -C . branch -d old/branch && git push origin --delete old/branch", ["old/branch"]],
      ["(cd src && ls app/models) || true", ["app/models"]],
    ];
    for (const [cmd, expected] of cases) assertExtracts(cmd, expected);
  } finally {
    cleanup(fx);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Summary matrix — what a correct fix must preserve vs. drop. Used as a
// reviewer checklist; not enforced against current behavior.
// ─────────────────────────────────────────────────────────────────────────

test("summary — a correct fix must PRESERVE real-path extraction", () => {
  // Any fix to `extractBashPathTokens` MUST keep every entry under
  // "PRESERVE" extracting the same token. The current (pre-fix) behavior
  // matches these expectations, so the test passes today and continues
  // to pass after the fix as long as the fix does not regress these.
  const fx = freshFixture();
  try {
    const preserve: Array<[string, string[]]> = [
      ["cat ./app/models/user.rb", ["./app/models/user.rb"]],
      ["cat /etc/hosts", ["/etc/hosts"]],
      ["rm ./app/models/user.rb", ["./app/models/user.rb"]],
      ["mv ./src/foo.rb ./src/bar.rb", ["./src/foo.rb", "./src/bar.rb"]],
      ["cp -r ./src ./dst", ["./src", "./dst"]],
      ["touch /tmp/foo/bar.txt", ["/tmp/foo/bar.txt"]],
      ["cat ./.hidden/file", ["./.hidden/file"]],
      ["cat ../sibling/file", ["../sibling/file"]],
      ["git worktree add .worktrees/foo main", [".worktrees/foo"]],
      ["git worktree add --detach .worktrees/foo", [".worktrees/foo"]],
    ];
    for (const [cmd, expected] of preserve) assertExtracts(cmd, expected);
  } finally {
    cleanup(fx);
  }
});

test("summary — a correct fix must DROP ref-arg extraction via filterBashPathTokens (PASSES AFTER FIX)", () => {
  // These are the canonical false-positive tokens a fix MUST drop.
  // The regex alone still extracts them; the post-extraction filter
  // `filterBashPathTokens` drops them when the resolved path AND its
  // immediate parent do not exist. The filter is read-kind only:
  // upsert/delete-kind bash keeps all tokens so legitimate CREATE/DELETE
  // targets like `.worktrees/<dir>/` still pass.
  const fx = freshFixture();
  try {
    const cwd = fx.cwd;
    const ctx = { cwd } as any;

    const drop: Array<[string, "read" | "upsert" | "delete" | "command", string[]]> = [
      // Read-kind: ref args are dropped (neither path nor parent exists).
      ["git log feature/foo", "read", []],
      ["git log origin/main", "read", []],
      ["git log refs/heads/main", "read", []],
      // Read-kind: worktree-path token kept (parent exists), branch dropped.
      ["git worktree add .worktrees/foo -b bar/baz main", "read", [".worktrees/foo"]],
      // Read-kind: ref arg with embedded path (`origin/<branch>:HANDOFF.md`)
      // drops the leading ref; HANDOFF.md is past the `:` and not extracted.
      ["git show origin/docs/handoff-after-pr-348:HANDOFF.md", "read", []],
      ["git -C . branch -d docs/handoff-after-pr-348", "read", []],
      // Upsert-kind: filter does NOT run; all tokens kept (existing
      // allowMissing logic authorizes CREATE/DELETE targets).
      ["git push --delete origin feature/foo", "upsert", ["feature/foo"]],
      // Delete-kind: same as upsert; all tokens kept.
      ["rm ./app/models/user.rb", "delete", ["./app/models/user.rb"]],
      // Upsert-kind: legitimate CREATE target kept even though the path
      // does not exist yet — the upsert scope authorizes the creation.
      ["touch /tmp/new/dir/file.txt", "upsert", ["/tmp/new/dir/file.txt"]],
    ];
    for (const [cmd, kind, expected] of drop) {
      const raw = extractBashPathTokens(cmd);
      const filtered = filterBashPathTokens(ctx, raw, kind);
      assert.deepEqual(
        sortTokens(filtered),
        sortTokens(expected),
        cmd,
      );
    }
  } finally {
    cleanup(fx);
  }
});

test("filterBashPathTokens — PRESERVE cases that already pass (sanity check)", () => {
  const fx = freshFixture();
  try {
    const cwd = fx.cwd;
    const ctx = { cwd } as any;

    const preserve: Array<[string, "read" | "upsert" | "delete" | "command", string[]]> = [
      ["cat ./app/models/user.rb", "read", ["./app/models/user.rb"]], // parent exists
      ["cat /etc/hosts", "read", ["/etc/hosts"]], // path probably exists on test runner
      ["touch /tmp/foo/bar.txt", "upsert", ["/tmp/foo/bar.txt"]], // upsert keeps all
      ["rm ./app/models/user.rb", "delete", ["./app/models/user.rb"]], // delete keeps all
      ["mv ./src/foo.rb ./src/bar.rb", "upsert", ["./src/foo.rb", "./src/bar.rb"]],
    ];
    for (const [cmd, kind, expected] of preserve) {
      const raw = extractBashPathTokens(cmd);
      const filtered = filterBashPathTokens(ctx, raw, kind);
      assert.deepEqual(
        sortTokens(filtered),
        sortTokens(expected),
        cmd,
      );
    }
  } finally {
    cleanup(fx);
  }
});

test("filterBashPathTokens — stat and shape fallback discriminate real paths from git refs", () => {
  // Two-tier heuristic:
  // 1. Stat check: path-or-parent existence is the primary signal.
  // 2. Shape fallback: when stat is inconclusive (path and parent both
  //    don't exist), tokens with strong path markers (absolute, `./`/
  //    `../` prefix, file extension, dotfile) are kept. Tokens without
  //    markers (like `feature/foo`) are likely git refs and dropped.
  // This makes the filter robust to sandbox-mediated stat calls (which
  // can return inaccurate values) without re-introducing git-ref
  // false positives.
  const fx = freshFixture();
  try {
    const cwd = fx.cwd;
    const ctx = { cwd } as any;

    // — Stat check —

    // Path exists → kept.
    writeFileSync(join(cwd, "real-file.txt"), "x");
    assert.deepEqual(
      sortTokens(filterBashPathTokens(ctx, extractBashPathTokens("cat real-file.txt"), "read")),
      sortTokens([]), // no `/`, not extracted
      "no-slash arg stays un-extracted",
    );

    // Path does not exist, parent exists → kept (stat: parent wins).
    assert.deepEqual(
      sortTokens(filterBashPathTokens(ctx, extractBashPathTokens("cat ./real-file.txt"), "read")),
      sortTokens(["./real-file.txt"]),
      "parent-exists path is kept",
    );

    // — Shape fallback: kept despite stat failing —

    // `./`-prefixed token with a file extension → kept via shape, even
    // though neither path nor parent exists. Resilient to sandbox
    // stat mediation.
    assert.deepEqual(
      sortTokens(filterBashPathTokens(ctx, extractBashPathTokens("cat ./missing-dir/missing.txt"), "read")),
      sortTokens(["./missing-dir/missing.txt"]),
      "./-prefixed path with extension kept via shape fallback",
    );

    // File-extension-only path (relative, no `./` prefix) → kept via
    // shape. Sandbox-resilient.
    assert.deepEqual(
      sortTokens(filterBashPathTokens(ctx, extractBashPathTokens("cat nonexistent-dir/file.txt"), "read")),
      sortTokens(["nonexistent-dir/file.txt"]),
      "file-extension marker keeps the token via shape fallback",
    );

    // Dotfile basename → kept via shape.
    assert.deepEqual(
      sortTokens(filterBashPathTokens(ctx, extractBashPathTokens("cat feature/.gitignore"), "read")),
      sortTokens(["feature/.gitignore"]),
      "dotfile basename keeps the token via shape fallback",
    );

    // Absolute path whose parent also doesn't exist → kept via shape.
    assert.deepEqual(
      sortTokens(filterBashPathTokens(ctx, extractBashPathTokens("cat /nonexistent-root/file.txt"), "read")),
      sortTokens(["/nonexistent-root/file.txt"]),
      "absolute path kept via shape fallback",
    );

    // — Shape fallback: dropped when no markers —

    // Git-ref-like token (`feature/foo`) with no markers → dropped.
    // This is the canonical false-positive the filter must keep dropping.
    assert.deepEqual(
      sortTokens(filterBashPathTokens(ctx, extractBashPathTokens("git log feature/foo"), "read")),
      sortTokens([]),
      "git-ref-like token without shape markers is dropped",
    );

    // Same for `origin/main`, `master`, `refs/heads/main`.
    for (const cmd of [
      "git log origin/main",
      "git log master",
      "git log refs/heads/main",
    ]) {
      assert.deepEqual(
        sortTokens(filterBashPathTokens(ctx, extractBashPathTokens(cmd), "read")),
        sortTokens([]),
        `git-ref-like token in "${cmd}" is dropped`,
      );
    }

    // Same token in upsert context → kept (filter does not run).
    assert.deepEqual(
      sortTokens(filterBashPathTokens(ctx, extractBashPathTokens("touch ./missing-dir/missing.txt"), "upsert")),
      sortTokens(["./missing-dir/missing.txt"]),
      "upsert keeps tokens even when path and parent do not exist",
    );
  } finally {
    cleanup(fx);
  }
});

// ─────────────────────────────────────────────────────────────────
// Lexer-based extraction: quoted strings are data, interpreter
// arguments recurse, env-var assignments are skipped.
// ─────────────────────────────────────────────────────────────────
test("lexer: quoted path-shaped substrings inside echo/printf/grep are not extracted", () => {
  const fx = freshFixture();
  try {
    const cases: Array<[string, string[], string]> = [
      // The user's actual smoke-test regression.
      [
        "grep -nE '^\\s*/?tmp' .worktrees/feature/.gitignore 2>&1 || echo \"no /tmp ignore line\"",
        [".worktrees/feature/.gitignore"],
        "smoke-test command — /tmp inside double-quoted echo message is data",
      ],
      [
        "echo \"see /etc/passwd for details\"",
        [],
        "echo argument is data; embedded path-shaped substring is not",
      ],
      [
        "printf 'see /etc/passwd now'",
        [],
        "printf format string is data; embedded path-shaped substring is not",
      ],
      [
        "grep \"x /etc/passwd y\" file",
        [],
        "grep pattern is data; embedded path-shaped substring is not",
      ],
      [
        "awk '/pat/' file",
        [],
        "awk script is data; not recursed (accepted limit)",
      ],
      [
        "find . -name '*.rb'",
        [],
        "find -name pattern is data; not extracted",
      ],
      [
        "sed -nE '/^\\s*tmp/p' .gitignore",
        [],
        "sed script is data; not extracted",
      ],
      // Bare path regression guard.
      ["cat /etc/passwd", ["/etc/passwd"], "bare path still extracts"],
      // Mixed bare + quoted.
      [
        "cat /etc/hosts && echo \"see /tmp log\"",
        ["/etc/hosts"],
        "bare /etc/hosts extracts; quoted /tmp in echo does not",
      ],
    ];
    for (const [cmd, expected] of cases) assertExtracts(cmd, expected);
  } finally {
    cleanup(fx);
  }
});

test("lexer: code-executing interpreters recurse into quoted code arguments", () => {
  const fx = freshFixture();
  try {
    const cases: Array<[string, string[], string]> = [
      // eval: every quoted arg is code.
      [
        "eval \"cat /etc/passwd\"",
        ["/etc/passwd"],
        "eval quoted arg — recurses",
      ],
      [
        "eval cat \"/etc/passwd\"",
        ["/etc/passwd"],
        "eval mixed args — recurses on quoted portion",
      ],
      // bash / sh / dash / ksh / zsh / ash -c.
      [
        "bash -c \"cat /etc/passwd\"",
        ["/etc/passwd"],
        "bash -c — recurses into quoted script",
      ],
      [
        "sh -c \"cat /etc/passwd\"",
        ["/etc/passwd"],
        "sh -c — recurses into quoted script",
      ],
      [
        "dash -c \"cat /etc/passwd\"",
        ["/etc/passwd"],
        "dash -c — recurses into quoted script",
      ],
      [
        "zsh -c \"cat /etc/passwd\"",
        ["/etc/passwd"],
        "zsh -c — recurses into quoted script",
      ],
      [
        "bash -lc \"cat /etc/passwd\"",
        ["/etc/passwd"],
        "bash -lc — -l flag is ignored, -c still recurses",
      ],
      // perl -e, python -c, python3 -c, ruby -e, node -e.
      [
        "perl -e 'open(F, q{> /etc/passwd}); print F qq{x}'",
        ["/etc/passwd"],
        "perl -e — recurses into quoted script (regex sees /etc/passwd inside the script text)",
      ],
      [
        "python -c \"open('/etc/passwd').read()\"",
        [],
        "python -c — Python's string quoting hides the path from the bash regex (pre-existing accepted limit per AGENTS.md)",
      ],
      [
        "python3 -c \"open('/etc/passwd').read()\"",
        [],
        "python3 -c — same accepted limit",
      ],
      [
        "ruby -e 'puts File.read(\"/etc/passwd\")'",
        [],
        "ruby -e — quoted string with no whitespace before / (pre-existing accepted limit per AGENTS.md)",
      ],
      [
        "node -e \"require('fs').readFileSync('/etc/passwd')\"",
        [],
        "node -e — same accepted limit",
      ],
    ];
    for (const [cmd, expected] of cases) assertExtracts(cmd, expected);
  } finally {
    cleanup(fx);
  }
});

test("lexer: env-var assignments are not extracted (preserves the documented workaround)", () => {
  const fx = freshFixture();
  try {
    const cases: Array<[string, string[], string]> = [
      [
        "WP='.worktrees/foo' B='feature/foo' REF='origin/main' git -C . worktree add \"$WP\" -b \"$B\" \"$REF\"",
        [],
        "env-var form — all assignments skipped, quoted $WP/$B/$REF skipped (git is not an interpreter)",
      ],
      [
        "export WP=.worktrees/foo",
        [],
        "export assignment — skipped",
      ],
    ];
    for (const [cmd, expected] of cases) assertExtracts(cmd, expected);
  } finally {
    cleanup(fx);
  }
});

test("lexer: unbalanced quotes fall back to the legacy regex (no crash, same output)", () => {
  const fx = freshFixture();
  try {
    // Unbalanced double quote: the lexer returns null; the legacy regex
    // takes over and still extracts whatever it can.
    const cmd = "cat \"unclosed file";
    const out = extractBashPathTokens(cmd);
    assert.ok(Array.isArray(out), "returns array (no crash)");
    // Legacy regex sees the unclosed command; the `/`-containing path-shaped
    // tokens (none in this fixture) would still be extracted. We just lock in
    // that the call returns without throwing.
    assert.ok(out.length === 0, "no path-shaped tokens in this particular unclosed-quote case");
  } finally {
    cleanup(fx);
  }
});
