import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readIfSmall } from "../core/fs";
import { resolveContainedPath, resolveProjectPath } from "../core/safe-path";
import { withCrossProcessFileLock } from "../core/file-lock";
import {
  ARTIFACT_ORDER,
  OPENSPEC_ARTIFACTS,
  artifactDependencies,
  type ArtifactId,
} from "../shared/openspec-artifacts";
export { ARTIFACT_ORDER, OPENSPEC_ARTIFACTS, type ArtifactId } from "../shared/openspec-artifacts";

// Thin, bounded wrapper around the OpenSpec CLI (@fission-ai/openspec).
//
// pi-hive shells out to the CLI and parses `--json` rather than importing its
// TypeScript tree (which drags in PostHog telemetry). All child output is
// bounded (timeout + maxBuffer) per the CLAUDE.md "tool output must be bounded"
// rule, and every command runs with telemetry disabled.
//
// OpenSpec is the *store + validator*: it owns the artifact dependency graph
// (proposal -> {design, specs} -> tasks) and validation, and reports readiness
// per artifact via `openspec status --json`. It does NOT model human approval —
// pi-hive owns the approval gate (content-bound records in the global agent
// directory). `isReadyToExecute` here answers only "are the artifacts materially
// complete + valid", which dispatch combines with pi-hive's approval authority.

// Node's Dirent, declared locally because the core tsconfig loads no @types/node
// (matches the pattern in plan-store.ts / sdd.ts).
type FsDirent = { name: string; isDirectory(): boolean; isFile(): boolean };

const CHANGE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EXEC_TIMEOUT_MS = 20_000;
const EXEC_MAX_BUFFER = 4_000_000; // 4 MB hard cap on CLI stdout
function asyncExecTimeoutMs(): number {
  const configured = Number(process.env.HIVE_OPENSPEC_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.min(60_000, Math.max(50, Math.floor(configured))) : EXEC_TIMEOUT_MS;
}
const MAX_ARTIFACT_BYTES = 512_000;

export type OpenSpecCommandErrorCode = "unavailable" | "timeout" | "cancelled" | "output-limit" | "failed";
export class OpenSpecCommandError extends Error {
  readonly code: OpenSpecCommandErrorCode;
  constructor(code: OpenSpecCommandErrorCode, message: string) {
    super(message);
    this.name = "OpenSpecCommandError";
    this.code = code;
  }
}

export function isSafeChangeId(changeId: string): boolean {
  return CHANGE_ID_RE.test(changeId);
}

// ---------------------------------------------------------------------------
// Binary resolution + invocation
// ---------------------------------------------------------------------------

// Resolve the OpenSpec CLI binary. It ships as a dependency of pi-hive (not of
// the user's project), so we look in pi-hive's own node_modules first, then
// allow an explicit override, then fall back to a PATH lookup. Returns null when
// the CLI is absent so callers can degrade gracefully instead of throwing.
let cachedBinary: string | null | undefined;
function resolveBinary(): string | null {
  if (cachedBinary !== undefined) return cachedBinary;
  const override = process.env.HIVE_OPENSPEC_BIN;
  if (override && existsSync(override)) return (cachedBinary = override);

  // Walk up from this module toward a node_modules/.bin/openspec. Under an
  // installed extension this file lives at <extension>/src/engine/openspec.ts.
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    dir = process.cwd();
  }
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "node_modules", ".bin", "openspec");
    if (existsSync(candidate)) return (cachedBinary = candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return (cachedBinary = null);
}

// Whether the OpenSpec CLI is available at all. When false, the extension still
// loads and reports "no plan store" rather than throwing.
export function isAvailable(): boolean {
  return resolveBinary() !== null;
}

// Run a CLI command expecting JSON on stdout. `openspec validate` exits non-zero
// when validation FAILS while still emitting a valid JSON report to stdout, so
// we recover stdout from the thrown error (execFileSync attaches it to
// error.stdout) and only return null when there is no parseable JSON at all.
function runJson<T>(cwd: string, args: string[]): T | null {
  const bin = resolveBinary();
  if (!bin) return null;
  let out: string | undefined;
  try {
    out = execFileSync(bin, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
      env: { ...process.env, OPENSPEC_TELEMETRY: "0", DO_NOT_TRACK: "1", NO_COLOR: "1" },
    });
  } catch (err) {
    // encoding:"utf8" means stdout is a string; validate exits non-zero on a
    // failing report but still writes the JSON to error.stdout.
    const stdout = (err as { stdout?: string })?.stdout;
    out = typeof stdout === "string" ? stdout : undefined;
  }
  if (!out) return null;
  try {
    return JSON.parse(out) as T;
  } catch {
    return null;
  }
}

