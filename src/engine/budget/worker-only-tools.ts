// Wave 3.5 wiring (Gap 1, Gap 2): production-side registration of the four
// worker-only tools that the Wave 3 brief required but never wired into the
// dispatcher's customTools list:
//
//   summarize_progress       \u2014 per-worker progress notes (built by
//                              buildSummarizeProgressTool).
//   request_compaction       \u2014 cooperative (agent-callable) compaction.
//   request_end_session      \u2014 cooperative (agent-callable) end-of-session.
//   request_snapshot         \u2014 cooperative (agent-callable) branch summary.
//
// Why these are deferred-binding wrappers, not the factories themselves:
// the four underlying factories each close over state that is only
// available AFTER `delegateAgent` returns `kind: "ready"`:
//   - summarize_progress        needs the worker's restored BudgetLedger.
//   - request_* (3 cooperative)  need the AgentSession, WorkerBudgetPolicy,
//                               and BudgetLedger.
//
// But the SDK's session.customTools list is fixed at session-creation
// time, so we can't build the real factories yet \u2014 we have to register
// wrappers that close over a mutable binding object and read from it at
// execute time. The wrapper's `populateBindings(...)` is called by
// `dispatchAgent` immediately after `delegateAgent` returns successfully.
//
// Region-marker constraint (Wave 3.5 hard gate): the cooperative factories
// themselves live in region 3D of `worker-tools.ts`, whose marker text
// must stay byte-identical. That means we CANNOT move the factory bodies
// here; we re-import them. The factories keep their
// `cooperativeToolRegistry.add(name)` side effect \u2014 Set.add of an
// existing member is a no-op, so calling them at execute time (after
// registration) doesn't change the registry's end state.
//
// Surface:
//   - `buildWorkerOnlyTools(state, agentName)` returns
//     { tools: ToolDefinition[], bindings: WorkerOnlyBindings }.
//   - `populateWorkerOnlyBindings(bindings, session, ledger, policy)`
//     fills the bindings object \u2014 call this AFTER delegateAgent returns
//     `kind: "ready"`. Subsequent tool calls from the worker read the
//     populated bindings.
//
// The four ToolDefinitions are registered as part of `customTools` in
// `dispatchAgent`, and their names are unioned into the `tools` array
// (the SDK drops a customTool whose name is missing from `tools`).

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { HiveState, WorkerBudgetPolicy } from "../../core/types";
import type { BudgetLedger } from "./ledger";
import { buildSummarizeProgressTool } from "../../agents/tools/summarize-progress";
import {
  buildRequestCompactionTool,
  buildRequestEndSessionTool,
  buildRequestSnapshotTool,
} from "./worker-tools";

/** Mutable container the worker-only tool wrappers read from at execute time. */
export interface WorkerOnlyBindings {
  session?: AgentSession;
  ledger?: BudgetLedger;
  policy?: WorkerBudgetPolicy;
}

/** Populate the bindings after `delegateAgent` returns `kind: "ready"`. */
export function populateWorkerOnlyBindings(
  bindings: WorkerOnlyBindings,
  session: AgentSession,
  ledger: BudgetLedger,
  policy: WorkerBudgetPolicy,
): void {
  bindings.session = session;
  bindings.ledger = ledger;
  bindings.policy = policy;
}

