import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildHiveTools } from "../src/agents/tools.ts";
import { HIVE_TOOL_NAMES } from "../src/core/constants.ts";
import { enqueueQuestion, recordQuestion } from "../src/engine/questions.ts";

// The ask_user tool itself moved to the optional pi-ask-user peer dep (see
// CHANGELOG [Unreleased]). These tests cover the file-backed trail and the
// dashboard-actions bridge, which remain pi-hive-owned — they're the legacy
// surface for surfacing questions from headless workers via the dashboard.

// Regression: pi-hive must not register ask_user locally — the peer dep owns it.
test("buildHiveTools does not register ask_user (lives in the pi-ask-user peer dep)", () => {
  const tools = buildHiveTools(
    {
      pi: {} as any,
      config: null,
      session: null,
      runtimes: new Map(),
      widgetCtx: null,
      activeRuns: 0,
      mode: "normal",
      normalToolNames: [],
      sddStatus: null,
      obsSeq: 0,
      latestVerdicts: new Map(),
    } as any,
    "Orchestrator",
  );
  assert.equal(tools.find((t) => t.name === "ask_user"), undefined, "ask_user must be registered by the peer dep, not by pi-hive");
});

test("HIVE_TOOL_NAMES does not include ask_user (peer-dep surface)", () => {
  assert.equal(HIVE_TOOL_NAMES.has("ask_user"), false, "HIVE_TOOL_NAMES is pi-hive's own tool set; ask_user moved to the peer dep");
});

test("recordQuestion writes a file-backed trail under the change", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-q-cwd-"));
  await recordQuestion(cwd, "add-auth", "Which auth provider?", "OIDC via Auth0");
  const file = join(cwd, "openspec", "changes", "add-auth", "questions.md");
  assert.ok(existsSync(file));
  const body = readFileSync(file, "utf8");
  assert.match(body, /Which auth provider\?/);
  assert.match(body, /OIDC via Auth0/);
  // Unsafe change ids are ignored (no traversal).
  await recordQuestion(cwd, "../evil", "x");
  assert.ok(!existsSync(join(cwd, "..", "evil", "questions.md")));
});

test("question writes share Pi's per-file mutation queue", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-q-concurrent-"));
  await Promise.all(Array.from({ length: 20 }, (_, index) => recordQuestion(cwd, "queued", `Question ${index}?`)));
  const body = readFileSync(join(cwd, "openspec", "changes", "queued", "questions.md"), "utf8");
  for (let index = 0; index < 20; index++) assert.match(body, new RegExp(`Question ${index}\\?`));
});

test("enqueueQuestion appends a question action to dashboard-actions.jsonl", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-q-enq-"));
  assert.ok(await enqueueQuestion(dir, { question: "Scope?", change: "add-auth", askedBy: "Planner" }));
  const body = readFileSync(join(dir, "dashboard-actions.jsonl"), "utf8");
  const action = JSON.parse(body.trim().split("\n")[0]);
  assert.equal(action.type, "question");
  assert.equal(action.question, "Scope?");
  assert.equal(action.change, "add-auth");
});
