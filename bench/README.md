# bench: does testonce ever wrongly skip?

An outside-checked benchmark for one property: **testonce must never skip a test that would fail.**
The oracle is the repo's own test command run plainly (`node --test <file>`), with no testonce involved.
Neither the oracle nor the subjects were written for this project, and no policy in `src/` reads an oracle verdict.

## Run it

```bash
node bench/replay.mjs admissible                 # dev subject
node bench/replay.mjs lattice-animal             # held-out subject
# options: --commits N  --budget-min M  --jobs J  --faults K  --out DIR
```

Needs `strace`, Node 22, and the subject repos already on disk (`bench/subjects.json`). It downloads and installs
nothing. Each subject is replayed in a scratch `git clone` under `/tmp/claude-0/bench/<subject>/`, never in the
original checkout. `node_modules` is a symlink to the original's. Tests run with a minimal environment
(`PATH`, a scratch `HOME`, `TMPDIR`, `LANG`, `TESTONCE_CACHE_DIR`), so no secret can reach a test, and the
environment is byte-stable across commits so skips are possible. Exit status is 1 when `false_skips > 0`.

## What it does

For the last N first-parent commits of a subject, oldest first, at each commit:

1. Reset the tree. Run every test file as `testonce run --name <file> -- node --test <file>` (4 at a time) with
   one persistent `TESTONCE_CACHE_DIR` per subject. Record skipped or ran, exit code, time, and the uncacheable
   reason testonce prints.
2. Reset the tree again. **Oracle:** run every test file plainly and record its exit code.
3. A **false skip** is a test testonce skipped whose oracle exit code at that commit is non-zero. Each one is
   re-run once through the oracle; `false_skips_confirmed` counts those that fail twice (the rest are a flaky oracle,
   which is reported, not hidden). The headline number is the unconfirmed count, so a flaky oracle can only make
   the benchmark stricter.

**Fault injection.** At 3 of the replayed commits (newest, middle, a quarter in), the cache is warmed on the clean tree. A
source file that tests import is picked by a fixed rule (static scan of relative imports, files imported by at most
half the tests, sorted by importer count, tried at rank 1, the median, then the last), `throw new Error('bench');` is
prepended (after any shebang), testonce is run on every test, the oracle is run on every test, and the file is
reverted (`git status` must be clean). A fault is *effective* if the oracle shows at least one test that passed at
that commit now failing. **Detected** means testonce reran that test and it failed. Inert faults are logged and
the next candidate is tried. `detection_rate_by_test` is detected over newly failing tests; `detection_rate_by_fault`
requires every newly failing test to be detected.

## Metrics (per subject, `results/<subject>.json`, summary also printed)

| Field | Meaning |
|---|---|
| `false_skips` | skipped and oracle non-zero. **Must be 0.** Any value above 0 is a soundness bug: the per-file rows hold the commit, file and both exit codes. |
| `skip_rate_all`, `skip_rate_after_first_commit` | skipped / file-runs. The first commit is cold by construction. |
| `wall_s_testonce_*` vs `wall_s_plain_*` | wall time of all files at 4 jobs, with and without testonce, summed over commits. |
| `first_run_tracing_overhead` | on the cold first commit, summed per-file time under testonce vs plain, and the wall ratio. |
| `uncacheable_reasons` | histogram of the first reason testonce prints for a test it ran and did not cache. |
| `divergent_nonskipped_runs` | tests testonce ran whose exit code differs from the oracle (harness noise or a flaky test; not a soundness event, since nothing was skipped). |
| `fault_injection` | effective faults, newly failing tests, detected, rates, clean reverts. |

## Dev and held-out

| Subject | Split | Why |
|---|---|---|
| `admissible` | **dev** | Full per-file test suite (`tests/*.test.mjs`) with dependencies installed. Also the repo whose numbers the testonce README quotes. |
| `lattice-animal` | **held-out** | A different codebase, 744 test files, no `node_modules` on disk, so the benchmark uses the first 40 files in name order that pass the oracle at the newest replayed commit (`results/selection-lattice-animal.json`). |

**Rules.** Tune only against `admissible`. Report `lattice-animal` separately, in its own row. Never change
`src/`, `testonce.json` defaults, the audit rate, or this harness's fault rule in response to a held-out result.
If a held-out run exposes a bug, fix it on a general principle, then re-run both subjects, and say in the commit
that the held-out set was consulted (once consulted, a subject stops being held-out for that change and a new
held-out subject should be added). A false skip found anywhere is a bug regardless of split.

