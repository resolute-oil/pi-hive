import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { AgentRuntime, DomainScope, HiveState } from "../core/types";
import { currentAgentName } from "./session";
import { resolveRuntime } from "./agent-lookup";
import { agentMatches } from "../core/utils";
import { globToRegExp, globSpecificity, toPosixPath } from "./glob";
import { classify } from "./file-class";
import { checkPlannerStages, checkTypePolicy, type PolicyAction, type PolicyDecision } from "./policy";
import { hasForeignAbsoluteSyntax, isPathInside, resolveConfiguredPath, resolveContainedPath } from "../core/safe-path";
import { checkReservedPath, type ReservedPathAccess } from "./reserved-paths";

function runtimeForCaller(state: HiveState, callerName: string): AgentRuntime | undefined {
  return resolveRuntime(state, callerName);
}

export function canDelegateTo(state: HiveState, callerName: string, targetName: string): { ok: boolean; reason?: string } {
  const caller = runtimeForCaller(state, callerName);
  if (!caller) return { ok: true };
  // Delegation is scoped to direct reports for EVERY node, including the
  // orchestrator (whose reports are the team leads). No blanket bypass.
  const allowed = caller.config.allowedAgents;
  const target = resolveRuntime(state, targetName);
  if (allowed && target && allowed.some((id) => agentMatches(target.config, id))) return { ok: true };
  // Inspection widening: a caller may also delegate to any configured agent
  // whose agent-type is in {coder, tester, reviewer, planner}. This lets the
  // orchestrator route read-only inspections directly to a typed specialist
  // (e.g. an idle frontend-coder) without going through a parent lead.
  // lead-typed agents stay tree-bound — they coordinate work, they don't
  // answer inspections directly. The downstream bash/file policy
  // (WRITABLE_CLASSES, readOnlyCommandDecision, commit-field gate) still
  // applies to the delegated worker session regardless of who delegated to
  // it; the widening is a permission, not a sandbox.
  if (target && ["coder", "tester", "reviewer", "planner"].includes(target.config.agentType || "")) {
    return { ok: true };
  }
  if (allowed?.length === 0 || caller.config.role === "member") {
    return { ok: false, reason: `${caller.config.name} is not configured to delegate to other agents.` };
  }
  return { ok: false, reason: `${caller.config.name} can only delegate to: ${allowed?.join(", ") || "none"}, or to typed specialists in {coder, tester, reviewer, planner}.` };
}

export function pathWithin(parent: string, child: string): boolean {
  return isPathInside(parent, child);
}

export function resolveDomainPath(ctx: ExtensionContext, rawPath: string): string {
  return resolve(ctx.cwd, rawPath || ".");
}

function matchingGlobSpecificity(patterns: string[] | undefined, relativePath: string): number | undefined {
  if (!patterns?.length) return 0;
  let best: number | undefined;
  for (const pattern of patterns) {
    if (!globToRegExp(pattern).test(relativePath)) continue;
    best = Math.max(best ?? 0, globSpecificity(pattern));
  }
  return best;
}

function excludedBy(scope: DomainScope, relativePath: string): boolean {
  return Boolean(scope.exclude?.some((pattern) => globToRegExp(pattern).test(relativePath)));
}

function domainScopeMatch(ctx: ExtensionContext, scope: DomainScope, target: string, allowMissing: boolean): { matches: boolean; specificity: number } {
  const resolvedScope = resolveConfiguredPath(ctx.cwd, scope.path, scope.allowOutsideProject === true, { allowMissing: true });
  if (!resolvedScope) return { matches: false, specificity: 0 };
  const scopePath = resolvedScope.canonicalPath;
  const contained = resolveContainedPath(scopePath, target, { allowMissing });
  if (!contained) return { matches: false, specificity: 0 };
  const relativePath = toPosixPath(relative(scopePath, contained.lexicalPath) || ".");
  if (excludedBy(scope, relativePath)) return { matches: false, specificity: 0 };
  const includeSpecificity = matchingGlobSpecificity(scope.include, relativePath);
  if (includeSpecificity === undefined) return { matches: false, specificity: 0 };
  return { matches: true, specificity: scopePath.length * 10_000 + includeSpecificity };
}

// Resolve a capability for a target path by MOST-SPECIFIC-WINS:
//
//   - Consider every scope whose resolved path covers the target.
//   - If a scope has include globs, the target must match at least one include;
//     exclude globs remove the target from that scope.
//   - The deepest path wins. At the same path, matching include globs beat a
//     catch-all rule, so an explicit read-only catch-all can coexist with a
//     narrower "upsert tests only" rule.
//   - On an exact specificity tie, DENY wins (fail safe).
//   - If no scope matches, the default is DENY.
export function domainAllows(ctx: ExtensionContext, runtime: AgentRuntime, rawPath: string, capability: "read" | "upsert" | "delete", options?: { allowMissing?: boolean }): boolean {
  if (hasForeignAbsoluteSyntax(rawPath)) return false;
  const target = resolveDomainPath(ctx, rawPath);
  let bestSpecificity = -1;
  let decision = false;
  // Default: upsert allows non-existent targets (CREATE targets are
  // authorized before they exist on disk). Read/delete require the
  // target to already exist. Bash callers pass `allowMissing: true`
  // because bash path tokens are heuristics, not authoritative
  // existence checks; the shell surfaces "no such file" at run time.
  const allowMissing = options?.allowMissing ?? (capability === "upsert");
  for (const scope of runtime.config.domain || []) {
    const match = domainScopeMatch(ctx, scope, target, allowMissing);
    if (!match.matches) continue;
    const opinion = scope[capability];
    if (match.specificity > bestSpecificity) {
      bestSpecificity = match.specificity;
      decision = opinion;
    } else if (match.specificity === bestSpecificity && opinion === false) {
      decision = false; // tie-break: deny wins
    }
  }
  return decision;
}

