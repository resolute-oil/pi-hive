// U3 — `enforceDomainForTool` plumbs merged scope.
//
// Covers the read half of the KTD4 plumbing (R5 enforcement + R7 concurrency).
// U2 writes `state.activeOverrides` at grant and clears it on revoke; U3 reads
// from the same field inside `enforceDomainForTool` (with an optional
// `effectiveDomain` parameter as the threading escape hatch for AE6-style
// concurrency). The tests in this file are mechanism-agnostic — they exercise
// the read surface only, treating `state.activeOverrides` (or the explicit
// `effectiveDomain` argument) as the seam.
//
// Patterns to follow:
//   - `runAsAgent(name, fn)` from `engine/session` scopes the AsyncLocalStorage
//     that `runtimeForCaller` reads, mirroring `tests/policy.test.ts`'s idiom.
//   - The minimal `stateWith([runtime(...)])` fixture is reused from
//     `tests/domain-routing.test.ts` so the existing-call-site path (no
//     explicit `effectiveDomain`, no `activeOverrides`) keeps its pre-U2
//     behavior under regression.
//   - `agentSlug` collision safety: callers match the worker's slug field
//     (lowercased name) to the `activeOverrides.worker` field U2 writes;
//     a deliberate mismatch in the rejection test must NOT let an override
//     leak across workers.
//
// Plan reference: docs/plans/2026-10-11-001-feat-per-delegation-domain-override-plan.md
// U3 § "Test scenarios":
//   - Happy: tool call against override ∪ static path succeeds.
//   - Edge (static only): a static-only path stays allowed inside the grant.
//   - Edge (post-revoke denied): an override-only path is denied after revoke.
//   - Concurrency (AE6): two parallel reads see only their own scope.
//   - Mismatch worker: a stale/wrong-worker override is ignored.

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { enforceDomainForTool } from "../src/engine/domain.ts";
import { runAsAgent } from "../src/engine/session.ts";
import type { AgentRuntime, DomainScope, HiveState, OverrideEntry } from "../src/core/types.ts";

// ── helpers ──────────────────────────────────────────────────────────────

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

// Materialize the override into a merged scope the way U2 does inside
// dispatchAgent. Kept here (rather than imported) so the test stays
// mechanism-agnostic — U2's internal merge algorithm could change
// without invalidating these tests, as long as the resulting
// `mergedScope` shape stays a `DomainScope[]`.
function mergedScopeFrom(staticDomain: DomainScope[], override: OverrideEntry[]): DomainScope[] {
  const merged: DomainScope[] = staticDomain.map((scope) => ({ ...scope }));
  for (const entry of override) {
    const row: DomainScope = {
      path: entry.path,
      read: true,
      upsert: Boolean(entry.upsert),
      delete: Boolean(entry.delete),
    };
    if (entry.include) row.include = entry.include;
    if (entry.exclude) row.exclude = entry.exclude;
    merged.push(row);
  }
  return merged;
}

// Real on-disk CWD so `resolveConfiguredPath` (which calls realpath) can
// resolve every scope path the tests feed in. A bare "/repo" string would
// fail path resolution and short-circuit `domainAllows` to false.
const policyRoot = realpathSync(mkdtempSync(join(tmpdir(), "pi-hive-uo-enforce-")));
mkdirSync(join(policyRoot, "ui"), { recursive: true });
mkdirSync(join(policyRoot, "src"), { recursive: true });
mkdirSync(join(policyRoot, ".worktrees"), { recursive: true });
mkdirSync(join(policyRoot, ".worktrees/feat-x"), { recursive: true });
mkdirSync(join(policyRoot, ".worktrees/feat-x/app"), { recursive: true });
mkdirSync(join(policyRoot, ".worktrees/_conflict-x"), { recursive: true });
mkdirSync(join(policyRoot, ".worktrees/_conflict-x/app"), { recursive: true });
mkdirSync(join(policyRoot, ".worktrees/conflict-a/app"), { recursive: true });
mkdirSync(join(policyRoot, ".worktrees/conflict-b/app"), { recursive: true });
writeFileSync(join(policyRoot, "src/existing.ts"), "x");
writeFileSync(join(policyRoot, "ui/App.tsx"), "x");
// Existing on-disk files so the `read` capability (which uses
// `allowMissing: false` and requires the target to exist) resolves the
// scope path. Without these, the read tests below fail at the scope-
// match layer regardless of what `domainAllows` would have decided.
writeFileSync(join(policyRoot, ".worktrees/feat-x/app/index.tsx"), "// existing");
writeFileSync(join(policyRoot, ".worktrees/feat-x/app/new.tsx"), "// existing");
writeFileSync(join(policyRoot, ".worktrees/feat-x/app/cross.tsx"), "// existing");
writeFileSync(join(policyRoot, ".worktrees/conflict-a/app/file.tsx"), "// existing");
writeFileSync(join(policyRoot, ".worktrees/conflict-b/app/file.tsx"), "// existing");
writeFileSync(join(policyRoot, ".worktrees/conflict-a/app/cross.tsx"), "// existing");
writeFileSync(join(policyRoot, ".worktrees/conflict-b/app/cross.tsx"), "// existing");
const ctx = { cwd: policyRoot } as any;

