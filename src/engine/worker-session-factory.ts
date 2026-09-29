/**
 * Wave 5 / F9 — Worker session creation (extracted from dispatch.ts).
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md §3.9.
 *
 * dispatch.ts used to own three coupled concerns in one block:
 *
 *   1. Open the SessionManager for the worker's transcript file.
 *   2. Reload the worker's resource loader (the SDK skips reload when
 *      a caller-supplied loader is passed in, which would silently
 *      bypass domain enforcement via the `tool_call` hook).
 *   3. Call `createAgentSession(...)` with the resolved model, tools,
 *      custom tools, and the reloaded loader.
 *   4. Restore the BudgetLedger against the worker's sessionManager.
 *   5. Install the mid-run budget event hooks so `message_end` /
 *      `compaction_end` / `agent_settled` update the ledger and the
 *      warning + exhaustion thresholds fire from `checkBudgetPolicy()`.
 *
 * These five steps were always called as a unit between the model
 * resolution and the `session.subscribe(...)` install. Extracting them
 * keeps dispatch.ts focused on orchestration; the budget hook install
 * stays co-located with session creation because it depends on the
 * session and sessionManager created in the same step.
 *
 * Behavior is byte-identical to the pre-extraction inline version: same
 * arguments, same call order, same abort-controller wiring.
 */

import { SessionManager, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentRuntime, HiveState } from "../core/types";
import { agentSlug } from "../core/utils";
import { workerResourceLoader } from "./worker-extension";
import { BudgetLedger } from "./budget/ledger";
import { installBudgetEventHooks } from "./budget/events";
import type { WorkerBudgetPolicy } from "./budget/types";

export interface CreateWorkerSessionOptions {
  state: HiveState;
  ctx: ExtensionContext;
  runtime: AgentRuntime;
  resolvedModel: unknown;
  thinking: string | undefined;
  allToolNames: string[];
  hiveTools: ToolDefinition[];
  skillPaths: string[];
  preflightPolicy: WorkerBudgetPolicy;
  runController: AbortController;
  createSession: (options: Record<string, unknown>) => Promise<{ session: unknown }>;
}

export interface CreateWorkerSessionResult {
  session: unknown;
  sessionManager: SessionManager;
}

/**
 * Open the `SessionManager` and call `createAgentSession(...)` with the
 * worker-specific arguments (resolved model, scoped tools, customTools,
 * resource loader). The returned `session` is unattached — the caller is
 * expected to thread it through `WorkerRunLifecycle.attachSession(...)`
 * BEFORE the budget-event-hook install, so a throw from
 * `installBudgetEventHooks` (which subscribes to the session internally)
 * still leaves the lifecycle in a state where `close(failed=true)` can
 * abort the partially-created session.
 */
export async function createWorkerSession(opts: CreateWorkerSessionOptions): Promise<CreateWorkerSessionResult> {
  const { state, ctx, runtime, resolvedModel, thinking, allToolNames, hiveTools, skillPaths, createSession } = opts;

  const sessionManager = SessionManager.open(runtime.sessionFile);

  // createAgentSession only calls reload() when it creates its own resource
  // loader (sdk.js). When a loader is supplied by the caller, the SDK skips
  // reload, leaving extensionsResult empty (constructor default). Without
  // reload the extensionFactories never run, runner.hasHandlers("tool_call")
  // is false, beforeToolCall short-circuits, and domain enforcement is silently
  // bypassed for every worker tool call. Call reload() here so the factory
  // registers the tool_call handler before the session starts.
  const workerLoader = workerResourceLoader(state, ctx.cwd, runtime.config.name, skillPaths);
  await workerLoader.reload();

  const created = await createSession({
    cwd: ctx.cwd,
    model: resolvedModel,
    modelRegistry: (ctx as any).modelRegistry,
    thinkingLevel: thinking as any,
    tools: allToolNames,
    customTools: hiveTools,
    sessionManager,
    resourceLoader: workerLoader,
  });

  return { session: created.session, sessionManager };
}

/**
 * Install the mid-run budget event hooks. The ledger is restored against the
 * WORKER's `sessionManager` (writes go there, not the read-only
 * `ctx.sessionManager`). The controller is wired to `runController` so an
 * F3 exhaustion signal aborts the session. Separated from `createWorkerSession`
 * so the dispatch caller can attach the session to the lifecycle BEFORE this
 * install — a throw from the install (e.g. `session.subscribe(...)` failing)
 * still leaves the lifecycle in a state where `close(failed=true)` aborts
 * the partially-created session.
 */
export async function installWorkerBudgetHooks(opts: {
  runtime: AgentRuntime;
  session: unknown;
  sessionManager: SessionManager;
  preflightPolicy: WorkerBudgetPolicy;
  runController: AbortController;
}): Promise<void> {
  const { runtime, session, sessionManager, preflightPolicy, runController } = opts;
  const workerLedger = await BudgetLedger.restore(
    sessionManager,
    agentSlug(runtime.config),
    preflightPolicy,
    runController.signal,
  );
  installBudgetEventHooks(
    session as Parameters<typeof installBudgetEventHooks>[0],
    workerLedger,
    preflightPolicy,
    sessionManager,
    runController,
  );
}