function formatScope(scope: DomainScope): string {
  const patterns = [
    scope.include?.length ? ` include:${scope.include.join("|")}` : "",
    scope.exclude?.length ? ` exclude:${scope.exclude.join("|")}` : "",
  ].join("");
  return `${scope.path}${patterns}`;
}

export function formatDomainRules(runtime: AgentRuntime, capability: "read" | "upsert" | "delete"): string {
  const scopes = runtime.config.domain || [];
  const allowed = scopes.filter((scope) => scope[capability] === true).map(formatScope);
  const denied = scopes.filter((scope) => scope[capability] === false).map(formatScope);
  if (allowed.length === 0 && denied.length === 0) return "none";
  const parts: string[] = [];
  if (allowed.length) parts.push(allowed.join(", "));
  if (denied.length) parts.push(`(denied: ${denied.join(", ")})`);
  return parts.join(" ");
}

export function extractToolPaths(toolName: string, input: any): string[] {
  const paths: string[] = [];
  const add = (value: any) => {
    if (typeof value === "string" && value.trim()) paths.push(value.trim());
    if (Array.isArray(value)) value.forEach(add);
  };

  add(input?.path);
  add(input?.paths);
  add(input?.file);
  add(input?.files);
  add(input?.filename);
  add(input?.directory);
  add(input?.cwd);

  if (["grep", "find", "ls"].includes(toolName) && paths.length === 0) paths.push(".");
  return Array.from(new Set(paths));
}

// Path-shaped regex shared by the lexer-based extractor and the legacy
// fallback. Matches relative or absolute paths containing a `/`. Same
// accepted limitation as before: a BARE filename with no slash fails OPEN
// for reads, since tightening would false-positive on every bash word.
const PATH_TOKEN_RE = /(?:^|\s)(\.{0,2}\/?[A-Za-z0-9_.-]+\/[A-Za-z0-9_./@-]+|\/[A-Za-z0-9_./@-]+)/g;
const URL_PREFIX_RE = /^https?:\/\//;

function isUrlToken(token: string): boolean {
  return URL_PREFIX_RE.test(token);
}

function extractPathTokensFromString(text: string): string[] {
  const matches = text.match(PATH_TOKEN_RE) || [];
  return Array.from(new Set(matches.map((m) => m.trim()).filter((t) => !isUrlToken(t))));
}

// Legacy fallback: regex on the raw command string. Used when the lexer
// rejects the command (unbalanced quotes, background job, etc.). Behavior
// matches the original implementation exactly.
function legacyExtractBashPathTokens(command: string): string[] {
  return extractPathTokensFromString(command);
}

// Extract path-like tokens from a bash command for read-domain checks. The
// implementation is lexer-based: we tokenize the command with `tokenizeBash`
// (which preserves quote context), then for each clause:
//   - skip env-var assignments (`VAR=value`);
//   - skip quoted tokens UNLESS the clause is a code-executing interpreter
//     (eval, bash -c, perl -e, ...) whose quoted argument is recursed into;
//   - apply the existing path regex to every other (unquoted, non-env) token.
// This eliminates false positives where a path-shaped substring appears
// inside a quoted string the agent doesn't operate on as a filesystem path
// (e.g. `"no /tmp ignore line"` in an echo argument), while preserving
// protection for code-execution forms like `eval "cat /etc/passwd"`.
export function extractBashPathTokens(command: string): string[] {
  const lexed = tokenizeBash(command);
  if (lexed === null) return legacyExtractBashPathTokens(command);

  const out = new Set<string>();

  for (const clause of lexed) {
    const head = clause.tokens[0]?.text ?? "";
    const spec = INTERPRETER_CODE_ARGS.find((p) => p.command === head);

    for (let i = 0; i < clause.tokens.length; i++) {
      const token = clause.tokens[i];

      if (token.isEnvAssignment) continue;

      if (token.quoted) {
        // Quoted token: data, unless this clause's command is an interpreter
        // whose quoted argument is code.
        if (spec) {
          const recurse = spec.mode === "shell"
            ? (inner: string) => extractBashPathTokens(inner)
            : (inner: string) => extractPathTokensFromString(inner);
          if (spec.flag === null) {
            // eval: any quoted token after `eval` is code (the rest are
            // concatenated and re-parsed by the shell).
            if (i > 0) {
              for (const path of recurse(token.text)) out.add(path);
            }
          } else {
            // bash -c, sh -c, perl -e, python -c, ruby -e, node -e: the token
            // immediately following the named flag is the code argument.
            // Accept either the exact flag (`-c`) or a combined-flag token
            // (`-lc`, `-cl`, `-pei`, etc.) that contains the flag char — bash
            // parses these as `-l -c`, `-c -l`, etc.
            const flagChar = spec.flag.slice(1);
            const flagIdx = clause.tokens.findIndex((t, idx) => {
              if (idx === 0) return false;
              if (t.text === spec.flag) return true;
              if (t.text === "--") return false;
              if (!t.text.startsWith("-")) return false;
              return t.text.includes(flagChar);
            });
            if (flagIdx !== -1 && i === flagIdx + 1) {
              for (const path of recurse(token.text)) out.add(path);
            }
          }
        }
        continue;
      }

      // Unquoted, non-env-assignment token: apply the path regex.
      for (const path of extractPathTokensFromString(token.text)) out.add(path);
    }
  }

  return Array.from(out);
}

