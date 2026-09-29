/**
 * Wave 5 / F9 — Helper functions shared by dispatch.ts and reviewer-verdict.ts.
 *
 * Source of truth: docs/reviews/28-09-2026-budget-review/04-refactor-plan.md §3.9.
 *
 * `dispatch.ts` historically bundled the artifact-inference + verdict-detection
 * helpers alongside the orchestration flow. They have no dependencies on the
 * dispatch state machine and were moved here so dispatch.ts can slim down to
 * a routing layer. dispatch.ts re-exports every name below so callers that
 * `import { inferArtifactFromReviewTask } from "../engine/dispatch"` keep
 * compiling without churn.
 */

import type { AgentReviewVerdict } from "./openspec";
import { ARTIFACT_ORDER, type ArtifactId } from "../shared/openspec-artifacts";

const ARTIFACT_REVISION_MARKERS = /\b(revise|revision|fix|address|correct|update|rewrite|repair|failed review|review failed|rejected|denied|blocker|blocking)\b/i;

const ARTIFACT_TARGET_MARKERS: Record<ArtifactId, RegExp> = {
  proposal: /\bproposal(?:\.md)?\b|proposal artifact|proposal gate/i,
  design: /\bdesign(?:\.md)?\b|design artifact|design gate/i,
  specs: /\b(specs?(?:\/\*\*\/\*\.md)? artifact| specs? gate)\b|specs\/|spec\.md/i,
  tasks: /\btasks(?:\.md)?\b|tasks artifact|tasks gate/i,
};

export function isPendingArtifactRevisionTask(task: string, pending: ArtifactId): boolean {
  if (!ARTIFACT_REVISION_MARKERS.test(task)) return false;
  if (/\bauthor the next artifact\b/i.test(task)) return false;
  return ARTIFACT_TARGET_MARKERS[pending].test(task);
}

export function inferChangeIdFromReviewTask(task: string): string | null {
  const pathMatch = task.match(/openspec\/changes\/([a-z0-9]+(?:-[a-z0-9]+)*)\//i);
  if (pathMatch) return pathMatch[1];
  const quotedMatch = task.match(/OpenSpec change [`"]([a-z0-9]+(?:-[a-z0-9]+)*)[`"]|change [`"]([a-z0-9]+(?:-[a-z0-9]+)*)[`"]|change\s+([a-z0-9]+(?:-[a-z0-9]+)*)\b/i);
  return quotedMatch?.[1] || quotedMatch?.[2] || quotedMatch?.[3] || null;
}

export function inferArtifactFromReviewTask(task: string): ArtifactId | null {
  // Prefer the explicit review target. Review prompts often contain negative
  // scope clauses like "Do not consider design/specs/tasks"; a plain keyword
  // scan would otherwise tag a proposal review as tasks/specs/design.
  const explicit = task.match(/\breview\s+only\s+the\s+(proposal|design|specs?|requirements|tasks)\s+(?:artifact|gate)\b/i);
  if (explicit) {
    const target = explicit[1].toLowerCase();
    return target.startsWith("spec") || target === "requirements" ? "specs" : (target as ArtifactId);
  }

  const pathMatch = task.match(/openspec\/changes\/[^\s`'"]+\/((?:proposal|design|tasks)\.md|specs\/[^\s`'"]+|specs\/\*\*\/\*\.md)/i);
  if (pathMatch) return pathMatch[1].startsWith("specs/") ? "specs" : (pathMatch[1].replace(/\.md$/i, "") as ArtifactId);

  const positiveText = task
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((sentence) => !/\bdo not\b|\bdon't\b|\bno\s+(?:design|specs|tasks|proposal)\b/i.test(sentence))
    .join("\n");
  let best: { id: ArtifactId; index: number } | null = null;
  for (const id of ARTIFACT_ORDER) {
    const match = positiveText.match(ARTIFACT_TARGET_MARKERS[id]);
    if (match?.index != null && (!best || match.index < best.index)) best = { id, index: match.index };
  }
  return best?.id ?? null;
}

export function inferReviewVerdict(output: string): Exclude<AgentReviewVerdict, null> | null {
  const text = output.trim();
  const match = text.match(/^\s*(?:#{1,6}\s*)?(?:verdict\s*[:—-]\s*)?(PASS|GREEN|YELLOW|FAIL|RED)\b/i);
  const verdict = match?.[1]?.toLowerCase();
  if (verdict === "pass" || verdict === "green") return "green";
  if (verdict === "yellow") return "yellow";
  if (verdict === "fail" || verdict === "red") return "red";
  return null;
}
