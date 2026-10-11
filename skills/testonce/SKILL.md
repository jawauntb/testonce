---
name: testonce
description: Skip tests that already passed on byte-identical inputs, and find which tests an edit could affect. Use when you are about to run a test suite you (or CI, or another agent) have run before in this repo, after an edit when you want to know which tests to run, or when setting up CI test steps. Requires Linux with strace and ptrace (check with `testonce doctor`).
---

# testonce

Problem: rerunning a whole test suite after every small edit wastes minutes on tests whose
inputs did not change. testonce runs each test under `strace` (a Linux tool that logs every
file a program opens) and records every file the test touches. A test that passed is skipped
while all of those files, the command and the environment are byte-identical. If anything
differs, or testonce cannot tell, the test runs.

## When you are about to run tests

1. `testonce doctor` once per environment. If it fails, run tests normally; testonce will too.
2. If the repo uses the shared cache: `testonce share pull`.
3. Run per file, in parallel, each cached on its own:
   `testonce each tests/*.test.mjs -- node --test {}` (or `pytest {}`, `go test {}`, any command).
4. Read the summary line: `N files: S skipped, R ran, F failed`. A skip is a recorded pass on
   identical inputs, not a guess. Report it as "skipped (unchanged since a recorded pass)", not "passed".

## After an edit

`testonce affected path/you/edited.ts` lists tests whose recorded inputs may include that path.
It never misses a test whose recorded inputs include the path (verified for the bloom-filter
model; a bloom filter is a compact set that can give false alarms but never misses a member),
and it may list extra tests. Run those first.

## When something looks wrong

- `testonce explain NAME`: what the test read and whether it would skip now, with the first
  changed input.
- `testonce status`: cached, uncacheable (with the reason) and quarantined tests. Quarantined
  means a test failed on unchanged inputs, so it always runs until cleared.
- A test that depends on the clock or randomness: add it to `noCache` in `testonce.json`.
- To force everything to run: `TESTONCE_FULL=1`.

## Do not

- Do not claim a skipped test "passed in this run". Say it was skipped on identical inputs.
- Do not push shared records from an untrusted machine; let CI run `testonce share push`.
