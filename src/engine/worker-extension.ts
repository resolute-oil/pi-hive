import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AfterProviderResponseEvent } from "@earendil-works/pi-coding-agent";
import type { HiveState } from "../core/types";
import { enforceDomainForTool } from "./domain";
import { emitHiveEvent } from "./observability";
import { buildProviderResponsePayload } from "./telemetry-payloads";
import { buildBudgetToolCallHandler } from "./budget/events";

export function normalizeWorkerSkillPaths(skillPaths: unknown[] = []): string[] {
  return skillPaths.map((entry, index) => {
    if (typeof entry === "string" && entry.trim()) return entry;
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const path = (entry as any).path;
      if (typeof path === "string" && path.trim()) return path;
      // Defensive compatibility for accidentally double-wrapped refs such as
      // { path: { path: "..." } }. Passing the raw object through to Pi's
      // ResourceLoader causes Node's opaque `paths[1] must be string` error
      // during delegation setup, before the worker can start.
      if (path && typeof path === "object" && typeof path.path === "string" && path.path.trim()) return path.path;
    }
    throw new TypeError(`workerResourceLoader skillPaths[${index}] must be a string or {path:string}`);
  });
}

// Worker AgentSessions are created with customTools, which bypass the
// extension/hook system entirely (ToolDefinition has no interception point).
// Domain enforcement only runs through pi.on("tool_call", ...), so each worker
// needs this one hook re-attached via its own resourceLoader — otherwise a
// worker's read/write/edit/bash calls would silently skip domain scoping.
// DefaultResourceLoader resolves cwd/agentDir eagerly in its constructor, so
// both must be passed even though this loader registers no other resources.
//
// Item 13: the extension seam is also the ONLY place worker-side ExtensionAPI
// events (pi.on) are reachable — dispatch.ts's session.subscribe() sees only
// AgentSessionEvents, so provider back-pressure (after_provider_response) never
// surfaces for workers otherwise. Wire it here so a worker stalled on a 429/529
// has the same visible cause the orchestrator does. callerName tags the events
// with the worker's own identity.
export function workerResourceLoader(state: HiveState, cwd: string, callerName: string, skillPaths: unknown[] = []): DefaultResourceLoader {
  const normalizedSkillPaths = normalizeWorkerSkillPaths(skillPaths);
  return new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    // Keep default/package skill discovery disabled for workers. Explicit
    // per-agent skills still load through additionalSkillPaths even when
    // noSkills=true; letting DefaultResourceLoader merge globally enabled skills
    // can reintroduce object-shaped package path entries and fail delegation
    // setup with Node's opaque `paths[1] must be string` error.
    noExtensions: true,
    noSkills: true,
    additionalSkillPaths: normalizedSkillPaths,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      (pi: any) => {
        // T3.4 (G-01) — wire the budget tool_call blocker per worker. The
        // handler looks up its budget context by `callerName` from the
        // module-level map populated by `installBudgetEventHooks`. Returns
        // `{ block: true, reason, terminate: false }` for `bash` / `edit` /
        // `write` / `read` when workerTokensRemaining ≤ 0 or
        // workerCostUsdRemaining ≤ 0; otherwise returns undefined and the
        // tool runs. Registered BEFORE domain enforcement so a budget
        // block fires first; if both gates could block, budget is cheaper
        // to evaluate (a Map lookup + arithmetic) and surfaces the
        // authoritative cap-driven reason. The Pi runner composes handlers
        // in registration order (per extension-patterns-reference.md §5);
        // the first `{ block: true }` short-circuits the chain.
        pi.on("tool_call", buildBudgetToolCallHandler(callerName));
        pi.on("tool_call", async (event: any, ctx: any) => enforceDomainForTool(state, event, ctx));
        // Only non-2xx responses (429/529 rate-limit/overload), mirroring the
        // orchestrator handler — successes would flood one row per call.
        pi.on("after_provider_response", async (event: AfterProviderResponseEvent) => {
          const status = Number(event?.status);
          if (!Number.isFinite(status) || (status >= 200 && status < 300)) return;
          emitHiveEvent(state, "provider_response", {
            agent: callerName,
            ...buildProviderResponsePayload(event),
          }, callerName);
        });
      },
    ],
  });
}