const writeUpsertEvent = (p: string) => ({ type: "tool_call" as const, toolCallId: "t1", toolName: "write" as const, input: { path: p } });
const readEvent = (p: string) => ({ type: "tool_call" as const, toolCallId: "t1", toolName: "read" as const, input: { path: p } });

// Block/allow via enforceDomainForTool under the named agent scope.
// Mirrors `tests/policy.test.ts`'s `block(...)` helper.
function underAgent(agent: string, state: HiveState, ev: any, effectiveDomain?: DomainScope[]): { block: true; reason: string } | undefined {
  return runAsAgent(agent, () => enforceDomainForTool(state, ev, ctx, effectiveDomain));
}

// ── AE1 — happy: override ∪ static path is allowed inside the grant ──────

test("enforceDomainForTool U3 happy — tool call against an override-only path is allowed inside the grant lifetime", () => {
  // Static config has NO write on `.worktrees/feat-x/app/` — the only
  // way it becomes writable is the merged scope U2 built at grant. The
  // override entry itself grants write (`upsert: true`).
  const staticDomain: DomainScope[] = [{ path: "ui/", read: true, upsert: true, delete: false }];
  const worker = runtime("Builder", { domain: staticDomain });
  const state = stateWith([worker]);

  const override: OverrideEntry[] = [{ path: ".worktrees/feat-x/app/", upsert: true, delete: false }];
  // Setting `state.activeOverrides` directly (without going through
  // dispatchAgent) is the unit-test surface for the U3 read side; this
  // is exactly the seam U2 writes to during grant. The worker slug is
  // what U2 emits and what U3's mismatch guard checks against.
  state.activeOverrides = {
    delegationId: "dov-test-happy",
    worker: "builder",
    mergedScope: mergedScopeFrom(staticDomain, override),
    staticReference: "unused-here",
  };

  const result = underAgent("Builder", state, writeUpsertEvent(".worktrees/feat-x/app/index.tsx"));
  assert.equal(result, undefined, "override-only write path must be allowed inside the grant: " + result?.reason);
});

test("enforceDomainForTool U3 happy — merged scope is the union (override wins over static deny, static grants pass through)", () => {
  // Static config explicitly DENIES write on `src/` and grants write
  // only on `ui/`. The override grants write on a fresh path that is
  // not in static at all. Inside the grant, the override-only path
  // must succeed AND the static-write-allowed path must still succeed
  // (regression: U2 builds merged = static ∪ override, not override-
  // only). Reading `.env*` should still trip the reserved-path fence
  // regardless of the merged scope, so it's deliberately excluded from
  // these happy assertions.
  const staticDomain: DomainScope[] = [
    { path: "ui/", read: true, upsert: true, delete: false },
    { path: "src/", read: true, upsert: false, delete: false },
  ];
  const worker = runtime("Builder", { domain: staticDomain });
  const state = stateWith([worker]);

  const override: OverrideEntry[] = [{ path: ".worktrees/feat-x/app/", upsert: true, delete: false }];
  state.activeOverrides = {
    delegationId: "dov-test-union",
    worker: "builder",
    mergedScope: mergedScopeFrom(staticDomain, override),
    staticReference: "unused-here",
  };

  // Override path write — allowed via the merged scope.
  assert.equal(underAgent("Builder", state, writeUpsertEvent(".worktrees/feat-x/app/new.tsx")), undefined);
  // Static-write-allowed path — still allowed (merged scope keeps static).
  assert.equal(underAgent("Builder", state, writeUpsertEvent("ui/NewComponent.tsx")), undefined);
  // Static-explicit-deny path — still denied even inside the grant (static
  // deny holds; override adds rows but doesn't relax existing denials).
  const denied = underAgent("Builder", state, writeUpsertEvent("src/never-writable.ts"));
  assert.ok(denied, "static upsert:false on src/ must remain denied even inside the override grant");
});

