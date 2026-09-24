// ── Model resolution helpers ────────────────────────────────────────────────
//
// Tiny `modelRegistry` helpers shared between `engine/dispatch.ts` (resolves
// the agent's requested `provider/id` string for the worker's AgentSession)
// and `engine/distiller.ts` (does the same for the distiller's constrained
// run). Pulled out so the distiller extraction doesn't drag an inline
// helper back into dispatch via a back-reference.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function resolveModel(ctx: ExtensionContext, modelString: string): any {
  const [provider, ...idParts] = modelString.split("/");
  return (ctx as any).modelRegistry?.find(provider, idParts.join("/"));
}

export function modelKey(model: any, fallback: string): string {
  if (model?.provider && model?.id) return `${model.provider}/${model.id}`;
  return fallback;
}
