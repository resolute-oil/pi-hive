// B-2 Telemetry Listeners extraction (Region 2).
//
// `handleAgentSettledForHiveRestore` moves out of
// `src/integration/hooks.ts` into a dedicated engine module. The original
// was a 70-line two-attempt retry + best-effort fallback policy that
// didn't fit the simple `gatedEmit` shape Region 1 consolidated. Its
// dedicated test suite (`tests/mode-switch-restore.test.ts`) covers the
// full retry policy plus the no-op and capture-and-clear invariants.
//
// The orchestration is now a 10-line retry loop around three helpers:
//
//   * `attemptRestoreWithSummary` — first attempt with the LLM's summary.
//     Throws on any failure.
//   * `attemptRestoreWithEmptySummary` — retry with an empty summary.
//     Throws on any failure.
//   * `notifyRestoreComplete` — best-effort warning emitted only when
//     both attempts fail (the "fall back to current behavior" branch).
//
// `ExtensionCommandContext.sessionManager` is typed as
// `ReadonlySessionManager` in the SDK, but the runtime instance from
// `setCommandCtx` is a writable `SessionManager` (the original code
// required the cast). The cast stays — extending the public API to
// advertise writable methods on the read-only view would be a lie.

import type { ExtensionCommandContext, SessionManager } from "@earendil-works/pi-coding-agent";
import type { HiveState } from "../core/types";
import { getCommandCtx } from "../integration/commands";

const NO_COMMAND_CTX_WARNING = "[pi-hive] agent_settled: no ExtensionCommandContext captured; hive→normal history restore skipped.";

const PRIMARY_SUCCESS_CONTENT = "Hive cycle summary complete. Your previous hive-mode work has been collapsed to the summary you provided. Continue from this state in normal mode.";
const FALLBACK_SUCCESS_CONTENT = "Hive cycle summary complete (with empty summary fallback). Continue from this state in normal mode.";
const FAILURE_MESSAGE = "Hive→normal history restore failed; continuing in normal mode without restoring prior context.";

const NAVIGATE_CANCELLED = "navigateTree cancelled";

const CUSTOM_TYPE = "pi-hive-mode-switch";

async function attemptRestoreWithSummary(
  state: HiveState,
  commandCtx: ExtensionCommandContext,
  snapshotLeafId: string,
  summary: string,
): Promise<void> {
  await commandCtx.waitForIdle();
  const sm = commandCtx.sessionManager as SessionManager;
  const nid = sm.branchWithSummary(snapshotLeafId, summary);
  sm.branch(snapshotLeafId);
  const result = await commandCtx.navigateTree(nid, { summarize: false });
  if (result.cancelled) throw new Error(NAVIGATE_CANCELLED);
  state.pi.sendMessage(
    {
      customType: CUSTOM_TYPE,
      content: PRIMARY_SUCCESS_CONTENT,
      display: false,
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}

async function attemptRestoreWithEmptySummary(
  state: HiveState,
  commandCtx: ExtensionCommandContext,
  snapshotLeafId: string,
): Promise<void> {
  await commandCtx.waitForIdle();
  const sm = commandCtx.sessionManager as SessionManager;
  const nid = sm.branchWithSummary(snapshotLeafId, "");
  sm.branch(snapshotLeafId);
  const result = await commandCtx.navigateTree(nid, { summarize: false });
  if (result.cancelled) throw new Error(NAVIGATE_CANCELLED);
  state.pi.sendMessage(
    {
      customType: CUSTOM_TYPE,
      content: FALLBACK_SUCCESS_CONTENT,
      display: false,
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}

function notifyRestoreComplete(commandCtx: ExtensionCommandContext, error: unknown): void {
  console.warn(`[pi-hive] ${FAILURE_MESSAGE}`, error);
  if (commandCtx.hasUI) commandCtx.ui.notify(FAILURE_MESSAGE, "warning");
}

// Failure policy (per design Q8): retry once with an empty summary, then
// fall back to best-effort (log + UI notify, no rethrow). The mode
// switch itself has already succeeded by the time this fires.
export async function handleAgentSettledForHiveRestore(state: HiveState): Promise<void> {
  const pending = state.pendingHiveCycleRestore;
  if (!pending) return;

  // Capture-and-clear immediately so a re-entry (next agent_settled) sees an
  // empty field and bails out — without this, a retried restore could fire
  // twice on the same cycle.
  state.pendingHiveCycleRestore = undefined;

  const commandCtx = getCommandCtx();
  if (!commandCtx) {
    console.warn(NO_COMMAND_CTX_WARNING);
    return;
  }

  const snapshotLeafId = pending.snapshotLeafId;
  const summary = pending.summary ?? "";

  try {
    await attemptRestoreWithSummary(state, commandCtx, snapshotLeafId, summary);
    return;
  } catch (_err1) {
    // First failure — fall through to retry.
  }

  try {
    await attemptRestoreWithEmptySummary(state, commandCtx, snapshotLeafId);
    return;
  } catch (err2) {
    notifyRestoreComplete(commandCtx, err2);
    // Don't rethrow — mode switch already succeeded.
  }
}
