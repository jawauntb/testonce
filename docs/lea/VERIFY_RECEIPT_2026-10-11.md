# SafeVerify receipt: formal/Singularity (2026-10-11)

Kernel replay of every theorem in `formal/Singularity/{Bloom,Skip}.lean` (singularity `27d7c80`, working tree
clean for `formal/`) with SafeVerify, run through a local Lea install. The method is the one in admissible's
`docs/lea/replay/replay.sh` (receipt 2026-10-05); `docs/lea/replay/replay.sh` here reruns it.

A green `lake build` is not this receipt. The proved grade is the build on the repository pin (below). This
receipt is the verified grade.

**Verified** means SafeVerify passed and every theorem's axioms are a subset of {`propext`, `Quot.sound`}.
`Classical.choice`, `sorryAx`, `Lean.ofReduceBool` / `Lean.ofReduceNat` do not qualify. SafeVerify's own
whitelist also admits `Classical.choice`, so the second condition is checked separately from its `-s` JSON report.

## Result

All 12 authored theorems **passed** SafeVerify and use only axioms within {`propext`, `Quot.sound`}: **verified**.
No declaration failed and none was skipped. SafeVerify also compared every `def` body and every type against the
target (13 target / 15 submission declarations in `Bloom.lean`; 23 / 26 in `Skip.lean`); all matched.

| Declaration | File | SafeVerify | Axioms | Grade |
|---|---|---|---|---|
| `Singularity.Bloom.no_false_negative` | `Bloom.lean` | passed | propext, Quot.sound | verified |
| `Singularity.Bloom.absent_of_query_false` | `Bloom.lean` | passed | propext, Quot.sound | verified |
| `Singularity.Skip.skip_sound` | `Skip.lean` | passed | propext, Quot.sound | verified |
| `Singularity.Skip.audit_mismatch` | `Skip.lean` | passed | propext, Quot.sound | verified |
| `Singularity.Skip.decide_spec` | `Skip.lean` | passed | propext, Quot.sound | verified |
| `Singularity.Skip.decide_empty` | `Skip.lean` | passed | propext | verified |
| helper `Singularity.Bloom.setBit_mono` | `Bloom.lean` | passed | propext | verified |
| helper `Singularity.Bloom.setBit_self` | `Bloom.lean` | passed | propext | verified |
| helper `Singularity.Bloom.setAll_mono` | `Bloom.lean` | passed | propext | verified |
| helper `Singularity.Bloom.setAll_sets` | `Bloom.lean` | passed | propext | verified |
| helper `Singularity.Bloom.build_mono` | `Bloom.lean` | passed | propext | verified |
| helper `Singularity.Bloom.foldl_insert_sets` | `Bloom.lean` | passed | propext | verified |

Definitions (not graded, compared body for body, all matched): `Bloom.{setBit, setAll, insert, build, query}`,
`Skip.{decide, record}`, and the structure `Skip.Entry` with its auto-generated declarations
(`mk`, `inputs`, `result`, `casesOn`, `recOn`, `noConfusion`, `mk.inj`, `mk.injEq`, `mk.sizeOf_spec`, ...), which
SafeVerify also reports and which pass with no axioms (`mk.injEq` uses `propext`).

What "verified" covers: the statements as written in the Lean files, in the model the file docstrings describe.
`skip_sound` holds **given** its hypotheses `deps` (strace trace completeness) and `inj` (fingerprint
injectivity); those are assumptions about strace and SHA-256, not proved here. `no_false_negative` says nothing
about the false-positive rate. The bridge from these models to `src/bloom.mjs`, `src/inputs.mjs` and
`src/cli.mjs` is tested (`test/`), not proved. `decide_empty` is a one-line `simp`; its docstring states what it
does and does not show.

## Environment

