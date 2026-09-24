// ── Approval ledger + flow ──────────────────────────────────────────────────
// Extracted from `engine/openspec.ts` so the file's monolithic structure
// stops being the single owner of "what's an approval flow". Every export
// below is re-exported from `openspec.ts` so external callers (`import *
// as openspec from "../engine/openspec"`) keep compiling without churn.
//
// Two ledger shapes live here:
//   * Human approvals ("human"): the trusted dashboard review hook is the
//     only writer. A green verdict requires (a) a current eligible
//     automated record and (b) current green approvals for every direct
//     upstream artifact — the gate the engine consults via
//     `isApprovedForExecution`.
//   * Automated reviews ("automated-review"): the verifier is the writer.
//     The `agent_review_verdict` events the dashboard consumes are produced
//     by projecting this ledger.
//
// Both verdicts are revalidated against the current artifact bytes before
// they can affect a gate — a stale approval doesn't outlive its artifact.

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readIfSmall } from "../core/fs";
import { withCrossProcessFileLock } from "../core/file-lock";
import { resolveProjectIdentity, type ProjectIdentity } from "../shared/project-identity";
import { ARTIFACT_ORDER, artifactDependencies, artifactIdFromReference, type ArtifactId } from "../shared/openspec-artifacts";
import { isSafeChangeId, listArtifacts, resolveArtifact } from "./openspec";

// Structural subset of `node:fs.Dirent` used at the readdirSync-with-fileTypes
// boundary. We don't import Dirent directly to keep the surface narrow (the
// withFileTypes branch returns a richer runtime type whose methods are
// unused here).
type FsDirent = { name: string; isDirectory(): boolean; isFile(): boolean };

export const APPROVAL_SCHEMA_VERSION = 1 as const;
export type ArtifactVerdict = "green" | "red" | null;
export type AgentReviewVerdict = "green" | "yellow" | "red" | null;
export type ApprovalAuthority = "automated-review" | "human";
export type ApprovalLedger = Partial<Record<ArtifactId, ArtifactVerdict>>;
export type AgentReviewLedger = Partial<Record<ArtifactId, AgentReviewVerdict>>;

export class StaleArtifactApprovalError extends Error {
  constructor(artifactId: ArtifactId) {
    super(`Artifact ${artifactId} changed after the review session was created`);
    this.name = "StaleArtifactApprovalError";
  }
}

export interface ApprovalRecord {
  schemaVersion: typeof APPROVAL_SCHEMA_VERSION;
  authority: ApprovalAuthority;
  projectId: string;
  canonicalRoot: string;
  changeId: string;
  artifactId: ArtifactId;
  verdict: Exclude<AgentReviewVerdict, null>;
  actor: string;
  timestamp: string;
  artifactHash: string;
  automatedReviewHash?: string;
}

// ── Identity + path helpers (also used by execution tasks in openspec.ts) ──
// Both the approval ledger and the execution-task records are keyed by
// project ID; the engine openspec.ts execution code reuses these helpers
// to stay consistent.

export function approvalIdentity(cwd: string): ProjectIdentity {
  return resolveProjectIdentity(cwd);
}

function approvalBaseDir(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "hive", "approvals");
}

export function approvalRecordPath(cwd: string, name: string, artifact: string, authority: ApprovalAuthority): string | null {
  const id = toArtifactId(artifact);
  if (!id || !isSafeChangeId(name)) return null;
  const identity = approvalIdentity(cwd);
  // Path shape: <base>/<projectId>/<changeId>/<artifactId>/<authority>.json
  //
  // The project's canonical root is *not* a path component here, even
  // though every ApprovalRecord carries a `canonicalRoot` field. The
  // `projectId` is a hash of the canonical root (see
  // `shared/project-identity.ts`), so adding the canonical root as a
  // directory segment would be redundant for identification AND would
  // produce ugly long paths with embedded absolute filesystem paths
  // (e.g. ~/.pi/agent/hive/approvals/<hash>/Users/cgrant/code/<repo>/<branch>).
  // The canonical root stays on the record for content-binding and
  // cross-checks (see `validRecordShape`).
  return join(approvalBaseDir(), identity.projectId, name, id, `${authority}.json`);
}

const UPSTREAM = Object.fromEntries(
  ARTIFACT_ORDER.map((id) => [id, [...artifactDependencies(id)]]),
) as Record<ArtifactId, ArtifactId[]>;
const APPROVAL_RECORD_MAX_BYTES = 16_000;
const APPROVAL_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
const APPROVAL_SPEC_MAX_FILES = 10_000;
const HASH_RE = /^[a-f0-9]{64}$/;

