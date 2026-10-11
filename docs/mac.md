# testonce on a Mac

**Short version.** testonce records which files a test reads with `strace`, and macOS has no `strace`.
On a Mac, `testonce each` and `testonce run` still run every test, but nothing is skipped. You can
get skips in two ways:

1. **In CI and in cloud coding agents.** They run Linux. Add `uses: jawauntb/testonce@main` (see the
   README's Install section). This needs nothing from your Mac.
2. **On your Mac, through a Linux container.** Add `--linux` and testonce runs the same command inside
   a small Linux container, where `strace` works. Unchanged tests are skipped there. The rest of this
   page is about this route.

## Set it up in 3 steps

1. **Install and start a container runtime.** [OrbStack](https://orbstack.dev) or
   [Docker Desktop](https://www.docker.com/products/docker-desktop/) are the simplest. Colima
   (`brew install colima docker && colima start`) and Podman also work. testonce uses the first of
   `docker` or `podman` it finds on your `PATH`; all of the above provide `docker`.
2. **Check it.** Run `testonce doctor`. On a Mac it prints both routes and says whether a runtime was
   found. It does not check that the runtime is running; testonce says so in step 3 if it is not.
3. **Run your tests with `--linux`.**

   ```
   testonce each --linux tests/*.test.mjs -- node --test {}
   ```

   The first run builds a small image once (about a minute, needs the network): Node of your major
   version, plus `strace`, `git` and CA certificates, tagged `testonce-linux:node22-v1` (the number is
   your Node major). Later runs reuse it. Run the same command again and unchanged tests are skipped.

To make it the default for a repo, put `"linux": true` in `testonce.json`, or `export TESTONCE_LINUX=1`
in your shell. `TESTONCE_LINUX=0` turns it off again. `--linux` works the same on `testonce run`.

If there is no `docker` or `podman`, `--linux` prints one line saying how to install one and exits 2.
It never quietly falls back to running natively.

## What happens inside

- Your repository is mounted into the container at the **same absolute path**, and the working
  directory is the same, so recorded paths and run keys stay stable between runs.
- testonce itself is mounted read-only at its own path and runs `node <install>/bin/testonce.mjs ...`
  with your arguments minus `--linux`. The exit code comes back unchanged.
- `.testonce/` stays in your repository, so results persist from one run to the next.
- The container gets `SYS_PTRACE` and an unconfined seccomp profile, which `strace` needs.
- **The container sees only the environment variables you name.** Those are every `TESTONCE_*`
  variable and the names listed in `env.include` in `testonce.json`. Your shell's other variables are
  not there. A variable that is not passed is missing on every run, so it cannot cause a wrong skip;
  if a test needs one, add it to `env.include` and its value is then part of the skip decision.
- On a Linux host the container runs as your user id, so files it writes are yours.

## Limits

- **Native dependencies.** Addons built on your Mac (`*.node` files in `node_modules` that start with
  Mach-O magic bytes) cannot load in Linux. testonce checks for them first and refuses with a message
  and exit 2. This check prevents false failures, not wrong skips: without it your tests would fail to
  load, not be wrongly skipped. Install dependencies inside a Linux dev container instead, and note that
  they then no longer work natively on the Mac.
- **Container records match only later `--linux` runs on this Mac.** Paths, the Node build, and on Apple
  Silicon the CPU architecture (`arm64` in the container, usually `x64` in CI) all differ from your CI,
  and the platform and architecture are part of every record's key. A record made in the container
  will not skip in CI, and CI's will not skip in the container. That costs a rerun, never a wrong skip.
  `testonce doctor` says this too.
- **First run builds an image**, about a minute, once per Node major version.
- **Speed.** Reading files through the Mac-to-container file share is slower than a Linux disk. Off a
  Linux host, testonce also hashes every input on every skip check instead of trusting file size and
  timestamps (`TESTONCE_TRUST_STAT=0`), because it cannot vouch for how the file share reports them.
  Skips are slower than on Linux but still much faster than running the tests.
- **Tests that need your Mac** (macOS-only APIs, the Keychain, a GUI, services on the host's
  `localhost`) cannot run in the container. Run those without `--linux`.
- **Git worktrees:** run from the worktree's top directory. Git inside the container cannot see the main
  repository's `.git` folder, so it falls back to the current directory as the root.
- Rootless Docker on a Linux host, and Podman, are expected to work but have not been tried.

## Why `--linux` adds no wrong-skip risk

A wrong skip is the one bug this product must not have. `--linux` changes where testonce runs, not how
it decides. Inside the container it is the same code with the same Linux `strace`, so the same
guarantees apply: every file read is traced and hashed (including the `node` binary and libraries in
the image, so a rebuilt image changes the record), the environment is fingerprinted, and the platform
and architecture are part of the key. The new risks are all on the cautious side: a missing runtime
stops the run instead of falling back, and a file share that reports stale timestamps is covered by
re-hashing.

## Why there is no native macOS tracer yet

A skip is only sound when the trace of what a test read is complete: one unseen read can let a changed
file slip past, which is a wrong skip. The ways to observe a process on macOS each have gaps:

- **DYLD interposition** hooks library calls, so it misses programs that make system calls directly,
  statically linked binaries, and anything the system strips the hooks from. Protected system binaries
  (macOS's System Integrity Protection) ignore it, and so do scripts that start through `/bin/sh`.
- **dtrace** needs root and is restricted by System Integrity Protection for protected binaries.
- **Endpoint Security** needs a signed system extension with an Apple entitlement.

`strace` on Linux traces the whole process tree from the kernel, which is what the proofs and the
audit assume. A macOS tracer would need to be shown complete on real Macs first, and that has not
been done. Until it is, the container is the honest route.

## What has been tested, and where

| Piece | Where it runs |
|---|---|
| Flag handling, container arguments, runtime detection, Mach-O check, image tag | Unit tests (`test/linux.test.mjs`), part of `npm test` |
| The whole `--linux` path against a stand-in `docker`: image built once, second run skips, edit reruns only the dependent test, a broken input is never skipped | `test/linux-e2e.test.mjs`, part of `npm test` (Linux, real `strace`) |
| The same flow against real Docker | CI job `linux-container` on ubuntu (`test/ci/linux-flow.sh`); also run once by hand on a Linux machine |
| `doctor`, the every-test-runs fallback and the no-runtime message on a real Mac | CI job `macos` on a `macos-latest` runner, which has no Docker (`test/ci/mac-flow.sh`) |
| `--linux` on a real Mac with OrbStack, Docker Desktop, Colima or Podman | **Not run.** No one has run it on a Mac yet |
