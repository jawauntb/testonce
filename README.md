# testonce

**A test that passed on these exact bytes doesn't need to run again.**

testonce runs each test under `strace` and records every file it touches, including files
read by servers and subprocesses the test starts. It also records the command and the
environment. Next time, if every one of those files is byte-identical, the test is skipped
with its recorded pass. If anything it read has changed, it runs. No build-system rewrite and
no declared inputs: you point it at the test command you already have.

```
$ testonce each tests/*.test.mjs -- node --test {}
testonce: skip tests/admission-live.test.mjs
testonce: pass tests/mcp.test.mjs
...
testonce: 37 files: 21 skipped, 16 ran, 0 failed
```

## What is true today

| Claim | Status |
|---|---|
| Records every file a test reads, lists, probes or executes, across child processes | Implemented, tested (`test/cli.test.mjs`) |
| Skips only when every recorded input is byte-identical (SHA-256), with the same command and env | Implemented, tested |
| A file the test reads and then rewrites makes it uncacheable, never wrongly cached | Implemented, tested |
| Tests that reach the network or run `git`, `curl`, `docker`, `ssh`… always run | Implemented, tested |
| Every 10th would-be skip runs anyway; a failure on unchanged inputs quarantines the test | Implemented, tested |
| `affected` never misses a test whose recorded inputs include a changed path | **Verified** for the bloom model (`formal/Testonce/Bloom.lean`, SafeVerify receipt in `docs/lea/`); index range checked by tests |
| A skipped test would have passed, given the three assumptions below | **Verified** (`formal/Testonce/Skip.lean`, SafeVerify receipt in `docs/lea/`) |
| A pass recorded on one machine skips on another (`share push` / `share pull`, via a branch on your own git remote) | Implemented, tested across two clones (`test/share.test.mjs`) |
| Broken tests get fixed automatically | **No.** `testonce fix` writes a brief of exactly what changed since the last pass and can hand it to your own agent; the agent does the fixing |