function toArtifactId(artifact: string): ArtifactId | null {
  return artifactIdFromReference(artifact);
}

function framed(hash: ReturnType<typeof createHash>, value: string | Uint8Array): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  const size = Buffer.allocUnsafe(8);
  size.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(size);
  hash.update(bytes);
}

function approvalSpecFiles(cwd: string, name: string): string[] | null {
  const root = resolveArtifact(cwd, name, "specs");
  if (!root) return null;
  const files: string[] = [];
  let overflow = false;
  const walk = (dir: string, rel: string, depth: number): void => {
    if (overflow || depth > 32) { overflow = true; return; }
    let entries: FsDirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as FsDirent[];
    } catch {
      overflow = true;
      return;
    }
    for (const entry of entries) {
      if (overflow) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), childRel, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(`specs/${childRel}`);
        if (files.length > APPROVAL_SPEC_MAX_FILES) overflow = true;
      }
    }
  };
  walk(root, "", 0);
  return overflow || files.length === 0 ? null : files.sort((a, b) => a.localeCompare(b));
}

// Hash one exact top-level artifact, or a stable path+bytes aggregate for specs.
// Length framing avoids ambiguous concatenations; sorted relative paths make the
// specs hash independent of filesystem enumeration order while still changing
// on rename/add/remove. Used by the approval ledger for `artifactHash` checks
// and by the execution-task section in openspec.ts to anchor task completion
// records to the tasks.md that was current at completion time.
export function artifactHash(cwd: string, name: string, artifact: string): string | null {
  const id = toArtifactId(artifact);
  if (!id || !isSafeChangeId(name)) return null;
  const files = id === "specs" ? approvalSpecFiles(cwd, name) : [`${id}.md`];
  if (!files) return null;
  const hash = createHash("sha256").update("pi-hive-artifact-v1\0");
  framed(hash, id);
  let total = 0;
  try {
    for (const relPath of files) {
      const target = resolveArtifact(cwd, name, relPath);
      if (!target) return null;
      const bytes = readFileSync(target);
      total += bytes.byteLength;
      if (total > APPROVAL_ARTIFACT_MAX_BYTES) return null;
      framed(hash, relPath);
      framed(hash, bytes);
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

function recordDigest(record: ApprovalRecord): string {
  return createHash("sha256")
    .update("pi-hive-approval-record-v1\0")
    .update(JSON.stringify(record))
    .digest("hex");
}

function validRecordShape(value: unknown, authority: ApprovalAuthority, identity: ProjectIdentity, name: string, id: ArtifactId): value is ApprovalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const verdictOk = authority === "human"
    ? r.verdict === "green" || r.verdict === "red"
    : r.verdict === "green" || r.verdict === "yellow" || r.verdict === "red";
  return r.schemaVersion === APPROVAL_SCHEMA_VERSION
    && r.authority === authority
    && r.projectId === identity.projectId
    && r.canonicalRoot === identity.canonicalRoot
    && r.changeId === name
    && r.artifactId === id
    && verdictOk
    && typeof r.actor === "string" && r.actor.trim().length > 0
    && typeof r.timestamp === "string" && Number.isFinite(Date.parse(r.timestamp))
    && typeof r.artifactHash === "string" && HASH_RE.test(r.artifactHash)
    && (r.automatedReviewHash === undefined || (typeof r.automatedReviewHash === "string" && HASH_RE.test(r.automatedReviewHash)));
}

function readApprovalRecord(cwd: string, name: string, id: ArtifactId, authority: ApprovalAuthority): ApprovalRecord | null {
  try {
    const identity = approvalIdentity(cwd);
    const path = approvalRecordPath(cwd, name, id, authority);
    if (!path) return null;
    const raw = readIfSmall(path, APPROVAL_RECORD_MAX_BYTES);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return validRecordShape(parsed, authority, identity, name, id) ? parsed : null;
  } catch {
    return null;
  }
}

function currentAutomatedRecord(cwd: string, name: string, id: ArtifactId): ApprovalRecord | null {
  const record = readApprovalRecord(cwd, name, id, "automated-review");
  const currentHash = artifactHash(cwd, name, id);
  return record && currentHash && record.artifactHash === currentHash ? record : null;
}

function currentHumanRecord(cwd: string, name: string, id: ArtifactId, seen = new Set<ArtifactId>()): ApprovalRecord | null {
  if (seen.has(id)) return null;
  seen.add(id);
  const record = readApprovalRecord(cwd, name, id, "human");
  const currentHash = artifactHash(cwd, name, id);
  if (!record || !currentHash || record.artifactHash !== currentHash) return null;
  if (record.verdict === "red") return record;
  const automated = currentAutomatedRecord(cwd, name, id);
  if (!automated || (automated.verdict !== "green" && automated.verdict !== "yellow")) return null;
  if (record.automatedReviewHash !== recordDigest(automated)) return null;
  for (const upstream of UPSTREAM[id]) {
    if (currentHumanRecord(cwd, name, upstream, new Set(seen))?.verdict !== "green") return null;
  }
  return record;
}

function writeApprovalRecord(path: string, record: ApprovalRecord): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best effort cleanup */ }
    throw error;
  }
}

