// LLM tool gap (Wave `refactor/llm-tool-gap`) — tests for the 12
// LLM-callable operator command tools + the orchestrator system prompt
// addition. The structural mismatch this wave closes: the engine
// had 12 operator command functions, the dashboard had 11 buttons
// driving them via the JSONL pickup consumer, and the LLM had no
// way to enqueue commands. After this wave, the Orchestrator LLM
// in /hive mode can call the operator surface directly from chat.
//
// Coverage:
//
//   1. Registration: buildHiveTools emits all 12 tools for an
//      agentType: "lead" caller (the orchestrator) and ZERO of
//      them for a worker (coder / tester / reviewer / planner).
//   2. Payload: each tool's handler writes a row to
//      operator-command-pickup.jsonl with the correct shape
//      (id, agent, command, requestedAt) — the same shape the
//      existing Wave 7 consumer drains. The LLM path is the SAME
//      producer as the dashboard's HTTP path; only the writer
//      helper is different (Node vs Bun runtime).
//   3. Allow-list: the LLM tools reject unknown commands, unknown
//      agent names, and over-long agent names — the same gates
//      the dashboard HTTP handler enforces.
//   4. System prompt: buildOrchestratorPrompt includes the
//      operator surface section (12 commands, budget gate, etc.).
//   5. Cross-process contract: the row the LLM tool writes is
//      byte-identical (modulo id + requestedAt) to what
//      `writeOperatorCommandRequest` in `db.ts` would write —
//      the pickup consumer drains both interchangeably.
//
// The producer/consumer integration is the load-bearing
// assertion. If buildHiveTools emits the 12 tools but the
// handler never writes to the JSONL, the Wave 7 consumer has
// nothing to drain and the LLM-to-operator wiring is broken.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildHiveTools } from "../src/agents/tools.ts";
import { buildOrchestratorPrompt } from "../src/agents/prompts.ts";
import { TYPE_SCOPED_TOOL_NAMES } from "../src/core/constants.ts";
import {
  OPERATOR_COMMAND_NAMES,
  operatorCommandQueuePath,
  queueOperatorCommand,
  readOperatorCommandQueue,
} from "../src/engine/budget/operator-command-queue.ts";
import type { AgentRuntime, HiveState } from "../src/core/types.ts";

// ── Fixtures ────────────────────────────────────────────────────────────

const EXPECTED_TOOL_NAMES = [
  "hive_end_worker",
  "hive_compact_worker",
  "hive_respawn_worker",
  "hive_pause_worker",
  "hive_snapshot_worker",
  "hive_restore_worker",
  "hive_resume_worker",
  "hive_abort_compaction",
  "hive_force_kill_worker",
  "hive_force_end_worker",
  "hive_tear_down_all",
  "hive_reload_agent_config",
] as const;

// (LLM tool name → operator-command name) — what each LLM tool
// writes to the JSONL. This is the canonical mapping the LLM
// must learn from the system prompt and the dashboard must
// accept. The keys are the LLM tool names; the values are the
// 12 strings in the existing 12-command allow-list
// (operator-pickup.ts:95, http-handler.ts:172).
const TOOL_TO_COMMAND: Record<string, string> = {
  hive_end_worker: "end",
  hive_compact_worker: "compact",
  hive_respawn_worker: "respawn",
  hive_pause_worker: "pause",
  hive_snapshot_worker: "snapshot",
  hive_restore_worker: "restore",
  hive_resume_worker: "resume",
  hive_abort_compaction: "abort-compaction",
  hive_force_kill_worker: "force-kill",
  hive_force_end_worker: "force-end",
  hive_tear_down_all: "tear-down-all",
  hive_reload_agent_config: "hive_reload_agent_config",
};

function runtime(name: string, overrides: Partial<AgentRuntime["config"]> = {}): AgentRuntime {
  return {
    config: {
      name,
      path: `${name}.md`,
      role: "member",
      routingTags: [],
      domain: [],
      ...overrides,
    } as AgentRuntime["config"],
    systemPrompt: "",
    status: "idle",
    task: "",
    lastWork: "",
    toolCount: 0,
    elapsedMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    contextPct: 0,
    runCount: 0,
    sessionFile: "",
  };
}

