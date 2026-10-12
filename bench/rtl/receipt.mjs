#!/usr/bin/env node
// Receipt for one bench/replay.mjs run: what ran, on what, and the hashes that tie the numbers to the raw results.
//   node bench/rtl/receipt.mjs <results.json> <versions.txt> <replay-exit-code> > receipt.json
// Anyone can check a receipt: re-hash the files it names, or rerun the same command on the same commits.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [resultsPath, versionsPath, exitCode] = process.argv.slice(2);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const rel = (p) => path.relative(ROOT, p);

const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
const s = results.summary;
const subj = JSON.parse(readFileSync(path.join(ROOT, 'bench/subjects.json'), 'utf8'))[s.subject];
const ratio = (a, b) => (b > 0 ? +(a / b).toFixed(2) : null);
const env = process.env;

// The baseline a hardware team would actually use instead of "rerun everything": a path filter that skips a commit
// whose changes are all docs (doc/, docs/, *.md, README, LICENSE, images, .gitignore) and reruns every test otherwise.
// It is computed from the replayed commits' diffs and the plain wall times already measured, so it costs no runs.
const DOC = /^(?:docs?\/|.*\.(?:md|png|jpe?g|gif|svg|pdf|txt)$|README|LICENSE|AUTHORS|COPYING|\.gitignore$)/i;
const repo = process.env.REPLAY_REPO ?? `/tmp/claude-0/bench/${s.subject}/repo`;
let pathFilter = null;
try {
  const rows = results.commits.slice(1).map((c, i) => {
    const changed = execFileSync('git', ['-c', 'core.quotePath=false', 'diff', '--name-only', results.commits[i].sha, c.sha], { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean);
    const runs = changed.some((f) => !DOC.test(f));
    return { sha: c.sha, changed_files: changed.length, path_filter_runs: runs, path_filter_wall_s: runs ? +(c.oracleWallMs / 1000).toFixed(1) : 0 };
  });
  const pf = +rows.reduce((x, r) => x + r.path_filter_wall_s, 0).toFixed(1);
  pathFilter = { rule: 'skip a commit whose changed files all match ' + DOC, wall_s_after_first: pf, speedup_of_testonce_over_path_filter: ratio(pf, s.wall_s_testonce_after_first), commits: rows };
} catch (e) { pathFilter = { error: String(e.message).split('\n')[0] }; }

const receipt = {
  kind: 'testonce replay receipt',
  subject: s.subject,
  subject_url: subj.url ?? null,
  subject_head: s.head,
  commits: results.commits.map((c) => ({ sha: c.sha, tests: c.files, skipped: c.rows.filter((r) => r.skipped).length, false_skips: c.rows.filter((r) => r.falseSkip).length, testonce_wall_s: +(c.singWallMs / 1000).toFixed(1), plain_wall_s: +(c.oracleWallMs / 1000).toFixed(1) })),
  headline: {
    false_skips: s.false_skips,
    false_skips_confirmed: s.false_skips_confirmed,
    skip_rate_after_first_commit: s.skip_rate_after_first_commit,
    wall_s_plain_after_first: s.wall_s_plain_after_first,
    wall_s_testonce_after_first: s.wall_s_testonce_after_first,
    speedup_after_first_commit: ratio(s.wall_s_plain_after_first, s.wall_s_testonce_after_first),
    speedup_all_commits: ratio(s.wall_s_plain_total, s.wall_s_testonce_total),
    first_run_tracing_overhead: s.first_run_tracing_overhead,
    fault_injection: s.fault_injection,
    path_filter_baseline: pathFilter,
  },
  how_to_read: 'The oracle is the subject\'s own test command run plainly at every commit. A false skip is a test testonce skipped while the oracle failed. Speedup is plain wall time over testonce wall time on the same machine, same commits, same job count. The first commit is cold (nothing cached) and is excluded from the after-first numbers.',
  replay_exit_code: exitCode === undefined ? null : +exitCode,
  testonce_git_head: s.testonce_git_head,
  sha256: {
    [rel(resultsPath)]: sha(resultsPath),
    [rel(versionsPath)]: sha(versionsPath),
    'bench/replay.mjs': sha(path.join(ROOT, 'bench/replay.mjs')),
    'bench/subjects.json': sha(path.join(ROOT, 'bench/subjects.json')),
    ...Object.fromEntries((subj.cmd ?? []).filter((c) => c.includes('{bench}')).map((c) => c.replaceAll('{bench}', 'bench')).map((p) => [p, sha(path.join(ROOT, p))])),
  },
  tools: readFileSync(versionsPath, 'utf8').trim().split('\n'),
  machine: { nproc: os.availableParallelism(), mem_gb: +(os.totalmem() / 2 ** 30).toFixed(1), kernel: os.release(), runner: env.RUNNER_NAME ?? null, image: env.ImageOS && env.ImageVersion ? `${env.ImageOS} ${env.ImageVersion}` : null },
  run: env.GITHUB_RUN_ID ? { url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`, attempt: env.GITHUB_RUN_ATTEMPT, workflow_sha: env.GITHUB_SHA, job: env.GITHUB_JOB } : null,
  rerun: `node bench/replay.mjs ${s.subject} ${process.env.REPLAY_ARGS ?? ''}`.trim(),
  total_runtime_s: s.total_runtime_s,
  generated_at: new Date().toISOString(),
  git_status_clean: execFileSync('git', ['status', '--porcelain', '--', 'bench', 'src', 'bin'], { cwd: ROOT, encoding: 'utf8' }).trim() === '',
};
console.log(JSON.stringify(receipt, null, 1));