// ── Edge — static-only path is allowed inside the grant ──────────────────

test("enforceDomainForTool U3 edge (static only) — a path granted only by static is still allowed during the grant lifetime", () => {
  // The override covers a DIFFERENT path; the test path is in static
  // only. Inside the grant, `domainAllows` should evaluate against the
  // merged scope, which is static ∪ override — so the static-only path
  // passes.
  const staticDomain: DomainScope[] = [{ path: "ui/", read: true, upsert: true, delete: false }];
  const worker = runtime("Builder", { domain: staticDomain });
  const state = stateWith([worker]);

  const override: OverrideEntry[] = [{ path: ".worktrees/feat-x/app/", upsert: true, delete: false }];
  state.activeOverrides = {
    delegationId: "dov-test-static-only",
    worker: "builder",
    mergedScope: mergedScopeFrom(staticDomain, override),
    staticReference: "unused-here",
  };

  const result = underAgent("Builder", state, writeUpsertEvent("ui/static-only-edit.tsx"));
  assert.equal(result, undefined, "static-only path must remain allowed inside the grant: " + result?.reason);
});

// ── Edge (post-revoke denied) — override-only path denied after revoke ───

test("enforceDomainForTool U3 edge (post-revoke denied) — override-only path is denied once activeOverrides is cleared", () => {
  // Static config has NO write on the override path. After U2's
  // finally-block clears `state.activeOverrides` (post-revoke), the
  // read side falls through to `runtime.config.domain`, and the
  // override-only path is no longer writable. This is the post-revoke
  // denial the design promises: a worker session continuing after its
  // dispatch returns must NOT retain its write grant.
  const staticDomain: DomainScope[] = [{ path: "ui/", read: true, upsert: true, delete: false }];
  const worker = runtime("Builder", { domain: staticDomain });
  const state = stateWith([worker]);

  // Simulate post-revoke: U2's finally already ran. Field is undefined.
  state.activeOverrides = undefined;

  // The override path is NOT in static → write must be denied.
  const denied = underAgent(
    "Builder",
    state,
    writeUpsertEvent(".worktrees/feat-x/app/post-revoke.tsx"),
  );
  assert.ok(denied, "override-only path must be denied after revoke");
  assert.match(denied!.reason, /cannot modify/i, "denial message names the capability");
  // And — importantly — the static-allowed path STILL works, proving
  // the read side properly fell back to the static config when the
  // grant was cleared.
  assert.equal(underAgent("Builder", state, writeUpsertEvent("ui/post-revoke-still-ok.tsx")), undefined);
});

// ── AE6 / R7 — concurrency: two parallel reads see only their own scope ─

