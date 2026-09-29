/**
 * Wave 5 / F9 — Reviewer verdict persistence (extracted from dispatch.ts).
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md §3.9.
 *
 * When a reviewer agent completes a run, dispatch.ts used to inspect the
 * task + output, derive a change id / artifact / verdict, and write the
 * per-artifact automated-review record inline (with the file-mutation queue
 * around the setAgentReviewVerdict call). That block sat between the
 * `delegation_end` log line and the emit — alongside the per-run delta
 * computation — so dispatch.ts accumulated two unrelated concerns in one
 * place. The reviewer block is the only consumer of the file-mutation
 * queue in dispatch.ts, and it is self-contained: extract it to keep
 * dispatch.ts focused on orchestration. Behavior is byte-identical to the
 * pre-extraction version (same call ordering, same queueing, same record
 * path resolution).
 */

import { withFileMutationQueue, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRuntime, HiveState } from "../core/types";
import { approvalRecordPath, setAgentReviewVerdict } from "./openspec";
import { currentChangeId } from "./session";
import { inferArtifactFromReviewTask, inferChangeIdFromReviewTask, inferReviewVerdict } from "./dispatch-helpers";

export async function persistReviewerVerdict(
  ctx: ExtensionContext,
  state: HiveState,
  runtime: AgentRuntime,
  task: string,
  output: string,
  _caller: string,
): Promise<void> {
  // Persist per-artifact reviewer clearance whenever a review prompt is
  // explicit enough to identify its target. Some dashboard-triggered review
  // turns can run without plan-mode ambient state after a session restore; in
  // that case, derive the change id from the OpenSpec paths in the task so the
  // Plans UI does not reject a freshly PASSed artifact as "not ready".
  const changeId = currentChangeId() || state.activeChangeId || inferChangeIdFromReviewTask(task) || "";
  const artifact = inferArtifactFromReviewTask(task);
  const verdict = inferReviewVerdict(output);
  if (!changeId || !artifact || !verdict) return;
  const recordPath = approvalRecordPath(ctx.cwd, changeId, artifact, "automated-review");
  if (!recordPath) return;
  await withFileMutationQueue(recordPath, async () => {
    setAgentReviewVerdict(ctx.cwd, changeId, artifact, verdict, runtime.config.name);
  });
}