// Bash path tokens are a regex match, so they conflate real paths with
// git ref / branch / remote-ref arguments (anything shaped `<word>/<word>`
// looks the same to the regex). `filterBashPathTokens` is a post-extraction
// pass that drops tokens which the regex picked up but which are almost
// certainly NOT filesystem paths: the resolved path does not exist AND
// its immediate parent directory does not exist AND the token has no
// path-shape markers (absolute path, `./`/`../` prefix, file extension,
// or dotfile basename). Git ref arguments never materialize as on-disk
// paths and rarely have an existing parent in the cwd; they also lack
// path-shape markers. Real paths either exist (the common case for
// reads and deletes), have an existing parent (the common case for
// CREATE targets like `.worktrees/<dir>/`), or carry a path-shape
// marker (the common case for sandbox-mediated stat calls that return
// inaccurate values, and for absolute paths whose parent doesn't exist
// on the test runner).
//
// The filter is applied only to read-classified bash. For upsert/delete
// bash (which covers legitimate `touch`, `mkdir`, `mv`, `cp`, `rm`, `git
// push --delete`, etc.) the original tokens are kept: the domain check
// already handles non-existent CREATE targets via `allowMissing: true`,
// and the pathless-mutation fail-safe continues to apply.
export function filterBashPathTokens(ctx: ExtensionContext, tokens: string[], kind: "read" | "upsert" | "delete" | "command"): string[] {
  if (kind !== "read" && kind !== "command") return tokens;
  return tokens.filter((token) => isLikelyFilesystemPath(ctx, token));
}

function isLikelyFilesystemPath(ctx: ExtensionContext, token: string): boolean {
  const resolved = resolveDomainPath(ctx, token);
  // Stat-based heuristic, wrapped to tolerate sandbox environments where
  // existsSync can throw (permission-denied intermediates, restricted
  // syscall surface). On throw, treat as "stat inconclusive" and let the
  // shape check decide.
  if (safeStat(resolved)) return true;
  const parent = dirname(resolved);
  if (safeStat(parent)) return true;
  // Stat said no for both path and parent. Fall back to SHAPE: tokens with
  // strong path markers are very likely real paths. Tokens without
  // markers — e.g. `origin/main`, `feature/foo`, `master` — are likely
  // git refs and remain dropped. This makes the filter robust to:
  //   - sandbox-mediated stat calls that return inaccurate values
  //     (HANDOFF.md deferred item #3);
  //   - CREATE targets whose parent directory doesn't exist yet
  //     (e.g. `.worktrees/fix-foo/file.txt` before the shell creates it);
  //   - absolute paths like `/etc/missing-file.txt` whose parent (`/etc`)
  //     may not exist on the test runner (e.g. macOS sandboxed CI).
  //
  // Shape is checked on the ORIGINAL token, not the resolved path —
  // resolveDomainPath always returns an absolute path (cwd-prefixed), so
  // checking the resolved path would mark every token as absolute.
  return looksLikePathByShape(token);
}

function safeStat(filePath: string): boolean {
  try {
    return existsSync(filePath);
  } catch {
    return false;
  }
}

function looksLikePathByShape(resolved: string): boolean {
  // Absolute paths are real paths.
  if (resolved.startsWith("/")) return true;
  // Paths starting with `./` or `../` are relative real paths.
  if (resolved.startsWith("./") || resolved.startsWith("../")) return true;
  const base = resolved.split("/").pop() ?? "";
  // Files with a recognizable extension are real paths.
  if (base.length > 1 && /\.[a-zA-Z0-9]+$/.test(base)) return true;
  // Dotfiles are real paths (.gitignore, .env, .npmrc, etc.).
  if (base.length > 1 && base.startsWith(".")) return true;
  return false;
}

type ParsedCommand = { words: string[]; operatorBefore?: string };