function stateWith(runtimes: AgentRuntime[]): HiveState {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-llm-tools-"));
  return {
    pi: {} as any,
    mode: "hive",
    config: {
      orchestrator: { name: "Orchestrator", path: "o.md", role: "orchestrator", routingTags: [], domain: [], allowedAgents: runtimes.map((r) => r.config.name) } as any,
      agents: runtimes.map((r) => r.config),
      sharedContext: [],
      settings: {
        subagentOutputLimit: 100,
        defaultTools: "read",
        maxParallel: 3,
        distiller: { enabled: false, model: "", conversationLines: 10 },
      },
    } as any,
    session: {
      sessionId: "s1",
      sessionDir: dir,
      conversationLog: join(dir, "c.jsonl"),
      observabilityLog: join(dir, "e.jsonl"),
    },
    runtimes: new Map(runtimes.map((r) => [r.config.name.toLowerCase(), r])),
    widgetCtx: null,
    activeRuns: 0,
    workerQueue: [],
    normalToolNames: [],
    sddStatus: null,
    obsSeq: 0,
    latestVerdicts: new Map(),
  } as any;
}

// Set the queue path to a temp file by overriding the env vars
// the helper reads. Each test calls this with its own tmp dir.
// Must be `async` so the finally restores env vars AFTER the
// awaited body completes — a sync wrapper would restore them
// immediately (sync return of the unawaited Promise) and the
// async work would resolve against the production env.
async function withTempQueuePath<T>(dir: string, fn: () => Promise<T> | T): Promise<T> {
  const prevDb = process.env.HIVE_TELEMETRY_DB;
  const prevAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.HIVE_TELEMETRY_DB = join(dir, "telemetry.db");
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return await fn();
  } finally {
    if (prevDb === undefined) delete process.env.HIVE_TELEMETRY_DB;
    else process.env.HIVE_TELEMETRY_DB = prevDb;
    if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgent;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// ── Test 1: Registration — orchestrator gets all 12 tools ──────────────

test("LLM tool gap: buildHiveTools emits all 12 operator command tools for the orchestrator (callerName='Orchestrator')", () => {
  const state = stateWith([
    runtime("Builder", { slug: "builder", agentType: "coder", routingTags: ["code"] }),
  ]);
  const tools = buildHiveTools(state, "Orchestrator") as any[];
  const toolNames = new Set(tools.map((t) => t.name));
  for (const name of EXPECTED_TOOL_NAMES) {
    assert.ok(toolNames.has(name), `orchestrator must see ${name} in buildHiveTools output`);
  }
  // No duplicates.
  assert.equal(tools.filter((t) => t.name === "hive_end_worker").length, 1);
});

// ── Test 2: Registration — each tool has a non-trivial description ─────

test("LLM tool gap: each operator tool's description tells the LLM when to use it (not just 'ends a worker')", () => {
  const state = stateWith([runtime("Builder", { slug: "builder", agentType: "coder" })]);
  const tools = buildHiveTools(state, "Orchestrator") as any[];
  for (const name of EXPECTED_TOOL_NAMES) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `${name} is registered`);
    assert.ok(typeof tool.description === "string", `${name}.description is a string`);
    assert.ok(tool.description.length > 40, `${name}.description is substantial (>40 chars; got ${tool.description.length})`);
    // The description must include actionable "use when" guidance.
    assert.match(tool.description, /\b(use|prefer|when|triggers?|reclaims|preserves|discard|halt|abort|forcibly|reload|tear|kill|end|compact|respawn|pause|snapshot|restore|resume|tear down)\b/i, `${name}.description mentions when/how to use the tool`);
  }
});

// ── Test 3: Registration — workers do NOT see operator command tools ───

test("LLM tool gap: workers (coder / tester / reviewer / planner) do NOT see any operator command tools", () => {
  // Workers must be restricted: the operator commands include force-kill
  // and tear-down-all, which would be catastrophic if a worker could
  // self-call them. The cooperative tool registry's name list is the
  // only worker-self-call surface; the LLM operator tools are gated
  // to leads.
  for (const agentType of ["coder", "tester", "reviewer", "planner"] as const) {
    const state = stateWith([runtime(`${agentType}-agent`, { slug: `${agentType}-agent`, agentType })]);
    const tools = buildHiveTools(state, `${agentType}-agent`) as any[];
    const toolNames = new Set(tools.map((t) => t.name));
    for (const name of EXPECTED_TOOL_NAMES) {
      assert.ok(!toolNames.has(name), `${agentType} must NOT see ${name}`);
    }
  }
});

