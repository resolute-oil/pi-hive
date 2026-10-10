// Region 3 partial convergence — shared payload builders for telemetry
// events emitted from BOTH the orchestrator-side `pi.on(...)` handlers
// and the worker-side `pi.on(...)` handlers (`worker-extension.ts`).
//
// Before this extraction, adding a `provider_response` or
// `session_info_changed` field required editing two inline builder
// expressions — a real drift risk given the wire shapes are
// intentionally identical across the orchestrator and the worker. Both
// builders are pure: they take the SDK event (or a structurally
// compatible variant — the `AgentSessionEvent` discriminated union's
// `session_info_changed` member has the same `{ name }` shape as the
// ExtensionAPI `SessionInfoChangedEvent`) and return the canonical
// payload. The `agent`/`actor` discriminator is filled in by the call
// site because it differs by emitter.
//
// Scope is narrow on purpose: the orchestrator's `gatedEmit` factory
// stays in `telemetry-listeners.ts` (orchestrator-only mode gate), and
// the worker's `DispatchStreamState` lifecycle stays in
// `dispatch-subscribe.ts`. Those are intentionally different shapes —
// see `tmp/b2-region3-plan.md` for the rationale.

import type { AfterProviderResponseEvent, SessionInfoChangedEvent } from "@earendil-works/pi-coding-agent";
import { truncateMiddle } from "../core/format";

/**
 * Build the `provider_response` telemetry payload.
 *
 * Both the orchestrator (`telemetry-listeners.ts`) and the worker
 * (`worker-extension.ts`) emit this shape after a non-2xx response. The
 * 2xx filter and (orchestrator-only) mode gate stay at the call sites;
 * this builder only owns the shared status / retry / rate-limit shape.
 */
export function buildProviderResponsePayload(event: AfterProviderResponseEvent): {
  status: number;
  retryAfter: string | undefined;
  rateLimitRemaining: string | undefined;
} {
  const headers = event?.headers || {};
  const pick = (k: string) => headers[k] ?? headers[k.toLowerCase()];
  return {
    status: Number(event?.status),
    retryAfter: pick("retry-after"),
    rateLimitRemaining: pick("anthropic-ratelimit-requests-remaining") ?? pick("x-ratelimit-remaining"),
  };
}

/**
 * Build the `session_info_changed` telemetry payload.
 *
 * Both the orchestrator (`pi.on("session_info_changed", ...)`) and the
 * worker (`session.subscribe((event) => switch(event.type) ===
 * "session_info_changed")`) emit this shape. The 200-char truncation
 * preserves the historical bound used at both sites.
 */
export function buildSessionInfoChangedPayload(event: SessionInfoChangedEvent): {
  name: string | undefined;
} {
  return { name: event.name ? truncateMiddle(String(event.name), 200) : undefined };
}
