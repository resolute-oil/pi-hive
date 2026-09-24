import { sessionUpdatedAt } from "./identity";

// A session is "live" if its snapshot updated within this window. A running
// agent that hasn't updated in this long is treated as stale (its process
// likely died without a final delegation_end), so it stops counting as live.
export const STALE_LIVE_MS = 5 * 60_000;

// A session's snapshot is stale when its last update is older than STALE_LIVE_MS.
// Used to suppress the event-status overlay's running/waiting for dead sessions:
// buildEventStatus only clears "running" on delegation_end, the one event a killed
// process never emits, so a stale session's overlay would pin an agent "running"
// forever. `now` defaults to the store tick so callers on the live tier stay in
// sync with the same clock recomputeLive uses.
export function sessionIsStale(sessionId: string, now: number): boolean {
  const at = sessionUpdatedAt.get(sessionId) || 0;
  return at > 0 && now - at >= STALE_LIVE_MS;
}

// Demote an overlay status for a stale session: running/waiting become idle (the
// process is presumed dead); terminal/idle states pass through unchanged.
export function demoteIfStale(status: string, sessionId: string, now: number): string {
  if ((status === "running" || status === "waiting") && sessionIsStale(sessionId, now)) return "idle";
  return status;
}
