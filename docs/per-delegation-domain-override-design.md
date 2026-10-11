# Per-delegation domain override for pi-hive

## Summary

A `delegate_agent` parameter (`domain_override`) lets orchestrator and Operations personas grant a worker a specific write scope inside a worktree for the duration of one `dispatchAgent()` call. The override is captured-and-merged with the worker's static `domain:` block before the worker session becomes active, enforced at every tool invocation against the merged scope, and reverted to static on every termination path — return, validation error, queue cancellation, budget exhaustion, abort, orchestrator crash. Reserved paths and reviewer-type policy stay binding: the override is a domain-layer delta and cannot loosen the fence. Every grant is audit-logged via `emitHiveEvent` as a `domain_override.granted` event with a paired `domain_override.revoked`, so post-hoc queries can reconstruct the effective scope for any past delegation. The worker is never the constraint author; the dispatch site fills the parameter, the runtime captures and merges before any tool runs, and the merged scope is what `enforceDomainForTool` sees for the call.

## Terms

Each term has a one-sentence definition. Words marked *Avoid* should not be used for the concept.

- **override** — the per-delegation delta applied to a worker's static `domain:` block for the duration of one `delegate_agent` call, granting `upsert: true` (and possibly `delete: true`) on a specific list of paths inside a worktree. Shape: `{ path: string; upsert: boolean; delete: boolean; include?: string[]; exclude?: string[] }[]`. *Avoid:* grant, extension, expansion, scope-patch.

- **effective domain** — the union of static config + override; the actual scope the runtime enforces for a delegation. With Q7 (per-call local), this lives in `dispatchAgent()` locals; with Q8 (`emitHiveEvent`), it is observable as the `domain_override.granted` event. *Avoid:* merged domain, active domain, live scope.

- **delegation** — one `delegate_agent` call (orchestrator/Operations → worker) and the worker session that runs to answer it. Per-dispatch lifetime only; reverts on every termination path including orchestrator crash. *Avoid:* invocation, task, worker-session.

- **static config** — the worker's `.md` frontmatter `domain:` block; the persistent config unaffected by an override. *Avoid:* base config, default scope, original domain.

- **worktree** — `APP_ROOT/.worktrees/<change-id>/` for normal changes or `APP_ROOT/.worktrees/_conflict-<change-id>/` for conflict-resolution runs. *Avoid:* branch, checkout, subtree.

- **reserved paths** — the policy-listed paths (`.git/**`, `.env*`, `**/*.key`, `**/*.pem`, `config/master.key`, `config/credentials*`, `.pi/hive/sessions/**`, plus anything in `settings.secret-paths`) that the runtime blocks before any domain logic. *Avoid:* denied paths, blocked paths, sensitive paths.

- **dispatch site** — the orchestrator or Operations role making a `delegate_agent` call. The only place a `domain_override` is declared; the worker side cannot establish or amend the constraint. *Avoid:* caller, orchestrator, hive.

- **scope grant** — the act of applying the override at the start of `dispatchAgent()`. The grant is implicit in the call; the runtime also emits a `domain_override.granted` Hive telemetry event per Q8. *Avoid:* scope-apply, scope-set, permission-grant.

- **scope revoke** — the act of restoring the static config when the worker returns (or via every error/abort/crash path). Implicit in the dispatch lifecycle; paired with `domain_override.revoked`. *Avoid:* revert, restore, release.

- **delegation id** — the per-call identifier used by the runtime to keep overrides from colliding when concurrent `delegate_agent` calls share a worker. Identity established at grant, released at revoke, surfaced in audit events so a post-hoc query can attribute each event to its delegation. *Avoid:* session-id, task-token, run-id.

- **inconsistent state** — the combination `isReadOnly: true` AND a non-empty `domain_override` with any `upsert: true` or `delete: true` entry. The pre-flight gate rejects this as a structured error so the call site surfaces the bug rather than having either flag silently win. *Avoid:* conflict, contradiction, mismatch.

## Why

