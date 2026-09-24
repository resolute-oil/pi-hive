// ── Mental-model distiller ────────────────────────────────────────────────
// After a worker finishes, a separate constrained `pi` run reads a SNAPSHOT of
// the just-completed conversation plus the agent's current mental model, then
// returns a consolidated rewrite of that file. This replaces inline self-update
// tools: the worker focuses on the task; memory is curated out-of-band, can
// consolidate (not just append), and never pollutes the worker's context.
//
// Extracted from `engine/dispatch.ts` so the dispatch function stops being
// the single owner of both worker orchestration AND post-run distillation.
// The three exports here (runDistillerProcess, distillMentalModel,
// scheduleMentalModelDistillation) are the public surface used by
// `agents/tools.ts` and `engine/session.ts`.

import { type ExtensionContext, createAgentSession, SessionManager, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { copyFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeMentalModelSpine } from "../core/mental-model";
import type { AgentRuntime, HiveState } from "../core/types";
import { ensureDir, readJsonlPage, safeRead, slug, tailLines, textFromMessage, truncateMiddle } from "../core/utils";
import { logRecord } from "./state";
import { resolveConfiguredPath } from "../core/safe-path";
import { agentMentalModelTarget, buildDistillerPrompt, extractTagged } from "./prompts";
import { emitHiveEvent } from "./observability";
import { effectiveWorkerGovernance } from "./governance";
import { resolveModel } from "./model-resolution";

export async function runDistillerProcess(state: HiveState, ctx: ExtensionContext, prompt: string, model: string): Promise<string> {
  const resolvedModel = resolveModel(ctx, model);
  if (!resolvedModel) return "";

  // In-process now: no separate session to inherit. The distiller's transcript
  // is a scratch prompt/response pair, not durably meaningful on its own, so it
  // never needs a session file — SessionManager.inMemory() is correct here.
  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    model: resolvedModel,
    modelRegistry: (ctx as any).modelRegistry,
    thinkingLevel: "off",
    tools: [],
    noTools: "all",
    sessionManager: SessionManager.inMemory(ctx.cwd),
  });

  const chunks: string[] = [];
  let streamedSnapshot = "";
  (state.backgroundDistillerSessions ||= new Set()).add(session);
  session.subscribe((event: any) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      const delta = event.assistantMessageEvent;
      const deltaText = typeof delta.delta === "string" ? delta.delta : "";
      if (deltaText) chunks.push(deltaText);
      const snapshot = textFromMessage(event.message) || (typeof delta.text === "string" ? delta.text : "");
      if (snapshot) streamedSnapshot = snapshot;
    } else if (event.type === "agent_end") {
      const last = [...(event.messages || [])].reverse().find((m: any) => m.role === "assistant");
      if (last && !chunks.length && !streamedSnapshot) chunks.push(textFromMessage(last));
    }
  });

  try {
    await session.prompt(prompt);
  } catch {
    return "";
  } finally {
    state.backgroundDistillerSessions?.delete(session);
    session.dispose();
  }
  return chunks.join("").trim() || streamedSnapshot.trim();
}

