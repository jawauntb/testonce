#!/usr/bin/env bash
# CI (macos-latest, a real Mac with no Docker): doctor, the every-test-runs fallback, and the clear
# "no container runtime" message. Never starts a container. Works with bash 3.2.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -R "$repo/test/fixtures/suite/." "$work/"
cd "$work"
git init -q
t="$repo/bin/testonce.mjs"
nodebin="$(command -v node)"
# A PATH with no docker or podman, so the no-runtime message does not depend on the runner image.
bare="${MAC_FLOW_PATH:-/usr/bin:/bin}"
expect() { if ! grep -qF -- "$1" <<<"$2"; then echo "ASSERT FAILED: $3 (wanted: $1)"; exit 1; fi; }

echo "== doctor prints the two routes"
code=0; out="$(node "$t" doctor 2>&1)" || code=$?
echo "$out"
[ "$code" = 1 ] || { echo "ASSERT FAILED: doctor should exit 1 natively on macOS, got $code"; exit 1; }
expect "(a) Your CI and cloud coding agents run Linux" "$out" "route a"
expect "(b) Locally, run \`testonce each --linux" "$out" "route b"
expect "container" "$out" "container line"

echo "== doctor with no runtime on PATH"
code=0; out="$(PATH="$bare" "$nodebin" "$t" doctor 2>&1)" || code=$?
echo "$out"
expect "no docker or podman on PATH" "$out" "doctor says no runtime"
expect "OrbStack" "$out" "doctor says how to install one"

echo "== each without --linux: notice once, every test runs, exit 0"
out="$(node "$t" each a.test.mjs b.test.mjs -- node --test '{}' 2>&1)"
echo "$out"
expect "2 files: 0 skipped, 2 ran, 0 failed" "$out" "both tests ran"
n="$(grep -cF 'macOS: tracing needs Linux, so every test runs. Use --linux to run them in a Linux container and skip unchanged ones.' <<<"$out" || true)"
[ "$n" = 1 ] || { echo "ASSERT FAILED: macOS notice printed $n times, wanted 1"; exit 1; }
[ ! -d .testonce/tests ] || { echo "ASSERT FAILED: something was cached on macOS"; exit 1; }

echo "== --linux with no runtime: clear message, exit 2, nothing runs"
code=0; out="$(PATH="$bare" "$nodebin" "$t" each --linux a.test.mjs -- "$nodebin" --test '{}' 2>&1)" || code=$?
echo "$out"
[ "$code" = 2 ] || { echo "ASSERT FAILED: wanted exit 2, got $code"; exit 1; }
expect "no container runtime (docker or podman) found on PATH" "$out" "clear message"
echo "mac-flow OK"
