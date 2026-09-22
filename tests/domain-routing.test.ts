import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashMutationKind, canDelegateTo, domainAllows, enforceDomainForTool, pathWithin } from "../src/engine/domain.ts";
import { routeAgents } from "../src/engine/routing.ts";
import { runAsAgent } from "../src/engine/session.ts";
import { buildOrchestratorPrompt } from "../src/agents/prompts.ts";
import type { AgentConfig, AgentRuntime, HiveState } from "../src/core/types.ts";

function runtime(name: string, extra: Partial<AgentRuntime["config"]> = {}): AgentRuntime {
  return {
    config: {
      name,
      path: `${name}.md`,
      role: "member",
      routingTags: [],
      domain: [],
      ...extra,
    },
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
  return {
    pi: {} as any,
    config: null,
    session: null,
    runtimes: new Map(runtimes.map((entry) => [entry.config.name.toLowerCase(), entry])),
    widgetCtx: null,
    activeRuns: 0,
    mode: "hive",
    normalToolNames: [],
    sddStatus: null,
    obsSeq: 0,
  };
}

test("domainAllows uses most-specific-wins with deny tie-breaks", () => {
  const ctx = { cwd: "/repo" } as any;
  const agent = runtime("Frontend Dev", {
    domain: [
      { path: "ui", read: true, upsert: true, delete: false },
      { path: "ui/secrets", read: true, upsert: false, delete: false },
    ],
  });

  assert.equal(pathWithin("/repo/ui", "/repo/ui/src/App.tsx"), true);
  assert.equal(domainAllows(ctx, agent, "ui/src/App.tsx", "upsert"), true);
  assert.equal(domainAllows(ctx, agent, "ui/secrets/token.ts", "upsert"), false);
  assert.equal(domainAllows(ctx, agent, "server/index.ts", "read"), false);
});

test("domainAllows applies include globs more specifically than catch-all denies", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-domain-"));
  mkdirSync(join(cwd, "backend/patient"), { recursive: true });
  writeFileSync(join(cwd, "backend/patient/search_test.go"), "package patient");
  writeFileSync(join(cwd, "backend/patient/search.go"), "package patient");
  const ctx = { cwd } as any;
  const agent = runtime("Core Tester", {
    domain: [
      { path: "backend", read: true, upsert: false, delete: false },
      { path: "backend", read: true, upsert: true, delete: false, include: ["**/*_test.go"] },
    ],
  });

  assert.equal(domainAllows(ctx, agent, "backend/patient/search_test.go", "read"), true);
  assert.equal(domainAllows(ctx, agent, "backend/patient/search_test.go", "upsert"), true);
  assert.equal(domainAllows(ctx, agent, "backend/patient/search.go", "read"), true);
  assert.equal(domainAllows(ctx, agent, "backend/patient/search.go", "upsert"), false);
});

test("domainAllows rejects existing and new targets through an escaping symlink", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-domain-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-hive-domain-outside-"));
  mkdirSync(join(cwd, "allowed"));
  writeFileSync(join(cwd, "allowed/inside.txt"), "inside");
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(outside, join(cwd, "allowed/escape"));
  symlinkSync(outside, join(cwd, "linked-domain"));
  const ctx = { cwd } as any;
  const agent = runtime("Symlink Tester", {
    domain: [{ path: "allowed", read: true, upsert: true, delete: true }],
  });

  assert.equal(domainAllows(ctx, agent, "allowed/inside.txt", "read"), true);
  assert.equal(domainAllows(ctx, agent, "allowed/escape/secret.txt", "read"), false);
  assert.equal(domainAllows(ctx, agent, "allowed/escape/new.txt", "upsert"), false);
  assert.equal(domainAllows(ctx, agent, "allowed/escape/secret.txt", "delete"), false);
  const linkedRootAgent = runtime("Linked Root", {
    domain: [{ path: "linked-domain", read: true, upsert: true, delete: true }],
  });
  assert.equal(domainAllows(ctx, linkedRootAgent, "linked-domain/secret.txt", "read"), false);
  assert.equal(domainAllows(ctx, linkedRootAgent, "linked-domain/new.txt", "upsert"), false);
});

