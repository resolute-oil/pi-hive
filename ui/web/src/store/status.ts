import type { HiveEvent } from "../types";

export type AgentStatusBySession = Map<string, Map<string, string>>;

// T13.2 dashboard half — per-session intervention-available flag, derived from
// the most recent `budget_warning` event for that worker. The engine emits
// `interventionAvailable: boolean` on each warning (computed from the worker's
// budget strategy: `true` under the default strategy, `false` under `compact`).
// The F13 dashboard reads this flag to decide whether to enable the rescue
// buttons (respawn / force-kill / force-end) on the per-worker button strip —
// under auto-recovery (compact), showing them would mislead the operator into
// thinking a manual intervention is required when the system will recover.
//
// Keyed by `session_id` because every `budget_warning` event is written from
// the worker session's own `sessionManager.appendCustomMessageEntry` (per
// `src/engine/budget/events.ts:221`), and one SDK AgentSession corresponds to
// exactly one worker — so per-session = per-worker for this surface.
//
// Wave 7 F13 production-wiring fix: the F1-F13 design wrote the
// per-worker `appendCustomMessageEntry` to the worker's session.jsonl
// but the dashboard server only ingests the parent's telemetry log
// (via `addSource(telemetry_log)` at runtime.ts:114). The Wave 7 fix
// also emits a `HiveTelemetryEvent` of type `budget_warning` to the
// parent's observability log, carrying the worker's session id in
// `payload.session_id` so the reducer can key per-worker (each
// worker has its own AgentSession). The reducer prefers
// `payload.session_id` (the worker) and falls back to `e.session_id`
// (the parent) so legacy / synthetic events still key correctly.
//
// Sessions whose workers have not yet emitted a `budget_warning` are absent
// from this map (the dashboard falls back to "intervention available" —
// all buttons enabled — which matches the brief's gate).
export type InterventionBySession = Map<string, boolean>;
export function buildInterventionBySession(events: HiveEvent[]): InterventionBySession {
  const out: InterventionBySession = new Map();
  for (const e of events) {
    if (e.type !== "budget_warning") continue;
    const flag = e.payload?.interventionAvailable;
    if (typeof flag !== "boolean") continue;
    // Wave 7 F13 fix: prefer the worker's session id (payload.session_id)
    // over the parent's (e.session_id). The parent's session id is
    // stamped onto every event by `emitHiveEvent`, but multiple workers
    // can share a parent — they each need their own map entry so the
    // per-worker row in the UI can read its own flag.
    const workerSessionId = typeof e.payload?.session_id === "string" && e.payload.session_id
      ? e.payload.session_id
      : e.session_id;
    // Latest event wins — strategies are static for the lifetime of the worker
    // policy, so the first and last warning carry the same value, but using
    // "latest" keeps the reducer monotonic in the face of any future
    // mid-session policy swap (e.g. a tool re-arming the strategy).
    out.set(workerSessionId, flag);
    // Wave 7.5 F13 fixup: also write the entry under the parent's session id
    // (when it differs from the worker key). The row builder at
    // `scoped-agents.ts` looks up the flag by the parent's session id
    // because the row's `session_id` field is the parent (the topology
    // describes the parent's team, not the worker's own session). Without
    // this alias every row's `interventionAvailable` is undefined and the
    // `OperatorCommands` compact-strategy gate never engages. The worker
    // key above still keeps the per-worker distinction intact for any
    // future consumer that wants it; the parent key is the alias the
    // current UI looks up. Cost: one extra Map.set per event.
    if (workerSessionId !== e.session_id) out.set(e.session_id, flag);
  }
  return out;
}

