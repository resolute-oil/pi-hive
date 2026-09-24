// Regression tests for `approvalRecordPath` — the on-disk layout of the
// content-bound approval ledger.
//
// Bug being pinned: WT-4 4d's `openspec.ts` split (commit 94bc8e8 on
// `refactor/split-monoliths`, also present in `integration/four-prs-merged`)
// introduced a `identity.canonicalRoot` segment between `<projectId>` and
// `<changeId>` in `approvalRecordPath`. The pre-bug layout
// (`main` at c4ce672) was:
//   <base>/<projectId>/<changeId>/<artifactId>/<authority>.json
// The buggy layout was:
//   <base>/<projectId>/<canonicalRoot>/<changeId>/<artifactId>/<authority>.json
//
// The canonicalRoot segment is redundant — `projectId` is already a
// hash of the canonical root — and it produces ugly paths that embed
// the absolute filesystem path of the project (e.g. the integration
// preview landed records at
// `~/.pi/agent/hive/approvals/<hash>/Users/cgrant/code/gitlab/resolute-oil/strata/smoke-test-engineering-lead-agent-end-to-end/...`).
// The canonical root stays on the `ApprovalRecord` itself for
// content-binding and the `validRecordShape` cross-check.
//
// These tests pin the SHAPE of `approvalRecordPath` and the round-trip
// behavior (write then read from the same path). If a future change
// reintroduces a path component, adds a stray segment, or breaks the
// read-back symmetry, these fail first.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import * as openspec from "../src/engine/openspec.ts";
import { resolveProjectIdentity } from "../src/shared/project-identity.ts";

// ── helpers ─────────────────────────────────────────────────────────────────

function newCwd(): string {
  return mkdtempSync(join(tmpdir(), "pi-hive-approval-paths-"));
}

// Normalize the path to forward slashes so the structural assertions are
// platform-independent.
function norm(value: string): string {
  return value.split(sep).join("/");
}

// Strip the trailing ".json" so the assertion below reads as a path-segment
// shape check, not a filename check.
function segments(path: string): string[] {
  return norm(path).replace(/\.json$/, "").split("/").filter(Boolean);
}

// The "stable" segments of every record path: everything after the base
// approval dir, before the changeId segment. We expect exactly the
// projectId (one segment) here — no canonicalRoot in between.
function pathSegmentsAfterBase(recordPath: string): { projectId: string; rest: string[] } {
  const all = segments(recordPath);
  // All approval records live under <homedir>/.pi/agent/hive/approvals/.
  // Walk the segments and find that marker; everything after is "after base".
  const markerIndex = all.lastIndexOf("approvals");
  assert.ok(markerIndex >= 0, `expected path under an "approvals" dir, got ${recordPath}`);
  const after = all.slice(markerIndex + 1);
  assert.ok(after.length >= 1, `expected at least one segment after the base, got ${recordPath}`);
  return { projectId: after[0]!, rest: after.slice(1) };
}

// ── path shape ──────────────────────────────────────────────────────────────

test("approvalRecordPath returns exactly one segment after the projectId — no canonicalRoot leak", () => {
  const cwd = newCwd();
  // The actual bug surface: a long change-id with a forward-slash-free
  // kebab-case name produced a path that looked like an absolute path
  // (because canonicalRoot was embedded as a directory segment).
  const path = openspec.approvalRecordPath(cwd, "smoke-test-engineering-lead-agent-end-to-end", "proposal", "automated-review");
  assert.ok(path, "approvalRecordPath should resolve");

  const { projectId, rest } = pathSegmentsAfterBase(path);
  // Reconstruct the rest as the expected shape:
  // <changeId>/<artifactId>/<authority>  (the .json suffix is stripped
  // by `segments` — the authority segment is the basename minus .json).
  assert.deepEqual(
    rest,
    ["smoke-test-engineering-lead-agent-end-to-end", "proposal", "automated-review"],
    `path after projectId must be exactly [changeId, artifactId, authority]; got ${JSON.stringify(rest)}`,
  );

  // ProjectId is a 64-char hex hash of the canonical root. It MUST NOT
  // contain "/" — if it ever does, the path is leaking absolute-path
  // segments into the directory.
  assert.ok(!projectId.includes("/"), `projectId must not contain "/"; got ${projectId}`);
  assert.match(projectId, /^[a-f0-9]{64}$/, `projectId must be a 64-char sha256 hex; got ${projectId}`);
});

