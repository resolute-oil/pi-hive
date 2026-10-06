# Wave `refactor/operator-writer-consolidation` — after-action report

## What this wave did

Collapsed the two `writeOperatorCommandRequest` writers into a single
runtime-agnostic implementation. Previously the dashboard server (Bun,
`src/observability/server/db.ts`) and the LLM tools (Node,
`src/engine/budget/operator-command-queue.ts`) each wrote the same
`{id, agent, command, requestedAt}` row to the same
`operator-command-pickup.jsonl` file. Two writers sharing one file
plus a 12-command allow-list meant any drift in path resolution, row
shape, or allow-list membership would be a silent regression.

After this wave, `src/engine/budget/operator-command-queue.ts` is the
single source of truth. `db.ts` re-exports the helpers
(`writeOperatorCommandRequest`, `readOperatorCommandRequests`,
`clearOperatorCommandRequests`, `OPERATOR_COMMAND_NAMES`,
`OperatorCommandRequest`, `OperatorCommandName`) so the dashboard's
`http-handler.ts` and the existing server-routes tests keep their
existing import shape. The dashboard's hardcoded `ALLOWED` set is
replaced with the shared `OPERATOR_COMMAND_NAMES`.

## Commit

- `4ea9192` — `refactor(extension): consolidate operator command writer into shared runtime-agnostic file`

## Where the writer now lives

| Concern | Single source of truth | Notes |
| --- | --- | --- |
| Path resolution (`<hive-dir>/operator-command-pickup.jsonl`) | `operatorCommandQueuePath()` in `src/engine/budget/operator-command-queue.ts` | Also re-declared in `src/integration/operator-pickup.ts` for the parent's startup path resolution; the resolution logic is identical (same env-var precedence). Could be a follow-up to re-export, but the consumer file is intentionally not coupled to the shared module to keep the parent's process from pulling in Bun-typed code. |
| Row shape (`{id, agent, command, requestedAt}`) | `OperatorCommandRequest` in `src/engine/budget/operator-command-queue.ts` | Re-exported from `db.ts` for backward compat. |
| 12-command allow-list | `OPERATOR_COMMAND_NAMES` in `src/engine/budget/operator-command-queue.ts` | Consumer (`operator-pickup.ts:95`) keeps its own `ALLOWED_COMMANDS` set as defense in depth — intentionally not centralized. The LLM tool's `queueOperatorCommand` validator is also driven by this array. |
| `writeOperatorCommandRequest(input)` | `src/engine/budget/operator-command-queue.ts` | Re-exported from `db.ts` so `http-handler.ts:35` keeps its existing import. |
| `readOperatorCommandRequests()` | `src/engine/budget/operator-command-queue.ts` (as `readOperatorCommandRequests = readOperatorCommandQueue`) | Re-exported from `db.ts`. The consumer has its own fs-based drain (`pickupOperatorCommandRequests`); the dashboard re-export exists for the test seam in `tests/server-routes.spec.ts`. |
| `clearOperatorCommandRequests()` | `src/engine/budget/operator-command-queue.ts` | Re-exported from `db.ts`. Best-effort `unlinkSync`. |

## File-by-file changes

- `src/engine/budget/operator-command-queue.ts`
  - **Doc comment** rewritten to describe the file as the
    runtime-agnostic single source of truth (used by Node LLM tools
    AND the Bun dashboard via re-export), not just the Node-safe
    mirror of the dashboard's writer.
  - Imports `unlinkSync` from `node:fs`.
  - Adds `readOperatorCommandRequests = readOperatorCommandQueue`
    alias (so the dashboard test seam keeps its name).
  - Adds `clearOperatorCommandRequests()` best-effort unlink helper.

- `src/observability/server/db.ts`
  - Removes the inline `OPERATOR_COMMAND_QUEUE` constant,
    `OperatorCommandRequest` interface, `writeOperatorCommandRequest`,
    `readOperatorCommandRequests`, `clearOperatorCommandRequests`
    blocks (~37 LOC).
  - Replaces with a re-export block that pulls in the same symbols
    from `src/engine/budget/operator-command-queue.ts`.
  - The `bun:sqlite` import, all `db.query(...)` prepared statements,
    and all `db.ts` consumers are untouched.

- `src/observability/server/http-handler.ts`
  - Imports `OPERATOR_COMMAND_NAMES` from `./db`.
  - Removes the hardcoded 12-string `ALLOWED = new Set([...])`.
  - Constructs the runtime set as `new Set(OPERATOR_COMMAND_NAMES)`.
  - Adds a comment block explaining the consolidation so a future
    reader understands why the set is no longer inline.

- `tests/f13-mode-independence.test.ts`
  - The "dashboard RPC handler's 11-command allow-list matches the
    brief" test previously grepped for `'const ALLOWED = new Set(['`
    and counted inline quoted strings. With the consolidation, the
    allow-list is derived from `OPERATOR_COMMAND_NAMES`; the test
    was rewritten to (a) assert the handler uses the shared export
    and does NOT hard-code the list inline, and (b) read the shared
    module's source to verify the 11 brief commands are present in
    `OPERATOR_COMMAND_NAMES`.
  - This is the only test that asserted on the old writer
    structure; all other tests pass without modification.

- `tests/llm-tools.test.ts`
  - Adds 3 new tests that pin the consolidation contract:
    1. **Structural source check.** Reads
       `src/observability/server/db.ts` and
       `src/engine/budget/operator-command-queue.ts`; asserts that
       `db.ts` no longer declares `OPERATOR_COMMAND_QUEUE`,
       no longer defines `writeOperatorCommandRequest` inline, and
       re-exports all three helpers from the shared module.
    2. **Reference identity.** Imports the shared module twice
       and asserts `writeOperatorCommandRequest`,
       `OPERATOR_COMMAND_NAMES`, and the read aliases are
       module-scoped singletons (no duplication).
    3. **Row-shape parity.** Writes two rows through
       `queueOperatorCommand` and verifies both have exactly the
       `{agent, command, id, requestedAt}` key set with the same
       types.

