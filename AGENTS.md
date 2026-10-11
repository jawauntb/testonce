# Working on testonce

Owner: The Aura Farming Company of New York LLC. These rules apply to every agent and person.

## Ship
- **Auto-merge and auto-deploy, always** (owner's standing instruction, 2026-10-11). Every PR turns
  on auto-merge (squash) when it is opened, and merges as soon as CI is green. If GitHub auto-merge
  is unavailable, the agent that opened the PR merges it itself the moment every check on the head
  commit is green. Never merge red. Never skip, disable or weaken a test or proof to get green.
- Merges to `main` deploy: Railway (project `testonce`, service `testonce`) serves `server/` and
  `site/` at https://testonce-production.up.railway.app, and the GitHub Action (`action.yml`) is
  used from `main`. The free core is mirrored to the public repo `jawauntb/testonce`; paid code
  (`src/addons/`, `src/connectors/`, `src/share.mjs`, `server/`) never leaves this private repo.
- Before pushing: `npm test` (needs strace) and, if `formal/` changed, `cd formal && lake build`.
  `formal/Challenge.lean` is frozen; its sha256 is pinned in CI. Fix the solution, never the challenge.
- **We run our own product.** The `test` job runs the root suite as `testonce each` with the shared
  cache: `share pull` first, `share push` only on a push to `main` (PRs read, only main writes).
  Locally, `npm run test:once` is the same command. Tests that call git are uncacheable by design.
- **The public mirror is `public-manifest.txt`.** It lists exactly the files of the public repo.
  `scripts/public-tree.mjs` holds the one list of paid paths (`PAID`) and the `public-build` check
  builds the manifest's tree and runs `npm test` in it, so a test that only passes with paid files
  present cannot merge. A new free file under `src/` or `test/` must be added to the manifest, or
  `public-build` fails. After a merge to `main`, until an automation token exists, sync by hand:
  `git clone https://github.com/jawauntb/testonce ../testonce-public` (once), then
  `node scripts/sync-public.mjs ../testonce-public`, then branch, commit and open a PR on the public
  repo. The script commits and pushes nothing. The public repo keeps its own `.github/workflows/ci.yml`.

## Claims
- The README's "What is true today" table is the source of truth. The site, `llms.txt`, launch copy
  and messages never claim more than it does. Measured numbers say "one repo, one machine".
- "Verified" means a SafeVerify receipt in `docs/lea/` covers it. Otherwise say "proved in Lean 4".
- Nothing is sold before it is built, tested and merged.

## Soundness
- A wrong skip is the one unforgivable bug. Any change to tracing, inputs or the skip decision
  ships with a test that would have caught the wrong skip, and should be checked with
  `node bench/replay.mjs admissible` (0 false skips required).