test("approvalRecordPath uses the change-id literally — never as a substring of an absolute path", () => {
  // The user's reported symptom: the change-id
  // "smoke-test-engineering-lead-agent-end-to-end" was visible only as
  // the LAST component of an embedded absolute filesystem path
  // (.../strata/smoke-test-engineering-lead-agent-end-to-end).
  const cwd = newCwd();
  const changeId = "smoke-test-engineering-lead-agent-end-to-end";
  const path = norm(openspec.approvalRecordPath(cwd, changeId, "proposal", "human")!);
  assert.ok(path, "approvalRecordPath should resolve");

  // The path must END with the change-id as a directory, not embed it
  // somewhere in the middle of an absolute path.
  const expectedTail = `approvals/${resolveProjectIdentity(cwd).projectId}/${changeId}/proposal/human.json`;
  assert.ok(
    path.endsWith(expectedTail),
    `path should end with ${expectedTail}; got ${path}`,
  );

  // And it must not contain the absolute cwd anywhere as a path segment.
  const normCwd = norm(cwd);
  assert.ok(
    !path.includes(normCwd),
    `path must not embed the absolute cwd ${normCwd}; got ${path}`,
  );
});

test("approvalRecordPath filenames match the authority value exactly", () => {
  const cwd = newCwd();
  const autoPath = openspec.approvalRecordPath(cwd, "add-auth", "proposal", "automated-review");
  const humanPath = openspec.approvalRecordPath(cwd, "add-auth", "proposal", "human");
  assert.ok(autoPath && humanPath);
  assert.ok(autoPath.endsWith("automated-review.json"), `automated-review path should end with automated-review.json; got ${autoPath}`);
  assert.ok(humanPath.endsWith("human.json"), `human path should end with human.json; got ${humanPath}`);
  // Distinct: separate authorities → separate files.
  assert.notEqual(autoPath, humanPath);
});

test("approvalRecordPath normalizes .md-suffixed artifact references the same as bare ids", () => {
  // The WT-4 4d toArtifactId delegation (artifactIdFromReference) means
  // `proposal.md` and `proposal` resolve to the same artifact id. Pin
  // that here so a future revert of that delegation breaks loudly
  // rather than silently producing two paths for one artifact.
  const cwd = newCwd();
  const bare = openspec.approvalRecordPath(cwd, "add-auth", "proposal", "human");
  const suffixed = openspec.approvalRecordPath(cwd, "add-auth", "proposal.md", "human");
  assert.ok(bare && suffixed);
  assert.equal(suffixed, bare, `proposal.md should resolve to the same record as proposal; got ${suffixed} vs ${bare}`);
});

test("approvalRecordPath differs only in the changeId segment across distinct changes in the same cwd", () => {
  const cwd = newCwd();
  const a = norm(openspec.approvalRecordPath(cwd, "change-a", "proposal", "automated-review")!);
  const b = norm(openspec.approvalRecordPath(cwd, "change-b", "proposal", "automated-review")!);
  // Replace the changeId in each, then assert they're identical except
  // for that segment — this is the property the canonicalRoot leak
  // destroyed (paths used to differ by an embedded absolute path
  // component AND the changeId).
  const aTail = a.replace("/change-a/", "/__CHANGE__/");
  const bTail = b.replace("/change-b/", "/__CHANGE__/");
  assert.equal(aTail, bTail, `paths should be identical after canonicalizing the changeId; got\n  ${a}\n  ${b}`);
});