## Test results

| Suite | Before | After | Delta |
| --- | ---: | ---: | ---: |
| `just test` (Node) | 715 | **718** | +3 (consolidation tests) |
| `just test-db` (Bun *.spec.ts) | 76 | **76** | 0 |
| `tests/operator-pickup.test.ts` | 12 | **12** | 0 |
| `tests/server-routes.spec.ts` | 11 | **11** | 0 |
| `cd ui/web && npm run test:unit` | 63 | **63** | 0 |

No behavior changes: existing tests pass without modification
(except the one structural assertion in `f13-mode-independence.test.ts`
that explicitly asserted on the old inline-allow-list shape). Row
shape, path resolution, file mode (`0o600`), directory mode
(`0o700`), and the 12-command allow-list are byte-identical to
before.

## Verification

```
just typecheck     # all 5 tsconfigs: pass
just test          # 718 pass
just test-db       # 76 pass
just dashboard-build  # pass
cd ui/web && npm run test:unit  # 63 pass
bun test tests/operator-pickup.test.ts  # 12 pass
bun test tests/server-routes.spec.ts    # 11 pass
```

## Deviations from the plan

- **`readOperatorCommandRequests` and `clearOperatorCommandRequests`
  moved too.** The brief said "(or keep it in db.ts if it's only
  used by the consumer; check the consumer's import)". I checked:
  `readOperatorCommandRequests` is imported by
  `tests/server-routes.spec.ts` (a dashboard test seam) and
  `clearOperatorCommandRequests` is also only used there. Neither is
  used by the consumer (`operator-pickup.ts` has its own
  `pickupOperatorCommandRequests` drain). They moved to the shared
  file as `readOperatorCommandRequests` (= `readOperatorCommandQueue`
  reference identity alias) and `clearOperatorCommandRequests()`
  best-effort unlink, and `db.ts` re-exports both so the test passes
  without modification. This makes the consolidation "true" — only
  one place writes to / reads from / clears the file.

- **3 consolidation tests instead of 1.** The brief asked for "1
  small test that proves the consolidation". I split it into three
  (structural, identity, row-shape) so a future drift in any one
  dimension surfaces as a distinct failure rather than a single
  ambiguous one. The brief explicitly allows additions: "Test
  counts should be unchanged from 715" applies to not breaking
  existing tests; the next paragraph says "Add 1 small test".

- **Did not touch `src/integration/operator-pickup.ts`.** The brief
  was explicit: "Don't touch the consumer's allow-list at
  `operator-pickup.ts:95` — that's a defense-in-depth check; the
  producer's allow-list is the source of truth but the consumer
  keeps its own. If they drift, the consumer's check catches it."
  The consumer also re-declares `operatorCommandQueuePath()` and the
  `OperatorCommandRequest` interface locally — these are still
  duplicated, and the brief did not ask to centralize them. The
  resolution logic is identical (same env-var precedence); if they
  drift, the writer's path and the consumer's path would resolve to
  different JSONLs and writes would be lost. A future wave could
  re-export `operatorCommandQueuePath` from
  `operator-command-queue.ts` and have the consumer import it, but
  the current wave's scope was the writer consolidation only.

- **Did not rename `readOperatorCommandQueue` -> `readOperatorCommandRequests`.**
  `readOperatorCommandQueue` is the existing test seam name used by
  `tests/llm-tools.test.ts:254,302,392`. Renaming would touch three
  call sites and the test file imports; the brief said "Tests
  should pass without modification" for the existing tests. So both
  names exist; the `readOperatorCommandRequests` export is a
  reference-identity alias of `readOperatorCommandQueue`. The
  consolidation test (`operator-writer consolidation`) explicitly
  asserts this identity.

- **Dashboard's HTTP allow-list is now `new Set(OPERATOR_COMMAND_NAMES)`.**
  This means the allow-list contains all 12 commands including
  `hive_reload_agent_config`. The previous inline list also
  contained 12 commands. No semantic change. The `f13-mode-independence`
  test was updated to assert on the new structure (the previous
  test relied on `indexOf('const ALLOWED = new Set([')`, which no
  longer matches).

## Follow-ups

- The consumer (`operator-pickup.ts`) could re-export
  `operatorCommandQueuePath` and the `OperatorCommandRequest`
  interface from `operator-command-queue.ts` to remove the
  local duplication. Out of scope for this wave; trivial follow-up.
- The dashboard's HTTP allow-list currently allows
  `hive_reload_agent_config` from the public RPC. The previous
  inline set did the same, so this is not a regression; it is a
  pre-existing T13.0 follow-up concern. The dashboard POST
  `/operator-command` endpoint accepts any agent name (no live
  worker handle check) for `hive_reload_agent_config` because the
  consumer (`operator-pickup.ts:131-134`) handles that special case.
  This was the same in the previous code and is unchanged.

## Confirmation

No behavior changed. Path is the same, row shape is the same, allow-list
is the same, file mode is the same, error-return shape is the same.
The dashboard's HTTP `ALLOWED` set was already 12 entries including
`hive_reload_agent_config`; now it derives from the shared
`OPERATOR_COMMAND_NAMES` which also contains 12 entries. Existing
tests pass without modification (except the one test that asserted on
the now-removed inline `ALLOWED` literal — that test was updated to
assert on the new shared structure).