// A deliberately small shell lexer. It supports ordinary quoting and command
// separators, but marks expansion/redirection syntax as unsafe for read-only
// agents rather than pretending to understand a full shell grammar.
function parseShellCommands(command: string): ParsedCommand[] | null {
  const commands: ParsedCommand[] = [];
  let words: string[] = [];
  let word = "";
  let quote = "";
  let escaped = false;
  let pendingOperator: string | undefined;
  const pushWord = () => { if (word) { words.push(word); word = ""; } };
  const pushCommand = (operator?: string) => {
    pushWord();
    if (!words.length) return false;
    commands.push({ words, operatorBefore: pendingOperator });
    words = [];
    pendingOperator = operator;
    return true;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) { word += ch; escaped = false; continue; }
    if (ch === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (ch === quote) quote = "";
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (/\s/.test(ch)) { pushWord(); continue; }
    if (ch === ";" || ch === "|" || ch === "&") {
      const pair = command.slice(i, i + 2);
      const op = pair === "||" || pair === "&&" ? pair : ch;
      if (op === "&") return null; // background jobs are ambiguous
      if (!pushCommand(op)) return null;
      if (op.length === 2) i++;
      continue;
    }
    word += ch;
  }
  if (escaped || quote) return null;
  pushWord();
  if (words.length) commands.push({ words, operatorBefore: pendingOperator });
  else if (pendingOperator) return null;
  return commands.length ? commands : null;
}

// Path-extraction needs to know whether each token came from inside quotes
// (data argument — skip) or unquoted (potentially a filesystem path the agent
// operates on). `parseShellCommands` strips quotes on entry, so it can't
// answer that. `tokenizeBash` is its sibling: same shell syntax, but each
// returned token carries `quoted` and `isEnvAssignment` flags. Returns null
// on unbalanced quotes — the caller falls back to the legacy regex.
type LexToken = { text: string; quoted: boolean; isEnvAssignment: boolean };
type LexClause = { tokens: LexToken[]; operatorBefore?: string };
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

function tokenizeBash(command: string): LexClause[] | null {
  const clauses: LexClause[] = [];
  let tokens: LexToken[] = [];
  let text = "";
  let quoted = false;
  let quote = "";
  let escaped = false;
  let pendingOperator: string | undefined;
  const pushToken = () => {
    if (text) {
      tokens.push({ text, quoted, isEnvAssignment: ENV_ASSIGNMENT_RE.test(text) });
      text = "";
      quoted = false;
    }
  };
  const pushClause = (operator?: string) => {
    pushToken();
    if (!tokens.length) return false;
    clauses.push({ tokens, operatorBefore: pendingOperator });
    tokens = [];
    pendingOperator = operator;
    return true;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) { text += ch; escaped = false; continue; }
    if (ch === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (ch === quote) quote = "";
      else text += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; quoted = true; continue; }
    if (/\s/.test(ch)) { pushToken(); continue; }
    if (ch === ";" || ch === "|" || ch === "&") {
      const pair = command.slice(i, i + 2);
      const op = pair === "||" || pair === "&&" ? pair : ch;
      if (op === "&") {
        // `&` is ambiguous by itself (background job), UNLESS it's part of a
        // shell redirection: `>&` (preceded by `>` in the current token), or
        // `&>` / `&>>` (combined redirect at the start of a token). Recognize
        // those so common idioms like `2>&1` and `cmd &> file` don't force a
        // fallback to the legacy regex.
        if (text.endsWith(">")) { text += ch; continue; }
        if (pair === "&>") { text += "&>"; i++; continue; }
        return null; // bare background job
      }
      if (!pushClause(op)) return null;
      if (op.length === 2) i++;
      continue;
    }
    text += ch;
  }
  if (escaped || quote) return null;
  pushToken();
  if (tokens.length) clauses.push({ tokens, operatorBefore: pendingOperator });
  else if (pendingOperator) return null;
  return clauses.length ? clauses : null;
}

// Code-executing interpreters whose quoted argument is *code*, not data.
// Recursing into these quoted arguments restores extraction for cases like
// `eval "cat /etc/passwd"` and `bash -c "cat /etc/passwd"`.
//
// Two modes:
//   - "shell": the quoted argument is itself bash — recurse with bash
//     parsing (eval, bash -c, sh -c, ...).
//   - "script": the quoted argument is a script in another language — apply
//     the path regex directly to the raw text. Quoting inside the script
//     (e.g. Python's `open('/etc/passwd')`) uses the language's own string
//     syntax, not bash, so a bash-aware lexer would (incorrectly) skip the
//     path. Code-mode bypasses quote-awareness entirely.
//
// AWK, sed, find -exec, and similar DSLs are deliberately absent — their
// quoted arguments are accepted limits per AGENTS.md. Adding a row is a
// one-line change with a clear test case.
const INTERPRETER_CODE_ARGS: ReadonlyArray<{
  command: string;
  flag: string | null;
  mode: "shell" | "script";
}> = [
  { command: "eval",    flag: null, mode: "shell"  },
  { command: "bash",    flag: "-c", mode: "shell"  },
  { command: "sh",      flag: "-c", mode: "shell"  },
  { command: "dash",    flag: "-c", mode: "shell"  },
  { command: "ksh",     flag: "-c", mode: "shell"  },
  { command: "zsh",     flag: "-c", mode: "shell"  },
  { command: "ash",     flag: "-c", mode: "shell"  },
  { command: "perl",    flag: "-e", mode: "script" },
  { command: "python",  flag: "-c", mode: "script" },
  { command: "python3", flag: "-c", mode: "script" },
  { command: "ruby",    flag: "-e", mode: "script" },
  { command: "node",    flag: "-e", mode: "script" },
];