test("enforceDomainForTool U3 AE6/R7 — two parallel calls with different scopes each see only their own merged scope", async () => {
  // Two distinct state objects simulate two concurrent worker sessions
  // (real concurrency would race on the shared `state.activeOverrides`
  // field; threading the scope via `effectiveDomain` per call is the
  // concurrency-safe path). Each call passes its own merged scope via
  // the 4th positional parameter — the seam U3 added specifically so
  // a per-worker-session closure can bypass the shared `state` field.
  //
  // For this assertion to be meaningful, each `effectiveDomain` MUST
  // be enforced against in isolation; a bug where the function
  // ignores the parameter and reads from `state.activeOverrides` would
  // make both calls see the same (last-writer-wins) scope.
  const stateA = stateWith([runtime("Worker A", { domain: [] })]);
  const stateB = stateWith([runtime("Worker B", { domain: [] })]);

  // Distinct paths for each call — chosen so neither path is in the
  // OTHER call's scope.
  const mergedA: DomainScope[] = [{ path: ".worktrees/conflict-a/app/", read: true, upsert: true, delete: false }];
  const mergedB: DomainScope[] = [{ path: ".worktrees/conflict-b/app/", read: true, upsert: true, delete: false }];

  // Fire both reads in parallel (Node's `node:test` runs `async`
  // tests serially, but the parallel assertion here is driven by
  // `Promise.all` over two independent `enforceDomainForTool` calls,
  // each on its own state object). The isolation promise: A's call
  // never sees B's scope, and vice versa.
  const aResult = runAsAgent("Worker A", () => Promise.resolve().then(() =>
    enforceDomainForTool(stateA, writeUpsertEvent(".worktrees/conflict-a/app/file.tsx"), ctx, mergedA),
  ));
  const bResult = runAsAgent("Worker B", () => Promise.resolve().then(() =>
    enforceDomainForTool(stateB, writeUpsertEvent(".worktrees/conflict-b/app/file.tsx"), ctx, mergedB),
  ));

  const [aDecision, bDecision] = await Promise.all([aResult, bResult]);

  // Each parallel call must see ONLY its own scope. A is allowed
  // (its path is in its merged scope), but if A had inadvertently
  // observed B's empty scope it would have been denied. We can't
  // observe "denial" for A directly here because A's path IS in A's
  // scope; the inverse direction is the discriminating assertion:
  // a path that's in B's scope but NOT in A's is denied for A even
  // when both calls are issued concurrently. Run a second parallel
  // pair where each call attempts the OTHER's path.
  const crossAEvent = writeUpsertEvent(".worktrees/conflict-b/app/cross.tsx"); // B's path, A's call
  const crossBEvent = writeUpsertEvent(".worktrees/conflict-a/app/cross.tsx"); // A's path, B's call
  const aCross = runAsAgent("Worker A", () => Promise.resolve().then(() =>
    enforceDomainForTool(stateA, crossAEvent, ctx, mergedA),
  ));
  const bCross = runAsAgent("Worker B", () => Promise.resolve().then(() =>
    enforceDomainForTool(stateB, crossBEvent, ctx, mergedB),
  ));

  const [aCrossDecision, bCrossDecision, , ] = await Promise.all([aCross, bCross, aDecision, bDecision]);

  // Sanity: same-scope calls return no block.
  assert.equal(aDecision, undefined, "A's call against A's scope must be allowed");
  assert.equal(bDecision, undefined, "B's call against B's scope must be allowed");
  // Isolation: each call's cross-scope attempt is denied, proving the
  // parameter thread is honored on the read side (not silently
  // overridden by a shared state field).
  assert.ok(aCrossDecision, "A's call against B's path must be denied (concurrency isolation)");
  assert.ok(bCrossDecision, "B's call against A's path must be denied (concurrency isolation)");
});

// ── Mismatch worker — a stale or wrong-worker override is ignored ────────

test("enforceDomainForTool U3 mismatch worker — `state.activeOverrides.worker !== agentSlug(runtime.config)` falls back to static", () => {
  // `state.activeOverrides.worker` is `"coder"` while the current
  // agent is `"builder"`. The mismatch guard at the read site must
  // cause the call to fall through to the static config (R7 leak
  // prevention — a delegation's grant must NOT transfer to a sibling
  // worker). With no static grant for `.worktrees/feat-x/app/`, the
  // write must be denied.
  const worker = runtime("Builder", { domain: [{ path: "ui/", read: true, upsert: true, delete: false }] });
  const state = stateWith([worker]);

  state.activeOverrides = {
    delegationId: "dov-test-mismatch",
    worker: "coder", // intentionally wrong — the active worker is "builder"
    mergedScope: [{ path: ".worktrees/feat-x/app/", read: true, upsert: true, delete: false }],
    staticReference: "unused-here",
  };

  const denied = underAgent("Builder", state, writeUpsertEvent(".worktrees/feat-x/app/leak.tsx"));
  assert.ok(denied, "wrong-worker override must not grant; static config denies this path");
  // And `state.activeOverrides` itself is left untouched (U3 only
  // reads it; U2 owns the lifecycle).
  assert.equal(state.activeOverrides?.delegationId, "dov-test-mismatch", "read side does not mutate the field");
});

