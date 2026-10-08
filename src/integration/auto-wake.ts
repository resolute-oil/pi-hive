// Transient auto-wake for the F13 operator-command consumer.
//
// Before this module existed, every operator command (compact, end, pause,
// snapshot, resume) required a live `WorkerHandle` in the `workerHandles`
// map. If the parent pi had never dispatched the agent — or had not done
// so since the last mode switch / session restart — the consumer reported
// `"no live worker handle for agent ..."` and the operator had to
// dispatch a task first to "prime" the handle. That footgun is the
// reason this module exists: the wake path rehydrates a session from
// the persisted SessionManager (`SessionManager.continueRecent(cwd)`)
// and registers a transient `WorkerHandle` for the duration of the
// command. After the command completes (success OR failure), the
// handle is unregistered — there is no persistent "live but idle"
// state. Every operator command is wake → operate → sleep.
//
// The wake is read-only: it skips `runPromptAndFinalize` and
// `installBudgetEventHooks` so the pre-flight gate (which would refuse
// dispatch when caps are exhausted) is bypassed. Only the per-command
// side effect (e.g., `compactWorkerSession` writing a ledger entry)
// runs. The ledger write is what the dashboard reads — auto-wake
// therefore has no budget side effects of its own.
//
// Concurrency: two simultaneous wake requests for the same agent share
// one Promise. The in-flight Map is keyed by agent name; the factory
// runs at most once per key, and the second caller awaits the first's
// outcome. The single-threaded JS event loop makes the Map a
// sufficient lock — no extra mutex needed.