const GIT_GLOBAL_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

function gitSubcommand(words: string[]): { subcommand: string; args: string[]; safeGlobals: boolean } | null {
  if (words[0] !== "git") return null;
  let i = 1;
  let safeGlobals = true;
  while (i < words.length) {
    const token = words[i];
    if (GIT_GLOBAL_VALUE_OPTIONS.has(token)) {
      if (token === "-c") safeGlobals = false;
      if (i + 1 >= words.length) return { subcommand: "", args: [], safeGlobals: false };
      i += 2;
      continue;
    }
    if (/^--(?:git-dir|work-tree|namespace)=/.test(token)) { i++; continue; }
    if (/^-c=/.test(token)) { safeGlobals = false; i++; continue; }
    if (token.startsWith("-")) { safeGlobals = false; i++; continue; }
    break;
  }
  return { subcommand: words[i] || "", args: words.slice(i + 1), safeGlobals };
}

function classifiedGitSubcommand(words: string[]): ReturnType<typeof gitSubcommand> {
  let i = 0;
  if (words[i] === "command") i++;
  if (words[i] === "env") {
    i++;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] || "")) i++;
  }
  return gitSubcommand(words.slice(i));
}

const GIT_DELETE_COMMANDS = new Set(["clean", "restore"]);
const GIT_MUTATION_COMMANDS = new Set([
  "add", "am", "apply", "checkout", "cherry-pick", "commit", "fetch", "merge",
  "mv", "pull", "push", "rebase", "reset", "restore", "revert", "rm", "stash",
  "switch", "tag",
]);
const READ_ONLY_GIT_COMMANDS = new Set(["status", "diff", "log", "show", "blame", "rev-parse", "ls-files"]);
const READ_ONLY_COMMANDS = new Set([
  "basename", "cat", "cd", "cmp", "cut", "dirname", "du", "file", "find", "grep",
  "head", "ls", "pwd", "readlink", "realpath", "rg", "sort", "stat", "tail",
  "uniq", "wc",
]);
const NETWORK_COMMANDS = new Set(["curl", "wget", "nc", "ncat", "telnet", "ssh", "scp", "sftp", "ftp"]);

function commandUsesNetwork(parsed: ParsedCommand[], command = ""): boolean {
  return parsed.some(({ words }) => NETWORK_COMMANDS.has(words[0] || ""))
    || /(?:^|[\s;&|])(?:[^\s;&|]*\/)?(?:curl|wget|nc|ncat|telnet|ssh|scp|sftp|ftp)(?=\s|$)/.test(command);
}