function removeApprovalRecord(cwd: string, name: string, id: ArtifactId, authority: ApprovalAuthority): void {
  const path = approvalRecordPath(cwd, name, id, authority);
  if (!path) throw new Error(`Invalid approval target: ${name}/${id}`);
  try {
    unlinkSync(path);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function readApprovalLedger(cwd: string, name: string): ApprovalLedger {
  const ledger: ApprovalLedger = {};
  for (const id of ARTIFACT_ORDER) {
    const verdict = currentHumanRecord(cwd, name, id)?.verdict;
    if (verdict === "green" || verdict === "red") ledger[id] = verdict;
  }
  return ledger;
}

export function readAgentReviewLedger(cwd: string, name: string): AgentReviewLedger {
  const ledger: AgentReviewLedger = {};
  for (const id of ARTIFACT_ORDER) {
    const verdict = currentAutomatedRecord(cwd, name, id)?.verdict;
    if (verdict === "green" || verdict === "yellow" || verdict === "red") ledger[id] = verdict;
  }
  return ledger;
}

// This function is called only from the trusted dashboard review hook. A green
// human approval requires a current eligible automated record and current green
// approvals for every direct upstream artifact.
function setArtifactApprovalUnlocked(cwd: string, name: string, artifact: string, verdict: ArtifactVerdict, by = "ui", expectedArtifactHash?: string): boolean {
  const id = toArtifactId(artifact);
  if (!id || !isSafeChangeId(name)) throw new Error(`Invalid approval target: ${name}/${artifact}`);
  if (verdict === null) {
    removeApprovalRecord(cwd, name, id, "human");
    for (const down of downstreamOf(id)) removeApprovalRecord(cwd, name, down, "human");
    return true;
  }
  if (!by.trim()) throw new Error("Approval actor is required");
  const identity = approvalIdentity(cwd);
  const hash = artifactHash(cwd, name, id);
  if (!hash) throw new Error(`Cannot approve missing, unsafe, or oversized artifact: ${id}`);
  if (expectedArtifactHash && hash !== expectedArtifactHash) throw new StaleArtifactApprovalError(id);
  const automated = currentAutomatedRecord(cwd, name, id);
  if (verdict === "green") {
    if (!automated || (automated.verdict !== "green" && automated.verdict !== "yellow")) {
      throw new Error(`Artifact ${id} has no current eligible automated review`);
    }
    for (const upstream of UPSTREAM[id]) {
      if (currentHumanRecord(cwd, name, upstream)?.verdict !== "green") {
        throw new Error(`Artifact ${id} requires current human approval of ${upstream}`);
      }
    }
  }
  const path = approvalRecordPath(cwd, name, id, "human");
  if (!path) throw new Error(`Invalid approval target: ${name}/${id}`);
  writeApprovalRecord(path, {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    authority: "human",
    projectId: identity.projectId,
    canonicalRoot: identity.canonicalRoot,
    changeId: name,
    artifactId: id,
    verdict,
    actor: by.trim(),
    timestamp: new Date().toISOString(),
    artifactHash: hash,
    ...(automated ? { automatedReviewHash: recordDigest(automated) } : {}),
  });
  if (verdict === "red") {
    for (const down of downstreamOf(id)) removeApprovalRecord(cwd, name, down, "human");
  }
  return true;
}

export function setArtifactApproval(cwd: string, name: string, artifact: string, verdict: ArtifactVerdict, by = "ui", expectedArtifactHash?: string): boolean {
  const recordPath = approvalRecordPath(cwd, name, artifact, "human");
  if (!recordPath) throw new Error(`Invalid approval target: ${name}/${artifact}`);
  const changeDir = dirname(dirname(recordPath));
  mkdirSync(changeDir, { recursive: true, mode: 0o700 });
  return withCrossProcessFileLock(join(changeDir, ".approval-state"), () =>
    setArtifactApprovalUnlocked(cwd, name, artifact, verdict, by, expectedArtifactHash));
}

export function artifactVerdict(cwd: string, name: string, artifact: string): ArtifactVerdict {
  const id = toArtifactId(artifact);
  return id ? (currentHumanRecord(cwd, name, id)?.verdict as ArtifactVerdict) ?? null : null;
}

function setAgentReviewVerdictUnlocked(cwd: string, name: string, artifact: string, verdict: AgentReviewVerdict, by = "agent-reviewer"): boolean {
  const id = toArtifactId(artifact);
  if (!id || !isSafeChangeId(name)) throw new Error(`Invalid automated review target: ${name}/${artifact}`);
  if (verdict === null) {
    removeApprovalRecord(cwd, name, id, "automated-review");
    return true;
  }
  if (!by.trim()) throw new Error("Automated reviewer actor is required");
  const identity = approvalIdentity(cwd);
  const hash = artifactHash(cwd, name, id);
  if (!hash) throw new Error(`Cannot review missing, unsafe, or oversized artifact: ${id}`);
  const path = approvalRecordPath(cwd, name, id, "automated-review");
  if (!path) throw new Error(`Invalid automated review target: ${name}/${id}`);
  writeApprovalRecord(path, {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    authority: "automated-review",
    projectId: identity.projectId,
    canonicalRoot: identity.canonicalRoot,
    changeId: name,
    artifactId: id,
    verdict,
    actor: by.trim(),
    timestamp: new Date().toISOString(),
    artifactHash: hash,
  });
  return true;
}

export function setAgentReviewVerdict(cwd: string, name: string, artifact: string, verdict: AgentReviewVerdict, by = "agent-reviewer"): boolean {
  const recordPath = approvalRecordPath(cwd, name, artifact, "automated-review");
  if (!recordPath) throw new Error(`Invalid automated review target: ${name}/${artifact}`);
  const changeDir = dirname(dirname(recordPath));
  mkdirSync(changeDir, { recursive: true, mode: 0o700 });
  return withCrossProcessFileLock(join(changeDir, ".approval-state"), () =>
    setAgentReviewVerdictUnlocked(cwd, name, artifact, verdict, by));
}

export function agentReviewVerdict(cwd: string, name: string, artifact: string): AgentReviewVerdict {
  const id = toArtifactId(artifact);
  return id ? (currentAutomatedRecord(cwd, name, id)?.verdict as AgentReviewVerdict) ?? null : null;
}

export function isArtifactApproved(cwd: string, name: string, artifact: string): boolean {
  return artifactVerdict(cwd, name, artifact) === "green";
}

function downstreamOf(artifact: ArtifactId): ArtifactId[] {
  const out: ArtifactId[] = [];
  for (const id of ARTIFACT_ORDER) {
    if (id === artifact) continue;
    const seen = new Set<ArtifactId>();
    const stack = [...UPSTREAM[id]];
    while (stack.length) {
      const dep = stack.pop()!;
      if (dep === artifact) { out.push(id); break; }
      if (!seen.has(dep)) { seen.add(dep); stack.push(...UPSTREAM[dep]); }
    }
  }
  return out;
}

export function canAuthorArtifact(cwd: string, name: string, artifact: string): boolean {
  const id = toArtifactId(artifact);
  return id ? UPSTREAM[id].every((dep) => isArtifactApproved(cwd, name, dep)) : false;
}

export function nextAuthorableArtifact(cwd: string, name: string): ArtifactId | null {
  const files = new Set(listArtifacts(cwd, name).map((f) => f.replace(/\.md$/, "")));
  const hasSpecs = existsSync(join(cwd, "openspec", "changes", name, "specs"));
  for (const id of ARTIFACT_ORDER) {
    const present = id === "specs" ? hasSpecs : files.has(id);
    if (!present && canAuthorArtifact(cwd, name, id)) return id;
  }
  return null;
}

export function isApprovedForExecution(cwd: string, name: string): boolean {
  return ARTIFACT_ORDER.every((id) => isArtifactApproved(cwd, name, id));
}

export function pendingReviewArtifact(cwd: string, name: string): ArtifactId | null {
  const files = new Set(listArtifacts(cwd, name).map((f) => f.replace(/\.md$/, "")));
  const hasSpecs = existsSync(join(cwd, "openspec", "changes", name, "specs"));
  for (const id of ARTIFACT_ORDER) {
    const present = id === "specs" ? hasSpecs : files.has(id);
    if (!present || artifactVerdict(cwd, name, id) !== null) continue;
    return agentReviewVerdict(cwd, name, id) === "red" ? null : id;
  }
  return null;
}

export function isAwaitingHumanApproval(cwd: string, name: string): ArtifactId | null {
  return pendingReviewArtifact(cwd, name);
}
