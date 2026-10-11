import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { auditAgentTypes, inferAgentType } from "../src/core/agent-type-audit.ts";

function fixture(config: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-agent-audit-"));
  mkdirSync(join(cwd, ".pi", "hive", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), config);
  return cwd;
}

test("agent-type audit tolerates absent and non-object configurations", () => {
  const missing = mkdtempSync(join(tmpdir(), "pi-hive-agent-audit-missing-"));
  assert.deepEqual(auditAgentTypes(missing), { rows: [], offenders: [] });
  assert.deepEqual(auditAgentTypes(fixture("null\n")), { rows: [], offenders: [] });
  assert.deepEqual(auditAgentTypes(fixture("planning: text\nhive: false\n")), { rows: [], offenders: [] });
});

test("agent-type audit walks legacy, explicit, nested, duplicate, and sparse nodes", () => {
  const cwd = fixture(`
main:
  name: Shared Lead
  path: .pi/hive/agents/shared.md
agents:
  - name: Direct Coder
    path: .pi/hive/agents/direct.md
    agentType: coder
    members:
      - name: Frontmatter Reviewer
        path: .pi/hive/agents/reviewer.md
      - ignored
    children:
      - path: .pi/hive/agents/empty.md
      - name: Escaping
        path: ../outside.md
planning:
  orchestrator:
    name: Shared Lead
    path: .pi/hive/agents/shared.md
  agents: not-an-array
`);
  writeFileSync(join(cwd, ".pi", "hive", "agents", "shared.md"), "---\nagent-type: lead\n---\nLead");
  writeFileSync(join(cwd, ".pi", "hive", "agents", "reviewer.md"), "---\nagent-type: reviewer\n---\nReview");
  writeFileSync(join(cwd, ".pi", "hive", "agents", "empty.md"), "");

  const audit = auditAgentTypes(cwd);
  assert.equal(audit.rows.filter((row) => row.name === "Shared Lead").length, 1);
  assert.equal(audit.rows.find((row) => row.name === "Direct Coder")?.declared, "coder");
  assert.equal(audit.rows.find((row) => row.name === "Frontmatter Reviewer")?.declared, "reviewer");
  assert.ok(audit.rows.some((row) => row.name === "(unnamed)"));
  assert.ok(audit.rows.some((row) => row.name === "Escaping" && !row.valid));
  assert.ok(audit.offenders.length >= 2);
});

test("explicit hive block accepts orchestrator aliases and missing paths", () => {
  const cwd = fixture(`
hive:
  orchestrator:
    name: Inline Lead
    agentType: lead
  agents:
    - name: No Path Coder
      agentType: coder
    - name: Missing File
      path: .pi/hive/agents/missing.md
`);
  const audit = auditAgentTypes(cwd);
  assert.equal(audit.rows.find((row) => row.name === "Inline Lead")?.valid, true);
  assert.equal(audit.rows.find((row) => row.name === "No Path Coder")?.valid, true);
  assert.equal(audit.rows.find((row) => row.name === "Missing File")?.declared, undefined);
});

test("inferAgentType suggests operations for lifecycle-flavored names", () => {
  assert.equal(inferAgentType("Operations Lead", false, false), "operations");
  assert.equal(inferAgentType("Lifecycle Lead", false, false), "operations");
});

// Positive coverage for the operations branch the audit recommends for
// lifecycle-flavored names (Kieran L1 finding). The first case pins
// `inferAgentType` against a "Lifecycle Engineer"-shaped name beyond the
// existing top-level lead pattern; the second case walks a fixture whose
// operations-typed agent is declared correctly and verifies the audit
// does not flag it (so a false-positive on the new branch regresses here).
test("inferAgentType recommends operations for Lifecycle-Engineer-flavored names, with or without reports", () => {
  // `inferAgentType` is the doctor's suggestion-only helper (never
  // written automatically). The two input parameters that vary in practice
  // are `hasReports` (does the agent own child reports? true for a lead)
  // and `isOrchestrator` (top of the team tree? typically false for
  // operations since the orchestrator sits above it). Both shapes must
  // round-trip to "operations".
  assert.equal(inferAgentType("Lifecycle Engineer", true, false), "operations", "lifecycle-named lead routes to operations");
  assert.equal(inferAgentType("Lifecycle Engineer", false, false), "operations", "lifecycle-named non-lead also routes to operations");
  // A "Pipeline Operations" name with no "lifecycle" token still routes
  // through the operations regex (only `operations|lifecycle` is in the
  // pattern). Pin that the second keyword covers the same set.
  assert.equal(inferAgentType("Pipeline Operations", false, false), "operations", "operations keyword also matches non-lead names");
});

test("audit does not flag a correctly-typed operations agent as an offender", () => {
  // Regression guard for the new operations tier: when an agent is
  // declared with `agent-type: operations` and named in an operations
  // shape (Operations Lead), the audit must report it as valid with no
  // suggestion; a false-positive would demote the persona to `lead` in
  // the doctor's report and the user would have to ignore the warning
  // on every run.
  const cwd = fixture(`
hive:
  orchestrator:
    name: Orchestrator
    agentType: lead
  agents:
    - name: Operations Lead
      path: .pi/hive/agents/operations.md
`);
  const opsPath = join(cwd, ".pi", "hive", "agents", "operations.md");
  writeFileSync(opsPath, "---\nagent-type: operations\n---\nOperations lead");
  const audit = auditAgentTypes(cwd);
  const opsRow = audit.rows.find((r) => r.name === "Operations Lead");
  assert.ok(opsRow, "audit must include the operations-typed agent row");
  assert.equal(opsRow.declared, "operations", "declared type mirrors the frontmatter verbatim");
  assert.equal(opsRow.valid, true, "operations is a recognized AgentType, so the row is valid");
  assert.equal(opsRow.suggestion, "operations", "the suggestion matches the declared type when already correct");
  assert.ok(
    !audit.offenders.some((r) => r.name === "Operations Lead"),
    "a correctly-typed operations agent must not appear in the offenders list",
  );
});