export async function distillMentalModel(state: HiveState, ctx: ExtensionContext, runtime: AgentRuntime): Promise<void> {
  if (!state.config || !state.session || !state.config.settings.distiller.enabled) return;
  const target = agentMentalModelTarget(runtime);
  if (!target) return;

  // Config validation already requires an explicit opt-in for targets outside
  // the project. Re-apply that rule at the write site before queueing mutation.
  const safeTarget = resolveConfiguredPath(ctx.cwd, target.path, target.allowOutsideProject === true, { allowMissing: true });
  if (!safeTarget) return;
  const targetPath = safeTarget.canonicalPath;

  // Snapshot the just-finished conversation, distill from the copy, then delete
  // it — so a re-delegation of the same agent can reuse its live session freely.
  const snapshotDir = join(state.session.sessionDir, "distill");
  ensureDir(snapshotDir);
  const snapshotPath = join(snapshotDir, `${slug(runtime.config.name)}-${runtime.runCount}.jsonl`);
  let conversation = "";
  try {
    if (existsSync(runtime.sessionFile)) {
      copyFileSync(runtime.sessionFile, snapshotPath);
      const tail = readJsonlPage(snapshotPath, { before: Number.MAX_SAFE_INTEGER, maxBytes: 1024 * 1024 });
      conversation = tailLines(tail.text, state.config.settings.distiller.conversationLines);
    }
  } catch { /* no session yet */ }
  if (!conversation) { try { rmSync(snapshotPath, { force: true }); } catch { /* noop */ } return; }

  let changed = false;
  let errorMessage: string | undefined;
  emitHiveEvent(state, "distill_start", { agent: runtime.config.name, target: target.path, model: state.config.settings.distiller.model, distillerRunCount: runtime.distillerRunCount || 0 }, "Distiller");
  try {
    const currentModel = safeRead(targetPath);
    const today = new Date().toISOString().slice(0, 10);
    const prompt = buildDistillerPrompt(runtime.config.name, currentModel, conversation, today);
    const output = await runDistillerProcess(state, ctx, prompt, state.config.settings.distiller.model);
    const extracted = extractTagged(output, "mental_model");
    // Mechanical safety net: guarantee the hard spine (owner/updated/spine keys)
    // even if the distiller's output drifts. The soft body is left byte-exact.
    const distilled = extracted ? normalizeMentalModelSpine(extracted, runtime.config.name).trim() : null;
    if (distilled && distilled !== currentModel.trim() && !state.shuttingDown) {
      await withFileMutationQueue(targetPath, async () => {
        // Re-read inside the queued mutation window. If another tool updated the
        // model while distillation was running, do not overwrite fresher state
        // with a result derived from the old snapshot.
        const latestModel = safeRead(targetPath);
        if (state.shuttingDown || latestModel.trim() !== currentModel.trim()) return;
        writeFileSync(targetPath, `${distilled}\n`);
        changed = true;
      });
      if (changed) {
        logRecord(state, { from: "Distiller", to: runtime.config.name, type: "mental_model_distilled", message: `Updated ${target.path}`, path: target.path });
      }
    }
  } catch (error: any) {
    errorMessage = truncateMiddle(error?.message || String(error), 500);
  } finally {
    emitHiveEvent(state, "distill_end", { agent: runtime.config.name, target: target.path, changed, errorMessage }, "Distiller");
    try { rmSync(snapshotPath, { force: true }); } catch { /* noop */ }
  }
}

export function scheduleMentalModelDistillation(
  state: HiveState,
  ctx: ExtensionContext,
  runtime: AgentRuntime,
  runDistiller: typeof distillMentalModel = distillMentalModel,
): Promise<void> {
  const target = agentMentalModelTarget(runtime);
  if (!target || state.shuttingDown) return Promise.resolve();
  const governance = effectiveWorkerGovernance(state, runtime);
  if (governance.distillerRuns !== undefined && (runtime.distillerRunCount || 0) >= governance.distillerRuns) {
    emitHiveEvent(state, "budget_exhausted", { agent: runtime.config.name, scope: "worker", resource: "distillerRuns", remaining: 0, limit: governance.distillerRuns }, "Distiller");
    return Promise.resolve();
  }
  const runCount = runtime.runCount;
  const queues = state.distillQueues ||= new Map<string, Promise<void>>();
  const background = state.backgroundTasks ||= new Set<Promise<void>>();
  const previous = queues.get(target.path) || Promise.resolve();
  const task = previous.catch((): void => undefined).then(async () => {
    // A newer run for the same runtime supersedes this queued snapshot. Skipping
    // it prevents an old conversation from overwriting a newer mental model.
    if (state.shuttingDown || runtime.runCount !== runCount) return;
    // Reserve at launch time so queued distillers cannot all pass the same cap.
    if (governance.distillerRuns !== undefined && (runtime.distillerRunCount || 0) >= governance.distillerRuns) return;
    runtime.distillerRunCount = (runtime.distillerRunCount || 0) + 1;
    await runDistiller(state, ctx, runtime);
  }).catch((): void => undefined);
  queues.set(target.path, task);
  background.add(task);
  void task.finally(() => {
    background.delete(task);
    if (queues.get(target.path) === task) queues.delete(target.path);
  });
  return task;
}