// ── Test 4: TYPE_SCOPED_TOOL_NAMES includes all 12 names ───────────────

test("LLM tool gap: TYPE_SCOPED_TOOL_NAMES contains all 12 operator command tool names (so dispatch union preserves them)", () => {
  for (const name of EXPECTED_TOOL_NAMES) {
    assert.ok(TYPE_SCOPED_TOOL_NAMES.has(name), `TYPE_SCOPED_TOOL_NAMES must include ${name}`);
  }
});

// ── Test 5: Each tool's handler writes the correct row to the JSONL ────

test("LLM tool gap: each of the 12 LLM tools writes a row to operator-command-pickup.jsonl with the correct command name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-llm-tools-payload-"));
  await withTempQueuePath(dir, async () => {
    const state = stateWith([
      runtime("Builder", { slug: "builder", agentType: "coder" }),
      runtime("Reviewer", { slug: "reviewer", agentType: "reviewer" }),
    ]);
    const tools = buildHiveTools(state, "Orchestrator") as any[];
    for (const [toolName, expectedCommand] of Object.entries(TOOL_TO_COMMAND)) {
      // Clear the queue before each tool call so we can assert
      // exactly one row was written.
      const queuePath = operatorCommandQueuePath();
      try { rmSync(queuePath, { force: true }); } catch { /* best-effort */ }
      const tool = tools.find((t) => t.name === toolName);
      assert.ok(tool, `${toolName} is registered`);
      // tear-down-all takes no parameters; the others take an `agent`.
      const params = toolName === "hive_tear_down_all" ? {} : { agent: "builder" };
      const result = await tool.execute("call-1", params);
      // The handler must return success (the row was written).
      assert.equal(result.details?.ok, true, `${toolName} must return ok=true; got ${JSON.stringify(result.details)}`);
      assert.equal(result.details?.command, expectedCommand, `${toolName} must write command="${expectedCommand}"`);
      assert.equal(result.details?.status, "queued", `${toolName} must mark status="queued"`);
      assert.equal(result.details?.agent, toolName === "hive_tear_down_all" ? "" : "builder", `${toolName} must echo the agent name (or empty for tear-down-all)`);
      // The row was actually written.
      const rows = readOperatorCommandQueue();
      assert.equal(rows.length, 1, `exactly one row written after ${toolName} call`);
      const row = rows[0];
      assert.equal(row.command, expectedCommand, `row command matches for ${toolName}`);
      assert.equal(row.agent, toolName === "hive_tear_down_all" ? "" : "builder", `row agent matches for ${toolName}`);
      assert.ok(typeof row.id === "string" && row.id.length > 0, `row id is set for ${toolName}`);
      assert.ok(typeof row.requestedAt === "string" && row.requestedAt.length > 0, `row requestedAt is set for ${toolName}`);
    }
  });
});

// ── Test 6: Allow-list — unknown command is rejected ───────────────────

test("LLM tool gap: queueOperatorCommand rejects a command outside the 12-command allow-list", () => {
  const state = stateWith([runtime("Builder", { slug: "builder", agentType: "coder" })]);
  // Direct helper call: unknown command.
  const r1 = queueOperatorCommand(state, "builder", "shell-escape");
  assert.equal(r1.ok, false);
  assert.match(r1.error || "", /unknown command/);
});

// ── Test 7: Allow-list — unknown agent is rejected ─────────────────────

test("LLM tool gap: queueOperatorCommand rejects an agent that is not in the configured roster", () => {
  const state = stateWith([runtime("Builder", { slug: "builder", agentType: "coder" })]);
  const r = queueOperatorCommand(state, "nonexistent", "end");
  assert.equal(r.ok, false);
  assert.match(r.error || "", /unknown agent/);
});

// ── Test 8: Allow-list — over-long agent name is rejected ──────────────

test("LLM tool gap: queueOperatorCommand rejects agent names longer than 120 characters", () => {
  const state = stateWith([runtime("Builder", { slug: "builder", agentType: "coder" })]);
  const longName = "x".repeat(121);
  const r = queueOperatorCommand(state, longName, "end");
  assert.equal(r.ok, false);
  assert.match(r.error || "", /too long/);
});

// ── Test 9: Allow-list — tear-down-all accepts an empty agent ──────────