The Lean proofs build with no `sorry`. SafeVerify, the checker in VIDA-NYU's Lea
(https://github.com/VIDA-NYU/Lea), replayed every declaration, and every one depends only on
`propext` and `Quot.sound` (`docs/lea/VERIFY_RECEIPT_2026-10-11-testonce.md`; replay with
`docs/lea/replay/replay.sh`). `formal/Challenge.lean` freezes the theorem statements and CI pins
its hash. A proof is about the model. The model matches the code
in `src/bloom.mjs` and `src/inputs.mjs`; that correspondence is reviewed and tested, not
proved.

## When a skip is sound

`skip_sound` holds when:

1. **The trace is complete.** The result depends only on what strace saw. It cannot see the
   clock, random numbers, memory shared with other processes, or a server the test didn't
   start. Those tests are flaky with respect to their inputs. The audit run exists to
   catch them, and quarantines them.
2. **SHA-256 doesn't collide.**
3. **The recorded pass was real.**

When an audit fails on unchanged inputs, at least one of these is false for that test
(`audit_mismatch`). The test then always runs until you `testonce clear` it.

What is traced: every path a test reads, lists, checks for or executes, across child processes,
except `/proc`, `/sys`, `/dev`, `/run`, the cache directory and your `ignore` globs. A path the test
checked and found missing is recorded as missing, even if the test then creates it. The temp
directory is traced like everything else; files a test creates there are its own outputs.

Environment variables: strace cannot see `getenv`, so every variable counts except per-run CI
bookkeeping. Excluded by prefix: `GITHUB_`, `RUNNER_`, `ACTIONS_`, `BUILDKITE_`, `GITLAB_`, `CI_`,
`CIRCLE_`, `BLACKSMITH_`, `TESTONCE_`, `TRAVIS_`, `JENKINS_`, `DRONE_`. Excluded by name:
`_`, `PWD`, `OLDPWD`, `SHLVL`, `HOSTNAME`, `TERM_SESSION_ID`, `INVOCATION_ID`, `JOURNAL_STREAM`,
`SSH_*` session variables, `WINDOWID`, `COLUMNS`, `LINES`, `BUILD_ID`, `BUILD_NUMBER`, `BUILD_URL`,
`BUILD_TAG`. Excluding is the unsafe direction: if a test reads one of these, a change won't rerun
it. Put it in `env.include` to count it again. Add a variable to `env.exclude` when you know it
doesn't matter.

Tests you know depend on the clock or randomness: list their names or globs in `noCache` and they
always run.

To share results between machines whose environments differ (a laptop and CI, or agent
sandboxes with per-session variables), set `"env": {"mode": "allowlist", "include": [...]}`.
Then only the named variables count, plus `PATH`, `LANG`, `LC_ALL`, `TZ`, `NODE_ENV`, `NODE_OPTIONS` and a few others. This
gives up part of assumption 1: an unlisted variable that changes a result won't trigger a rerun,
and only the audit catches it.

## Measured

Outside-checked benchmark (`bench/`): replay real commit history, run every test file under
testonce, then run each one plainly as the oracle. One machine, one run each.

| | admissible (tuning repo) | lattice-animal (held-out) |
|---|---|---|
| Commits replayed, test-file runs | 8, 289 | 10, 400 (40-file subset) |
| Wrong skips (skipped, but the plain run failed) | **0** | **0** |
| Injected breaking edits caught | 3 of 3 | 3 of 3 |
| Skip rate after the first commit | 61% | 81% |
| Wall time after the first commit, testonce vs plain | 267 s vs 564 s | 83 s vs 107 s |

Recording runs cost about 1.4x a plain run. Tests that call `git` always run. On suites of very
short tests the gain is small; it is largest on tests that take seconds. Reproduce with
`node bench/replay.mjs admissible`.

## Use it

```bash
testonce run [--name NAME] [--full] -- <command...>   # run, or skip if it passed on identical inputs
testonce each [-j N] FILE... -- <command with {}>     # one cached run per file, in parallel
testonce affected [--base REF] [PATH...]              # tests whose inputs may include these paths
testonce share pull|push [--remote NAME]              # team cache on a branch of your own git remote
testonce status                                       # what's cached, uncacheable, quarantined
testonce explain NAME                                 # what a test read, and whether it would skip now
testonce clear [NAME]
testonce doctor                                       # can this machine trace and cache? PASS/FAIL per check, with the fix
```

`TESTONCE_FULL=1` runs everything. Without strace (macOS, or a container without
`CAP_SYS_PTRACE`), testonce runs every test normally, caches nothing, and says why once,
pointing at `testonce doctor`.

### Cloud sandboxes: run `testonce doctor` first

```
$ testonce doctor
PASS  platform    linux x64, Node 22.22.0
PASS  strace      strace -- version 6.8
PASS  ptrace      strace traced a child process
PASS  seccomp-bpf --seccomp-bpf works (faster tracing)
PASS  cache dir   /work/repo/.testonce is writable
testonce doctor: caching will work here.
```

It exits 0 if caching will work, 1 if not, and prints the exact fix under each failing check
(`apt-get install -y strace`; `docker run --cap-add SYS_PTRACE`; a writable
`TESTONCE_CACHE_DIR`). `--seccomp-bpf` is optional: it only makes tracing faster, so a
failure there prints `WARN` and does not change the exit code. Where ptrace cannot be enabled,
your tests still run every time. Tested here against a stand-in `strace` and a PATH without
one; not yet run on Codespaces, E2B, Modal or gVisor.

### GitHub Actions

```yaml
- uses: actions/checkout@v4
- uses: jawauntb/testonce@main   # installs strace, restores and saves .testonce/
- run: testonce each tests/*.test.mjs -- node --test {}
```

GitLab, Buildkite, Blacksmith and any other CI: install `strace`, cache the `.testonce/`
directory between jobs, and wrap the test command the same way.

### Shared cache (team plan)

```yaml
permissions: { contents: write }       # CI pushes results to the testonce-cache branch
steps:
  - uses: actions/checkout@v4
  - uses: jawauntb/testonce@main
  - run: testonce share pull
  - run: testonce each tests/*.test.mjs -- node --test {}
  - if: success()
    run: testonce share push
```

On a laptop or in an agent sandbox, run `testonce share pull` before testing. Records live on
the `testonce-cache` branch of your own remote: no testonce server, no account. Whoever
can push to that branch is trusted, so let CI push and everyone else pull.

A record skips only on byte-identical inputs. Inputs outside the repo, such as the `node` binary,
are stored by absolute path, so results travel between machines built from the same image (CI
runners, agent sandboxes) and miss where toolchains differ.

### Config: `testonce.json` (optional)

```json
{
  "auditEvery": 10,
  "ignore": ["**/node_modules/.cache/**", "**/__pycache__/**", "coverage/**"],
  "denyExec": ["git", "curl", "docker"],
  "env": { "exclude": ["MY_BUILD_NUMBER"] },
  "noCache": ["tests/timing-*.test.mjs"],
  "trustStat": true
}
```

`trustStat` reuses a file's hash while its inode, size, mtime and ctime are unchanged, as
git's index does. That took a skip from ~470 ms to ~100 ms. Set it to `false` to hash every byte
every time.

## Pricing

- **CLI: free** for any use. Local caching, `affected`, audits, `each`, `doctor`.
- **Team: $5 per user per month**, $100 per user per year, or $200 per user lifetime. The shared
  cache: a pass recorded once skips for every teammate, CI job and agent.
- **Add-ons, $20 per user per month each:** Flaky Shield (`flaky`), Smart Shards (`shard`),
  Fail-Fast Order (`order`), Savings Report (`report`), Fix Brief (`fix`). See `docs/addons/`.
- **Everything: $100 per user per month.** Team plus all five add-ons.

All paid features are free for personal, education, non-profit and public open-source projects.
Terms: `COMMERCIAL.md`.

## Prior art

Go's test cache already caches passing results keyed on files opened and env vars read, for Go
only. Bazel, Pants, Nx and Turborepo need inputs declared up front. Datadog Test Impact Analysis,
Launchable and Develocity choose tests by coverage or ML. testonce observes the inputs of any
test command, refuses what it can't observe, and audits itself.

## For AI agents

Coding agents (Claude Code, Codex, Cursor and others) can use testonce directly: copy
`skills/testonce/SKILL.md` into your agent's skills directory (for Claude Code,
`.claude/skills/testonce/SKILL.md`), or point the agent at `https://testonce-production.up.railway.app/llms.txt`.
The short version: `testonce doctor`, then `testonce each <test files> -- <cmd> {}`, and
`testonce affected <edited paths>` to pick tests after an edit.

## Develop

```bash
npm test                  # unit + end-to-end (needs strace)
cd formal && lake build   # Lean 4.34.1, core only
```

## Licence

Source-available, not OSI open source. The CLI is free for any use. The paid features (the
shared cache and the five add-ons) are free for personal, education, non-profit and public
open-source projects, and need a seat per user inside a for-profit organization. See `LICENSE`
and `COMMERCIAL.md` (both drafts, pending owner and counsel confirmation).