## Subjects skipped, and why

| Subject | Reason |
|---|---|
| `research-derived-experiments`, `social-cohesion-vectors` | Python/pytest. Collection errors at HEAD: their dependencies (numpy, pydantic, modal, ...) are not installed, and installing needs the network. |
| `mapvest` | Bun workspace with no `node_modules`. |
| `objetdart_proj` | Next.js app with no `node_modules`; its test script chains hundreds of `npm run` steps. |
| `brainweight`, `agentwire` | No per-file test command (assay scripts, or no tests). |

## What this does not show

- Two subjects, one machine, 8 to 10 commits each. Absence of a false skip in this sample is evidence, not proof;
  the proof in `formal/` covers the model, under its three assumptions.
- The oracle is exit status of one run per file. A test whose pass depends on the clock or randomness can pass the
  oracle and still be wrongly skipped later; the re-run of the oracle catches only some of these.
- Fault injection is a single kind of edit (a throw at the top of an imported file). It does not cover changes to
  data files, configuration, the environment, or a dependency's version.
- Timing is from a shared 4-core container, one sample.

## Results (testonce at `27d7c80` / `f2e7602`, 2026-10-11)

| | admissible (dev) | lattice-animal (held-out) |
|---|---|---|
| Commits x files | 8 x 35-37 = 289 file-runs | 10 x 40 = 400 file-runs |
| **False skips** (skipped, oracle non-zero) | **2 raw, 0 confirmed** (see below) | **0** |
| Skip rate (all / after the cold first commit) | 54.3% / 61.8% | 75.5% / 83.9% |
| Wall, testonce vs plain (all commits, 4 jobs) | 165 s vs 345 s (loaded machine) | 45 s vs 35 s |
| Wall after the cold first commit | 118 s vs 313 s | 36 s vs 29 s |
| First-run tracing overhead (per-file time, wall) | 1.42x, 1.46x | 1.52x, 1.53x |
| Uncacheable reasons | `runs outside tool: git` x16 | `runs outside tool: git` x20 |
| Fault detection (effective faults / newly failing tests detected) | 3/3 faults, 34/34 tests | 3/3 faults, 4/4 tests |
| Audit mismatches | 0 | 0 |

A quiet-machine run of `admissible` made earlier with the same harness (all three faults landed on `server.js`; the
rule was then changed to rotate the choice, which is why the table above has three different files) measured:
0 false skips, skip rate 54.7%, 128.6 s vs 264.0 s wall, 1.50x tracing overhead, 13/13 tests detected at each fault.

### The two raw false skips: one flaky test, not a logic error

Both are `tests/monitor-agent.test.mjs` (commits 7 and 8 of 8). The test asserts that each policy "completes in under
5 s" (`Date.now()` deltas), and another process was compiling Lean on the same 4 cores during this run. At that file's
inputs, testonce skipped on a recorded pass; the plain oracle failed once, and passed on the immediate re-run
(`falseSkipConfirmed: false`). The same test also failed under the oracle at commits 5 and 6 (testonce itself ran it there: it failed at commit 5 and passed at commit 6). So the
oracle disagreed with itself: this is README assumption 1 (the trace cannot see the clock), not a wrong skip on
changed bytes. It is still the exact failure mode that matters to a user, so it stays in the headline count rather than
being filtered out. Two honest readings: testonce cannot know a test asserts on wall-clock time; the audit run
(every 10th skip) is the designed catch and did not fire here because only 2 skips of that file occurred.
Whether to add a way to mark or auto-detect clock-dependent tests is a product call, not made here.

### Other findings

- **Short tests lose.** On `lattice-animal` (40 tests of about 0.1 s each) testonce was slower than plain even with an 84% skip rate, because each `testonce run` is a Node start plus a state load. The win is on suites with seconds-long tests.
- Only `git` was ever the uncacheable reason in these samples; no network, no input-modified-by-run.
- Timing for `admissible` is contaminated by an unrelated Lean build sharing the machine (plain wall rose from 33 s to 50-57 s per commit mid-run).
- Not run: the full 744-file `lattice-animal` suite (no `node_modules`; 40 passing files were used), any Python subject.