test("domainAllows honors exclude globs", () => {
  const ctx = { cwd: "/repo" } as any;
  const agent = runtime("Backend Dev", {
    domain: [
      { path: "backend", read: true, upsert: true, delete: false, exclude: ["generated/**"] },
      { path: "backend/generated", read: true, upsert: false, delete: false },
    ],
  });

  assert.equal(domainAllows(ctx, agent, "backend/api/server.go", "upsert"), true);
  assert.equal(domainAllows(ctx, agent, "backend/generated/client.go", "upsert"), false);
});

test("enforceDomainForTool blocks mutating bash outside explicit domains", () => {
  const ctx = { cwd: "/repo" } as any;
  const state = stateWith([runtime("Frontend Dev", { domain: [{ path: "ui", read: true, upsert: true, delete: false }] })]);

  assert.equal(bashMutationKind("rm ui/App.tsx"), "delete");
  runAsAgent("Frontend Dev", () => {
    assert.match(enforceDomainForTool(state, { toolName: "bash", input: { command: "rm ui/App.tsx" } }, ctx)?.reason ?? "", /cannot delete/);
    assert.equal(enforceDomainForTool(state, { toolName: "bash", input: { command: "touch ui/App.tsx" } }, ctx), undefined);
  });
});

test("routeAgents scores specialists and respects delegation hierarchy", () => {
  const state = stateWith([
    runtime("Orchestrator", { role: "orchestrator", allowedAgents: ["Frontend Dev", "Backend Dev"] }),
    runtime("Frontend Dev", { role: "lead", groupName: "Engineering", routingTags: ["react", "css"] }),
    runtime("Backend Dev", { role: "lead", groupName: "Engineering", routingTags: ["api", "database"] }),
    runtime("Security Reviewer", { role: "member", groupName: "Validation", routingTags: ["security"] }),
  ]);

  const matches = runAsAgent("Orchestrator", () => routeAgents(state, "fix the React CSS component", 3));
  assert.equal(matches[0].name, "Frontend Dev");
  assert.equal(matches.some((match) => match.name === "Security Reviewer"), false);

  for (const unsafe of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
    const bounded = runAsAgent("Orchestrator", () => routeAgents(state, "fix the React CSS component", unsafe));
    assert.equal(bounded[0].name, "Frontend Dev");
    assert.ok(bounded.length <= 5, `unsafe limit ${unsafe} must fall back to a bounded result`);
  }
});

test("routeAgents scores capability types and SDD phase groups", () => {
  const specialists = [
    runtime("Planning Specialist", { role: "lead", agentType: "planner", groupName: "Planning", consultWhen: "requirements and product scope", routingTags: ["proposal"], responsibilities: ["design specs"] }),
    runtime("Implementation Coder", { role: "lead", agentType: "coder", groupName: "Engineering", consultWhen: "backend component", domain: [{ path: "src/api", description: "service migration", read: true, upsert: true, delete: false }] }),
    runtime("QA Tester", { role: "lead", agentType: "tester", groupName: "QA Validation", consultWhen: "acceptance evidence" }),
    runtime("Security Reviewer", { role: "lead", agentType: "reviewer", groupName: "Validation", consultWhen: "auth permission review" }),
  ];
  const state = stateWith([
    runtime("Orchestrator", { role: "orchestrator", allowedAgents: specialists.map((entry) => entry.config.name) }),
    ...specialists,
  ]);

  const task = "plan product requirements proposal design specs tasks; implement backend API service migration component; test QA acceptance evidence; security auth permission review; apply-progress implementation; verify-report release confidence";
  const matches = runAsAgent("Orchestrator", () => routeAgents(state, task, 1000));
  assert.deepEqual(new Set(matches.map((match) => match.name)), new Set(specialists.map((entry) => entry.config.name)));
  assert.ok(matches.find((match) => match.name === "Planning Specialist")?.reasons.includes("planning-group"));
  assert.ok(matches.find((match) => match.name === "Implementation Coder")?.reasons.includes("coder-type"));
  assert.ok(matches.find((match) => match.name === "QA Tester")?.reasons.includes("tester-type"));
  assert.ok(matches.find((match) => match.name === "Security Reviewer")?.reasons.includes("reviewer-type"));

  state.mode = "plan";
  const planning = runAsAgent("Orchestrator", () => routeAgents(state, task));
  assert.equal(planning.some((match) => ["Implementation Coder", "QA Tester"].includes(match.name)), false);
});

