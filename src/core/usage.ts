import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function usageNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// Pick the first finite number among several candidate values.
function firstNumber(...candidates: unknown[]): number {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  return 0;
}

// Normalized usage totals. `cost` is SDK-priced (pi-ai computes it); pi-hive
// keeps no pricing table of its own.
export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number;
}

// Normalize a pi-ai `Usage` object into typed totals. Every worker session is
// created via pi's own createAgentSession and always yields the canonical shape
// (input/output/cacheRead/cacheWrite/reasoning + cost.total). One legacy
// fallback (`input_tokens`/`output_tokens`) is kept for pre-canonical logs read
// back during replay.
export function extractUsage(usage: unknown): UsageTotals {
  if (!usage || typeof usage !== "object") {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
  }
  // Narrow `usage` to a record so `firstNumber`'s unknown[] call sites can
  // pass indexed properties; the runtime guard above already established
  // `usage` is non-null and `typeof === "object"`.
  const u = usage as Record<string, unknown>;
  const costRaw = u.cost;
  const costTotal = costRaw && typeof costRaw === "object" ? (costRaw as Record<string, unknown>).total : undefined;
  const costIsNumber = typeof costRaw === "number" ? costRaw : undefined;
  return {
    input: firstNumber(u.input, u.input_tokens),
    output: firstNumber(u.output, u.output_tokens),
    cacheRead: firstNumber(u.cacheRead),
    cacheWrite: firstNumber(u.cacheWrite, u.cacheWrite1h),
    reasoning: firstNumber(u.reasoning),
    cost: firstNumber(costTotal, costIsNumber),
  };
}

export function modelFrom(ctx: ExtensionContext, requested?: string): string {
  if (requested && requested !== "inherit") return requested;
  // `ExtensionContext.model` is typed `Model<any> | undefined`, but the
  // `Model<any>` generic from pi-ai leaves `.provider`/`.id` not directly
  // available through TS narrowing. Use a structural cast that names exactly
  // the two fields this resolver reads — same narrowing pattern as
  // `telemetry-listeners.ts:138` for the model_select handler.
  const model = (ctx as ExtensionContext & { model?: { provider?: string; id?: string } }).model;
  if (model?.provider && model?.id) return `${model.provider}/${model.id}`;
  throw new Error("Cannot resolve model: agent requested 'inherit' but no session model is available. Set an explicit 'provider/id' model in the agent's frontmatter.");
}