test("approvalRecordPath differs only in the artifactId across the four canonical artifacts", () => {
  const cwd = newCwd();
  const paths = {
    proposal: norm(openspec.approvalRecordPath(cwd, "add-auth", "proposal", "human")!),
    design: norm(openspec.approvalRecordPath(cwd, "add-auth", "design", "human")!),
    specs: norm(openspec.approvalRecordPath(cwd, "add-auth", "specs", "human")!),
    tasks: norm(openspec.approvalRecordPath(cwd, "add-auth", "tasks", "human")!),
  };
  // All four should share the same prefix up to the artifactId segment.
  const prefix = paths.proposal.substring(0, paths.proposal.lastIndexOf("/proposal/"));
  for (const [artifact, p] of Object.entries(paths)) {
    assert.ok(
      p.startsWith(prefix + `/${artifact}/human.json`),
      `${artifact} path should match /<prefix>/${artifact}/human.json; got ${p}`,
    );
  }
});

test("approvalRecordPath differs only in the projectId across distinct cwd values", () => {
  const cwdA = newCwd();
  const cwdB = newCwd();
  const a = norm(openspec.approvalRecordPath(cwdA, "add-auth", "proposal", "human")!);
  const b = norm(openspec.approvalRecordPath(cwdB, "add-auth", "proposal", "human")!);
  // Different projectIds → the projectId segment differs, everything
  // else is identical.
  const aId = a.match(/\/approvals\/([a-f0-9]{64})\//)![1]!;
  const bId = b.match(/\/approvals\/([a-f0-9]{64})\//)![1]!;
  assert.notEqual(aId, bId, `different cwds should yield different projectIds; got ${aId} and ${bId}`);
  const aTail = a.replace(aId, "__PID__");
  const bTail = b.replace(bId, "__PID__");
  assert.equal(aTail, bTail, `paths should be identical after canonicalizing the projectId; got\n  ${a}\n  ${b}`);
});

test("approvalRecordPath returns null for unsafe change ids and unknown artifacts", () => {
  const cwd = newCwd();
  // Unsafe change id (uppercase, contains slash, contains .., etc.).
  assert.equal(openspec.approvalRecordPath(cwd, "../escape", "proposal", "human"), null);
  assert.equal(openspec.approvalRecordPath(cwd, "UPPER", "proposal", "human"), null);
  // Unknown artifact id — toArtifactId returns null for anything that
  // doesn't resolve through artifactIdFromReference.
  assert.equal(openspec.approvalRecordPath(cwd, "add-auth", "random.md", "human"), null);
});

// ── round-trip ──────────────────────────────────────────────────────────────

test("round-trip: write and read via approvalRecordPath land on the same file", () => {
  const cwd = newCwd();
  const changeId = "add-auth";
  // setAgentReviewVerdict requires the artifact to exist on disk so it
  // can compute the content hash. Mirror the existing openspec.test.ts
  // setup pattern (line 117): create the change dir and write proposal.md.
  const dir = join(cwd, "openspec", "changes", changeId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "proposal.md"), "# proposal\n");

  const path = openspec.approvalRecordPath(cwd, changeId, "proposal", "automated-review");
  assert.ok(path, "approvalRecordPath should resolve");

  // Use setAgentReviewVerdict to write via the production code path.
  openspec.setAgentReviewVerdict(cwd, changeId, "proposal", "green", "Plan Reviewer");
  assert.ok(existsSync(path), `record should exist at ${path}`);

  const raw = readFileSync(path, "utf8");
  const record = JSON.parse(raw);
  assert.equal(record.authority, "automated-review");
  assert.equal(record.changeId, changeId);
  assert.equal(record.artifactId, "proposal");
  assert.equal(record.verdict, "green");
  // The reviewer/actor field is named `actor` on the record (not
  // `reviewer`) — see `ApprovalRecord` in openspec-approvals.ts.
  assert.equal(record.actor, "Plan Reviewer");
  assert.match(record.artifactHash, /^[a-f0-9]{64}$/);
});

test("round-trip: setArtifactApproval + readApprovalRecord share the same path", () => {
  const cwd = newCwd();
  const changeId = "add-auth";
  // Set up: the artifact must exist with content + an eligible
  // automated review, otherwise setArtifactApproval throws.
  const dir = join(cwd, "openspec", "changes", changeId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "proposal.md"), "# proposal\n");
  openspec.setAgentReviewVerdict(cwd, changeId, "proposal", "green", "Plan Reviewer");
  openspec.setArtifactApproval(cwd, changeId, "proposal", "green");

  const path = openspec.approvalRecordPath(cwd, changeId, "proposal", "human");
  assert.ok(path, "approvalRecordPath should resolve");
  assert.ok(existsSync(path), `human record should exist at ${path}`);

  const raw = readFileSync(path, "utf8");
  const record = JSON.parse(raw);
  assert.equal(record.authority, "human");
  assert.equal(record.changeId, changeId);
  assert.equal(record.artifactId, "proposal");
  assert.equal(record.verdict, "green");
});

