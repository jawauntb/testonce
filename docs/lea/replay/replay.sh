#!/usr/bin/env bash
# SafeVerify replay of formal/Testonce/*.lean (the method of admissible's docs/lea/replay/replay.sh).
#
#   bash docs/lea/replay/replay.sh [WORK_DIR]
#
# 1. Copies formal/ into WORK_DIR and pins it to SafeVerify's toolchain (Lean 4.29.0); the repo stays on 4.34.1.
# 2. Applies scratch-4.29.sed if it exists (proof-body edits for drifted core lemma names), prints the diff,
#    and stops unless every theorem statement (text up to its first `:=`) is unchanged.
# 3. Builds the scratch package, writes a sorry-target per file with Lea's own splitter
#    (lea/safeverify.py::sorry_target, unchanged), compiles it at the submission's module path.
# 4. Runs `safe_verify -v target submission --disallow-partial -s report.json` per file and prints one row
#    per theorem. Verified = SafeVerify passed AND axioms within {propext, Quot.sound}.
# Needs Lea at $LEA (default ~/.local/src/Lea) with SafeVerify built. No model key is needed.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
LEA="${LEA:-$HOME/.local/src/Lea}"
SV="$LEA/apps/lea-standalone/prover/third_party/SafeVerify"
SV_BIN="$SV/.lake/build/bin/safe_verify"
WORK="${1:-$(mktemp -d)}"
FILES=(Bloom Skip)
export PATH="$HOME/.elan/bin:$PATH"
[ -x "$SV_BIN" ] || { echo "replay: $SV_BIN not built" >&2; exit 2; }
TOOLCHAIN="$(tr -d '[:space:]' < "$SV/lean-toolchain")"

rm -rf "$WORK/formal" "$WORK/targets" "$WORK/oleans" "$WORK/reports"; mkdir -p "$WORK"
cp -r "$ROOT/formal" "$WORK/formal"; rm -rf "$WORK/formal/.lake"
echo "$TOOLCHAIN" > "$WORK/formal/lean-toolchain"; echo "$TOOLCHAIN" > "$WORK/lean-toolchain"
cd "$WORK"
echo "replay: repo pin $(tr -d '[:space:]' < "$ROOT/formal/lean-toolchain"); scratch and SafeVerify pin $TOOLCHAIN"
echo "replay: $(lean --version)"
echo "replay: SafeVerify $SV_BIN (Lea $(git -C "$LEA" rev-parse --short HEAD 2>/dev/null || echo unknown))"

echo "== scratch-only edits"
[ -f "$HERE/scratch-4.29.sed" ] && sed -i -f "$HERE/scratch-4.29.sed" formal/Testonce/*.lean
diff -ru "$ROOT/formal/Testonce" formal/Testonce | sed -e "s#$ROOT/##" -e "s#$WORK/##"
ROOT="$ROOT" python3 - <<'PY' || exit 3
import os, pathlib, re
head = lambda p: [re.sub(r"\s+", " ", m.group(0)) for m in re.finditer(r"(?ms)^(?:theorem|lemma)\b.*?:=", p.read_text())]
bad = n = 0
for f in sorted(pathlib.Path(os.environ["ROOT"], "formal/Testonce").glob("*.lean")):
    a, b = head(f), head(pathlib.Path("formal/Testonce") / f.name)
    n += len(a); bad += a != b
print(f"theorem statements unchanged in scratch: {n if not bad else 'NO'} ({n} checked)")
raise SystemExit(1 if bad else 0)
PY

echo "== lake build (scratch, $TOOLCHAIN)"
(cd formal && lake build 2>&1 | grep -E "error|Build completed|build failed")
[ -f formal/.lake/build/lib/lean/Testonce/Skip.olean ] || { echo "replay: scratch build failed" >&2; exit 4; }

echo "== sorry-targets (Lea's splitter, unchanged) and safe_verify"
export LEAN_PATH="$WORK/formal/.lake/build/lib/lean"
LEA="$LEA" python3 - "${FILES[@]}" <<'PY'
import importlib.util, os, pathlib, sys, types
P = pathlib.Path(os.environ["LEA"]) / "apps/lea-standalone/prover"
def load(n, p):
    s = importlib.util.spec_from_file_location(n, p); m = importlib.util.module_from_spec(s); sys.modules[n] = m; s.loader.exec_module(m); return m
sys.modules.setdefault("lea", types.ModuleType("lea")); load("lea.imports", P / "lea/imports.py"); sv = load("lea.safeverify", P / "lea/safeverify.py")
for f in sys.argv[1:]:
    out = pathlib.Path("targets/Testonce") / f"{f}.lean"; out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(sv.sorry_target((pathlib.Path("formal/Testonce") / f"{f}.lean").read_text()))
PY
mkdir -p oleans reports
rc=0
for f in "${FILES[@]}"; do
  if ! lean --root=targets -o "oleans/${f}_target.olean" "targets/Testonce/$f.lean" > "reports/$f.target.log" 2>&1; then
    echo "$f: TARGET DID NOT COMPILE (splitter failure, no verdict on the proofs): $(grep -m1 error "reports/$f.target.log")"; rc=1; continue
  fi
  (cd "$SV" && "$SV_BIN" -v "$WORK/oleans/${f}_target.olean" "$WORK/formal/.lake/build/lib/lean/Testonce/$f.olean" --disallow-partial -s "$WORK/reports/$f.json") > "reports/$f.out" 2>&1
  echo "$f: safe_verify exit $?; $(grep -E 'SafeVerify check (passed|failed)' "reports/$f.out" | head -1)"
done
echo "== verdicts (verified = SafeVerify passed and axioms within {propext, Quot.sound})"
python3 - "${FILES[@]}" <<'PY' || rc=1
import json, pathlib, sys
OK = {"propext", "Quot.sound"}; bad = 0
print("| File | Declaration | Kind | SafeVerify | Axioms | Grade |\n|---|---|---|---|---|---|")
for f in sys.argv[1:]:
    out = pathlib.Path(f"reports/{f}.out"); rep = pathlib.Path(f"reports/{f}.json")
    passed = out.exists() and "SafeVerify check passed" in out.read_text()
    rows = json.loads(rep.read_text()) if rep.exists() else []
    if not rows: bad += 1; print(f"| {f}.lean | (no report) | | not run | | proved-not-verified |")
    for name, o in sorted(rows):
        kind = o["targetInfo"]["constInfo"]["kind"]; ax = (o.get("solutionInfo") or {}).get("axioms")
        ok = passed and not o.get("failureMode") and isinstance(ax, list) and set(ax) <= OK
        bad += not ok
        print(f"| {f}.lean | `{name}` | {kind} | {'passed' if passed else 'failed'} | {', '.join(ax) if ax else 'none'} | {'verified' if ok else 'proved-not-verified'} |")
sys.exit(1 if bad else 0)
PY
exit $(( rc | $? ))