test("buildOrchestratorPrompt routes to the ACTUAL configured leads, nothing hardcoded (H3/L4)", () => {
  // A team with entirely custom lead names — no "Engineering Lead"/"Planning
  // Lead" anywhere. The routing block must name these leads and their cues.
  const lead = (name: string, extra: Partial<AgentConfig> = {}): AgentConfig =>
    ({ name, path: `${name}.md`, role: "lead", routingTags: [], domain: [], ...extra });
  const shipwright = lead("Shipwright", { consultWhen: "building and shipping features", agentType: "lead" });
  const cartographer = lead("Cartographer", { consultWhen: "mapping requirements and specs", agentType: "lead" });
  const orchestrator = lead("Conductor", { role: "orchestrator" });

  const state = stateWith([
    { config: orchestrator, systemPrompt: "ORCH-SYS", status: "idle", task: "", lastWork: "", toolCount: 0, elapsedMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, contextPct: 0, runCount: 0, sessionFile: "" },
  ]);
  state.config = {
    orchestrator, agents: [shipwright, cartographer], sharedContext: [],
    settings: { subagentOutputLimit: 100, defaultTools: "read", maxParallel: 2, distiller: { enabled: false, model: "", conversationLines: 10 } },
  } as any;

  const prompt = buildOrchestratorPrompt(state, { cwd: "/repo" } as any);

  // Names the configured leads and their cues.
  assert.match(prompt, /Shipwright/);
  assert.match(prompt, /Cartographer/);
  assert.match(prompt, /building and shipping features/);
  assert.match(prompt, /mapping requirements and specs/);
  // Routing lines are derived from the real cues → real leads.
  assert.match(prompt, /Work matching "building and shipping features" → shipwright \(Shipwright\)\./);
  assert.match(prompt, /Work matching "mapping requirements and specs" → cartographer \(Cartographer\)\./);
  // Nothing hardcoded from the example teams leaks in.
  assert.doesNotMatch(prompt, /Engineering Lead|Planning Lead/);
});

// --- Orchestrator delegation widening (T1-T5) ---
// The orchestrator's allowedAgents is derived from members/children nesting
// (typically the top-level leads). To let the orchestrator route read-only
// inspections directly to typed specialists (coder/tester/reviewer/planner)
// without going through a parent lead, canDelegateTo adds a second axis:
// after the tree-match check, if the target's agent-type is in
// {coder, tester, reviewer, planner}, the call is allowed. lead-typed
// targets stay tree-bound. See `src/engine/domain.ts:18-31`.

test("canDelegateTo widens to typed specialists (non-direct-report coder)", () => {
  const state = stateWith([
    runtime("Orchestrator", { role: "orchestrator", allowedAgents: ["Engineering Lead"] }),
    runtime("Engineering Lead", { role: "lead", agentType: "lead", groupName: "Engineering" }),
    runtime("Frontend Coder", { role: "member", agentType: "coder", groupName: "Engineering" }),
  ]);
  runAsAgent("Orchestrator", () => {
    assert.deepEqual(canDelegateTo(state, "Orchestrator", "Frontend Coder"), { ok: true });
  });
});

test("canDelegateTo keeps lead-typed non-reports tree-bound after widening", () => {
  const state = stateWith([
    runtime("Orchestrator", { role: "orchestrator", allowedAgents: ["Engineering Lead"] }),
    runtime("Engineering Lead", { role: "lead", agentType: "lead", groupName: "Engineering" }),
    runtime("Sub-Lead", { role: "lead", agentType: "lead", groupName: "Engineering" }),
  ]);
  runAsAgent("Orchestrator", () => {
    const result = canDelegateTo(state, "Orchestrator", "Sub-Lead");
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /can only delegate to/);
  });
});

test("canDelegateTo widens for all four inspection-capable agent types", () => {
  const state = stateWith([
    runtime("Orchestrator", { role: "orchestrator", allowedAgents: ["Engineering Lead"] }),
    runtime("Engineering Lead", { role: "lead", agentType: "lead", groupName: "Engineering" }),
    runtime("Frontend Coder", { role: "member", agentType: "coder", groupName: "Engineering" }),
    runtime("QA Tester", { role: "member", agentType: "tester", groupName: "Validation" }),
    runtime("Spec Reviewer", { role: "member", agentType: "reviewer", groupName: "Validation" }),
    runtime("Plan Specialist", { role: "member", agentType: "planner", groupName: "Planning" }),
  ]);
  runAsAgent("Orchestrator", () => {
    for (const target of ["Frontend Coder", "QA Tester", "Spec Reviewer", "Plan Specialist"]) {
      assert.deepEqual(canDelegateTo(state, "Orchestrator", target), { ok: true }, `${target} should be reachable via type widening`);
    }
  });
});

