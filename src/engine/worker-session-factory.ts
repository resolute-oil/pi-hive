/**
 * Wave 5 / F3 — F3 budget tool_call guard wiring (extracted from dispatch.ts).
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md §3.3.
 *
 * The F2 spine (`createBudgetAwareSession` in `src/engine/budget/worker-tools.ts`)
 * installs the budget event hooks (`message_end` / `compaction_end` /
 * `agent_settled` → ledger write). This module owns the companion F3 wiring:
 * the `createBudgetToolCallGuard` that blocks the four mutating tools
 * (`bash` / `edit` / `write` / `read`) at `session.agent.beforeToolCall`
 * when the worker is exhausted.
 *
 * The guard WRAPS (does not replace) the SDK's existing `beforeToolCall`
 * chain so pi-hive's domain enforcement (`pi.on("tool_call", ...)`) still
 * runs FIRST and can still block on policy violations. The budget gate
 * fires only when the extension chain returns nothing block-worthy.
 */

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { BudgetLedger } from "./budget/ledger";
import { createBudgetToolCallGuard } from "./budget/events";
import type { WorkerBudgetPolicy } from "./budget/types";

/**
 * F3 / T3.4 — tool_call blocking. Wire the budget guard onto the session's
 * `agent.beforeToolCall`. The factory's signature requires the captured
 * dispatch depth (`currentDelegationDepth()` + 1) — passed as a closure so
 * `checkBudgetPolicy` sees the correct depth for the in-flight worker
 * regardless of nesting level (G-29 / plan §2.5).
 *
 * Pre-requisite: the caller has already installed the budget event hooks
 * (via `createBudgetAwareSession`). This function only wires the
 * `beforeToolCall` wrapper.
 */
export async function installWorkerBudgetHooks(opts: {
  session: unknown;
  sessionManager: SessionManager;
  preflightPolicy: WorkerBudgetPolicy;
  /** Pre-restored BudgetLedger (created by createBudgetAwareSession). */
  ledger: BudgetLedger;
  runController: AbortController;
  currentDelegationDepth: () => number;
}): Promise<BudgetLedger> {
  const { session, sessionManager, preflightPolicy, ledger: workerLedger, runController, currentDelegationDepth } = opts;
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
