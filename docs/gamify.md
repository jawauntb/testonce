# gamify: `testonce score` and `testonce publish`

Two free commands that turn the run history testonce already keeps into a level, a streak, badges, and an honest estimate of the time and money skipping saved. They are part of the CLI, not an add-on: no plan is needed.

Command name: these docs write `testonce`, the name the CLI is being renamed to. Until `package.json` installs a `testonce` binary (today `bin` has only `testonce`), run the same commands as `testonce score` and `testonce publish`.

Status: implemented and unit tested (`test/gamify-levels.test.mjs`, `test/gamify-score.test.mjs`, `test/gamify-publish.test.mjs`, no network). The modules live in `src/gamify/`; they are not wired into `src/cli.mjs` by these files. `publish` has not yet been run against the hosted API in a real GitHub Actions job; the tests use a stub for both the identity-token call and the API, and the request body was checked against the hosted API's own validator (`validateRun` in `server/lib/app.mjs`).

## `testonce score`

```
testonce score [--json] [--price-per-minute USD]
```

```
testonce score

  Level         Ember (level 2 of 7)
                [####----------------] 22%   7 h to Flame (10 h)
  Time saved    ~3h 00m (estimate)
  Money saved   ~$1.08 (estimate: 180.00 min x $0.006/min, GitHub Actions standard Linux 2-core list price)
  Test runs     5 (3 skipped, 2 ran, 1 failed), skip rate 60.0%
  Streak        3 days in a row (best 3)
  Badges        3 of 5

  [x] First skip
  [ ] 100 skips         to earn: skip 100 test runs
  [ ] Unbroken week     to earn: skip at least one test on 7 UTC days in a row
  [x] Zero wrong skips
  [x] Hour back
```

(Sample from synthetic test data, not from a real repository.)

- Reads the cache only. Runs nothing, makes no network call, always exits 0 (2 for bad arguments).
- Text works without color. Color (bold, green) is used only when stdout is a terminal and `NO_COLOR` is unset or empty.
- `--json` prints the same facts as one object: totals, `skipRate`, `savedMs`, `hoursSaved`, `pricePerMinute`, `priceBasis`, `estimatedUsdSaved`, `level` (with `next` and `progress`), `streak`, `longestStreak`, `auditMismatches`, `quarantined`, `badges`, and `estimate: true`.
- `--price-per-minute USD`: dollars per CI minute. Default is `DEFAULT_PRICE_PER_MINUTE` from `src/addons/report.mjs`, $0.006, the GitHub-hosted standard Linux 2-core list price (source and date in that file). Use your own number for larger or self-hosted runners.

### The rules

| Level | Hours saved |
|---|---|
| Spark | under 1 |
| Ember | 1 |
| Flame | 10 |
| Blaze | 50 |
| Star | 100 |
| Nova | 500 |
| Singularity | 1000 |

"Hours saved" is the sum of the capped `savedMs` of skipped runs (see below). Levels compare milliseconds, so 59 minutes 59 seconds is still Spark.

Streak: consecutive UTC days with at least one skipped test, ending today or yesterday (a streak stays alive until a whole UTC day passes without a skip). `longestStreak` is the best run anywhere in the history.

| Badge | Earned when |
|---|---|
| First skip | one test skipped |
| 100 skips | 100 skipped test runs |
| Unbroken week | a run of 7 UTC days in a row, each with a skip (once earned, it stays earned within the history) |
| Zero wrong skips | at least one skip, and no audit mismatch and no quarantine recorded |
| Hour back | 1 hour of test time saved |

### What the numbers are, and are not

- **Estimates.** Money is `minutes saved x price per minute` and is labelled as an estimate, with the price and its source, every time. CI bills job minutes (rounded up per job), and tests run in parallel inside a job, so a real bill moves by a different amount.
- **Time saved is capped, and still an overestimate.** A skip's recorded `savedMs` is the cache entry's duration, stamped after input hashing, so it is longer than the test. `score` and `publish` count each skip at most the duration of the nearest earlier passing real run (the same cap `testonce report` applies, so the two commands agree on the same history). When no earlier real run is left in the 30 kept, the recorded figure is used as is, `skipsUncapped` in `--json` counts those skips, and the text says so. The real run was traced with strace, which is slower than an untraced run (about 1.8x on the one repo measured in the README), so the figure can still be high.
- **A window, not a lifetime.** The cache keeps the last 30 runs per test. Totals, streaks, levels and badges cover that retained history. A test run more than 30 times has its older runs forgotten. `testonce clear` deletes a test's history, including any recorded audit failure.
- **"Zero wrong skips" means none detected.** testonce audits a sample of its skips (every 10th by default); an audit that fails on unchanged inputs quarantines the test. The badge says no such failure is recorded. It does not say every skip was checked. It needs at least one skip, so an empty history earns nothing.
- **No cross-machine view.** The score reads this machine's cache (or the cache you restored in CI). Records pulled with `share pull` bring their history with them.