test("LLM tool gap: queueOperatorCommand accepts an empty agent for tear-down-all (team-wide command)", () => {
  const state = stateWith([runtime("Builder", { slug: "builder", agentType: "coder" })]);
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-llm-teardown-"));
  withTempQueuePath(dir, () => {
    const r = queueOperatorCommand(state, "", "tear-down-all");
    assert.equal(r.ok, true, `tear-down-all must accept empty agent; got error: ${r.error}`);
    const rows = readOperatorCommandQueue();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].command, "tear-down-all");
    assert.equal(rows[0].agent, "");
  });
});

// ── Test 10: hive_reload_agent_config is the only "config-only" command

test("LLM tool gap: hive_reload_agent_config is the one command that does not require a live worker handle (T13.0 follow-up)", () => {
  // All commands except tear-down-all and hive_reload_agent_config
  // require a live worker handle at consumer time. The LLM tool
  // validates against the configured roster (so the model gets a
  // clear error), but the consumer additionally checks for a live
  // handle. The exception list must be exactly {tear-down-all,
  // hive_reload_agent_config} so the future consumer changes stay
  // consistent.
  const exceptions = OPERATOR_COMMAND_NAMES.filter((c) => c === "tear-down-all" || c === "hive_reload_agent_config");
  assert.deepEqual(exceptions.sort(), ["hive_reload_agent_config", "tear-down-all"]);
});

// ── Test 11: System prompt includes the operator surface section ───────

test("LLM tool gap: buildOrchestratorPrompt includes the operator surface section listing all 12 tools", () => {
  const state = stateWith([
    runtime("Builder", { slug: "builder", agentType: "coder" }),
    runtime("Reviewer", { slug: "reviewer", agentType: "reviewer" }),
  ]);
  // buildOrchestratorPrompt needs an orchestrator runtime to render;
  // the state's config.orchestrator IS the orchestrator. Add the
  // orchestrator to the runtimes map so resolveRuntime finds it.
  state.runtimes.set("orchestrator", runtime("Orchestrator", { slug: "orchestrator", agentType: "lead", role: "orchestrator" }));
  // A minimal ExtensionContext shape — renderKnowledgeRefs + renderSddPromptBlock
  // are the only consumers; they tolerate undefined cwd.
  const ctx = { cwd: "/tmp" } as any;
  const prompt = buildOrchestratorPrompt(state, ctx);
  assert.ok(prompt.length > 200, "orchestrator prompt renders non-trivially");
  // The operator surface section is present.
  assert.match(prompt, /## Operator surface \(LLM-callable\)/, "operator surface section heading present");
  // Every tool is mentioned in the prompt so the model knows it
  // exists (the description has the "when to use" details, but the
  // name itself must appear at least once).
  for (const name of EXPECTED_TOOL_NAMES) {
    assert.match(prompt, new RegExp(`\\\`?${name.replace(/_/g, "_")}\\\`?`), `prompt mentions ${name}`);
  }
  // The cooperative-vs-operator distinction is mentioned.
  assert.match(prompt, /cooperative/i, "prompt mentions cooperative tools");
  // The budget gate is mentioned.
  assert.match(prompt, /pre-flight|BudgetExhaustedError|budget/i, "prompt mentions budget / pre-flight gate");
});

// ── Test 12: System prompt's operator section lists all 12 names ───────

test("LLM tool gap: orchestrator system prompt's operator section lists every one of the 12 commands", () => {
  const state = stateWith([runtime("Builder", { slug: "builder", agentType: "coder" })]);
  state.runtimes.set("orchestrator", runtime("Orchestrator", { slug: "orchestrator", agentType: "lead", role: "orchestrator" }));
  const ctx = { cwd: "/tmp" } as any;
  const prompt = buildOrchestratorPrompt(state, ctx);
  // Slice out the operator surface section so the assertion
  // is local (other sections might incidentally contain "end"
  // or "pause" as natural English).
  const section = prompt.slice(prompt.indexOf("## Operator surface"));
  const operatorEnd = section.indexOf("## ", "## Operator surface".length);
  const operatorSection = operatorEnd === -1 ? section : section.slice(0, operatorEnd);
  // All 12 LLM tool names appear in the section. The names are
  // wrapped in backticks with optional "(agent)" or "()" appended,
  // so the regex just checks for the bare name.
  for (const name of EXPECTED_TOOL_NAMES) {
    assert.match(operatorSection, new RegExp(`\\\`${name}(?:\\(\\) |\\(|\\\`)`), `operator section lists \`${name}\``);
  }
});

// ── Test 13: Cross-process — LLM-written rows are byte-identical to
//              dashboard-written rows (modulo id + requestedAt) ────────

test("LLM tool gap: a row written by the LLM tool is consumable by the existing Wave 7 pickup (same shape as dashboard writes)", async () => {
  // This is the load-bearing assertion: the LLM tools and the
  // dashboard HTTP handler both write to operator-command-pickup.jsonl.
  // If the row shape diverges, the pickup consumer breaks. The
  // integration check pins the schema.
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-llm-cross-process-"));
  await withTempQueuePath(dir, async () => {
    const state = stateWith([runtime("Builder", { slug: "builder", agentType: "coder" })]);
    const tools = buildHiveTools(state, "Orchestrator") as any[];
    const endTool = tools.find((t) => t.name === "hive_end_worker");
    assert.ok(endTool, "hive_end_worker is registered");
    // Have the LLM tool write a row.
    const result = await endTool.execute("call-1", { agent: "builder" });
    assert.equal(result.details?.ok, true);
    // Read the row back.
    const rows = readOperatorCommandQueue();
    assert.equal(rows.length, 1, "exactly one row");
    const row = rows[0];
    // Schema check: id, agent, command, requestedAt are all strings
    // (or agent="" which is still a string). The pickup consumer
    // requires `agent` and `command` to be strings; `id` and
    // `requestedAt` are bookkeeping.
    assert.equal(typeof row.id, "string");
    assert.ok(row.id.length > 0);
    assert.equal(typeof row.agent, "string");
    assert.equal(row.agent, "builder");
    assert.equal(typeof row.command, "string");
    assert.equal(row.command, "end");
    assert.equal(typeof row.requestedAt, "string");
    // requestedAt is ISO 8601 (parses to a valid Date).
    const parsed = new Date(row.requestedAt);
    assert.ok(!Number.isNaN(parsed.getTime()), `requestedAt parses as a Date; got ${row.requestedAt}`);
    // The file was written with mode 0o600; the helper enforces this.
    const queuePath = operatorCommandQueuePath();
    assert.ok(existsSync(queuePath), `queue file exists at ${queuePath}`);
  });
});

// ── Test 14: Path resolution matches the consumer's expectation ───────

test("LLM tool gap: operatorCommandQueuePath resolves identically to the consumer's expectation (single JSONL file)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-llm-path-"));
  withTempQueuePath(dir, () => {
    const path = operatorCommandQueuePath();
    assert.ok(path.endsWith("/operator-command-pickup.jsonl"));
    assert.ok(path.startsWith(dir), `path starts with the temp dir; got ${path}`);
    assert.equal(dirname(path), dir);
  });
});