/** Build the four worker-only ToolDefinitions with deferred bindings. */
export function buildWorkerOnlyTools(state: HiveState, agentName: string): {
  tools: ToolDefinition[];
  bindings: WorkerOnlyBindings;
} {
  const bindings: WorkerOnlyBindings = {};

  const notReadyResponse = (toolName: string) => ({
    content: [{ type: "text" as const, text: `${toolName}: worker session not initialized yet` }],
    details: { ok: false, reason: "session_not_ready" },
    isError: true,
  });

  const summarizeProgressTool: ToolDefinition = {
    name: "summarize_progress",
    label: "Summarize Progress",
    description:
      "Record wrap-up notes for your worker session. Notes are capped at progressSummaryTokenLimit tokens (default 2000). This is a per-worker tool \u2014 the orchestrator's tool set does not include it because each worker has its own restored BudgetLedger.",
    parameters: {
      type: "object",
      properties: {
        notes: { type: "string", description: "Wrap-up notes for operator interventions." },
        compact: { type: "boolean", description: "When true and the worker's budget strategy is 'compact', inject the notes into LLM context via appendCustomMessageEntry." },
      },
      required: ["notes"],
    },
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      if (!bindings.ledger) return notReadyResponse("summarize_progress");
      const built = buildSummarizeProgressTool(state, agentName, bindings.ledger);
      // The factory returns a ToolDefinition whose execute() captures
      // `callerName` and `ledger` from closure, so this deferred
      // wrapper just delegates to the factory output's execute().
      // The factory's execute() has the same (toolCallId, params,
      // signal, ...) shape; we cast through `unknown` to bridge the
      // ToolDefinition's loose `object` params detail to our `unknown`
      // params (the factory itself was typed loosely when Wave 1
      // defined it \u2014 see summarize-progress.ts:168-177).
      const factoryExecute = (built as unknown as {
        execute: (id: string, p: unknown, s: AbortSignal | undefined) => Promise<{ content: { type: "text"; text: string }[]; details: unknown; isError?: boolean }>;
      }).execute;
      return factoryExecute(_toolCallId, params, signal);
    },
  };

  const buildCooperativeTool = (
    name: "request_compaction" | "request_end_session" | "request_snapshot",
    description: string,
    parameters: ToolDefinition["parameters"],
    invoke: (
      fn: ReturnType<typeof buildRequestCompactionTool | typeof buildRequestEndSessionTool | typeof buildRequestSnapshotTool>,
      params: unknown,
      signal: AbortSignal | undefined,
    ) => Promise<{ ledgerSnapshot: unknown }>,
  ): ToolDefinition => {
    return {
      name,
      label: name,
      description,
      parameters,
      async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
        if (!bindings.session || !bindings.policy || !bindings.ledger) {
          return notReadyResponse(name);
        }
        const opts = {
          session: bindings.session,
          policy: bindings.policy,
          ledger: bindings.ledger,
        };
        const fn = (
          name === "request_compaction" ? buildRequestCompactionTool(opts) :
          name === "request_end_session" ? buildRequestEndSessionTool(opts) :
          buildRequestSnapshotTool(opts)
        ) as ReturnType<typeof buildRequestCompactionTool | typeof buildRequestEndSessionTool | typeof buildRequestSnapshotTool>;
        // The cooperative factory returns `{ ledgerSnapshot }` (NOT the
        // SDK's AgentToolResult shape), so wrap the result so it
        // surfaces to the model as a normal tool result with the
        // ledger entry echoed in `details`.
        const result = await invoke(fn, params, signal);
        const okText = `${name}: cooperative call recorded (${name === "request_compaction" ? "cooperative-compact" : name === "request_end_session" ? "cooperative-end" : "cooperative-snapshot"}).`;
        return {
          content: [{ type: "text" as const, text: okText }],
          details: { ok: true, name, ledgerSnapshot: result.ledgerSnapshot },
        };
      },
    };
  };

  const cooperativeTools: ToolDefinition[] = [
    buildCooperativeTool(
      "request_compaction",
      "Cooperatively request compaction of your worker session. Honors policy.strategies.summary.maxTokens. Writes a 'cooperative-compact' ledger snapshot.",
      {
        type: "object",
        properties: {
          customInstructions: { type: "string", description: "Optional instructions forwarded to session.compact()." },
        },
      },
      async (fn, _params, signal) => {
        const p = (_params ?? {}) as { customInstructions?: string };
        return (fn as ReturnType<typeof buildRequestCompactionTool>)(p.customInstructions, signal);
      },
    ),
    buildCooperativeTool(
      "request_end_session",
      "Cooperatively request end of your worker session. Calls session.abort() and writes a 'cooperative-end' ledger snapshot.",
      {
        type: "object",
        properties: {
          reason: { type: "string", description: "Why the worker is requesting end." },
        },
        required: ["reason"],
      },
      async (fn, params, signal) => {
        const p = (params ?? {}) as { reason?: string };
        return (fn as ReturnType<typeof buildRequestEndSessionTool>)(String(p.reason ?? ""), signal ?? new AbortController().signal);
      },
    ),
    buildCooperativeTool(
      "request_snapshot",
      "Cooperatively request a snapshot of your worker session. Calls session.sessionManager.branchWithSummary() and writes a 'cooperative-snapshot' ledger snapshot.",
      {
        type: "object",
        properties: {
          label: { type: "string", description: "Snapshot label." },
        },
        required: ["label"],
      },
      async (fn, params, signal) => {
        const p = (params ?? {}) as { label?: string };
        return (fn as ReturnType<typeof buildRequestSnapshotTool>)(String(p.label ?? ""), signal ?? new AbortController().signal);
      },
    ),
  ];

  return {
    tools: [summarizeProgressTool, ...cooperativeTools],
    bindings,
  };
}