## `testonce publish`

```
testonce publish [--public] [--api URL] [--dry-run]
```

Posts the summary of this CI run to the hosted API, which keeps a per-repo total, level, streak and badge. It does nothing useful outside GitHub Actions and never fails your CI.

```yaml
permissions:
  id-token: write        # lets the job request a short-lived identity token from GitHub
  contents: read
steps:
  - uses: actions/checkout@v4
  - uses: jawauntb/testonce@main
  - run: testonce each tests/*.test.mjs -- node --test {}
  - if: always()
    run: testonce publish          # add --public to appear on the public leaderboard
```

### What is sent, exactly

One POST to `<api>/v1/runs` with this JSON body and nothing else:

```json
{ "repo": "owner/name", "sha": "<GITHUB_SHA>", "files": 0, "skipped": 0, "ran": 0, "failed": 0, "savedMs": 0, "ranMs": 0, "public": false }
```

`repo` and `sha` come from `GITHUB_REPOSITORY` and `GITHUB_SHA`. The other six are counts and millisecond totals from the run history. `public` is `true` only with `--public`. **Never sent: file paths, test names, environment variables, command lines, code, or file contents.** The body is built field by field from this list (`buildBody` in `src/gamify/publish.mjs`), and `test/gamify-publish.test.mjs` fails if a test name, path, environment value or token appears in it. `--dry-run` prints the exact body without sending anything, and works on your own machine.

The request carries an `Authorization: Bearer` header holding a GitHub Actions OIDC token for audience `testonce`, which tells the server which repository is speaking. The token is requested from GitHub with `GET ${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=testonce` using `ACTIONS_ID_TOKEN_REQUEST_TOKEN`. Neither token is printed or stored. The API URL must be `https` (`http` only for `localhost`), because the identity token travels with the request.

### How a run is counted

- The summary is every history entry recorded since the last publish. The time of the newest entry sent is stored in `<cacheDir>/last-publish` after a successful send, so the next publish sends only newer entries. With no `last-publish` file, all retained history is sent once.
- `skipped` and `ran` count history entries; `files` is `skipped + ran`; `failed` is the ran entries that failed; `savedMs` is the capped time of the skips (same cap as `report`, taken from the whole history even for runs already published); `ranMs` is the time the real runs took.
- The hosted API rejects a single run above 24 h of `savedMs` or 7 days of `ranMs`. A first publish over those limits is capped at them and says so.
- The numbers are the CI's own report. The hosted API does not audit them: any repository with a valid identity token can send any figure up to the per-run limits. A leaderboard or a "saved so far" total built from them is self-reported, not verified.

### When publishing is unavailable

Every case below prints one line to stderr and exits 0, so a missing service cannot turn a green build red:

| Situation | Result |
|---|---|
| Not in GitHub Actions, or the job lacks `permissions: id-token: write` | one-line explanation, nothing sent |
| `GITHUB_REPOSITORY` / `GITHUB_SHA` missing | nothing sent |
| Nothing recorded since the last publish | nothing sent |
| Offline, DNS, connection refused or TLS failure, or no identity token | warning, nothing sent; `last-publish` not advanced, so the next publish includes these runs |
| HTTP error from the API that means a refusal (400, 401, 429, other 4xx and 5xx) | warning with the server's reason; `last-publish` not advanced |
| No answer within 10 s, a dropped connection after the request started, or HTTP 408, 502 or 504 | warning that the API **may or may not** have recorded the run; `last-publish` **is** advanced |

The last row is deliberate. The request had left the machine, so the server may have stored it, and the API has no idempotency key, so resending would count the same run twice. Those runs are not sent again; the cost is that a run the server did not store is missing from the totals. For a leaderboard, an undercount is the safer error. Exit 2 is reserved for bad arguments, including a non-https `--api`.

### API URL

`--api URL`, else `TESTONCE_API`, else the default in `src/gamify/publish.mjs` (`DEFAULT_API`, currently a placeholder the maintainers set when the service is live).

## Limits

- Not yet exercised against the live hosted service or a real Actions job (see Status).
- Exactly-once delivery needs an idempotency key honored by the server (not in `server/` today). Until then `publish` is at-most-once when an answer is lost.
- History is capped at 30 runs per test, so lifetime totals are not available without changing the cache format.
- Streaks and badges use UTC days and the local history only.
