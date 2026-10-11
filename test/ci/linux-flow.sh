#!/usr/bin/env bash
# CI (ubuntu-latest, real Docker): the --linux route end to end on a small fixture suite.
# Run twice (all skipped), edit one source file (only its dependent test reruns), break it (never skipped).
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -R "$repo/test/fixtures/suite/." "$work/"
cd "$work"
git init -q

each() { node "$repo/bin/testonce.mjs" each --linux a.test.mjs b.test.mjs -- node --test '{}' 2>&1; }
expect() { # expect "<text>" "<output>" "<what>"
  if ! grep -qF -- "$1" <<<"$2"; then echo "ASSERT FAILED: $3 (wanted: $1)"; exit 1; fi
}

echo "== run 1: builds the image once, records both tests"
out="$(each)"; echo "$out"
expect "2 files: 0 skipped, 2 ran, 0 failed" "$out" "first run runs both"
[ -d .testonce/tests ] || { echo "ASSERT FAILED: records were not written to .testonce"; exit 1; }

echo "== run 2: nothing changed"
out="$(each)"; echo "$out"
expect "2 files: 2 skipped, 0 ran, 0 failed" "$out" "second run skips both"

echo "== run 3: edit src.mjs, which only a.test.mjs reads"
printf 'export const value = 2;\n' > src.mjs
out="$(each)"; echo "$out"
expect "2 files: 1 skipped, 1 ran, 0 failed" "$out" "one skipped, one ran"
expect "pass a.test.mjs" "$out" "the dependent test reran"
expect "skip b.test.mjs" "$out" "the independent test was skipped"

echo "== run 4: break src.mjs; the dependent test must run and fail, never be skipped"
printf 'export const value = -1;\n' > src.mjs
if out="$(each)"; then echo "$out"; echo "ASSERT FAILED: a broken input was skipped or passed"; exit 1; fi
echo "$out"
expect "FAIL a.test.mjs" "$out" "broken test reported as failed"
expect "skip b.test.mjs" "$out" "independent test still skipped"

echo "== run: --linux with a single command"
node "$repo/bin/testonce.mjs" run --linux --name once -- node -e 0 2>&1
out="$(node "$repo/bin/testonce.mjs" run --linux --name once -- node -e 0 2>&1)"; echo "$out"
expect "skip once" "$out" "run --linux skips on identical inputs"
echo "linux-flow OK"
