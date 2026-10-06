# Wave budget-include-filter — after-action report

## Summary

Fixed the pre-flight and mid-run budget gates so they honor the resolved
policy's `include` list (default `["input", "output"]`). The pre-fix code
compared `stats.tokens.total` against the cap, which folds `cacheRead` /
`cacheWrite` in per the SDK contract. With high cache hits, the gate
fired earlier than the user expected; the dashboard's
`tokenBudgetScope: "input_output"` display honored the include list, so
the user saw a contradiction.

The user's exact 350,000-token scenario (input=10K, output=5K,
cacheRead=200K, cacheWrite=135K, cap=20K, include=[input,output]) now
lets the worker run instead of refusing mid-run.

## Commits

- `058e8f3` — `fix(budget): honor include list in pre-flight gate and tool-call handler`

## Helper function

- `tokensForInclude(stats: SessionStats, include: IncludeKeys): number`
  at `src/engine/budget/policy.ts:18-58`.

Sums the requested token dimensions from a SessionStats snapshot. Pure
(no I/O, no SDK). Accepts the documented `IncludeKey` union
(`"input" | "output" | "cacheRead" | "cacheWrite" | "reasoning"`).
Defaults to `["input", "output"]` when an empty or undefined list is
passed (matches the policy resolver's documented default).

**Limitation:** `reasoning` lives on `runtime.reasoningTokens`, not on
`SessionStats.tokens`, so the helper returns 0 for the `reasoning`
dimension. The helper accepts it in the include list for future-proofing
and documents the no-op explicitly. Flagged as a follow-up that would
require plumbing the runtime through.

## Call sites updated

| File | Line | Change |
|---|---|---|
| `src/engine/budget/policy.ts` | 60-141 | `checkBudgetPolicy` signature gains optional 4th `stats?: SessionStats`. When supplied, the worker-tokens comparison uses `tokensForInclude(stats, include)`. When absent, falls back to `ledger.cumulative.tokens` (legacy behavior). The reason string reflects the include-scoped count. |
| `src/engine/budget/events.ts` | 161-176 | `buildBudgetToolCallHandler` replaces `stats.tokens.total` with `tokensForInclude(stats, include)`. The reason string reflects the include-scoped count. |
| `src/engine/budget/events.ts` | 17 | Import `tokensForInclude` from `./policy`. |
| `tests/budget-contracts.test.ts` | 35 | Pin the new 4-arity of `checkBudgetPolicy` (was 3). |
| `tests/budget-races.test.ts` | 70-85 | `makeScriptedSession` now distributes `initialCumulative.tokens` into `tokens.input` (with `tokens.output = 0`, `tokens.cacheRead = 0`, `tokens.cacheWrite = 0`, `tokens.total = input`). The pre-fix total-only check didn't care about the per-dim split; the new helper does, so fakes that reported `total=N, input=0` would underreport and let tools run when the gate should fire. |

## Call sites intentionally NOT updated (legacy fallback)

- `src/engine/budget/worker-tools.ts:278` — the delegation-time pre-flight
  gate. No AgentSession is open at this point in `delegateAgent`, so the
  helper cannot be invoked without restructuring the lifecycle
  (open-session-before-gate adds overhead and a cleanup path). Per the
  brief: "If a call site doesn't have a session handy (rare), keep the
  fallback to `ledger.cumulative.tokens` (the `stats?` parameter handles
  this)." The legacy fallback is the documented behavior here; the
  mid-run tool-call handler (which DOES have stats) is where the
  include-aware comparison fires.

## Test count delta

| Scope | Before | After | Delta |
|---|---|---|---|
| Total | 718 | 732 | +14 |
| `tests/budget-policy.test.ts` | 15 | 24 | +9 |
| `tests/budget-events.test.ts` | 30 | 35 | +5 |

All 732 tests pass; `just typecheck`, `just test`, `just dashboard-build`,
and `cd ui/web && npm run test:unit` all green.

## New tests

### `tests/budget-policy.test.ts` (9 new tests)

1. `tokensForInclude: sums only the dimensions named in include` —
   pins the per-dimension sum across `["input"]`, `["output"]`,
   `["input","output"]`, `["cacheRead"]`, `["cacheWrite"]`, and
   `["input","output","cacheRead","cacheWrite"]`.
2. `tokensForInclude: empty / undefined include list falls back to
   input + output` — pins the helper's default behavior matches the
   policy resolver's default.
3. `checkBudgetPolicy 4-arg overload: include=[input,output] ignores
   cacheRead/write when stats supplied` — the user's exact bug scenario
   (large cache, small input+output, cap under cache total).
4. `checkBudgetPolicy 4-arg overload: include=[input,output] fires when
   input+output exceeds cap` — negative case to confirm the gate still
   fires when the include-scoped sum exceeds cap (cache alone doesn't
   push it over).
5. `checkBudgetPolicy 4-arg overload: include=all-four sums every
   dimension` — confirms `include=["input","output","cacheRead","cacheWrite"]`
   matches the pre-fix total behavior.
6. `checkBudgetPolicy 4-arg overload: include=undefined defaults to
   input+output` — pins the default path when the policy omits `include`.
7. `checkBudgetPolicy 4-arg overload: include includes reasoning →
   reasoning contributes 0` — documents the no-op for reasoning so a
   future fix that wires runtime through is caught by the diff.
8. `checkBudgetPolicy 3-arg overload (no stats): falls back to
   ledger.cumulative.tokens` — pins the legacy behavior at
   `worker-tools.ts:278` so a future refactor doesn't silently change
   the comparison semantics.
9. `user's 350,000-token scenario: cache hits do not push
   include=[input,output] gate over` — pins the user's exact scenario
   end-to-end (cap=20K, total=350K, include=[input,output] → no block;
   negative control with include=all-four → block fires with reason
   `350000/20000`).

### `tests/budget-events.test.ts` (5 new tests)

1. `buildBudgetToolCallHandler respects include=[input,output]: bash
   NOT blocked when only cacheRead is large` — pins the include-aware
   comparison in the mid-run handler (cap=1K, total=280K, input+output=150
   → no block).
2. `buildBudgetToolCallHandler respects include=[input,output]: bash
   BLOCKED when input+output exceeds cap` — negative case (input+output=1.1K
   > cap=1K, total=16K → block fires; reason shows `1100/1000`, not
   `16100/1000`).
3. `buildBudgetToolCallHandler respects include=all-four: bash BLOCKED
   when total exceeds cap` — confirms the all-four path.
4. `buildBudgetToolCallHandler respects include=undefined (defaults
   to [input,output])` — pins the default path when the policy omits
   `include`.
5. `buildBudgetToolCallHandler applies the include filter to all 4
   BLOCKED tools (bash, edit, write, read)` — confirms the filter
   applies uniformly across the four tools the G-01 gate covers.

## Verification

```sh
just typecheck              # clean
just test                   # 732 pass, 0 fail
just dashboard-build          # clean
cd ui/web && npm run test:unit   # 63 passed
```

## Deviations / follow-ups

1. **`reasoning` dimension cannot be honored from `SessionStats` alone.**
   The helper accepts `reasoning` in the include list for future-proofing
   but treats it as 0 because `runtime.reasoningTokens` (the source of
   truth per `dispatch-lifecycle.ts:148-167`) is not plumbed into
   `tokensForInclude`. Fix requires threading the runtime (or a small
   `reasoningTokens: number` argument) through the helper, which is a
   larger change that the brief scoped out. Recommend a follow-up wave
   that adds a `reasoningTokens?: number` parameter to the helper and
   threads it from the `BudgetContext` in `events.ts` and the
   `AgentRuntime` in `worker-tools.ts`.

2. **The pre-flight gate at `worker-tools.ts:278` still uses the legacy
   `ledger.cumulative.tokens` fallback.** No AgentSession is open at
   delegation start, so the include-aware comparison cannot fire there.
   The mid-run tool-call handler (which IS include-aware) is where the
   user's 350K-token scenario manifests, so the fix covers the user's
   reported case. The pre-flight gate is approximate; restoring its
   exact include-awareness would require restructuring `delegateAgent`
   to open the session before the gate, adding a cleanup path on the
   `BudgetExhaustedError` branch (abort + dispose the just-opened
   session). Out of scope for this wave.

3. **`budget-races.test.ts:makeScriptedSession` distributes
   `initialCumulative.tokens` into `tokens.input`** to keep the fake's
   per-dimension shape consistent with the SDK contract (total = input
   + output + cacheRead + cacheWrite). The previous fake reported
   `total=15134` with `input=0, output=0, cacheRead=0, cacheWrite=0`,
   which broke a pre-existing test (T7.7) because the new helper
   returned 0 instead of the included-scope sum. The distribution is
   documented inline; any test that needs a non-input-majority split
   should override `setStats` directly.