// Event-driven agent status overlay. The topology must reflect activity the
// instant an event arrives (same channel as the activity feed) — snapshots
// arrive later (file-poll) and can coalesce, so they alone make the graph lag.
//
// We replay events chronologically and track, per session:
//   • each agent's last status
//   • outstanding delegations per parent (delegation_start without a matching
//     delegation_end from that child yet)
//
// Status meaning:
//   running  — actively executing (issued tool calls, or just delegated-to)
//   waiting  — has ≥1 outstanding delegation to a child; it's blocked waiting
//              on that child rather than doing work itself
//   done/error — finished
//   idle     — never ran / reset by session_start
export function buildEventStatus(events: HiveEvent[]): AgentStatusBySession {
  const bySession = new Map<string, Map<string, string>>();
  // per session: child -> parent (who delegated to it), and parent -> set of
  // outstanding child delegations.
  const parentOf = new Map<string, Map<string, string>>();
  const outstanding = new Map<string, Map<string, Set<string>>>();

  const ses = <T>(map: Map<string, Map<string, T>>, sid: string): Map<string, T> => {
    let values = map.get(sid);
    if (!values) { values = new Map(); map.set(sid, values); }
    return values;
  };
  const setStatus = (sid: string, name: string | undefined, status: string) => {
    if (!name) return; ses(bySession, sid).set(name, status);
  };

  for (const e of events) {
    const sid = e.session_id, p = e.payload || {};
    switch (e.type) {
      case "session_start":
        bySession.set(sid, new Map()); parentOf.set(sid, new Map()); outstanding.set(sid, new Map());
        break;
      case "delegation_start": {
        if (!p.to) break;
        setStatus(sid, p.to, "running");
        if (p.from) {
          ses(parentOf, sid).set(p.to, p.from);
          const out = ses(outstanding, sid);
          const set = out.get(p.from) || new Set<string>(); set.add(p.to); out.set(p.from, set);
          setStatus(sid, p.from, "waiting"); // blocked on the child it just spawned
        }
        break;
      }
      case "worker_tool_start": {
        // An agent that has handed work to a child is WAITING even though pi
        // emits tool calls for it — the delegation itself (delegate_agent /
        // team_conversation) is a tool call, and a parent mid-delegation isn't
        // doing real work. So only flip to running when it has NO outstanding
        // delegations. (Delegation tools never count as "work".)
        const out = ses(outstanding, sid).get(p.agent);
        if (out && out.size) break; // still waiting on a child
        setStatus(sid, p.agent, "running");
        break;
      }
      case "delegation_end": {
        const child = p.from;
        if (!child) break;
        setStatus(sid, child, p.type === "error" ? "error" : "done");
        // clear this child from its parent's outstanding set; if the parent has
        // none left, it resumes running.
        const parent = ses(parentOf, sid).get(child);
        if (parent) {
          const out = ses(outstanding, sid);
          const set = out.get(parent); if (set) { set.delete(child); if (!set.size) { out.delete(parent); setStatus(sid, parent, "running"); } }
          ses(parentOf, sid).delete(child);
        }
        break;
      }
      // Events below intentionally do not affect agent status — they pass
      // through without updating bySession/parentOf/outstanding. Explicit cases
      // (instead of `default:`) are required by
      // `@typescript-eslint/switch-exhaustiveness-check` with the project's
      // default config (`considerDefaultExhaustiveForUnions: false`); the lint
      // surfaced as a merge interaction when WT-1 narrowed `HiveEvent.type`
      // from `HiveEventType | string` to `HiveEventType`, exposing the
      // previously-silent gaps in this switch.
      case "error":
      case "user_message":
      case "assistant_message":
      case "worker_tool_end":
      case "worker_retry":
      case "worker_compaction":
      case "orchestrator_tool_start":
      case "orchestrator_tool_end":
      case "orchestrator_compaction":
      case "orchestrator_message":
      case "model_select":
      case "thinking_level_select":
      case "turn":
      case "provider_response":
      case "user_bash":
      case "input":
      case "session_fork":
      case "session_tree":
      case "session_info_changed":
      case "model_catalog":
      case "distill_start":
      case "distill_end":
      case "budget_warning":
      case "budget_exhausted":
      case "queue_update":
      case "review_verdict":
      case "plan_approval":
      case "plan_comment":
      case "delegation_progress":
        break;
    }
  }
  return bySession;
}