// ── AE1 — explicit effectiveDomain parameter shadows `state.activeOverrides` ─

test("enforceDomainForTool U3 effectiveDomain — explicit 4th positional shadows the state.activeOverrides read", () => {
  // The explicit parameter is the threading seam (AE6/R7). When the
  // caller passes a scope, it MUST win — even if `state.activeOverrides`
  // is set for a DIFFERENT scope. This is the contract a per-worker
  // closure relies on for true concurrency isolation.
  const worker = runtime("Builder", { domain: [{ path: "ui/", read: true, upsert: true, delete: false }] });
  const state = stateWith([worker]);

  state.activeOverrides = {
    delegationId: "dov-test-shadow",
    worker: "coder", // wrong-worker + wrong-path on the state field
    mergedScope: [{ path: "never/used/", read: true, upsert: true, delete: false }],
    staticReference: "unused-here",
  };

  // Pass the merged scope directly via the parameter — Builder must
  // be allowed to write the override path even though the state
  // field points at a wrong-worker scope that would otherwise leak
  // or be ignored.
  const explicit: DomainScope[] = [{ path: ".worktrees/feat-x/app/", read: true, upsert: true, delete: false }];
  const result = underAgent("Builder", state, writeUpsertEvent(".worktrees/feat-x/app/shadowed.tsx"), explicit);
  assert.equal(result, undefined, "explicit effectiveDomain must shadow the state.activeOverrides read: " + result?.reason);
});

// ── Backward compat — call sites that omit the new param keep working ───

test("enforceDomainForTool U3 backward compat — three-positional call with no activeOverrides reads runtime.config.domain", () => {
  // Pre-U2 behavior: `state.activeOverrides` is undefined; the
  // function should resolve to `runtime.config.domain` exactly as
  // before. This regression covers the orchestrator-side call site at
  // `src/engine/telemetry-listeners.ts:162`, which never sets the
  // field and never passes the parameter.
  const worker = runtime("Builder", { domain: [{ path: "ui/", read: true, upsert: true, delete: false }] });
  const state = stateWith([worker]);
  // intentionally no activeOverrides field
  const allowed = underAgent("Builder", state, writeUpsertEvent("ui/back-compat.tsx"));
  assert.equal(allowed, undefined, "static-only call must remain allowed: " + allowed?.reason);

  // And — symmetrically — a path outside static must still be
  // denied (the read side must not silently authorize more than
  // runtime.config.domain).
  const denied = underAgent("Builder", state, writeUpsertEvent("some/other/path.tsx"));
  assert.ok(denied, "path outside static must be denied when no override is active");
});

// ── Read-only scope via override — read succeeds, write denied ───────────

test("enforceDomainForTool U3 read-only override — read paths succeed and write paths denied when override grants read-only", () => {
  // Defensive: even when the override read-shape layer widens reads
  // (U2 always emits `read: true` rows), the deny side must hold if
  // the override entry says `upsert: false` and `delete: false`. The
  // regression ensures the read-side wiring didn't accidentally
  // promote an upsert on a read-only override.
  const staticDomain: DomainScope[] = [{ path: "ui/", read: true, upsert: true, delete: false }];
  const worker = runtime("Builder", { domain: staticDomain });
  const state = stateWith([worker]);

  const override: OverrideEntry[] = [{ path: ".worktrees/feat-x/app/", upsert: false, delete: false }];
  state.activeOverrides = {
    delegationId: "dov-test-readonly",
    worker: "builder",
    mergedScope: mergedScopeFrom(staticDomain, override),
    staticReference: "unused-here",
  };

  // Read on the override path: U2 emits `read: true`, so the merged
  // scope row allows it. The static config doesn't cover the path,
  // so a read succeeds only because the override row grants it.
  assert.equal(underAgent("Builder", state, readEvent(".worktrees/feat-x/app/index.tsx")), undefined);
  // Write: explicitly denied by the override's `upsert: false`.
  const denied = underAgent("Builder", state, writeUpsertEvent(".worktrees/feat-x/app/index.tsx"));
  assert.ok(denied, "read-only override must still deny writes: " + denied?.reason);
});