| | |
|---|---|
| Repository pin | `leanprover/lean4:v4.34.1` (unchanged). Proved-grade build on the pin, run in a scratch copy: `lake build` "Build completed successfully (5 jobs)", zero `sorry`/`native_decide` in the sources, `#print axioms` for `no_false_negative` and `skip_sound` prints `[propext, Quot.sound]` |
| Scratch build, submission oleans, target oleans | `leanprover/lean4:v4.29.0`: `Lean (version 4.29.0, x86_64-unknown-linux-gnu, commit 98dc76e3c0a9b856c9b98726b713fb04fab16740, Release)` |
| SafeVerify | `safe_verify` built by `./install.sh --target ui` (no `--skip-verify`) from the copy vendored in Lea, `apps/lea-standalone/prover/third_party/SafeVerify`, `lean-toolchain` `leanprover/lean4:v4.29.0`; it prints `Currently running on Lean v4.29.0` |
| Lea | `VIDA-NYU/Lea` at `8fc9a74bb7de07b655105e46fe661eb3473482b2`, cloned to `~/.local/src/Lea` |
| Target splitter | Lea's own `apps/lea-standalone/prover/lea/safeverify.py::sorry_target`, unchanged (no arm-aware variant: every proof opens with `:=` or `:= by`) |
| Both sides | Lean 4.29.0: submission oleans, target oleans, checker |
| Sources (sha256) | `Bloom.lean` 46882dcd..., `Skip.lean` e22843e1... |

What was built for Lea: the full `./install.sh --target ui`, which finished with exit 0. That is uv, the Lean
4.29.0 toolchain, the prover and adapter Python environments, the Lean/Mathlib workspace cache, the UI node
dependencies, and the SafeVerify audit binary with its own Mathlib cache (about 7.4 GB under
`prover/workspace/.lake`). The UI/adapter was **not started** and `/verify` through Lea's HTTP endpoint was not
used (see Cross-check). No model key was configured or read.

## Commands

```bash
git clone https://github.com/VIDA-NYU/Lea ~/.local/src/Lea      # at 8fc9a74
(cd ~/.local/src/Lea && ./install.sh --target ui)
bash docs/lea/replay/replay.sh $WORK
```

The script copies `formal/` to `$WORK/formal`, pins its `lean-toolchain` to SafeVerify's, checks that every
`theorem` header (text up to its first `:=`) is unchanged in the scratch copy ("theorem statements unchanged in
scratch: 12 (12 checked)"), runs `lake build` ("Build completed successfully (5 jobs)"), writes one sorry-target
per file with Lea's splitter, compiles it with `lean --root=targets -o oleans/<File>_target.olean
targets/Singularity/<File>.lean` (same module path as the submission), and runs

```bash
safe_verify -v oleans/<File>_target.olean formal/.lake/build/lib/lean/Singularity/<File>.olean \
  --disallow-partial -s reports/<File>.json      # cwd = SafeVerify's directory, LEAN_PATH = scratch build
```

Both files printed `SafeVerify check passed.` and exited 0. The verdict table is computed from the `-s` JSON
(axioms from `solutionInfo.axioms`), not from the exit code.

## Scratch-only edits

**None.** No proof body or statement was edited: both files built unchanged on Lean 4.29.0, so
`scratch-4.29.sed` does not exist and the script's edit diff is empty. (admissible needed `if_pos`/`if_neg`
for `ite_eq_left`/`ite_eq_right`; singularity does not use them.)

## Negative controls

Run through the same script on scratch copies of `Skip.lean`, with `skip_sound`'s proof changed:

| Submission | Result |
|---|---|
| as on the working tree | all 12 verified |
| proof replaced by `sorry` | `safe_verify` exit 1, "SafeVerify check failed"; `skip_sound`, `audit_mismatch` report `sorryAx`; graded proved-not-verified |
| proof prefixed with `have _h := Classical.em (run w = run w₀)` | SafeVerify passed, but `skip_sound` and `audit_mismatch` use `Classical.choice`; graded proved-not-verified by the axiom rule |

## Cross-check through Lea

**Not run.** The replay used Lea's installed splitter and its vendored SafeVerify binary, not a running Lea
instance's `/verify` endpoint. The verdicts above do not depend on it.

## What this receipt does not cover

- SafeVerify derives the target from the submission, so a weakened statement with a sound proof would pass. The
  statements are pinned only by the scratch check that no `theorem` header changed between the repository copy and
  the scratch copy; singularity has no frozen challenge file or statement manifest.
- The JavaScript implementation. The Lean files are models of it; the bridge is tested, not proved.
- The assumptions (A1) `deps`, (A2) `inj`, (A3) the recorded entry came from a real passing run.
- Definitions are not graded. They are compared, and they matched.