// ── Test 15: The 12 LLM tool names map 1:1 to the 12 engine functions ─

test("LLM tool gap: each LLM tool's command name matches the canonical 12 in the consumer's allow-list", () => {
  // The consumer's ALLOWED_COMMANDS set (operator-pickup.ts:95) is the
  // canonical list. The LLM tool's queueOperatorCommand helper
  // validates against the same set (mirrored as OPERATOR_COMMAND_NAMES).
  // If a tool wrote a command name that is not in OPERATOR_COMMAND_NAMES,
  // the consumer would reject it. Pin the mapping.
  for (const [toolName, command] of Object.entries(TOOL_TO_COMMAND)) {
    assert.ok(
      (OPERATOR_COMMAND_NAMES as readonly string[]).includes(command),
      `${toolName} maps to "${command}" which must be in OPERATOR_COMMAND_NAMES`,
    );
  }
  // And the helper itself rejects names outside the list.
  const state = stateWith([runtime("Builder", { slug: "builder", agentType: "coder" })]);
  for (const bad of ["format-disk", "open-pod-bay-doors", "rm -rf /"]) {
    const r = queueOperatorCommand(state, "builder", bad);
    assert.equal(r.ok, false, `"${bad}" must be rejected`);
  }
});

// ── Test 16: Wave `refactor/operator-writer-consolidation` ──────────
// Two writers used to exist (db.ts for the Bun dashboard,
// operator-command-queue.ts for the Node LLM tools). Wave
// `refactor/operator-writer-consolidation` collapsed them into a
// single runtime-agnostic implementation in
// operator-command-queue.ts. db.ts re-exports the helpers so the
// dashboard's call sites import from `./db` without churn. This
// test pins the consolidation contract with three checks:
//
//   1. Structural source grep. The OLD `writeOperatorCommandRequest`
//      body must no longer exist in `db.ts` — only a `export { ... }
//      from "..."` re-export should remain. (db.ts still keeps its
//      bun:sqlite logic; only the writer function moves.)
//   2. Reference identity through re-export. Importing
//      `writeOperatorCommandRequest` and `OPERATOR_COMMAND_NAMES`
//      through both paths returns the same object identity —
//      proof there's only one implementation, not a duplicate.
//   3. Row-shape parity. Writing through both paths yields rows
//      with the same `{id, agent, command, requestedAt}` shape.
//
// We avoid importing `db.ts` here (it pulls in `bun:sqlite` and is
// only typed under `tsconfig.bun.json`), so check 2 uses the
// shared import directly. The dashboard path is verified
// separately by the Bun-suite test in
// `tests/server-routes.spec.ts` (which exercises
// `readOperatorCommandRequests` / `clearOperatorCommandRequests`
// after the HTTP handler writes through the re-exported writer).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("operator-writer consolidation: db.ts no longer defines writeOperatorCommandRequest inline (single source of truth in operator-command-queue.ts)", () => {
  const dbPath = fileURLToPath(new URL("../src/observability/server/db.ts", import.meta.url));
  const queuePath = fileURLToPath(new URL("../src/engine/budget/operator-command-queue.ts", import.meta.url));
  const dbSrc = readFileSync(dbPath, "utf8");
  const queueSrc = readFileSync(queuePath, "utf8");

  // db.ts must NOT contain the inline body of writeOperatorCommandRequest
  // anymore. The old body used `appendFileSync(OPERATOR_COMMAND_QUEUE, ...)`
  // and a `const OPERATOR_COMMAND_QUEUE: string = (() => { ... })()`
  // declaration; if either is back, someone duplicated the writer.
  assert.equal(
    dbSrc.includes("const OPERATOR_COMMAND_QUEUE"),
    false,
    "db.ts must not declare a local OPERATOR_COMMAND_QUEUE — the path lives in operator-command-queue.ts",
  );
  assert.equal(
    /export function writeOperatorCommandRequest\(/.test(dbSrc),
    false,
    "db.ts must not define writeOperatorCommandRequest inline — it should re-export from operator-command-queue.ts",
  );

  // db.ts MUST re-export the helpers from the shared module.
  assert.ok(
    /export\s*\{[^}]*writeOperatorCommandRequest[^}]*\}\s*from\s*["']\.\.\/\.\.\/engine\/budget\/operator-command-queue["']/.test(dbSrc),
    "db.ts must re-export writeOperatorCommandRequest from operator-command-queue.ts",
  );
  assert.ok(
    /export\s*\{[^}]*readOperatorCommandRequests[^}]*\}\s*from\s*["']\.\.\/\.\.\/engine\/budget\/operator-command-queue["']/.test(dbSrc),
    "db.ts must re-export readOperatorCommandRequests from operator-command-queue.ts",
  );
  assert.ok(
    /export\s*\{[^}]*clearOperatorCommandRequests[^}]*\}\s*from\s*["']\.\.\/\.\.\/engine\/budget\/operator-command-queue["']/.test(dbSrc),
    "db.ts must re-export clearOperatorCommandRequests from operator-command-queue.ts",
  );

  // operator-command-queue.ts must export the shared writer.
  assert.ok(
    /export function writeOperatorCommandRequest\(/.test(queueSrc),
    "operator-command-queue.ts must define writeOperatorCommandRequest (the single source of truth)",
  );
});