function targetsDashboardLoopback(command: string): boolean {
  return /(?:https?:\/\/)?(?:127(?:\.\d{1,3}){3}|localhost|0\.0\.0\.0|\[?::1\]?):43191(?:[\s/'"?]|$)/i.test(command);
}

// Reviewer/lead shell policy. Unknown commands, shell expansion, interpreters,
// project scripts, and mutating Git are denied instead of falling through as
// reads. Network inspection is opt-in and remains unable to reach the local
// dashboard API.
export function readOnlyCommandDecision(command: string, networkAllowed = false): PolicyDecision {
  if (!command.trim()) return { ok: false, reason: "empty or pathless shell command" };
  if (/[`$<>{}\n]/.test(command)) return { ok: false, reason: "shell expansion, redirection, or multiline syntax is not permitted" };
  const parsed = parseShellCommands(command);
  if (!parsed) return { ok: false, reason: "ambiguous shell syntax" };
  if (targetsDashboardLoopback(command)) return { ok: false, reason: "worker access to the pi-hive dashboard loopback API is blocked" };
  if (commandUsesNetwork(parsed, command) && !networkAllowed) return { ok: false, reason: "network access is not enabled for this agent" };

  for (const { words } of parsed) {
    const head = words[0] || "";
    const git = gitSubcommand(words);
    if (git) {
      if (!git.safeGlobals || !READ_ONLY_GIT_COMMANDS.has(git.subcommand)) {
        return { ok: false, reason: `git ${git.subcommand || "command"} is not an allowed inspection operation` };
      }
      if (git.args.some((arg) => arg === "--ext-diff" || arg === "--textconv" || arg === "--output" || arg.startsWith("--output=") || arg.startsWith("--exec="))) {
        return { ok: false, reason: `git ${git.subcommand} option may execute or write` };
      }
      continue;
    }
    if (head === "curl" && networkAllowed) {
      if (!/https?:\/\//i.test(command) || words.slice(1).some((arg) => /^(?:-o|-O|-T|-d|-F|-K|--output|--remote-name|--upload-file|--data(?:-binary|-raw|-urlencode)?|--form|--request|--config|--json|--next|-X)(?:=|$)/.test(arg))) {
        return { ok: false, reason: "curl is limited to read-only GET/HEAD requests" };
      }
      continue;
    }
    if (!READ_ONLY_COMMANDS.has(head)) return { ok: false, reason: `${head || "command"} is not in the read-only inspection allowlist` };
    if (head === "find" && words.some((arg) => /^(?:-delete|-exec|-execdir|-ok|-okdir|-fprint|-fprintf|-fls)$/.test(arg))) {
      return { ok: false, reason: "find action may execute or write" };
    }
    if (head === "sort" && words.some((arg) => arg === "-o" || arg === "--output" || arg.startsWith("--output=") || arg.startsWith("--compress-program="))) {
      return { ok: false, reason: "sort option may execute or write" };
    }
  }
  return { ok: true };
}

export function bashMutationKind(command: string): "delete" | "upsert" | "read" {
  const parsed = parseShellCommands(command) || [];
  const gitCommands = parsed.map(({ words }) => classifiedGitSubcommand(words)?.subcommand).filter(Boolean) as string[];
  // Deletions and destructive working-tree operations.
  if (/\brm\b|\brmdir\b/.test(command)) return "delete";
  if (/\bfind\b[^\n]*\s-delete\b/.test(command)) return "delete";
  if (gitCommands.some((subcommand) => GIT_DELETE_COMMANDS.has(subcommand))) return "delete";
  if (parsed.some(({ words }) => {
    const git = classifiedGitSubcommand(words);
    return git?.subcommand === "checkout" && git.args.includes("--");
  })) return "delete";
  // Upserts include every Git repository/history mutation, patch/archive
  // extraction, package installation, and known file-writing command.
  if (gitCommands.some((subcommand) => GIT_MUTATION_COMMANDS.has(subcommand))) return "upsert";
  if (/\b(mv|cp|touch|mkdir|chmod|chown|ln|truncate|rsync|install|patch|unzip|gunzip|bunzip2|unxz)\b|\bsed\s+-i\b|\bperl\s+-pi\b|\btee\b/.test(command)) return "upsert";
  // G6: stdout/appender redirect (`>`, `>>`) is a file mutation; stderr /
  // combined / fd-target redirects (`2>`, `2>&1`, `&>`, `&>>`, `>&N`,
  // `N>&M`) are stream plumbing and don't classify the command as an upsert.
  // Strip the non-mutating forms before matching `>` / `>>` so `2>&1`
  // doesn't trip this branch.
  const noStreamPlumbing = command.replace(/[2-9]>>?|&>>?|>&\d|[2-9]>&\d/g, "");
  if (/>>?/.test(noStreamPlumbing)) return "upsert";
  if (/\b(?:tar|bsdtar)\s+(?:-[^\s]*[xcru]|[xcru][^\s]*|--(?:extract|create|append|update))|\b7z\s+(?:x|e|a)\b|\bjar\s+[xcu]/.test(command)) return "upsert";
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|remove|uninstall)\b|\b(?:pip|pip3|apt|apt-get|dnf|yum|apk|cargo|gem|go)\s+(?:install|add)\b|\bcomposer\s+(?:install|require|remove)\b/.test(command)) return "upsert";
  if (/\bcurl\b[^\n]*(?:\s-o(?:\s|$)|\s--output(?:=|\s)|\s-O(?:\s|$)|\s--remote-name(?:\s|$))/.test(command)) return "upsert";
  if (/\bwget\b/.test(command) && !/\bwget\b[^\n]*(?:\s-O\s*-|\s--output-document=-)/.test(command)) return "upsert";
  if (/\bdd\b[^\n]*\bof=/.test(command)) return "upsert";
  if (/\bawk\b[^\n]*\s-i(\s|$)|\bawk\b[^\n]*inplace/.test(command)) return "upsert";
  return "read";
}

// Publish / history-creation operations blocked at the tool layer unless the
// agent has a non-empty `commit:` config field. Deliberately BROAD: it covers
// the common aliases and release runners. Local working-tree ops (git
// merge/rebase/cherry-pick/add/status/diff) are intentionally NOT here — they
// stay allowed. Word-boundary aware so `git commit-graph` or a path containing
// "commit" does not false-positive.
//
// Returns true if ANY statement in the command (split on shell separators) is a
// commit-class operation.
export function isCommitCommand(command: string): boolean {
  // Split on shell command separators so `cd x && git commit` is inspected
  // statement-by-statement; each statement's head token is what we classify.
  const statements = command.split(/(?:&&|\|\||;|\||\n)/);
  for (const statement of statements) {
    if (statementIsCommit(statement)) return true;
  }
  // Backstop: catch a commit hidden in a command substitution ($(...) / `...`)
  // that the separator split above wouldn't surface as its own statement.
  if (/(?:\$\(|`)[^)`]*\bgit\b(?:\s+-[Cc]\s+\S+|\s+-c\s+\S+|\s+--git-dir=\S+)*\s+commit\b/.test(command)) return true;
  return false;
}

// Strip leading `env [VAR=val ...]` and `command` wrappers, and unwrap
// `bash -c "<str>"` / `sh -c "<str>"` by recursing into the quoted string, then
// classify the remaining head token.
function statementIsCommit(statement: string): boolean {
  const trimmed = statement.trim();
  if (!trimmed) return false;

  // Unwrap bash -c "<str>" / sh -c '<str>' — recurse into the inner command.
  const shcMatch = trimmed.match(/^(?:command\s+)?(?:ba|z|da)?sh\s+-c\s+(['"])([\s\S]*)\1\s*$/);
  if (shcMatch) return isCommitCommand(shcMatch[2]);

  const tokens = trimmed.split(/\s+/);
  let i = 0;
  // Skip `command` / `env [VAR=val]...` prefixes.
  while (i < tokens.length) {
    if (tokens[i] === "command") { i++; continue; }
    if (tokens[i] === "env") { i++; while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++; continue; }
    break;
  }
  const head = tokens[i] || "";
  const rest = tokens.slice(i + 1);

  // Bare git aliases that publish/create history.
  if (/^(gc|gcm|gca|gp|gpf|gcam)$/.test(head)) return true;
  if (head === "git") {
    const sub = gitSubcommand([head, ...rest])?.subcommand || "";
    if (sub === "commit" || sub === "push" || sub === "tag" || sub === "am") return true;
  }
  if (head === "gh") {
    const sub = rest[0] || "";
    if (sub === "pr" && rest.includes("merge")) return true;
    if (sub === "release" && rest.includes("create")) return true;
  }
  // Package publishes.
  if (/^(npm|pnpm|yarn|bun)$/.test(head) && rest[0] === "publish") return true;
  // Release runners.
  if ((head === "just" || head === "make") && /\brelease\b/.test(rest[0] || "")) return true;
  if (head === "npm" && rest[0] === "run" && /\brelease\b/.test(rest[1] || "")) return true;
  return false;
}

// Check the TYPE-POLICY layer for one path+action. Runs first (cheaper, clearer
// message) and independently of the domain-glob layer; both must pass. When the
// agent has no agent-type (e.g. tests, normal mode) type-policy is skipped and
// only the domain layer applies. Returns a block reason or undefined.
function enforceReservedPath(state: HiveState, runtime: AgentRuntime, ctx: ExtensionContext, rawPath: string, access: ReservedPathAccess): string | undefined {
  const decision = checkReservedPath(ctx.cwd, rawPath, access, {
    secretPaths: state.config?.settings.secretPaths,
    allowMissing: access === "upsert",
  });
  return decision.ok ? undefined : `${runtime.config.name} cannot ${access} reserved path "${rawPath}": ${decision.reason}. Reserved-path policy takes precedence over domains.`;
}

function enforceTypePolicyForPath(runtime: AgentRuntime, ctx: ExtensionContext, rawPath: string, action: PolicyAction): string | undefined {
  const agentType = runtime.config.agentType;
  if (!agentType) return undefined;
  const target = resolveDomainPath(ctx, rawPath);
  const rel = relative(ctx.cwd, target);
  const cls = classify(rel);
  const decision = checkTypePolicy(agentType, cls, action);
  if (!decision.ok) return `${runtime.config.name}: ${decision.reason} ("${rawPath}" is class=${cls}.)`;
  // Planner stage-scoping: a planner may only write its assigned gate artifacts.
  if (agentType === "planner" && (action === "upsert" || action === "delete")) {
    const stageDecision = checkPlannerStages(runtime.config.stages, rel);
    if (!stageDecision.ok) return `${runtime.config.name}: ${stageDecision.reason}`;
  }
  return undefined;
}

export function enforceDomainForTool(state: HiveState, event: any, ctx: ExtensionContext): { block: true; reason: string } | undefined {
  // Use runtimeForCaller so the main session ("Orchestrator") resolves to its
  // configured runtime instead of silently no-oping (G4). Zero behavior change
  // today (the main session has no file/bash tools in plan/hive mode) — this
  // removes the trap where a future main-session file tool would bypass domain
  // enforcement.
  const runtime = runtimeForCaller(state, currentAgentName());
  if (!runtime) return undefined;

  const toolName = String(event.toolName || "");
  const readTools = new Set(["read", "grep", "find", "ls"]);
  const upsertTools = new Set(["write", "edit"]);

  if (readTools.has(toolName)) {
    for (const path of extractToolPaths(toolName, event.input)) {
      const reservedBlock = enforceReservedPath(state, runtime, ctx, path, "read");
      if (reservedBlock) return { block: true, reason: reservedBlock };
      const typeBlock = enforceTypePolicyForPath(runtime, ctx, path, "read");
      if (typeBlock) return { block: true, reason: typeBlock };
      if (!domainAllows(ctx, runtime, path, "read")) {
        return { block: true, reason: `${runtime.config.name} cannot read ${path}. Read domains: ${formatDomainRules(runtime, "read")}` };
      }
    }
  }

  if (upsertTools.has(toolName)) {
    for (const path of extractToolPaths(toolName, event.input)) {
      const reservedBlock = enforceReservedPath(state, runtime, ctx, path, "upsert");
      if (reservedBlock) return { block: true, reason: reservedBlock };
      const typeBlock = enforceTypePolicyForPath(runtime, ctx, path, "upsert");
      if (typeBlock) return { block: true, reason: typeBlock };
      if (!domainAllows(ctx, runtime, path, "upsert")) {
        return { block: true, reason: `${runtime.config.name} cannot modify ${path}. Upsert domains: ${formatDomainRules(runtime, "upsert")}` };
      }
    }
  }

  if (toolName === "bash") {
    const command = String(event.input?.command || "");
    const readOnlyType = runtime.config.agentType === "reviewer" || runtime.config.agentType === "lead";

    // Read-only types get a positive allowlist before the broader mutation and
    // domain checks. A commit: field never turns a reviewer/lead into a writer.
    if (readOnlyType) {
      const decision = readOnlyCommandDecision(command, runtime.config.network === true);
      if (!decision.ok) return { block: true, reason: `${runtime.config.name} cannot run this shell command: ${decision.reason}.` };
    }

    const parsedCommands = parseShellCommands(command) || [];
    if (targetsDashboardLoopback(command)) {
      return { block: true, reason: `${runtime.config.name} cannot access the pi-hive dashboard loopback API from a worker.` };
    }
    if (commandUsesNetwork(parsedCommands, command) && runtime.config.network !== true) {
      return { block: true, reason: `${runtime.config.name} cannot use network commands (network: true is not configured).` };
    }

    // Commit gate: publish/history creation is blocked unless a write-capable
    // agent carries a non-empty `commit:` field (a static config fact).
    if (isCommitCommand(command) && !runtime.config.commit?.trim()) {
      return { block: true, reason: `${runtime.config.name} cannot run commit/publish operations (no commit: field configured). This command creates history or publishes. Only write-capable agents with a commit: guidance field may commit.` };
    }

    const kind = bashMutationKind(command);
    const capability = kind === "read" ? "read" : kind;
    // Extract raw path tokens, then filter out git ref / branch arguments
    // that the regex mistakenly picked up. Filter is read-only by kind
    // (see `filterBashPathTokens`); upsert/delete bash keeps all tokens
    // so legitimate CREATE/DELETE targets like `.worktrees/<dir>/` still
    // pass via the `allowMissing: true` path below.
    const paths = filterBashPathTokens(ctx, extractBashPathTokens(command), kind);
    // Reserved-path matching also inspects bare shell words. Normal domain
    // extraction intentionally ignores bare words because they are ambiguous,
    // but known secret/authority names must never inherit that fail-open rule.
    for (const token of parsedCommands.flatMap(({ words }) => words)) {
      const reservedBlock = enforceReservedPath(state, runtime, ctx, token, capability);
      if (reservedBlock) return { block: true, reason: reservedBlock };
    }
    // Git mutates its worktree/repository even when the command names no file.
    // Treat the effective working directory as an explicit policy target so a
    // write-capable agent can use granted Git operations without making generic
    // pathless mutations fail open.
    if (kind !== "read" && parsedCommands.some(({ words }) => {
      const git = classifiedGitSubcommand(words);
      return Boolean(git && GIT_MUTATION_COMMANDS.has(git.subcommand));
    }) && !paths.includes(".")) paths.push(".");
    // Non-mutating bash is a "command"; mutating bash maps to upsert/delete.
    const policyAction: PolicyAction = kind === "read" ? "command" : kind;

    if (kind !== "read" && paths.length === 0) {
      // A pathless mutating bash still gets the type check (reviewers/leads are
      // denied any mutation regardless of path) before the in-domain-paths rule.
      const typeBlock = runtime.config.agentType
        ? (() => { const d = checkTypePolicy(runtime.config.agentType!, null, policyAction); return d.ok ? undefined : `${runtime.config.name}: ${d.reason}`; })()
        : undefined;
      if (typeBlock) return { block: true, reason: typeBlock };
      return { block: true, reason: `${runtime.config.name} cannot run mutating bash without explicit in-domain paths. Use edit/write or include a path inside: ${formatDomainRules(runtime, capability)}` };
    }

    for (const path of paths) {
      const reservedBlock = enforceReservedPath(state, runtime, ctx, path, capability);
      if (reservedBlock) return { block: true, reason: reservedBlock };
      const typeBlock = enforceTypePolicyForPath(runtime, ctx, path, policyAction);
      if (typeBlock) return { block: true, reason: typeBlock };
      // Bash path tokens are regex matches, not authoritative existence
      // checks; let the shell report missing files at run time. The
      // domain check is about authorization (is this path inside the
      // agent's granted scope?), not existence (does this file exist?).
      // Reserved-path and type-policy layers above already enforce the
      // strict rules for sensitive locations and write-capable types.
      if (!domainAllows(ctx, runtime, path, capability, { allowMissing: true })) {
        return { block: true, reason: `${runtime.config.name} cannot ${capability} ${path} via bash. Allowed ${capability} domains: ${formatDomainRules(runtime, capability)}` };
      }
    }
  }

  return undefined;
}
