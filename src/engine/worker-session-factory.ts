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
import {
  createBudgetToolCallGuard,
  installBudgetEventHooks,
} from "./budget/events";
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
  preflightPolicy: WorkerBudgetPolicy | undefined;
  runController: AbortController | undefined;
  createSession: (options: Record<string, unknown>) => Promise<{ session: unknown }>;
  /**
   * When true, the worker gets a brand-new `SessionManager` via
   * `SessionManager.create(ctx.cwd)` instead of opening the existing
   * `runtime.sessionFile`. The dispatch caller updates `runtime.sessionFile`
   * from the returned SM's `getSessionFile()` so the dashboard's "view
   * session" link stays valid. Source: tmp/2025-09-29-fresh-true-rebuild-runtime.md
   * Move 3.
   */
  fresh?: boolean;
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
  const { state, ctx, runtime, resolvedModel, thinking, allToolNames, hiveTools, skillPaths, createSession, fresh } = opts;

  // Move 3 (tmp/2025-09-29-fresh-true-rebuild-runtime.md): `fresh=true` MUST
  // produce a brand-new `SessionManager` so `getSessionStats()` covers only
  // the new run — otherwise the end-of-run overwrite restores the OLD
  // lifetime totals (the user-visible bug). `SessionManager.create(cwd)`
  // creates an empty SM in the default directory; the caller updates
  // `runtime.sessionFile` from `sessionManager.getSessionFile()` so the
  // dashboard's "view session" link stays valid across the swap.
  const sessionManager = fresh
    ? SessionManager.create(ctx.cwd)
    : SessionManager.open(runtime.sessionFile);

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
 *
 * Wave 5 / F3 — also wires the budget `beforeToolCall` guard so the four
 * blocking targets (bash / edit / write / read) hit `checkBudgetPolicy` on
 * every tool call. The SDK's `AgentSession` constructor installs its own
 * `session.agent.beforeToolCall` that routes through extension tool_call
 * handlers (drives pi-hive's domain enforcement — see `worker-extension.ts`).
 * We WRAP that handler instead of overwriting it so domain enforcement still
 * runs FIRST and can still block on policy violations; the budget guard
 * runs ONLY when the extension chain returns nothing block-worthy. Minimal
 * change: no architectural redesign of the dispatch path (the plan's
 * Wave 5 hard constraint).
 */
export async function installWorkerBudgetHooks(opts: {
  runtime: AgentRuntime;
  session: unknown;
  sessionManager: SessionManager;
  preflightPolicy: WorkerBudgetPolicy;
  runController: AbortController;
  currentDelegationDepth: () => number;
}): Promise<BudgetLedger> {
  const { runtime, session, sessionManager, preflightPolicy, runController, currentDelegationDepth } = opts;
  const workerLedger = await BudgetLedger.restore(
    sessionManager,
    agentSlug(runtime.config),
    preflightPolicy,
    runController.signal,
  );
  // `installBudgetEventHooks` returns the unsubscribe handle from
  // `session.subscribe(...)`. We intentionally do NOT capture it: the
  // dispatch lifecycle (`WorkerRunLifecycle.close()`) invokes
  // `session.dispose()` on every dispatch, and the SDK's
  // `agent-session.js#dispose` clears `_eventListeners` wholesale — so the
  // budget subscription is dropped alongside the dispatch's own
  // `handleEvent` subscription. The discarded unsubscribe is therefore safe
  // under the current lifecycle contract. If a future refactor separates
  // dispose from event teardown (e.g. session reuse across dispatches),
  // wire the unsubscribe through `lifecycle.attachSubscription` instead.
  installBudgetEventHooks(
    session as Parameters<typeof installBudgetEventHooks>[0],
    workerLedger,
    preflightPolicy,
    sessionManager,
    runController,
  );
  // F3 / T3.4 — tool_call blocking. Wire the budget guard onto the session's
  // agent.beforeToolCall. The factory's signature requires the captured
  // dispatch depth (currentDelegationDepth() + 1) — passed as a closure so
  // checkBudgetPolicy sees the correct depth for the in-flight worker
  // regardless of nesting level (G-29 / plan §2.5).
  const agent = (session as { agent?: { beforeToolCall?: ((ctx: unknown, signal?: AbortSignal) => Promise<unknown>) | undefined } } | null | undefined)?.agent;
  if (agent) {
    const previousBeforeToolCall = agent.beforeToolCall;
    const budgetGuard = createBudgetToolCallGuard(
      workerLedger,
      preflightPolicy,
      sessionManager,
      runController,
      currentDelegationDepth,
    );
    agent.beforeToolCall = async (ctx: unknown, signal?: AbortSignal) => {
      // 1. Run the SDK's chain (extension tool_call handlers — pi.on("tool_call")
      //    routes through here, e.g. enforceDomainForTool in worker-extension.ts).
      //    Domain rejection MUST take precedence over the budget gate so a worker
      //    that violates domain rules never spends a token of its budget.
      if (typeof previousBeforeToolCall === "function") {
        const extResult = await previousBeforeToolCall(ctx, signal);
        if (extResult && typeof extResult === "object" && (extResult as { block?: unknown }).block) {
          return extResult;
        }
      }
      // 2. Budget gate. The guard reads `ctx.toolCall.name` / `ctx.args`
      //    (the BeforeToolCallContext shape — see pi-agent-core types.d.ts).
      const toolCtx = ctx as { toolCall?: { name?: unknown }; args?: unknown } | undefined;
      return budgetGuard({
        toolName: toolCtx?.toolCall?.name,
        input: toolCtx?.args,
      });
    };
  }
  return workerLedger;
}