// ── canonicalRoot stays on the record, NOT in the path ─────────────────────

test("the canonicalRoot field on ApprovalRecord is preserved even though it's not in the path", () => {
  const cwd = newCwd();
  const changeId = "add-auth";
  const dir = join(cwd, "openspec", "changes", changeId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "proposal.md"), "# proposal\n");
  openspec.setAgentReviewVerdict(cwd, changeId, "proposal", "green", "Plan Reviewer");
  openspec.setArtifactApproval(cwd, changeId, "proposal", "green");

  const humanPath = openspec.approvalRecordPath(cwd, changeId, "proposal", "human")!;
  const record = JSON.parse(readFileSync(humanPath, "utf8"));
  // canonicalRoot stays on the record for content-binding (see
  // validRecordShape's cross-check). Removing it from the path doesn't
  // mean removing it from the data model.
  assert.ok(
    typeof record.canonicalRoot === "string" && record.canonicalRoot.length > 0,
    `ApprovalRecord.canonicalRoot must remain populated; got ${JSON.stringify(record)}`,
  );
  // And the canonicalRoot must not appear as a directory component in
  // the path (regression pin).
  const pathNorm = norm(humanPath);
  assert.ok(
    !pathNorm.includes(record.canonicalRoot),
    `path must not embed the canonicalRoot ${record.canonicalRoot}; got ${pathNorm}`,
  );
});

// ── base directory ──────────────────────────────────────────────────────────

test("approvalRecordPath honors PI_CODING_AGENT_DIR override", () => {
  const cwd = newCwd();
  const override = mkdtempSync(join(tmpdir(), "pi-hive-approval-base-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = override;
  try {
    const path = openspec.approvalRecordPath(cwd, "add-auth", "proposal", "human");
    assert.ok(path);
    assert.ok(
      norm(path).startsWith(norm(override) + "/"),
      `path should start with the override ${override}; got ${path}`,
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("approvalRecordPath defaults to <homedir>/.pi/agent/hive/approvals when PI_CODING_AGENT_DIR is unset", () => {
  const cwd = newCwd();
  const previous = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    const path = openspec.approvalRecordPath(cwd, "add-auth", "proposal", "human");
    assert.ok(path);
    const expectedPrefix = join(homedir(), ".pi", "agent", "hive", "approvals");
    assert.ok(
      norm(path).startsWith(norm(expectedPrefix) + "/"),
      `path should start with ${expectedPrefix}; got ${path}`,
    );
  } finally {
    if (previous !== undefined) process.env.PI_CODING_AGENT_DIR = previous;
  }
});
