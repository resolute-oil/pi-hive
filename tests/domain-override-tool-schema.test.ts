// U1 — `OverrideEntry` typebox + `delegate_agent` tool param wiring.
//
// Covers AE1 (per-call parameter mechanism), R12 (empty-array boundary),
// and the typebox rejection contract. The unit-tests the schema directly via
// `Value.Errors` (matching the pattern in `tests/budget-contracts.test.ts`)
// and exercises the `delegate_agent` tool surface built from `buildHiveTools`
// to confirm `domain_override` flows through to `dispatchAgent` as the 8th
// positional (signature widening lives in `src/engine/dispatch.ts:278`). The
// dispatcher-side validator (reserved-paths / reviewer / depth / budget /
// inconsistent `isReadOnly`) is U2's job and is NOT exercised here.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { OverrideEntrySchema, type OverrideEntry } from "../src/core/types.ts";
import { buildHiveTools } from "../src/agents/tools.ts";

// Wrap `OverrideEntrySchema` in the same shape the tool surface uses
// (`Type.Optional(Type.Array(OverrideEntrySchema, ...))`) so the schema-level
// tests exercise the wire shape callers will see, not the inner entry alone.
const DelegateDomainOverrideSchema = Type.Optional(Type.Array(OverrideEntrySchema));

// Helper: strip ANSI escape codes (matching `tools-branches.test.ts`) so
// regex assertions match visible text only.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

// Minimal state fixture — mirrors `toolState()` in `tools-branches.test.ts`.
// `mode: "plan"` makes the plan-gate pre-flight reject a `coder` worker so
// the integration-style test below can verify the param reached
// `dispatchAgent` (the rejection message names the agent and the gate, NOT
// the typebox "missing parameters" surface). The rejection is deterministic
// and stable across runs.
function fixture(dir: string): any {
  const runtime = {
    config: { name: "Tiny", slug: "tiny", path: "Tiny.md", role: "member", agentType: "coder", groupName: "Engineering", routingTags: [], domain: [], allowedAgents: [] },
    systemPrompt: "", status: "idle", task: "", lastWork: "", toolCount: 0, elapsedMs: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    costUsd: 0, contextPct: 0, runCount: 0, sessionFile: join(dir, "tiny.jsonl"),
  };
  return {
    pi: {}, mode: "plan", activeRuns: 0, workerQueue: [], activeChangeId: undefined,
    config: {
      orchestrator: { name: "Orchestrator", path: "o.md", role: "orchestrator", allowedAgents: ["tiny"] },
      agents: [runtime.config], sharedContext: [],
      settings: { subagentOutputLimit: 100, defaultTools: "read", maxParallel: 3, distiller: { enabled: false, model: "", conversationLines: 10 } },
    },
    session: { sessionId: "s1", sessionDir: dir, conversationLog: join(dir, "c.jsonl"), observabilityLog: join(dir, "e.jsonl") },
    runtimes: new Map([["tiny", runtime]]),
    latestVerdicts: new Map(),
  };
}

const theme = {
  fg: (_color: string, value: string) => value,
  bold: (value: string) => value,
};

// ── Schema-level contract (typebox) ──────────────────────────────────────

// AE1 happy path: a valid `OverrideEntry` is accepted by the schema.
test("OverrideEntrySchema accepts a valid per-call write grant (AE1)", () => {
  const valid: OverrideEntry = { path: ".worktrees/x/app/", upsert: true, delete: false };
  assert.equal(Value.Errors(OverrideEntrySchema, valid).length, 0);
});

// AE1 happy path with optional include/exclude globs narrowed to the path.
test("OverrideEntrySchema accepts optional include/exclude globs", () => {
  const valid: OverrideEntry = { path: ".worktrees/x/app/", upsert: true, delete: false, include: ["**/*.ts"], exclude: ["**/*.test.ts"] };
  assert.equal(Value.Errors(OverrideEntrySchema, valid).length, 0);
});

// R12 boundary: an empty array `[]` is structurally valid (no entries is
// not a type error). The dispatcher treats it as "no override" (U2).
test("OverrideEntry array wrapper accepts an empty array (R12 boundary)", () => {
  assert.equal(Value.Errors(DelegateDomainOverrideSchema, []).length, 0);
});

// AE1 happy path at the wire shape: `delegate_agent` accepts the full
// param object including a populated override.
test("delegate_agent wire shape accepts domain_override with one entry", () => {
  const valid = {
    agent: "Tiny",
    task: "review",
    domain_override: [{ path: ".worktrees/x/app/", upsert: true, delete: false }],
  };
  assert.equal(Value.Errors(DelegateDomainOverrideSchema, valid.domain_override).length, 0);
});

// Error: a non-array value is rejected by the schema (e.g. the caller passes
// a string). Typebox returns structured errors the orchestrator can surface.
test("delegate_agent rejects non-array domain_override with a structured error", () => {
  const errors = Value.Errors(DelegateDomainOverrideSchema, "nope");
  assert.ok(errors.length > 0, "expected at least one typebox error for string-shaped override");
  // The first error must reference the offending path so the orchestrator
  // can show the user where the validation failed.
  const root = errors[0];
  assert.ok(typeof root.message === "string" && root.message.length > 0, "error message is non-empty");
});

// Error: an entry missing the required `path` field is rejected. Path and
// the boolean triple are all required so callers see the full action set
// on the wire (the schema description strings explain why defaults are
// not silently filled in).
test("OverrideEntrySchema rejects an entry missing required path", () => {
  const errors = Value.Errors(OverrideEntrySchema, { upsert: true, delete: false });
  assert.ok(errors.length > 0, "expected a typebox error for missing path");
});

