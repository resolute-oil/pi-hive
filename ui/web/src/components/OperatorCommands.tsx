// F13 — operator intervention buttons.
//
// Renders 11 buttons per active worker for the EOL (end-of-life) commands
// exposed in `src/engine/budget/worker-tools.ts` (Wave 3 3B/3C regions):
//
//   6 base commands:
//     end · compact · respawn · pause · snapshot · restore
//   2 shape variants:
//     resume (post-pause re-attach) · abort-compaction (cancel in-flight compact)
//   3 escape-hatch variants (operator-only — never agent-callable):
//     force-kill · force-end · tear-down-all
//
// Per `04-refactor-plan.md` §2.2, the escape-hatch trio is operator-only — the
// dashboard is the operator surface; cooperative tools (request_compaction /
// request_end_session / request_snapshot) are the agent surface and live in
// worker-only-tools.ts, not here.
//
// Per `04-refactor-plan.md` §6.2 (interventionAvailable decision, T13.2),
// the parent may suppress the rescue buttons when the worker's strategy
// auto-recovers (the `compact` strategy auto-compacts on exhaustion, so
// showing an "abort" button would mislead the operator). The `interventionAvailable`
// prop threads that flag from the Agents tab's row data — when `false`, the
// 3 rescue buttons (respawn, force-kill, force-end) are disabled with a tooltip.
//
// Click handler posts to the daemon's `/operator-command` RPC (T13.1), which
// queues the request for the parent pi to pick up via a
// `command_request` telemetry event. The full execution loop is
// `brief §T13.3` mode-independence smoke test territory; this component is
// the dashboard's UI half of the contract.

import { useState } from "react";
import type { ScopeAgent } from "../store";
import { runOperatorCommand, type OperatorCommandName } from "../api";

// The 11 command buttons, in the brief-pinned order. Keep the array
// order stable so the rendered layout matches the dashboard contract
// downstream (visual-review gate per `04-refactor-plan.md` §5).
const COMMANDS: ReadonlyArray<{ name: OperatorCommandName; label: string; title: string; danger?: boolean; rescue?: boolean }> = [
  { name: "end", label: "End", title: "End session (operator may resume)" },
  { name: "compact", label: "Compact", title: "Compact session" },
  { name: "respawn", label: "Respawn", title: "Discards prior session and creates a clean slate", rescue: true },
  { name: "pause", label: "Pause", title: "Pause session (listeners stay attached)" },
  { name: "snapshot", label: "Snapshot", title: "Snapshot the current session" },
  { name: "restore", label: "Restore", title: "Restore a previously-snapshotted session" },
  { name: "resume", label: "Resume", title: "Re-attach budget hooks after a pause" },
  { name: "abort-compaction", label: "Abort compact", title: "Cancel an in-flight compaction" },
  // Escape hatches — operator-only. The `danger` flag styles them in the
  // --crit color so a stray click is visually obvious; the `rescue` flag
  // makes them subject to the interventionAvailable gate.
  { name: "force-kill", label: "Force kill", title: "Operator escape: abort + dispose", danger: true, rescue: true },
  { name: "force-end", label: "Force end", title: "Operator escape: abort + dispose (loses resume)", danger: true, rescue: true },
  { name: "tear-down-all", label: "Tear down all", title: "Operator escape: stop every worker", danger: true },
];

// Renders the 11-button strip for a single agent row. The parent (Agents
// tab) is responsible for the "per active worker" gate — this component
// is a stateless presentational widget.
export default function OperatorCommands({ agent, interventionAvailable }: { agent: ScopeAgent; interventionAvailable?: boolean }) {
  const [busy, setBusy] = useState<OperatorCommandName | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const onClick = async (name: OperatorCommandName) => {
    setBusy(name);
    setLastError(null);
    try {
      const res = await runOperatorCommand(agent.name, name);
      if (!res.ok) {
        setLastError(res.error || `${name} failed`);
      }
    } catch (e: any) {
      setLastError(e?.message || `${name} failed (network)`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-wrap gap-1 items-center" data-testid={`operator-commands-${agent.name}`}>
      {COMMANDS.map((cmd) => {
        // T13.2: under the "compact" strategy the system auto-recovers, so
        // the rescue buttons (respawn / force-kill / force-end) would be
        // misleading. The brief pins interventionAvailable to `false` under
        // the compact strategy; honor it here.
        const isRescue = cmd.rescue === true;
        const disabled = busy !== null || (isRescue && interventionAvailable === false);
        const tooltip = disabled && isRescue && interventionAvailable === false
          ? `${cmd.title} (suppressed: auto-recovery strategy)`
          : busy === cmd.name
            ? "running…"
            : cmd.title;
        return (
          <button
            key={cmd.name}
            type="button"
            data-testid={`operator-cmd-${agent.name}-${cmd.name}`}
            data-cmd={cmd.name}
            data-danger={cmd.danger ? "true" : undefined}
            data-rescue={cmd.rescue ? "true" : undefined}
            disabled={disabled}
            aria-label={cmd.title}
            title={tooltip}
            onClick={() => void onClick(cmd.name)}
            className={cmd.danger ? "oc-btn oc-btn-danger" : "oc-btn"}
          >
            {busy === cmd.name ? "…" : cmd.label}
          </button>
        );
      })}
      {lastError && <span role="alert" className="text-[11px] text-crit ml-1">{lastError}</span>}
    </div>
  );
}