test("canDelegateTo denial reason names both the tree-allowed list and the type-allowed set", () => {
  const state = stateWith([
    runtime("Orchestrator", { role: "orchestrator", allowedAgents: ["Engineering Lead"] }),
    runtime("Engineering Lead", { role: "lead", agentType: "lead", groupName: "Engineering" }),
    runtime("Stranger", { role: "lead", agentType: "lead", groupName: "Other" }),
  ]);
  runAsAgent("Orchestrator", () => {
    const result = canDelegateTo(state, "Orchestrator", "Stranger");
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /Engineering Lead/);
    assert.match(result.reason ?? "", /coder|tester|reviewer|planner/);
  });
});

test("canDelegateTo widening applies symmetrically to non-orchestrator callers", () => {
  const state = stateWith([
    runtime("Orchestrator", { role: "orchestrator", allowedAgents: ["Engineering Lead"] }),
    runtime("Engineering Lead", { role: "lead", agentType: "lead", allowedAgents: ["Frontend Coder"], groupName: "Engineering" }),
    runtime("Frontend Coder", { role: "member", agentType: "coder", groupName: "Engineering" }),
    runtime("Backend Coder", { role: "member", agentType: "coder", groupName: "Engineering" }),
  ]);
  runAsAgent("Engineering Lead", () => {
    // Backend Coder is typed coder and not in Engineering Lead's direct
    // reports — the widening lets the lead reach it.
    assert.deepEqual(canDelegateTo(state, "Engineering Lead", "Backend Coder"), { ok: true });
    // Frontend Coder is in Engineering Lead's allowedAgents — tree match wins.
    assert.deepEqual(canDelegateTo(state, "Engineering Lead", "Frontend Coder"), { ok: true });
  });
});

// --- T-Routing (PR #10 plan item) ---
// Acceptance criterion #4 in the plan: the orchestrator still routes
// HANDOFF cycle rotation, worktree create, preflight, push, and PR-open
// through the operations lead. This is enforced by the orchestrator
// prompt + routeAgents scoring (NOT by canDelegateTo — the widening in
// PR #10 lets any typed specialist be reached, and a coder is technically
// capable of running worktree/push). The test asserts the routing layer
// reflects the prompt-level preference.

test("routeAgents prefers Operations for HANDOFF/worktree/push/PR-open task strings (T-Routing)", () => {
  const state = stateWith([
    runtime("Orchestrator", { role: "orchestrator", allowedAgents: ["Operations"] }),
    runtime("Operations", {
      role: "lead",
      agentType: "lead",
      groupName: "Operations",
      routingTags: ["handoff", "worktree", "push", "pull request"],
      consultWhen: "HANDOFF cycle rotation, worktree create, preflight, push, PR-open",
    }),
    runtime("Frontend Coder", {
      role: "member",
      agentType: "coder",
      groupName: "Engineering",
      routingTags: ["react", "ui"],
    }),
  ]);

  runAsAgent("Orchestrator", () => {
    // Operations top-matches each lead-routed operation by tag overlap.
    for (const task of [
      "rotate the HANDOFF cycle for next session",
      "git worktree create for fix/foo",
      "git push the changes to remote",
      "open a pull request for fix/foo",
    ]) {
      const matches = routeAgents(state, task, 3);
      assert.equal(
        matches[0]?.name,
        "Operations",
        `expected Operations to top-match "${task}"; got: ${matches.map((m) => m.name).join(", ")}`,
      );
    }

    // A read-only inspection task should NOT route to Operations. The
    // Frontend Coder (typed coder, type-widening-reachable) wins on tag
    // overlap with "react"; Operations scores 0 and is filtered.
    const inspection = routeAgents(state, "look at this React view file", 3);
    assert.notEqual(
      inspection[0]?.name,
      "Operations",
      `Operations should not top-match read-only inspection; got: ${inspection.map((m) => m.name).join(", ")}`,
    );
    assert.ok(
      inspection.some((m) => m.name === "Frontend Coder"),
      `Frontend Coder should surface for react-related inspection; got: ${inspection.map((m) => m.name).join(", ")}`,
    );
  });
});
