// ── Worker run lifecycle ────────────────────────────────────────────────────
//
// The `WorkerRunLifecycle` class bundles session/subscription/abort-timer
// cleanup so dispatchAgent stays focused on the orchestration flow. Each
// dispatch creates one of these; its `close()` is the unconditional teardown
// path that releases the worker slot even if the session abort hung.
//
// Extracted from `engine/dispatch.ts` so the dispatch function itself stops
// being the single owner of "what happens when a worker finishes" — the
// teardown contract now lives next to the type that owns it. No behavior
// change; the dispatch file imports `WorkerRunLifecycle` from here.

import type { AgentRuntime, HiveState } from "../core/types";
import { releaseWorkerSlot } from "./governance";

export class WorkerRunLifecycle {
  private session: any;
  private unsubscribe?: () => void;
  private abortListener?: () => void;
  private closed = false;
  private readonly state: HiveState;
  private readonly runtime: AgentRuntime;
  private readonly abortSignal?: AbortSignal;

  constructor(state: HiveState, runtime: AgentRuntime, abortSignal?: AbortSignal) {
    this.state = state;
    this.runtime = runtime;
    this.abortSignal = abortSignal;
  }

  attachSession(session: any): void {
    this.session = session;
    this.runtime.session = session;
  }

  attachSubscription(unsubscribe: () => void): void {
    this.unsubscribe = unsubscribe;
  }

  watchParentAbort(listener: () => void): void {
    this.abortListener = listener;
    if (this.abortSignal?.aborted) listener();
    else this.abortSignal?.addEventListener("abort", listener, { once: true });
  }

  async close(failed: boolean): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.abortListener) this.abortSignal?.removeEventListener("abort", this.abortListener);
    if (this.runtime.timer) {
      clearInterval(this.runtime.timer);
      this.runtime.timer = undefined;
    }
    try { this.unsubscribe?.(); } catch { /* cleanup must continue */ }
    if (failed && this.session?.abort) {
      // Do not let a hung provider abort strand the slot forever. Invoking abort
      // starts cancellation; disposal and counter release remain unconditional.
      try { void Promise.resolve(this.session.abort()).catch((): void => undefined); } catch { /* cleanup must continue */ }
    }
    try { this.session?.dispose?.(); } catch { /* cleanup must continue */ }
    this.runtime.session = undefined;
    releaseWorkerSlot(this.state);
  }
}