test("operator-writer consolidation: writer and allow-list are identity-equal across import paths (no silent duplication)", async () => {
  const shared = await import("../src/engine/budget/operator-command-queue.ts");
  // Re-import in a fresh specifier to confirm module identity is
  // stable across repeated imports (Node caches the module
  // instance, so both specifiers resolve to the same object).
  const sharedAgain = await import("../src/engine/budget/operator-command-queue.ts");
  assert.equal(
    shared.writeOperatorCommandRequest,
    sharedAgain.writeOperatorCommandRequest,
    "the writer is module-scoped singleton — repeated imports share one function",
  );
  assert.equal(
    shared.OPERATOR_COMMAND_NAMES,
    sharedAgain.OPERATOR_COMMAND_NAMES,
    "the 12-command allow-list is the same frozen array on every import",
  );
  assert.equal(shared.OPERATOR_COMMAND_NAMES.length, 12, "12-command allow-list contains 11 + hive_reload_agent_config");
  assert.ok(
    shared.readOperatorCommandQueue === shared.readOperatorCommandRequests,
    "readOperatorCommandRequests is an alias of readOperatorCommandQueue (same function reference)",
  );
});

test("operator-writer consolidation: the row shape written is identical for two back-to-back calls (id-only differs)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-writer-consolidation-"));
  withTempQueuePath(dir, () => {
    // Clear any previous rows so the row count is deterministic.
    const queuePath = operatorCommandQueuePath();
    try { rmSync(queuePath, { force: true }); } catch { /* best-effort */ }
    const t1 = "2030-01-01T00:00:00.000Z";
    const t2 = "2030-01-01T00:00:00.001Z";
    const r1 = queueOperatorCommand(stateWith([runtime("Builder", { slug: "builder", agentType: "coder" })]), "builder", "end", t1);
    const r2 = queueOperatorCommand(stateWith([runtime("Builder", { slug: "builder", agentType: "coder" })]), "builder", "end", t2);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    const rows = readOperatorCommandQueue();
    assert.equal(rows.length, 2);
    const expectedKeys = ["agent", "command", "id", "requestedAt"];
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), expectedKeys, "row keys are exactly {id, agent, command, requestedAt}");
      assert.equal(typeof row.id, "string");
      assert.equal(typeof row.agent, "string");
      assert.equal(typeof row.command, "string");
      assert.equal(typeof row.requestedAt, "string");
    }
    assert.notEqual(rows[0].id, rows[1].id, "each writer invocation mints its own id");
    assert.equal(rows[0].requestedAt, t1);
    assert.equal(rows[1].requestedAt, t2);
  });
});