async function runJsonAsync<T>(cwd: string, args: string[], signal?: AbortSignal, allowNonZero = false): Promise<T> {
  const bin = resolveBinary();
  if (!bin) throw new OpenSpecCommandError("unavailable", "OpenSpec CLI is unavailable");
  if (signal?.aborted) throw new OpenSpecCommandError("cancelled", "OpenSpec request was cancelled");

  return new Promise<T>((resolvePromise, rejectPromise) => {
    const detached = process.platform !== "win32";
    const child = spawn(bin, args, {
      cwd,
      detached,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, OPENSPEC_TELEMETRY: "0", DO_NOT_TRACK: "1", NO_COLOR: "1" },
    });
    const chunks: string[] = [];
    let bytes = 0;
    let settled = false;
    let failure: OpenSpecCommandError | undefined;
    const finish = (error?: OpenSpecCommandError, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) rejectPromise(error);
      else resolvePromise(value as T);
    };
    const terminate = (error: OpenSpecCommandError) => {
      if (failure) return;
      failure = error;
      try {
        if (detached && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { finish(error); }
    };
    const onAbort = () => terminate(new OpenSpecCommandError("cancelled", "OpenSpec request was cancelled"));
    const timeoutMs = asyncExecTimeoutMs();
    const timer = setTimeout(() => terminate(new OpenSpecCommandError("timeout", `OpenSpec command timed out after ${timeoutMs}ms`)), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > EXEC_MAX_BUFFER) {
        terminate(new OpenSpecCommandError("output-limit", "OpenSpec output exceeded 4 MB"));
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", (error: Error) => finish(new OpenSpecCommandError("failed", error.message || "OpenSpec command failed")));
    child.once("close", (code: number | null) => {
      if (failure) { finish(failure); return; }
      const out = chunks.join("");
      try {
        const parsed = JSON.parse(out) as T;
        if (code && !allowNonZero) finish(new OpenSpecCommandError("failed", `OpenSpec command exited with code ${code}`));
        else finish(undefined, parsed);
      } catch { finish(new OpenSpecCommandError("failed", "OpenSpec returned invalid JSON")); }
    });
  });
}

function run(cwd: string, args: string[]): boolean {
  const bin = resolveBinary();
  if (!bin) return false;
  try {
    execFileSync(bin, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
      env: { ...process.env, OPENSPEC_TELEMETRY: "0", DO_NOT_TRACK: "1", NO_COLOR: "1" },
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// init / update
// ---------------------------------------------------------------------------

// True once `openspec init` has run in this project (the openspec/ tree exists).
export function isInitialized(cwd: string): boolean {
  return existsSync(join(cwd, "openspec", "config.yaml")) || existsSync(join(cwd, "openspec", "changes"));
}

// Normalize a title/id into a stable kebab change-id (matches OpenSpec's naming).
export function toChangeId(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Scaffold a new change directory via `openspec new change <id>`. Returns the
// change-id, or null if the CLI is unavailable / the id is unsafe / the command
// failed. Idempotent: if the change already exists, returns it without error.
export function newChange(cwd: string, title: string): { changeId: string; created: boolean } | null {
  const changeId = toChangeId(title);
  if (!isSafeChangeId(changeId)) return null;
  if (changeExists(cwd, changeId)) return { changeId, created: false };
  if (!isAvailable()) return null;
  const ok = run(cwd, ["new", "change", changeId]);
  if (!ok || !changeExists(cwd, changeId)) return null;
  return { changeId, created: true };
}

// Idempotently initialize OpenSpec with the Pi adapter selected, writing the
// /opsx-* prompts + skills to .pi/. Non-interactive via `--tools pi`. Returns
// true if OpenSpec is (now) initialized. Safe to call when the CLI is absent
// (returns false without throwing).
export function ensureInit(cwd: string): boolean {
  if (!isAvailable()) return false;
  if (isInitialized(cwd)) return true;
  return run(cwd, ["init", "--tools", "pi"]) && isInitialized(cwd);
}

// ---------------------------------------------------------------------------
// list --json
// ---------------------------------------------------------------------------

export type ChangeTaskStatus = "no-tasks" | "in-progress" | "complete";

export interface ChangeSummary {
  name: string;
  completedTasks: number;
  totalTasks: number;
  status: ChangeTaskStatus;
  lastModified?: string;
}

interface ListJson {
  changes?: Array<{
    name?: string;
    completedTasks?: number;
    totalTasks?: number;
    status?: string;
    lastModified?: string;
  }>;
}

function parseChanges(data: ListJson | null): ChangeSummary[] {
  if (!data?.changes) return [];
  return data.changes
    .filter((c): c is Required<Pick<typeof c, "name">> & typeof c => typeof c.name === "string" && isSafeChangeId(c.name))
    .map((c) => ({
      name: c.name as string,
      completedTasks: Number(c.completedTasks ?? 0),
      totalTasks: Number(c.totalTasks ?? 0),
      status: (c.status === "in-progress" || c.status === "complete" ? c.status : "no-tasks") as ChangeTaskStatus,
      lastModified: c.lastModified,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// All changes under openspec/changes/, from `openspec list --json`.
export function listChanges(cwd: string): ChangeSummary[] {
  return parseChanges(runJson<ListJson>(cwd, ["list", "--json"]));
}

export async function listChangesAsync(cwd: string, signal?: AbortSignal): Promise<ChangeSummary[]> {
  return parseChanges(await runJsonAsync<ListJson>(cwd, ["list", "--json"], signal));
}

export function changeExists(cwd: string, name: string): boolean {
  return isSafeChangeId(name) && existsSync(join(cwd, "openspec", "changes", name));
}

// ---------------------------------------------------------------------------
// status --json (artifact dependency graph)
// ---------------------------------------------------------------------------

export type ArtifactStatus = "done" | "ready" | "blocked";

export interface ArtifactState {
  id: ArtifactId;
  displayLabel: string;
  outputPath: string;
  status: ArtifactStatus;
  missingDeps: ArtifactId[];
  reviewOrder: number;
}

export interface ChangeDetail {
  name: string;
  artifacts: ArtifactState[];
  // The first artifact whose dependencies are satisfied but which is not yet
  // authored — i.e. the next thing the planning team should produce. null when
  // everything is authored.
  nextReady: string | null;
}

interface StatusJson {
  artifacts?: Array<{
    id?: string;
    outputPath?: string;
    status?: string;
    missingDeps?: string[] | null;
  }>;
}

function parseChangeDetail(name: string, data: StatusJson | null): ChangeDetail | null {
  if (!data?.artifacts) return null;
  const reported = new Map(data.artifacts.map((artifact) => [String(artifact.id ?? ""), artifact]));
  const artifacts: ArtifactState[] = OPENSPEC_ARTIFACTS.map((definition) => {
    const state = reported.get(definition.id);
    const status = state?.status === "done" || state?.status === "ready" ? state.status : "blocked";
    const missingDeps = Array.isArray(state?.missingDeps)
      ? state.missingDeps.map(String).filter((id): id is ArtifactId => (ARTIFACT_ORDER as readonly string[]).includes(id))
      : [...artifactDependencies(definition.id)];
    return {
      id: definition.id,
      displayLabel: definition.displayLabel,
      outputPath: definition.outputPath,
      status,
      missingDeps,
      reviewOrder: definition.reviewOrder,
    };
  });
  const nextReady = artifacts.find((a) => a.status === "ready")?.id ?? null;
  return { name, artifacts, nextReady };
}

export function changeDetail(cwd: string, name: string): ChangeDetail | null {
  if (!isSafeChangeId(name)) return null;
  return parseChangeDetail(name, runJson<StatusJson>(cwd, ["status", "--json", "--change", name]));
}

export async function changeDetailAsync(cwd: string, name: string, signal?: AbortSignal): Promise<ChangeDetail | null> {
  if (!isSafeChangeId(name)) return null;
  return parseChangeDetail(name, await runJsonAsync<StatusJson>(cwd, ["status", "--json", "--change", name], signal));
}

// ---------------------------------------------------------------------------
// validate --json
// ---------------------------------------------------------------------------

export interface ValidateIssue {
  level: string; // ERROR | WARNING
  path: string;
  message: string;
}

export interface ValidateResult {
  passed: boolean;
  failed: number;
  issues: ValidateIssue[];
}

interface ValidateJson {
  items?: Array<{ issues?: Array<{ level?: string; path?: string; message?: string }> }>;
  summary?: { totals?: { passed?: number; failed?: number } };
}

function parseValidation(data: ValidateJson | null): ValidateResult {
  if (!data?.summary?.totals) return { passed: false, failed: -1, issues: [] };
  const failed = Number(data.summary.totals.failed ?? 0);
  const issues: ValidateIssue[] = [];
  for (const item of data.items ?? []) {
    for (const issue of item.issues ?? []) {
      issues.push({
        level: String(issue.level ?? "ERROR"),
        path: String(issue.path ?? ""),
        message: String(issue.message ?? ""),
      });
    }
  }
  return { passed: failed === 0, failed, issues };
}

// Validate one change (or all when name omitted). A change passes when the
// summary reports zero failures.
export function validate(cwd: string, name?: string): ValidateResult {
  const args = name ? ["validate", name, "--json"] : ["validate", "--all", "--json"];
  return parseValidation(runJson<ValidateJson>(cwd, args));
}

export async function validateAsync(cwd: string, name?: string, signal?: AbortSignal): Promise<ValidateResult> {
  const args = name ? ["validate", name, "--json"] : ["validate", "--all", "--json"];
  return parseValidation(await runJsonAsync<ValidateJson>(cwd, args, signal, true));
}

// ---------------------------------------------------------------------------
// Execution readiness gate
// ---------------------------------------------------------------------------

// tasks.md exists and is materially authored. Prefer checkbox/task-list items
// when present, but accept execution-ready sprint plans too: the planning gate
// may produce dependency-ordered sprint sections with acceptance criteria rather
// than Markdown checkboxes, and /hive:execute should not report that such a file
// is missing.
export function hasTasks(cwd: string, name: string): boolean {
  if (!isSafeChangeId(name)) return false;
  const tasksPath = resolveArtifact(cwd, name, "tasks.md");
  const raw = tasksPath ? readIfSmall(tasksPath, MAX_ARTIFACT_BYTES) : "";
  if (!raw.trim()) return false;
  if (/^\s*(?:[-*]|\d+\.)\s*\[[ xX]\]/m.test(raw)) return true;
  const hasTasksHeading = /^#\s+Tasks\b/im.test(raw);
  const sprintSections = raw.match(/^##\s+\d+\.\s+Sprint\b/gim)?.length ?? 0;
  const hasAcceptanceCriteria = /\*\*Acceptance criteria:\*\*/i.test(raw);
  return hasTasksHeading && sprintSections > 0 && hasAcceptanceCriteria;
}

// Artifact-side readiness: the artifacts are materially complete (tasks
// authored) AND OpenSpec validation passes. This is what the dashboard and
// /hive:plan surface show as "ready to approve". It does NOT include pi-hive's
// human approval — see isExecutionGateOpen for the load-bearing dispatch gate.
export function isReadyToExecuteWithValidation(cwd: string, name: string, validation: ValidateResult): boolean {
  return hasTasks(cwd, name) && validation.passed;
}

export function isReadyToExecute(cwd: string, name: string): boolean {
  return isReadyToExecuteWithValidation(cwd, name, validate(cwd, name));
}

// The load-bearing gate consumed by dispatch.ts before it will delegate to a
// coder/tester: the artifacts are ready AND a human has approved execution via
// the review surface. pi-hive owns approval, so both halves are required.
export function isExecutionGateOpen(cwd: string, name: string): boolean {
  return isReadyToExecute(cwd, name) && isApprovedForExecution(cwd, name);
}

// Execution progress is stored outside the approved tasks artifact. Checking a
// box in tasks.md would change its exact content hash and correctly close the
// execution gate after the first task. Trusted progress records stay bound to
// the approved tasks hash without mutating the reviewed plan.
export interface ExecutionTaskProgress {
  taskId: string;
  text: string;
  completed: boolean;
  actor?: string;
  evidence?: string;
  completedAt?: string;
}

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TASK_PROGRESS_MAX_BYTES = 16_000;

function plannedTasks(cwd: string, name: string): Array<{ taskId: string; text: string }> {
  const raw = readArtifact(cwd, name, "tasks.md");
  const tasks: Array<{ taskId: string; text: string }> = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*[-*]\s*\[[ xX]\]\s+([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:[.:)]\s+|\s+-\s+|\s+)(.+?)\s*$/);
    if (match && TASK_ID_RE.test(match[1])) tasks.push({ taskId: match[1], text: match[2] });
  }
  return tasks;
}

export function executionTaskRecordPath(cwd: string, name: string, taskId: string): string | null {
  if (!isSafeChangeId(name) || !TASK_ID_RE.test(taskId)) return null;
  const identity = approvalIdentity(cwd);
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "hive", "execution", identity.projectId, name, "tasks", `${taskId}.json`);
}

export function markExecutionTaskComplete(cwd: string, name: string, taskId: string, actor: string, evidence: string): ExecutionTaskProgress {
  const path = executionTaskRecordPath(cwd, name, taskId);
  if (!path) throw new Error(`Invalid execution task target: ${name}/${taskId}`);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return withCrossProcessFileLock(path, () => {
    if (!isExecutionGateOpen(cwd, name)) throw new Error(`Execution gate is not open for change ${name}`);
    if (!actor.trim() || !evidence.trim()) throw new Error("Task completion requires an actor and implementation evidence");
    const task = plannedTasks(cwd, name).find((item) => item.taskId === taskId);
    if (!task) throw new Error(`Unknown task id ${taskId} in ${name}/tasks.md`);
    const tasksHash = artifactHash(cwd, name, "tasks");
    if (!tasksHash) throw new Error(`Invalid execution task target: ${name}/${taskId}`);
    const record = {
      schemaVersion: 1,
      projectId: approvalIdentity(cwd).projectId,
      changeId: name,
      taskId,
      taskText: task.text,
      tasksHash,
      actor: actor.trim(),
      evidence: evidence.trim().slice(0, 8_000),
      completedAt: new Date().toISOString(),
    };
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(tmp, path);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* best effort */ }
      throw error;
    }
    return { taskId, text: task.text, completed: true, actor: record.actor, evidence: record.evidence, completedAt: record.completedAt };
  });
}

export function executionTaskProgress(cwd: string, name: string): ExecutionTaskProgress[] {
  const currentHash = artifactHash(cwd, name, "tasks");
  const projectId = approvalIdentity(cwd).projectId;
  return plannedTasks(cwd, name).map((task) => {
    const path = executionTaskRecordPath(cwd, name, task.taskId);
    if (!path || !currentHash) return { ...task, completed: false };
    try {
      const raw = readIfSmall(path, TASK_PROGRESS_MAX_BYTES);
      const record = raw ? JSON.parse(raw) as Record<string, unknown> : null;
      if (!record || record.schemaVersion !== 1 || record.projectId !== projectId || record.changeId !== name
        || record.tasksHash !== currentHash || record.taskId !== task.taskId || record.taskText !== task.text
        || typeof record.actor !== "string" || !record.actor.trim()
        || typeof record.evidence !== "string" || !record.evidence.trim() || record.evidence.length > 8_000
        || typeof record.completedAt !== "string" || !Number.isFinite(Date.parse(record.completedAt))) {
        return { ...task, completed: false };
      }
      return {
        ...task,
        completed: true,
        actor: String(record.actor || ""),
        evidence: String(record.evidence || ""),
        completedAt: String(record.completedAt || ""),
      };
    } catch {
      return { ...task, completed: false };
    }
  });
}

// ---------------------------------------------------------------------------
// Artifact reads (path-guarded)
// ---------------------------------------------------------------------------

// Guard a requested artifact path so a read cannot traverse outside the change
// folder. Returns the resolved absolute path or null if unsafe. Ported from
// plan-store.resolveArtifact.
export function resolveArtifact(cwd: string, name: string, relPath: string): string | null {
  if (!isSafeChangeId(name)) return null;
  const baseRequest = resolve(cwd, "openspec", "changes", name);
  const safeBase = resolveProjectPath(cwd, baseRequest, { allowMissing: true });
  if (!safeBase) return null;
  const target = resolve(baseRequest, relPath);
  const safeTarget = resolveContainedPath(baseRequest, target, { allowMissing: true });
  return safeTarget?.canonicalPath || null;
}

// Read an artifact under a change folder, path-guarded and capped at 512 KB.
// OpenSpec reports specs as a glob (`specs/**/*.md`), not as a single file; for
// that review artifact, concatenate the concrete spec markdown files into one
// bounded document so the review UI has real content to render.
export function readArtifact(cwd: string, name: string, relPath: string): string {
  if (isSpecsGlob(relPath)) return readSpecsBundle(cwd, name);
  // Be tolerant of agents/review links that point at an OpenSpec spec directory
  // (e.g. specs/front-window-backend) instead of the concrete spec.md file.
  // OpenSpec stores capability specs as directories containing markdown files.
  if (relPath.startsWith("specs/") && !relPath.endsWith(".md")) return readSpecsBundle(cwd, name, relPath);
  const target = resolveArtifact(cwd, name, relPath);
  if (!target) return "";
  return readIfSmall(target, MAX_ARTIFACT_BYTES);
}

// ---------------------------------------------------------------------------
// Content-bound approval authority
// ---------------------------------------------------------------------------
//

// ── Approval ledger + flow re-export shim ────────────────────────────────
// The implementation moved to `./openspec-approvals.ts`. Re-exported here so
// every external call site that does `import * as openspec from "./openspec"`
// (or namespaced `import { setArtifactApproval, ... } from "./openspec"`)
// keeps compiling without churn. The execution-task section above imports
// `approvalIdentity` directly from the approvals
// module to keep the path short.
// Internal imports: bring the moved approval symbols into openspec.ts scope
// so the execution-task section (which still lives in this file) can call
// them without `openspec.foo(...)` qualification.
import {
  approvalIdentity,
  artifactHash,
  isApprovedForExecution,
} from "./openspec-approvals";

export {
  APPROVAL_SCHEMA_VERSION,
  StaleArtifactApprovalError,
  agentReviewVerdict,
  approvalIdentity,
  approvalRecordPath,
  artifactHash,
  artifactVerdict,
  canAuthorArtifact,
  isApprovedForExecution,
  isArtifactApproved,
  isAwaitingHumanApproval,
  nextAuthorableArtifact,
  pendingReviewArtifact,
  readAgentReviewLedger,
  readApprovalLedger,
  setAgentReviewVerdict,
  setArtifactApproval,
  type AgentReviewLedger,
  type AgentReviewVerdict,
  type ApprovalAuthority,
  type ApprovalLedger,
  type ApprovalRecord,
  type ArtifactVerdict,
} from "./openspec-approvals";

function isSpecsGlob(relPath: string): boolean {
  return relPath.startsWith("specs/") && relPath.includes("*") && relPath.endsWith(".md");
}

function readSpecsBundle(cwd: string, name: string, relRoot = "specs"): string {
  const parts: string[] = [];
  let total = 0;
  for (const file of listSpecArtifacts(cwd, name, relRoot)) {
    const text = readArtifact(cwd, name, file);
    if (!text) continue;
    const chunk = `## ${file}\n\n${text.trim()}\n`;
    total += Buffer.byteLength(chunk, "utf8");
    if (total > MAX_ARTIFACT_BYTES) return "";
    parts.push(chunk);
  }
  return parts.join("\n");
}

function listSpecArtifacts(cwd: string, name: string, relRoot = "specs"): string[] {
  if (!isSafeChangeId(name)) return [];
  const rootTarget = resolveArtifact(cwd, name, relRoot);
  if (!rootTarget || !relRoot.startsWith("specs")) return [];
  const root = rootTarget;
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 8 || out.length >= 200) return;
    let entries: FsDirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as FsDirent[];
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= 200) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = join(dir, entry.name);
      if (entry.isDirectory()) walk(childAbs, childRel, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(`specs/${childRel}`);
    }
  };
  walk(root, relRoot.replace(/^specs\/?/, ""), 0);
  return out;
}

// The markdown artifact files present in a change folder. Includes top-level
// proposal/design/tasks files plus concrete OpenSpec spec files under specs/.
export function listArtifacts(cwd: string, name: string): string[] {
  if (!isSafeChangeId(name)) return [];
  try {
    const changeRoot = resolveArtifact(cwd, name, ".");
    if (!changeRoot) return [];
    const topLevel = (readdirSync(changeRoot, { withFileTypes: true }) as FsDirent[])
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name);
    return [...topLevel, ...listSpecArtifacts(cwd, name)].sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}