The user ships a worktree-backed workflow in a downstream Rails project where coding agents must write only into a per-change worktree subdir at `APP_ROOT/.worktrees/<change-id>/<subdir>/`, never into APP_ROOT directly during hive mode. The static `.md` `domain:` blocks cannot express this because the worktree path contains a dynamic `<change-id>` segment that doesn't exist until `/hive:execute <change-id>` creates the worktree. A per-delegation override at dispatch time closes the gap: the orchestrator or Operations persona names the exact paths inside the worktree for this delegation, the runtime enforces them, the static config reverts on return.

The load-bearing constraint — and the one that drove Q1's thread reply — is that the worker must never be the constraint author. The override is set up by the dispatch site before the worker can touch any file, so the worker has no opportunity to widen its own scope. Reserved paths and reviewer-type policy remain binding regardless of override, preserving defense in depth: even an override that would grant `.worktrees/<change-id>/.env*` is rejected at the pre-flight gate (Q6) AND the reserve-paths fence runs before domain enforcement at every tool call.

## Locked decisions

Every durable question from rounds 1–3 of the grill. Each lists the choice, the rejected alternatives, and the rationale.

### Q1 — Interface seam: per-call parameter (I-1)

**Decision.** I-1. A `domain_override` parameter on `delegate_agent`. Runtime snapshots static config at `dispatchAgent()` start, layers the parameter, enforces the merged scope for the call, reverts on return.

Rejected.
- **I-2 run manifest.** Pushes the source of truth outside the call site. The runtime gains only filesystem durability, which can be added on top of I-1 if a real need emerges; loses call-site-local audit simplicity.
- **I-6 per-change worker `.md` overrides.** Same source-of-truth split as I-2, plus the burden of a discovery-and-prefer mechanism that risks misordering when a delegation happens outside the worktree.
- **I-3 token syntax, I-4 cwd-derived, I-5 event.** Each either inverts audit (cwd hides what was granted), introduces runtime parsing surface (tokens), or moves the truth off the call site (event ordering).

### Q2 — Override author: Orchestrator + Operations

**Decision.** Both orchestrator and Operations personas can declare a `domain_override`. Lead agents and worker agents cannot.

Rejected.
- **Operations only.** Defense-tightest but breaks the auto-dispatch path from `/hive:execute`, which the spec's locked Q2 requires run without round-tripping through Operations.
- **Any dispatch-capable role.** Drops defense: a Lead agent would gain the same override power as Operations.
- **Role allow-list in `hive-config.yaml`.** Strongest least-privilege posture, worth it only when the project's role hierarchy grows beyond orchestrator/Operations/leads/workers. Skip until that need actually surfaces.

### Q3 — Granularity: subdir-only

**Decision.** The override is an explicit list of paths inside the worktree, named by the call site per-dispatch. Whole-worktree grants are not supported.

Rejected.
- **Whole-worktree.** Conflicts with the reserve-paths constraint — would let a coder write into `.worktrees/<change-id>/.env*` if not for the reserve fence running before the domain layer, which is defense-in-depth but a pre-flight surprise. Also conflicts with the spec's "smallest scope necessary" guidance.
- **Worktree-tag with role-default subdirs.** Hides the granted scope behind a per-role mapping config that the audit log can only summarize, not enumerate.

### Q4 — Override data shape: `DomainScope` subset

**Decision.** Override entry shape = `{ path: string; upsert: boolean; delete: boolean; include?: string[]; exclude?: string[] }`. Reuses the existing `DomainScope` read/write fields, omits `read`, keeps `include`/`exclude` for fine-grained narrowing inside a path. Parameter type on `delegate_agent`: `domain_override: Array<OverrideEntry>`.

Rejected.
- **String paths only.** Smallest API but cannot exclude files inside a granted directory — dispatches that need to permit `app/` but block `app/secrets.rb` would have to enumerate the rest of the directory contents, brittle and likely to overshoot least-privilege.
- **Full `DomainScope` including `read`.** Supersets the read-preservation constraint from Q1's thread; the `read` field would be dead unless that constraint is later relaxed.

### Q5 — Lifetime: per-delegation-call