import {
  createAgentSession,
  SessionManager as SessionManagerClass,
  type AgentSession,
  type ExtensionContext,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { HiveState, WorkerBudgetPolicy } from "../core/types";
import { BudgetLedger } from "../engine/budget/ledger";
import { resolveWorkerBudgetPolicy as resolveWorkerBudgetPolicyFn } from "../engine/budget/strategy";
import {
  registerWorkerHandleForProduction,
  unregisterWorkerHandleForProduction,
  type WorkerContext,
} from "../engine/budget/worker-tools";

// Commands that benefit from a transient auto-wake. `respawn`,
// `restore`, `abort-compaction`, `force-kill`, `force-end`, and
// `tear-down-all` do NOT wake:
//   - respawn / restore operate on persisted state and rebuild the
//     session from scratch (waking first is wasted I/O).
//   - abort-compaction, force-kill, force-end are escape hatches on
//     already-running sessions; waking then immediately tearing down
//     is nonsensical.
//   - tear-down-all iterates the live handle map; it has no per-row
//     agent and is dispatched before the per-agent lookup runs.
//   - hive_reload_agent_config operates on the static config, not a
//     live session.
//
// Keep this set in sync with the consumer's wake gate. The prompt's
// brief listed exactly these five commands; the test suite pins the
// membership so accidental additions surface immediately.
export const wakesForCommand: ReadonlySet<string> = new Set([
  "compact",
  "end",
  "pause",
  "snapshot",
  "resume",
]);

// Test seam — reset module state between cases. Production code does
// not call this; the consumer's per-drain path is the only legitimate
// caller of the concurrency guard.
export function __resetAutoWakeForTests(): void {
  inflightWakes.clear();
  overrideInternals = undefined;
}

// Module-level override for the wake's internals seam. Tests set
// this to inject fakes for `createAgentSessionFn` /
// `sessionManagerContinueRecent` / `restoreLedger` /
// `resolveWorkerBudgetPolicy` without rebuilding the
// `pickupOperatorCommandRequests` opts shape. The override is
// applied inside `tryAutoWake` before the default internals are
// merged, so partial overrides compose with defaults for the
// omitted fields.
let overrideInternals: AutoWakeInternals | undefined;
export function __setAutoWakeInternalsForTests(internals: AutoWakeInternals | undefined): void {
  overrideInternals = internals;
}

// In-flight wake registry. Keyed by agent name so two simultaneous
// wake requests for the same agent share one Promise; the factory
// runs at most once per key. The Map's promise is removed in the
// `.finally` so the next wake (after the first completes) creates a
// fresh Promise.
const inflightWakes = new Map<string, Promise<WorkerContext | undefined>>();

/**
 * Concurrency guard for wake requests. If an in-flight wake for the
 * same agent is already running, return its Promise so the second
 * caller awaits the first's outcome. Otherwise call the factory once,
 * register its Promise, and clear the registry entry on completion
 * (success OR failure).
 *
 * Exported for the test suite to verify the dedup behavior; the
 * consumer always calls it through `tryAutoWake`.
 */
export async function getOrCreateInflightWake(
  _state: HiveState,
  agent: string,
  factory: (state: HiveState, agent: string) => Promise<WorkerContext | undefined>,
): Promise<WorkerContext | undefined> {
  const existing = inflightWakes.get(agent);
  if (existing) return existing;
  const p = Promise.resolve()
    .then(() => factory(_state, agent))
    .finally(() => {
      // Clear the entry only if it still points at this Promise. A
      // concurrent call may have replaced it (it cannot, given the
      // single-event-loop guard, but defend against future changes
      // that move wake off the main thread).
      if (inflightWakes.get(agent) === p) inflightWakes.delete(agent);
    });
  inflightWakes.set(agent, p);
  return p;
}

/**
 * Sleep — unregister the wake handle for the given agent. Called
 * from the operator-pickup consumer's `finally` block so the handle
 * is released even when the underlying command throws.
 *
 * The wrapper exists so the consumer can call a single named
 * function (mirroring the wake contract) without reaching into the
 * worker-tools module's production-side alias. The unregister is a
 * no-op when the handle was never registered (e.g., the wake path
 * itself failed-closed).
 */
export function releaseWorkerWake(agent: string): void {
  unregisterWorkerHandleForProduction(agent);
}

// Test seam — allow injecting the `SessionManager.continueRecent`
// factory, the policy resolver, the ledger restore, and the
// `createAgentSession` factory so the test can point the wake at a
// temp dir with a real persisted session (the makePersistedSessionFixture
// helper) and stub out the SDK's session-open call. Without these
// seams, the wake would hit the real `SessionManagerClass.continueRecent`
// and the real `createAgentSession` (which loads extensions and
// model-runtime state) — both unwanted in a hermetic unit test.
export interface AutoWakeInternals {
  sessionManagerContinueRecent?: (cwd: string) => SessionManager;
  resolveWorkerBudgetPolicy?: (
    config: NonNullable<HiveState["config"]>,
    agent: string,
  ) => WorkerBudgetPolicy;
  restoreLedger?: typeof BudgetLedger.restore;
  createAgentSessionFn?: (opts: { cwd: string; sessionManager: SessionManager }) => Promise<{ session: AgentSession; [key: string]: unknown }>;
}

const defaultInternals: Required<AutoWakeInternals> = {
  sessionManagerContinueRecent: (cwd) => SessionManagerClass.continueRecent(cwd),
  resolveWorkerBudgetPolicy: resolveWorkerBudgetPolicyFn,
  restoreLedger: BudgetLedger.restore,
  createAgentSessionFn: async (opts) => createAgentSession(opts) as unknown as { session: AgentSession; [key: string]: unknown },
};

/**
 * Try to wake a worker handle for the given agent. Returns a
 * `WorkerContext` (a superset of `WorkerHandle` that also carries
 * `cwd` and the `internals` seam) on success, or `undefined` when
 * the wake is impossible:
 *
 *   - `state.config` is null (no project config loaded)
 *   - the agent is not declared in the config
 *   - the persisted session has no entries (the agent has never been
 *     dispatched, so there is nothing to wake)
 *   - `SessionManager.continueRecent` itself throws (e.g., the
 *     session file is corrupted)
 *
 * The fail-closed contract is what lets the operator-pickup
 * consumer return its pre-change error message byte-identically:
 * `wake → undefined → "no live worker handle for agent ..."`.
 */
export async function tryAutoWake(
  state: HiveState,
  agent: string,
  ctx: ExtensionContext,
  internals: AutoWakeInternals = {},
): Promise<WorkerContext | undefined> {
  if (!state.config) return undefined;
  const config = state.config;

  // Agent must be declared in the config; otherwise resolveWorkerBudgetPolicy
  // would have nothing to look up, and the original "no live worker handle"
  // error is the right user-facing message.
  const declared = config.agents.some((a) => a.name === agent)
    || (config.orchestrator && config.orchestrator.name === agent);
  if (!declared) return undefined;

  const eff: Required<AutoWakeInternals> = { ...defaultInternals, ...overrideInternals, ...internals };

  // Load (or create-then-load) the persisted session. continueRecent
  // may throw on a corrupted session file; the catch returns undefined
  // so the consumer surfaces the pre-change "no live worker handle"
  // error.
  let sessionManager: SessionManager;
  try {
    sessionManager = eff.sessionManagerContinueRecent(ctx.cwd);
  } catch {
    return undefined;
  }

  // A freshly-created session has no entries; treat that as "no
  // persisted session for this agent" and fail-closed. The check uses
  // `getEntryCount` (no copy) for the cheap path; `getEntries` is the
  // documented accessor.
  if (sessionManager.getEntryCount() === 0) return undefined;

  const policy = eff.resolveWorkerBudgetPolicy(config, agent);
  const ledger = await eff.restoreLedger(
    sessionManager,
    agent,
    policy,
    new AbortController().signal,
  );

  // Open the AgentSession. The wake does not call installBudgetEventHooks
  // (read-only contract; only the per-command side effect runs) and does
  // not call runPromptAndFinalize. `createAgentSession` is the same
  // factory the dispatch path uses, so the wake's session shape matches
  // the live path's. The seam lets the test inject a fake session.
  const { session } = await eff.createAgentSessionFn({ cwd: ctx.cwd, sessionManager });

  const controller = new AbortController();

  // Build the WorkerContext literal. The shape is a superset of
  // WorkerHandle (handle + cwd + internals) so it can be both passed
  // to operator commands that take a WorkerContext (respawn /
  // snapshot / restore) and registered as a WorkerHandle via
  // registerWorkerHandleForProduction (which reads only the typed
  // subset).
  const workerContext: WorkerContext = {
    agent,
    session,
    sessionManager,
    ledger,
    policy,
    cwd: ctx.cwd,
    internals: {
      sessionManagerContinueRecent: eff.sessionManagerContinueRecent,
    },
  };

  registerWorkerHandleForProduction({
    agent,
    session,
    controller,
    sessionManager,
    ledger,
    policy,
  });

  return workerContext;
}