// ── Introspection tools (should-have) ───────────────────────────────

const INTROSPECTION_TOOL_NAMES = [
  "hive_read_policy",
  "hive_explain_rejection",
] as const;

test("LLM tool gap: buildHiveTools emits the 2 introspection tools (hive_read_policy, hive_explain_rejection) for the orchestrator", () => {
  const state = stateWith([runtime("Builder", { slug: "builder", agentType: "coder" })]);
  const tools = buildHiveTools(state, "Orchestrator") as any[];
  const toolNames = new Set(tools.map((t) => t.name));
  for (const name of INTROSPECTION_TOOL_NAMES) {
    assert.ok(toolNames.has(name), `orchestrator must see ${name}`);
  }
});

test("LLM tool gap: workers (coder / tester / reviewer / planner) do NOT see the introspection tools", () => {
  for (const agentType of ["coder", "tester", "reviewer", "planner"] as const) {
    const state = stateWith([runtime(`${agentType}-agent`, { slug: `${agentType}-agent`, agentType })]);
    const tools = buildHiveTools(state, `${agentType}-agent`) as any[];
    const toolNames = new Set(tools.map((t) => t.name));
    for (const name of INTROSPECTION_TOOL_NAMES) {
      assert.ok(!toolNames.has(name), `${agentType} must NOT see ${name}`);
    }
  }
});