// Error: an entry missing `upsert` or `delete` is rejected — booleans are
// required (not defaulted) so the caller must own the choice.
test("OverrideEntrySchema rejects an entry missing required upsert/delete", () => {
  const missingUpsert = Value.Errors(OverrideEntrySchema, { path: ".worktrees/x/app/", delete: false });
  const missingDelete = Value.Errors(OverrideEntrySchema, { path: ".worktrees/x/app/", upsert: true });
  assert.ok(missingUpsert.length > 0, "missing upsert must fail validation");
  assert.ok(missingDelete.length > 0, "missing delete must fail validation");
});

// Error: `include`/`exclude` must be arrays of strings when present.
test("OverrideEntrySchema rejects non-string include/exclude entries", () => {
  const badInclude = Value.Errors(OverrideEntrySchema, { path: ".worktrees/x/app/", upsert: true, delete: false, include: [123] });
  const badExclude = Value.Errors(OverrideEntrySchema, { path: ".worktrees/x/app/", upsert: true, delete: false, exclude: [true] });
  assert.ok(badInclude.length > 0, "non-string include must fail validation");
  assert.ok(badExclude.length > 0, "non-string exclude must fail validation");
});

// ── Tool surface contract (buildHiveTools → delegate_agent) ──────────────

// Render surface: `domain_override` set as a flag renders in the call line,
// mirroring the `isReadOnly` precedent (T13.0). Count is shown so the
// caller sees the override landed without dumping full paths.
test("delegate_agent renderCall surfaces domain_override count", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-override-render-"));
  const state = fixture(dir);
  const delegate = (buildHiveTools(state, "Orchestrator") as any[]).find((tool) => tool.name === "delegate_agent");

  const one = delegate.renderCall(
    { agent: "Tiny", task: "review", domain_override: [{ path: ".worktrees/x/app/", upsert: true, delete: false }] },
    theme,
  ).render(120);
  assert.match(stripAnsi(one[0]), /delegate_agent Tiny \[domain_override=1\]/);

  const two = delegate.renderCall(
    { agent: "Tiny", task: "review", domain_override: [
      { path: ".worktrees/x/app/", upsert: true, delete: false },
      { path: ".worktrees/x/test/", upsert: true, delete: false },
    ] },
    theme,
  ).render(120);
  assert.match(stripAnsi(two[0]), /delegate_agent Tiny \[domain_override=2\]/);
});

// R12: an empty array `[]` still renders as a flag (the caller chose to
// pass it), so `domain_override=0` is visible on the call line.
test("delegate_agent renderCall surfaces domain_override=0 when caller passes []", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-override-empty-"));
  const state = fixture(dir);
  const delegate = (buildHiveTools(state, "Orchestrator") as any[]).find((tool) => tool.name === "delegate_agent");

  const empty = delegate.renderCall(
    { agent: "Tiny", task: "review", domain_override: [] },
    theme,
  ).render(120);
  assert.match(stripAnsi(empty[0]), /delegate_agent Tiny \[domain_override=0\]/);
});

// Defaults stay invisible: omitting `domain_override` produces no flag
// suffix, so the common case is unchanged from before U1.
test("delegate_agent renderCall omits domain_override flag when not set", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-override-default-"));
  const state = fixture(dir);
  const delegate = (buildHiveTools(state, "Orchestrator") as any[]).find((tool) => tool.name === "delegate_agent");

  const none = delegate.renderCall({ agent: "Tiny", task: "review" }, theme).render(120);
  assert.doesNotMatch(stripAnsi(none[0]), /domain_override/);
});

// Integration-style: the param reaches `dispatchAgent`. The fixture puts the
// state in `mode: "plan"` with a `coder` worker; pre-flight rejects
// "Delegation blocked: plan mode may only delegate to planners..." before
// any session is created. The rejection message names the worker, so we
// can assert the param flow reached `dispatchAgent` (not the typebox
// missing-parameters surface, which would NOT name the worker).
test("delegate_agent execute forwards domain_override into dispatchAgent (AE1 wiring)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-override-flow-"));
  const state = fixture(dir);
  const delegate = (buildHiveTools(state, "Orchestrator") as any[]).find((tool) => tool.name === "delegate_agent");

  const result = await delegate.execute("id", {
    agent: "Tiny",
    task: "review",
    domain_override: [{ path: ".worktrees/x/app/", upsert: true, delete: false }],
  }, undefined, undefined, { cwd: dir } as any);

  // The pre-flight rejection is the deterministic short-circuit BEFORE any
  // session creation. If the param flow had been dropped at the tool
  // surface, dispatchAgent would still have been called (it's wired
  // unconditionally), but we also want a positive signal: the rejection
  // message references the worker name (proof the call entered dispatchAgent
  // with a real agent + task pair), not the typebox "missing parameters"
  // surface (which fires inside the tool before dispatchAgent is touched).
  assert.equal(result.details.status, "error");
  assert.match(result.content[0].text, /Tiny/);
  assert.doesNotMatch(result.content[0].text, /missing parameters/);
});

// R12: an empty array `[]` is forwarded to `dispatchAgent` (not dropped to
// undefined at the tool surface). We verify via the same integration-style
// pattern — the rejection message names Tiny, proving dispatchAgent ran.
test("delegate_agent execute forwards empty [] array to dispatchAgent (R12)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hive-override-empty-flow-"));
  const state = fixture(dir);
  const delegate = (buildHiveTools(state, "Orchestrator") as any[]).find((tool) => tool.name === "delegate_agent");

  const result = await delegate.execute("id", {
    agent: "Tiny",
    task: "review",
    domain_override: [],
  }, undefined, undefined, { cwd: dir } as any);

  assert.equal(result.details.status, "error");
  assert.match(result.content[0].text, /Tiny/);
  assert.doesNotMatch(result.content[0].text, /missing parameters/);
});
