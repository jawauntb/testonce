# testonce

**Skip the tests that already passed on the same files.**

CI is slow, and coding agents rerun the whole test suite after every small edit, even though most
tests read files that did not change. testonce runs each test under `strace` (a Linux tool that logs
every file a program opens) and records every file the test touches, including files read by servers
and subprocesses the test starts. It also records the command and the environment. Next time, if every
one of those files is byte-identical, the test is skipped with its recorded pass. If anything it read
has changed, or testonce cannot tell, the test runs. There is no build-system rewrite and no list of
inputs to maintain: you point it at the test command you already have.

- **Who it is for:** engineering leads and developers whose test suite takes minutes, and AI coding
  agents that run it repeatedly. Linux only, any test command.
- **Why trust it:** under three stated assumptions (below), the skip rule is proved in Lean 4 (a proof
  checker) for a model of the code and re-checked by an independent verifier, and testonce reruns every 10th
  would-be skip to check itself. Replaying real commit history on a private codebase used while building it, it skipped none of
  the 8 test runs that failed plainly; a second codebase's sample had no failing tests to skip (see [Measured](#measured)).
- **How to start:** one command, `testonce each tests/*.test.mjs -- node --test {}`. In GitHub Actions,
  add `uses: jawauntb/testonce@main` before it (see [Install](#install)).

```
$ testonce each tests/*.test.mjs -- node --test {}
testonce: skip tests/checkout.test.mjs
testonce: pass tests/search.test.mjs
...
testonce: 37 files: 21 skipped, 16 ran, 0 failed
```

(Example output after one source file was edited since the last run. File names are illustrative.)

## What is true today

| Claim | Status |
|---|---|
| Records every file a test reads, lists, probes or executes, across child processes | Implemented, tested (`test/cli.test.mjs`) |
| Skips only when every recorded input is byte-identical (SHA-256), with the same command and env | Implemented, tested |
| A file the test reads, or opens for writing without truncating it, and then rewrites makes it uncacheable, never wrongly cached | Implemented, tested |
| Each test gets its own empty temp directory (`TMPDIR`, `TMP`, `TEMP`), removed when the test ends, so temp files never make a test rerun and never pile up. No temp-dir naming rule or sweeper script is needed | Implemented, tested (`test/cli.test.mjs`, `test/tmp.test.mjs`). A testonce killed with SIGKILL leaves its directory behind; a later run deletes it after 24 h. On by default; `"privateTmp": false` turns it off |
| Tests that reach the network (including a loopback server they did not start) or run `git`, `curl`, `docker`, `ssh`… always run | Implemented, tested |
| Every 10th would-be skip runs anyway; a failure on unchanged inputs quarantines the test | Implemented, tested |
| `affected` (lists the tests an edit might affect) never misses a test whose recorded inputs include a changed path | **Verified** for the bloom model (`formal/Testonce/Bloom.lean`, SafeVerify receipt in `docs/lea/`); index range checked by tests |
| A skipped test would have passed, given the three assumptions below | **Verified** (`formal/Testonce/Skip.lean`, SafeVerify receipt in `docs/lea/`) |
| A pass recorded on one machine skips on another (`share push` / `share pull`, via a branch on your own git remote) | Implemented, tested across two clones (`test/share.test.mjs`) |
| Paid features are delivered by license key: checkout issues a key, and with `TESTONCE_KEY` set the CLI downloads the modules that plan covers on first use | Implemented, tested against a local fake service (`test/unlock.test.mjs`, `server/test/licenses.test.mjs`); not yet exercised with a live Stripe payment |
| On a Mac, `testonce each --linux ...` / `run --linux ...` runs the tests in a Linux container (Docker Desktop, OrbStack, Colima or Podman), where skips work | Implemented. Tested on Linux: units and an end-to-end run against a stand-in `docker` (`test/linux*.test.mjs`), and real Docker in CI (`test/ci/linux-flow.sh`). `doctor`, the every-test-runs fallback and the no-runtime message are run on a macOS CI runner (`test/ci/mac-flow.sh`). **Not run on a real Mac with a real container runtime.** Container records match later `--linux` runs on that Mac only, not CI. See `docs/mac.md` |
| Skips natively on macOS or Windows (without a container) | **No.** Tracing needs Linux strace; natively every test runs. A native macOS tracer is not built because it could not be shown complete without testing on Macs (`docs/mac.md`). The shared cache pays off between Linux machines (CI, Linux dev containers, agent sandboxes) |
| Broken tests get fixed automatically | **No.** `testonce fix` writes a brief of exactly what changed since the last pass and can hand it to your own coding agent; the agent does the fixing |

About the proofs: Lean 4 is a proof checker that verifies a mathematical proof step by step. The
proofs build with no `sorry` (an unfinished step). SafeVerify, the independent checker in VIDA-NYU's Lea
(https://github.com/VIDA-NYU/Lea), replayed every declaration, and every one depends only on two
standard axioms, `propext` and `Quot.sound` (`docs/lea/VERIFY_RECEIPT_2026-10-11-testonce.md`; replay
with `docs/lea/replay/replay.sh`). `formal/Challenge.lean` freezes the theorem statements and CI pins
its hash. A bloom filter is a compact set that can give false alarms but never misses a member; the
`affected` proof is about that model. A proof is about the model, not the code. The model matches the
code in `src/bloom.mjs` and `src/inputs.mjs`; that correspondence is reviewed and tested, not proved.

## When a skip is sound

A skip is sound (the theorem is called `skip_sound`) when three things hold:

1. **The trace is complete.** The result depends only on what strace saw. It cannot see the
   clock, random numbers, memory shared with other processes, or a server the test didn't
   start. Those tests are flaky with respect to their inputs. The audit run exists to
   catch them, and quarantines them.
2. **SHA-256 doesn't collide.**
3. **The recorded pass was real.**

An audit is a would-be skip that runs anyway. When an audit fails on unchanged inputs, at least one of
these is false for that test (`audit_mismatch`). The test is then quarantined: it always runs until you
`testonce clear` it.

What is traced: every path a test reads, lists, checks for or executes, across child processes,
except `/proc`, `/sys`, `/dev`, `/run`, the cache directory, your `ignore` globs and the test's private
temp directory (below). A path the test checked and found missing is recorded as missing, even if the
test then creates it. A regular file the test only checks with `stat` is recorded by its content, like a
read, because tools act on its size and mtime in place of its bytes: Python loads a module's `.pyc` after
only a `stat` of its `.py`, so an edited `.py` must rerun the test. A path reached through a symlink the test created is recorded at the symlink's
target. A test that renames or hard-links a file it did not create is not cached. A write through a
symlink that was already there (`truncate`, or deleting a file inside a linked directory) counts as a
write to the file the link points at, so a test that reads a file and then changes it that way is not
cached. When a test reads a symlink itself (`readlink`, or `lstat` finding a link), where the link points
is recorded, so repointing it reruns the test even if the new target has the same type and bytes. A test
that talks to an abstract unix socket (`@name`, which has no file to hash) counts as using the network
and is not cached. So does one that sends to an outside address with `sendmmsg`, and every address in
the call is checked, not just the first. A connection or datagram to a loopback address counts as using the
network unless the test itself bound that address and port, with the same socket type, before reaching it
(or was refused while its own server was starting), so a dev server, a CI service container or a daemon on
localhost makes the test uncacheable. A file the test opens for writing without truncating it (an append,
`a+`, a SQLite database, `truncate` to a length) keeps its old bytes, so they count as read and the test is
not cached, unless the test first found the path missing. Creating a directory, a link or an `O_EXCL` file
records the path as missing beforehand (a dangling symlink there does not count as missing), and deleting a
file or directory records it as present beforehand. Changing a file's mode or timestamps (`chmod`, `utimes`)
leaves it an input instead of making it an output. A repo or working directory under `/proc`, `/sys`, `/dev`
or `/run` is never cached, because every file in it would be ignored.

**Temp files.** Each test runs with `TMPDIR`, `TMP` and `TEMP` set to a new, empty directory that
testonce creates for that run (`<temp dir>/testonce-XXXXXX/tmp`) and deletes when the test ends: pass,
fail, timeout or Ctrl-C. Because the directory starts empty every time, anything the test finds there it
made itself (its starting content is the same on every run, so assumption 1 still holds), and nothing in
it is an input: listing it, leaving files in it or writing a file there after
reading it never makes a test rerun or uncacheable. The rest of the real temp directory is still traced:
a fixture another process put in `/tmp` and the test reads by path is an input, as before. The three
variables are hashed as the fixed value `<testonce-private-tmp>`. If testonce is killed with SIGKILL, the
directory stays; each later `run` or `each` deletes `testonce-*` directories that hold testonce's marker
file and are more than 24 hours old (checked at most once an hour), and nothing else. One behaviour changes: a test that reads files a
*different* process wrote into `$TMPDIR` beforehand (a global setup step, say) no longer finds them there.
That test fails or reruns; it is never wrongly skipped. Set `"privateTmp": false` in `testonce.json`, or
`TESTONCE_PRIVATE_TMP=0`, to use the shared temp directory as before (then the temp directory is traced
like everything else; files a test creates there are its own outputs).

Environment variables: strace cannot see `getenv`, so every variable counts except per-run CI
bookkeeping. With the private temp directory on, `TMPDIR`, `TMP` and `TEMP` always count, as the fixed
placeholder above, whatever `env` says. Excluded by prefix: `GITHUB_`, `RUNNER_`, `ACTIONS_`, `BUILDKITE_`, `GITLAB_`, `CI_`,
`CIRCLE_`, `BLACKSMITH_`, `TESTONCE_`, `TRAVIS_`, `JENKINS_`, `DRONE_`. Excluded by name:
`_`, `PWD`, `OLDPWD`, `SHLVL`, `HOSTNAME`, `TERM_SESSION_ID`, `INVOCATION_ID`, `JOURNAL_STREAM`,
`SSH_*` session variables, `WINDOWID`, `COLUMNS`, `LINES`, `BUILD_ID`, `BUILD_NUMBER`, `BUILD_URL`,
`BUILD_TAG`, and systemd's per-process `SYSTEMD_EXEC_PID`, `MANAGER_PID`, `MAINPID`, `LISTEN_PID`,
`LISTEN_FDS`, `LISTEN_FDNAMES`, `NOTIFY_SOCKET`, `WATCHDOG_PID`, `WATCHDOG_USEC` (they differ on every
GitHub-hosted runner, so counting them stopped any skip across runners). Excluding is the unsafe direction: if a test reads one of these, a change won't rerun
it. Put it in `env.include` to count it again. Add a variable to `env.exclude` when you know it
doesn't matter.

Tests you know depend on the clock or randomness: list their names or globs in `noCache` and they
always run.

To share results between machines whose environments differ (a laptop and CI, or coding-agent
sandboxes with per-session variables), set `"env": {"mode": "allowlist", "include": [...]}`.
Then only the named variables count, plus `PATH`, `LANG`, `LC_ALL`, `TZ`, `NODE_ENV`, `NODE_OPTIONS` and a few others. This
gives up part of assumption 1: an unlisted variable that changes a result won't trigger a rerun,
and only the audit catches it.

## Measured

Three measurements, each on one machine with one sample per cell, so treat them as examples, not guarantees.

**One suite, timed.** A 37-file Node test suite from one repository, on one 4-core machine. Plain `npm test` uses Node's own runner, which already runs files in parallel; the testonce rows use `-j4`. Plain `-j4` was not timed, so the rows are not a like-for-like comparison:

| | Seconds |
|---|---|
| Plain `npm test` | 34.8 |
| Nothing changed, `testonce each -j4` (4 files at a time) | 6.4 |
| One source file edited, `-j4` (14 files reran, 21 skipped) | 24.4 |
| That edit reverted, `-j4` (identical bytes to an earlier pass) | 6.1 |

The first run records: tracing cost about 1.8x (126 s against 70.6 s plain, both serial). 2 of the 37
files call `git`, so they always run.

**Commit replay, checked against plain runs.** The harness in `bench/` replays real commit history, runs
every test file under testonce, then runs each one plainly as the check. The two codebases are Node
projects. Codebase A was used while building testonce. Codebase B was not tuned against.

| | Codebase A | Codebase B |
|---|---|---|
| Commits replayed, test-file runs | 8, 289 | 10, 400 (a 40-file subset of its 744-file suite) |
| Wrong skips (skipped, but the plain run failed) | **0** of 8 plainly failing runs | 0, but no sampled test failed plainly, so this could not occur |
| Injected breaking edits caught | 3 of 3 | 3 of 3 |
| Skip rate after the first commit | 61% | 81% |
| Wall time after the first commit, testonce vs plain | 267 s vs 564 s | 83 s vs 107 s |

An earlier run of the same harness (`bench/README.md`) had 2 skips of a clock-dependent test on A where the plain run failed once and passed on an immediate rerun: the trace cannot see the clock (assumption 1), so put such tests in `noCache`. In that run B was slower under testonce, 36 s against 29 s after the first commit. Recording runs cost about 1.4x a plain run in the replay. Tests that call `git` always run. On suites of
very short tests the gain is small; it is largest on tests that take seconds. The two codebases are not
public, so you cannot rerun these exact numbers. The harness, its rules and the recorded results are in
[`bench/`](bench/README.md); to measure your own repository, add an entry to `bench/subjects.json` and run
`node bench/replay.mjs <name>`.

**A public codebase, not ours: gbrain.** [garrytan/gbrain](https://github.com/garrytan/gbrain) is a public
TypeScript repository whose tests run under Bun, so anyone can rerun this. We ran it ourselves, at commit
`af7dffc` (2026-10-11), with an earlier build of this code from before the rename from singularity to
testonce. The gbrain authors did not run it or take part, and this implies no endorsement or use by them.

The sample is 237 of gbrain's 3,154 unit-test files: every 8th file of the sorted list, minus 6 that failed
a plain screen, 69 that need Postgres or another database, 82 that took more than 12 s each under load, and
1 flaky file. That skews it toward fast tests, which are the least favourable for skipping gains. Each file
ran as `bun test --timeout=60000 ./<file>`, 4 at a time (`-j4`), on one shared 4-core machine under heavy load
(load average about 10 during the timed runs), one sample per cell:

| | Seconds | Files skipped / ran |
|---|---|---|
| Plain, two samples | 102.6 and 128.3 | n/a |
| First run (records) | 177.8 | 0 / 237 |
| Nothing changed | 45.0 | 210 / 27 |
| One comment appended to `src/core/semver.ts`, which 23 of the recorded tests read | 53.4 | 193 / 44 |
| That edit reverted | 39.7 | 211 / 26 |

Two earlier plain samples, at heavier load, took 206.3 s and 229.0 s. Recording cost about 1.4x to 1.7x a
plain run here. Of the 237 files, 20 are uncacheable and always run: 16 call `git`, 1 calls `docker`, 1 uses a
unix socket (counted as network) and 2 rewrite a file they read.

Replaying gbrain's last 8 commits gave 480 file-level skips and 0 confirmed wrong skips. The plain check ran
only on files testonce skipped, so this does not compare the files that ran. There was 1 raw candidate,
`test/fence-marker-code-context.test.ts`: testonce skipped it on a recorded pass, the plain check failed it once
and passed on an immediate rerun. It asserts that it finishes in under 150 ms, and 16 concurrent plain runs failed
16 of 16. That is the clock case, which assumption 1 already excludes. The audit did not fire.

Limits. Every pull request in gbrain bumps `package.json`, which every test reads, so a version bump reruns
everything: 6 of the 8 replayed commits changed `package.json` or `VERSION`, and only 3 had any skips. We ran
each file separately, which costs more than gbrain's CI (one `bun test` process per shard), so our plain time
is not what their CI pays. We did not run the other 2,917 unit files, its Postgres tests or its serial tests.
The file list and scripts are not yet in `bench/`; the selection rule above is the part to repeat.

## Install

testonce needs Linux, Node.js 18 or newer, and `strace`. **On a Mac** use CI or `--linux` (a Linux container); see [docs/mac.md](docs/mac.md).

**GitHub Actions** (the action installs `strace`, restores and saves the `.testonce/` cache directory,
and puts `testonce` on your PATH):

```yaml
- uses: actions/checkout@v4
- uses: jawauntb/testonce@main
- run: testonce each tests/*.test.mjs -- node --test {}
```

**Anywhere else** (GitLab, Buildkite, Blacksmith, a laptop, a coding-agent sandbox): install `strace`,
link `bin/testonce.mjs` from this repository onto your PATH as `testonce`, cache the `.testonce/`
directory between jobs, and wrap the test command the same way. Run `testonce doctor` first (below).

## Use it

```bash
testonce run [--name NAME] [--full] -- <command...>   # run, or skip if it passed on identical inputs
testonce each [-j N] FILE... -- <command with {}>     # one cached run per file, in parallel
testonce run|each --linux ...                         # same, inside a Linux container (macOS; docs/mac.md)
testonce affected [--base REF] [PATH...]              # tests whose inputs may include these paths
testonce share pull|push [--remote NAME]              # team cache on a branch of your own git remote
testonce status                                       # what's cached, uncacheable, quarantined
testonce explain NAME                                 # what a test read, and whether it would skip now
testonce clear [NAME]
testonce doctor                                       # can this machine trace and cache? PASS/FAIL per check, with the fix
testonce score | publish [--public]                   # time and money saved, level; send counts to the optional leaderboard (docs/gamify.md)
testonce flaky | shard | order | report | fix         # paid add-ons (docs/addons/)
testonce mcp | api                                    # paid Connectors: local MCP server and JSON, for agents and scripts
```

`each` runs the command once per file, replacing `{}` with the file name. Each file is cached on its own.

`TESTONCE_FULL=1` runs everything. Without strace (macOS, or a container without
`CAP_SYS_PTRACE`), testonce runs every test normally, caches nothing, and says why once. On
macOS the notice points at `--linux`; elsewhere at `testonce doctor`.

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
your tests still run every time. Tested against a stand-in `strace` and a PATH without one; not yet
run on Codespaces, E2B, Modal or gVisor.

### Shared cache (Team plan)

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

On a laptop or in a coding-agent sandbox, run `testonce share pull` before testing. Records live on
the `testonce-cache` branch of your own remote: no testonce server, no account. Whoever
can push to that branch is trusted, so let CI push and everyone else pull.

A record skips only on byte-identical inputs. Inputs outside the repo, such as the `node` binary,
are stored by absolute path, so results travel between machines built from the same image (CI
runners, coding-agent sandboxes) and miss where toolchains differ.

### Config: `testonce.json` (optional)

```json
{
  "auditEvery": 10,
  "ignore": ["**/node_modules/.cache/**", "**/__pycache__/**", "coverage/**"],
  "denyExec": ["git", "curl", "docker"],
  "env": { "exclude": ["MY_BUILD_NUMBER"] },
  "noCache": ["tests/timing-*.test.mjs"],
  "privateTmp": true,
  "trustStat": true
}
```

`trustStat` reuses a file's hash while its inode, size, mtime and ctime are unchanged, as
git's index does. That took a skip from ~470 ms to ~100 ms. Set it to `false` to hash every byte
every time.

## Pricing

- **CLI: free** for any use. Local caching, `affected`, audits, `each`, `doctor`.
- **Team: $5 per user per month**, $100 per user per year, or $200 per user lifetime. The shared
  cache: a pass recorded on one machine can skip on teammates' machines, CI jobs and agent
  sandboxes with the same toolchain.
- **Add-ons, $20 per user per month each:** Flaky Shield (`flaky`), Smart Shards (`shard`),
  Fail-Fast Order (`order`), Savings Report (`report`), Fix Brief (`fix`). See `docs/addons/`.
- **Everything: $100 per user per month.** Team plus all five add-ons.
- **Connectors: $49 per month per organization.** The local MCP server (`testonce mcp`; MCP is a
  standard way for agents to call tools) and the JSON API, for agents and scripts.

All paid features are free for personal, education, non-profit and public open-source projects.
Pricing and terms are drafts pending legal review and can change. Terms: `COMMERCIAL.md`.

## Prior art

Go's test cache already caches passing results keyed on files opened and env vars read, for Go
only. Bazel, Pants, Nx and Turborepo need inputs declared up front. Datadog Test Impact Analysis,
Launchable and Develocity choose tests by coverage or machine learning. testonce observes the inputs
of any test command, refuses what it can't observe, and audits itself.

## For AI agents

Coding agents (Claude Code, Codex, Cursor and others) can use testonce directly: copy
`skills/testonce/SKILL.md` into your agent's skills directory (for Claude Code,
`.claude/skills/testonce/SKILL.md`), or point the agent at `https://testonce-production.up.railway.app/llms.txt`.
The short version: `testonce doctor`, then `testonce each <test files> -- <cmd> {}`, and
`testonce affected <edited paths>` to pick tests after an edit. The skill file also tells the agent to
report a skip as "skipped on identical inputs" rather than "passed".

## Develop

```bash
npm test                  # unit + end-to-end (needs strace)
cd formal && lake build   # Lean 4.34.1, core only
```

## Licence

Source-available, not OSI open source. The CLI is free for any use. The paid features (the
shared cache and the five add-ons) are free for personal, education, non-profit and public
open-source projects, and need a seat per user inside a for-profit organization. See `LICENSE`
and `COMMERCIAL.md` (both are drafts, pending legal review).