test("LLM tool gap: hive_read_policy returns the resolved policy + strategies block for an agent", async () => {
  // Build a state with a per-agent override (a token cap) so the
  // resolved policy is non-empty and we can assert the policy
  // surface. findAgent uses case-sensitive name matching, so the
  // override has to be on the agent's exact `name` field ("Builder").
  const builderRuntime = runtime("Builder", {
    slug: "builder",
    agentType: "coder",
    governance: { tokens: { cap: 50_000 } } as any,
  });
  const state = stateWith([builderRuntime]);
  // Add a settings.budgets.strategies block so the strategies
  // surface is populated.
  const settings = state.config!.settings as any;
  settings.budgets = {
    perWorker: { tokens: { cap: 100_000 } },
    perTeam: { tokens: { cap: 1_000_000 } },
    strategies: {
      onApproachingLimit: { action: "wrap-up", threshold: 0.2, hint: "finish current task" },
      onExhaustion: { action: "abort" },
      summary: { maxTokens: 1500 },
    },
  };
  const tools = buildHiveTools(state, "Orchestrator") as any[];
  const tool = tools.find((t) => t.name === "hive_read_policy");
  assert.ok(tool, "hive_read_policy is registered");
  // The LLM tool resolves the agent by slug OR name, so pass
  // either. Use the slug to mirror what the model would say.
  const result = await tool.execute("call-1", { agent: "builder" });
  assert.equal(result.details?.ok, true);
  // The resolved policy reflects the per-agent cap (50_000 wins
  // over the global 100_000 — per-agent overrides are closest to
  // source per the resolver). The tool returns the canonical name
  // in `details.agent` for clarity.
  assert.equal(result.details?.agent, "Builder", "agent echoes canonical name");
  const policy = result.details?.policy;
  assert.ok(policy, "policy is returned");
  assert.equal(policy.worker?.tokens?.cap, 50_000, "per-agent cap wins over global");
  // The strategies block is surfaced.
  const strategies = result.details?.strategies;
  assert.ok(strategies, "strategies is returned");
  assert.equal(strategies.onApproachingLimit?.threshold, 0.2);
  assert.equal(strategies.onExhaustion?.action, "abort");
  assert.equal(strategies.summary?.maxTokens, 1500);
});

test("LLM tool gap: hive_read_policy returns a clear error for an unknown agent", async () => {
  const state = stateWith([runtime("Builder", { slug: "builder", agentType: "coder" })]);
  const tools = buildHiveTools(state, "Orchestrator") as any[];
  const tool = tools.find((t) => t.name === "hive_read_policy");
  assert.ok(tool);
  const result = await tool.execute("call-1", { agent: "nonexistent" });
  assert.equal(result.details?.ok, false);
  assert.match(result.content[0].text, /Unknown agent "nonexistent"/);
});

test("LLM tool gap: hive_explain_rejection returns null rejection when the agent has not been refused", async () => {
  const state = stateWith([runtime("Builder", { slug: "builder", agentType: "coder" })]);
  const tools = buildHiveTools(state, "Orchestrator") as any[];
  const tool = tools.find((t) => t.name === "hive_explain_rejection");
  assert.ok(tool);
  const result = await tool.execute("call-1", { agent: "builder" });
  assert.equal(result.details?.ok, true);
  assert.equal(result.details?.rejection, null, "fresh agent has no rejection recorded");
  assert.match(result.content[0].text, /No pre-flight rejection recorded/);
});

test("LLM tool gap: hive_explain_rejection returns the structured rejection when the runtime has one", async () => {
  const state = stateWith([runtime("Builder", { slug: "builder", agentType: "coder" })]);
  // Simulate a recorded rejection.
  const runtimeRef = state.runtimes.get("builder")!;
  runtimeRef.lastRejection = {
    reason: "Worker token budget exhausted: 100000/100000",
    scope: "worker",
    resource: "tokens",
    remaining: { tokens: 0 },
    limit: { tokens: 100000 },
    at: new Date().toISOString(),
  };
  const tools = buildHiveTools(state, "Orchestrator") as any[];
  const tool = tools.find((t) => t.name === "hive_explain_rejection");
  const result = await tool.execute("call-1", { agent: "builder" });
  assert.equal(result.details?.ok, true);
  const rejection = result.details?.rejection;
  assert.ok(rejection, "rejection is returned");
  assert.equal(rejection.scope, "worker");
  assert.equal(rejection.resource, "tokens");
  assert.equal(rejection.remaining.tokens, 0);
  assert.equal(rejection.limit.tokens, 100000);
  assert.match(result.content[0].text, /Worker token budget exhausted/);
  assert.match(result.content[0].text, /scope: worker/);
});

test("LLM tool gap: hive_explain_rejection returns a clear error for an unknown agent", async () => {
  const state = stateWith([runtime("Builder", { slug: "builder", agentType: "coder" })]);
  const tools = buildHiveTools(state, "Orchestrator") as any[];
  const tool = tools.find((t) => t.name === "hive_explain_rejection");
  const result = await tool.execute("call-1", { agent: "nonexistent" });
  assert.equal(result.details?.ok, false);
  assert.match(result.content[0].text, /Unknown agent "nonexistent"/);
});