**Decision.** Override is captured-and-applied inside `dispatchAgent()` and reverts when the call returns (sync or async). A worker session may live longer than the call; if the same worker is dispatched again, a fresh override is required (or none — falls back to static).

Rejected.
- **Per-worker-session.** Requires the runtime to keep override state live across tool turns within the session, which adds an in-memory cache keyed by session-id and complicates every termination path (a forced `hive_end_worker` mid-call would still need to revert the override — a leaky abstraction).
- **Per-tool-call.** Too granular for a worker that needs write across many tool calls within one delegation.

### Q6 — Pre-flight gate: inline

**Decision.** `delegate_agent` runs the override validator before spawning the worker. On invalid override, returns a structured error and the worker never starts. Validator checks: (a) no entry grants a reserved path; (b) no entry grants `upsert: true` or `delete: true` to a reviewer-typed agent; (c) override does not expand the agent's static budget; (d) override does not violate depth-cap; (e) `isReadOnly` and the override are not in inconsistent state (per Q9).

Rejected.
- **Sibling `validate_domain_override` tool.** Gives orchestrators a dry-run surface, but most will not dry-run — they'll just dispatch and read the error when it happens. Pays API surface for a niche use.
- **Both.** Doubles the validator's maintenance burden and creates two places a bug could live.

### Q7 — Concurrency: per-call local

**Decision.** The merged scope lives in a per-call local inside `dispatchAgent()`, keyed by the call's local `try`/`finally` and the call's `delegationId`. No global registry. Each call's worker session sees its own effective scope for the duration of that call's tool turns.

Rejected.
- **Process-wide registry (`Map<delegationId, override>`).** Right choice if cross-call queries ("what's agent X currently scoped to?") were required, but no part of the spec or codebase asks for that. Adds an extra state object plus a guaranteed cleanup path on every termination.
- **Per-worker-session overlay.** Coupling between concurrent calls to the same worker — they would each need to mutate the shared per-session scope, which the spec's explicit acceptance criterion forbids.

### Q8 — Audit shape: Hive telemetry events

**Decision.** Two `emitHiveEvent` records per delegation:

- **`domain_override.granted`** — fields: `delegationId`, `dispatcher` (agent slug), `dispatcherRole` (orchestrator/Operations), `worker` (target agent slug), `changeId`, `grantedAt`, `overrideEntries` (the locked Q4 shape), `staticReference` (digest of the static config the override layered onto).
- **`domain_override.revoked`** — fields: `delegationId`, `revokedAt`, `terminationReason` (`return` / `error` / `abort` / `crash` / `budget-exhausted` / `queue-cancelled`).

Records land in the existing telemetry channel so dashboard views and session archives pick them up via the same listener plumbing.

Rejected.
- **Per-delegation file at `.pi/hive/sessions/<run-id>/overrides/<delegation-id>.json`.** Easy to read in isolation but bypasses the existing telemetry pipeline — a dashboard widget would have to be written specifically for the file, and any tool that already parses Hive events would miss it.
- **Both event and file.** Doubles storage and write paths; the file would sit unused most of the time.

### Q9 — `isReadOnly` vs `domain_override`: reject inconsistent state

**Decision.** If `isReadOnly` is `true` and any override entry has `upsert: true` or `delete: true`, the validator (Q6) returns a structured error. The two parameters express orthogonal intents and cannot both be true.

Rejected.
- **`domain_override` wins.** Makes `isReadOnly` a no-op when an override is present, complicates the validator ("the caller probably meant this" rather than "these are inconsistent"), and muddies the audit log entry.
- **`isReadOnly` wins.** Silently strips writes from the override — a security-style footgun; the override's intended scope is silently narrowed and the call site has no signal that its call was reduced.

## Routine choices

All nine questions in the grill were durable. No non-durable choices emerged.

## Verified facts

Established by reading pi-hive's codebase rather than asking. Cited so the implementing session can sanity-check semantics if useful:

- **`DomainScope` interface** at `src/core/types.ts:77`, fields `path`, `read`, `upsert`, `delete`, optional `include`/`exclude`/`description`/`allowOutsideProject`. The Q4 override entry is a strict subset.
- **`delegate_agent`** is the existing dispatch tool name; declared at `src/agents/tools.ts:187`. Its current typebox schema declares `agent` (string) and `task` (string); `domain_override` slots in as a third optional parameter.
- **`dispatchAgent`** is the runtime entry point at `src/engine/dispatch.ts:278`. Signature: `dispatchAgent(state, agentName, task, ctx, createSession=createAgentSession, abortSignal?, isReadOnly?)`. The new `domain_override` slots as an 8th positional argument after `isReadOnly`.
- **`enforceDomainForTool(event)`** is at `src/engine/domain.ts:751`. Already accepts a scope-shaped parameter; the merged effective scope plumbs through here unchanged.
- **Existing telemetry channel** runs through `emitHiveEvent` (used by `src/engine/telemetry-listeners.ts`, the orchestrator hooks, and the session archive). The Q8 events `domain_override.granted` and `domain_override.revoked` join this channel.
- **`tests/policy.test.ts`** already constrains reviewer upsert behavior (the "reviewer upsert blocked by type even when in-domain" tests). The Q9 rejection must respect these.
- **Pre-flight pattern** lives in `dispatchAgent` already (`preflightCheck` helper at `dispatch.ts:298` area). The Q6 validator becomes a new branch of `preflightCheck`.

## Risks

Risks called out by the spec itself or implied by the locked design but not directly addressed by Q1–Q9. Captured here so the implementing session can plan for them.

- **Conflict-resolution worktree retargeting (spec §3.7).** The Q3 subdir-only + Q1 per-call parameter lock already supports this: the call site just passes different paths (e.g., `.worktrees/_conflict-<change-id>/app/controllers/...`). No new mechanism required. The implementing session should write at least one regression test that covers the conflict-worktree path so the support is locked in.
- **Spec references c2c/permissions files that the orchestrator session cannot read.** The locked design treats the feature spec (sections §1–§8) as canonical; the reference paths (`docs/operations-and-worktrees-design.md`, `tmp/handoff-pickup.md`, `tmp/per-delegation-domain-override-feature-spec.md` in the consuming project) were used as context by the user but not by the orchestrator. The implementing session in the pi-hive repo has full filesystem access; if it can co-locate with the consuming project's design notes it can sanity-check against them.
- **Empty `domain_override` array vs absent.** Spec invariant §4: "a delegation with an empty override behaves identically to no override." The Q6 validator must treat `domain_override: []` as if it were absent — no grant event emitted, no scope widening. Worth a test.
- **`staticReference` digest for audit replay.** Q8's grant event includes `staticReference` so a post-hoc investigator can reconstruct what the override layered onto. The implementing session picks an algorithm (whole-file hash, per-`domain:`-block hash, etc.). Any deterministic digest is acceptable; the auditor's job is to detect "this override layered onto a different static config than what I'd expect from the worker's `.md`."
- **Orchestrator crash mid-delegation.** The spec invariant lists crash as a termination path. With Q7 = per-call local, the override lives in the call's locals; if the orchestrator process crashes, the in-memory grant is gone with the process. Worker sessions currently run in the same process (`src/engine/dispatch.ts:34-37`'s note), so they lose their grant simultaneously. If the runtime later moves to multi-process workers, the implementing session must add a cleanup hook to every worker-death path so the grant is revoked via the Q8 event.
- **Override for nested `delegate_agent`.** With Q7 = per-call local, a worker session that itself calls `delegate_agent` (nested delegation) starts its own override lifetime. The parent's effective scope does not propagate down — the child sees only its own override + the parent's static config. The implementing session should make this explicit in the typebox schema and test that nested calls each have their own grant/revoke events.

## Deferred

None. All branches the grill walked received durable decisions.

## Open threads

The one discussion thread from the grill (Q1, on the worker-not-establishing-constraint invariant) was answered by the agent's reply on Q1 — it is locked into the design via Q1 itself (the dispatch site is the only grant author) and the round-1 decision. No open threads remain.
