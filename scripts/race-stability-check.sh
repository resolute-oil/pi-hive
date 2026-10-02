#!/usr/bin/env bash
# 100-consecutive-run stability gate per plan §5 F7
# (`docs/plans/budget-refactor/wave-4-validation.md` line 99).
#
# Runs `tests/budget-races.test.ts` 100 times in a row and fails on any
# non-zero exit. Used to confirm that the race-condition fixes are not
# flaky under repeated execution. The T7.8 real-SDK integration tests
# (`tests/budget-races-integration.test.ts`) are excluded by the brief
# because real SDK timing is non-deterministic; T7.8 is bounded-timing
# only and verified separately.
#
# Run via `just race-stability`.

set -eu
set -o pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

PROGRESS_EVERY=25
TOTAL=100

echo "Race-stability gate: running ${TOTAL} iterations of tests/budget-races.test.ts..."
for i in $(seq 1 "${TOTAL}"); do
  # Invoke node directly so each iteration runs ONLY the races test file;
  # `just test` would also expand the `tests/*.test.ts` glob in addition
  # to any explicit path, doubling the per-iteration cost (~13s vs <1s).
  node --import tsx --import ./tests/register-ts-loader.mjs --test tests/budget-races.test.ts >/dev/null 2>&1 || {
    echo "FAIL on iteration $i"
    exit 1
  }
  if [[ $((i % PROGRESS_EVERY)) -eq 0 ]]; then
    echo "  ok: ${i}/${TOTAL}"
  fi
done
echo "${TOTAL}: all iterations passed"