// ── Model resolution helpers ────────────────────────────────────────────────
//
// Tiny `modelRegistry` helpers shared between `engine/dispatch.ts` (resolves
// the agent's requested `provider/id` string for the worker's AgentSession)
// and `engine/distiller.ts` (does the same for the distiller's constrained
// run). Pulled out so the distiller extraction doesn't drag an inline
// helper back into dispatch via a back-reference.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// Structural type mirroring the SDK's `Model<TApi>` shape we care about —
// the registry hands back an opaque object whose `.provider` / `.id` keys
// we read for telemetry. We don't need the full Model interface here, and
// the SDK doesn't re-export Model<TApi> from its main barrel so we'd
// otherwise leave `any` in its place.
export interface ResolvedModel {
  provider: string;
  id: string;
  [key: string]: unknown;
}

export function resolveModel(ctx: ExtensionContext, modelString: string): ResolvedModel | undefined {
  const [provider, ...idParts] = modelString.split("/");
  const found = (ctx as { modelRegistry?: { find: (provider: string, id: string) => ResolvedModel | undefined } }).modelRegistry?.find(provider, idParts.join("/"));
  return found;
}

export function modelKey(model: ResolvedModel | undefined, fallback: string): string {
  if (model?.provider && model?.id) return `${model.provider}/${model.id}`;
  return fallback;
}
