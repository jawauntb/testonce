#!/usr/bin/env node
// Outside-checked soundness benchmark for testonce. See bench/README.md.
//   node bench/replay.mjs <subject> [--commits N] [--budget-min M] [--jobs J] [--faults K] [--out DIR] [--tests a,b] [--tag T]
// The oracle is the repo's own test command run plainly. testonce is never consulted for ground truth.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SING = path.resolve(HERE, '../bin/testonce.mjs');
const SUBJECTS = JSON.parse(readFileSync(path.join(HERE, 'subjects.json'), 'utf8'));
const argv = process.argv.slice(2);
const subject = argv[0];
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
if (!SUBJECTS[subject]) { console.error('usage: replay.mjs <' + Object.keys(SUBJECTS).join('|') + '>'); process.exit(2); }
const S = SUBJECTS[subject];
const N = +opt('commits', S.commits);
const BUDGET_MS = +opt('budget-min', 18) * 60000;
const J = +opt('jobs', 4);
const FAULTS = +opt('faults', 3);
const OUT = opt('out', path.join(HERE, 'results'));
const WORK = `/tmp/claude-0/bench/${subject}`;
const REPO = path.join(WORK, 'repo');
const FILE_TIMEOUT_MS = (S.timeoutSec ?? 120) * 1000;
const ONLY = opt('tests', null)?.split(',');
const NAME = subject + (opt('tag', '') ? '-' + opt('tag', '') : '');

// Minimal env: no secrets reach any test, and the env is byte-stable across commits so skips are possible.
// A subject may add fixed variables; a value written "$NAME" is copied from the harness's own environment (a tool path).
const ENV = { PATH: process.env.PATH, HOME: path.join(WORK, 'home'), TMPDIR: path.join(WORK, 'tmp'), LANG: 'C.UTF-8', TESTONCE_CACHE_DIR: path.join(WORK, 'cache'),
  ...Object.fromEntries(Object.entries(S.env ?? {}).map(([k, v]) => [k, v.startsWith('$') ? process.env[v.slice(1)] ?? '' : v])) };
const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const t0 = Date.now();
const log = (m) => console.error(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${subject}: ${m}`);

async function pool(items, j, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(j, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
const cmdFor = (f) => S.cmd.map((c) => (c === '{}' ? f : c.replaceAll('{bench}', HERE)));

function exec(argvv, { capture = false, timeoutMs = FILE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const t = Date.now();
    const c = spawn(argvv[0], argvv.slice(1), { cwd: REPO, env: ENV, stdio: ['ignore', 'ignore', capture ? 'pipe' : 'ignore'] });
    let err = '';
    if (capture) c.stderr.on('data', (d) => { if (err.length < 1e6) err += d; });
    const timer = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
    c.on('exit', (code, sig) => { clearTimeout(timer); resolve({ code: sig ? 137 : code ?? 1, ms: Date.now() - t, err }); });
    c.on('error', () => { clearTimeout(timer); resolve({ code: 127, ms: Date.now() - t, err }); });
  });
}

// The last stderr lines of a failing run (testonce's own lines dropped), kept in the results so a failure can be read later.
const tail = (r) => (r.code === 0 ? undefined : r.err.split('\n').filter((l) => l && !l.startsWith('testonce: ')).slice(-12).join('\n'));

function parseSing(err, name) {
  const lines = err.split('\n').filter((l) => l.startsWith('testonce: '));
  const mine = lines.filter((l) => l.includes(` ${name}:`) || l.includes(` ${name} `));
  const has = (p) => mine.some((l) => l.startsWith(`testonce: ${p} ${name}`));
  const nc = mine.find((l) => l.startsWith(`testonce: not caching ${name}:`));
  let reason = null;
  if (nc) reason = nc.slice(`testonce: not caching ${name}: `.length).replace(/ \(\+\d+ more.*$/, '').replace(/^(input modified by the run): .*/, '$1').replace(/^(network): .*/, '$1');
  return { skipped: has('skip'), audited: has('audit'), cached: has('cached'), reason, reasonDetail: nc ? nc.slice(`testonce: not caching ${name}: `.length, 400) : null, auditMismatch: lines.some((l) => l.includes('AUDIT MISMATCH')) };
}

// A subject variant may carry the testonce.json a user would add (`testonceConfig`); it stays in the scratch clone across resets.
const KEEP = ['-e', 'node_modules', ...(S.testonceConfig ? ['-e', 'testonce.json'] : [])];
const resetTree = () => { git('checkout', '-q', '-f', '--detach', ...(resetTree.sha ? [resetTree.sha] : [])); git('clean', '-fdxq', ...KEEP); };
const cleanUntracked = () => git('clean', '-fdxq', ...KEEP);
const checkout = (sha) => { resetTree.sha = sha; resetTree(); };

// A glob with a wildcard in its directory part (tb/*/test_*.py) is matched over the whole tree; `**/` spans directories.
const globRe = (g) => new RegExp('^' + g.split(/(\*\*\/|\*|\?)/).map((t) => (t === '**/' ? '(?:.*/)?' : t === '*' ? '[^/]*' : t === '?' ? '[^/]' : t.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('') + '$');
const treeMatch = (sha, g) => { const re = globRe(g); return git('ls-tree', '-r', '--name-only', sha).split('\n').filter((f) => re.test(f)).sort(); };
const filesAt = (sha) => {
  if (S.tests) return S.tests.filter((t) => !ONLY || ONLY.includes(t));
  if (/[*?]/.test(path.dirname(S.testGlob))) return treeMatch(sha, S.testGlob);
  const dir = path.dirname(S.testGlob), suffix = path.basename(S.testGlob).replace('*', '');
  return git('ls-tree', '--name-only', sha, dir + '/').split('\n').filter((f) => f.endsWith(suffix)).sort();
};

async function singPass(files) {
  const t = Date.now();
  const rs = await pool(files, J, async (f) => {
    const r = await exec(['node', SING, 'run', '--name', f, '--', ...cmdFor(f)], { capture: true });
    return { file: f, code: r.code, ms: r.ms, ...parseSing(r.err, f), errTail: tail(r) };
  });
  return { wallMs: Date.now() - t, results: rs };
}
async function oraclePass(files) {
  const t = Date.now();
  const rs = await pool(files, J, async (f) => { const r = await exec(cmdFor(f), { capture: true }); return { file: f, code: r.code, ms: r.ms, errTail: tail(r) }; });
  return { wallMs: Date.now() - t, results: rs };
}

// ---- setup ----
rmSync(WORK, { recursive: true, force: true });
for (const d of ['home', 'tmp', 'cache']) mkdirSync(path.join(WORK, d), { recursive: true });
if (S.url) execFileSync('git', ['clone', '--no-checkout', '-q', '--filter=blob:none', S.url, REPO]);
else execFileSync('git', ['clone', '--local', '--no-checkout', '-q', S.repo, REPO]);
if (S.nodeModules) { symlinkSync(path.join(S.repo, 'node_modules'), path.join(REPO, 'node_modules')); writeFileSync(path.join(REPO, '.git/info/exclude'), 'node_modules\n'); }
if (S.testonceConfig) writeFileSync(path.join(REPO, 'testonce.json'), JSON.stringify(S.testonceConfig) + '\n');
const head = git('rev-parse', 'HEAD').trim();
const commits = git('rev-list', '--first-parent', '-n', String(N), head).trim().split('\n').reverse();
log(`${commits.length} commits ${commits[0].slice(0, 7)}..${commits.at(-1).slice(0, 7)}`);

// ---- selection (held-out subject without deps: keep files whose oracle passes at the newest commit) ----
let selection = null;
if (S.select) {
  checkout(commits.at(-1));
  const all = filesAt(commits.at(-1));
  selection = [];
  const saved = FILE_TIMEOUT_MS;
  for (let i = 0; i < all.length && selection.length < S.select.maxFiles; i += 16) {
    const batch = all.slice(i, i + 16);
    const rs = await pool(batch, J, async (f) => ({ f, ...(await exec(cmdFor(f), { timeoutMs: S.select.timeoutSec * 1000 })) }));
    for (const r of rs) if (r.code === 0 && selection.length < S.select.maxFiles) selection.push(r.f);
  }
  log(`selected ${selection.length}/${all.length} files (passing at newest commit, <${S.select.timeoutSec}s)`);
  writeFileSync(path.join(OUT, `selection-${NAME}.json`), JSON.stringify({ subject, newest: commits.at(-1), rule: `first ${S.select.maxFiles} files in name order whose oracle exit is 0 within ${S.select.timeoutSec}s at the newest replayed commit`, files: selection }, null, 1));
}
const listAt = (sha) => { const f = filesAt(sha); return selection ? f.filter((x) => selection.includes(x)) : f; };

// ---- replay ----
const perCommit = [];
const oracleBy = new Map();
const dropped = [];
for (let ci = 0; ci < commits.length; ci++) {
  if (Date.now() - t0 > BUDGET_MS) { dropped.push(...commits.slice(ci)); log(`budget hit: dropping ${commits.length - ci} commits`); break; }
  const sha = commits[ci];
  checkout(sha);
  const files = listAt(sha);
  const sing = await singPass(files);
  resetTree();
  const orc = await oraclePass(files);
  const om = new Map(orc.results.map((r) => [r.file, r]));
  // false-skip check: skipped while the oracle says non-zero. Re-run the oracle once to separate a flaky oracle from a real wrong skip.
  const rows = [];
  for (const s of sing.results) {
    const o = om.get(s.file);
    let confirmed = null;
    if (s.skipped && o.code !== 0) { confirmed = (await exec(cmdFor(s.file))).code !== 0; }
    rows.push({ file: s.file, skipped: s.skipped, audited: s.audited, cached: s.cached, reason: s.reason, reasonDetail: s.reasonDetail, singCode: s.code, singMs: s.ms, oracleCode: o.code, oracleMs: o.ms, singErr: s.errTail, oracleErr: o.errTail, falseSkip: s.skipped && o.code !== 0, falseSkipConfirmed: confirmed, divergent: !s.skipped && s.code !== o.code, auditMismatch: s.auditMismatch });
  }
  oracleBy.set(sha, om);
  const rec = { sha, index: ci, files: files.length, singWallMs: sing.wallMs, oracleWallMs: orc.wallMs, rows };
  perCommit.push(rec);
  writeFileSync(path.join(OUT, `${NAME}.partial.json`), JSON.stringify({ partial: true, commits: perCommit }, null, 1)); // survives a job timeout
  const sk = rows.filter((r) => r.skipped).length;
  log(`commit ${ci + 1}/${commits.length} ${sha.slice(0, 7)}: ${files.length} files, ${sk} skipped, false_skips=${rows.filter((r) => r.falseSkip).length}, sing ${(sing.wallMs / 1000).toFixed(1)}s vs plain ${(orc.wallMs / 1000).toFixed(1)}s`);
}

// ---- fault injection ----
const importers = (sha, files) => {
  const map = new Map();
  for (const f of files) {
    let src = ''; try { src = readFileSync(path.join(REPO, f), 'utf8'); } catch { continue; }
    for (const m of src.matchAll(/(?:from|import|require\()\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      const p = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      if (!/\.(mjs|cjs|js)$/.test(p) || p.startsWith(path.dirname(S.testGlob) + '/')) continue;
      if (!existsSync(path.join(REPO, p))) continue;
      if (git('ls-files', '--', p).trim() !== p) continue;
      (map.get(p) ?? map.set(p, new Set()).get(p)).add(f);
    }
  }
  return map;
};
const faultRecs = [];
const done = perCommit.map((c) => c.sha);
const picks = done.length ? [done.at(-1), done[Math.floor(done.length / 2)], done[Math.max(0, Math.floor(done.length / 4))]].slice(0, FAULTS) : [];
for (const [slot, sha] of picks.entries()) {
  if (Date.now() - t0 > BUDGET_MS + 6 * 60000) { log('fault stage budget hit'); break; }
  checkout(sha);
  const files = listAt(sha);
  const base = oracleBy.get(sha);
  await singPass(files); // warm: the cache holds a pass for exactly this tree
  cleanUntracked();
  // JS subjects: a statically imported module. Subjects with a `fault` rule (RTL): any tracked file matching its glob, in name order.
  const cands = S.fault
    ? treeMatch(sha, S.fault.glob).map((f) => [f, null])
    : [...importers(sha, files).entries()].filter(([, s]) => s.size <= files.length / 2).sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : 1));
  const start = [0, Math.floor(cands.length / 2), cands.length - 1][slot % 3]; // slot 0: most imported, 1: median, 2: least imported
  const order = cands.length ? [...cands.slice(start), ...cands.slice(0, start)] : [];
  const tried = new Set();
  const rec = { sha, attempts: [] };
  for (const [src, imps] of order) {
    if (tried.has(src) || tried.size >= 4) continue;
    tried.add(src);
    const abs = path.join(REPO, src);
    const orig = readFileSync(abs, 'utf8');
    const lines = orig.split('\n');
    const k = lines[0].startsWith('#!') ? 1 : 0;
    lines.splice(k, 0, S.fault ? S.fault.line : "throw new Error('bench');");
    writeFileSync(abs, lines.join('\n'));
    const sing = await singPass(files);
    cleanUntracked();
    const orc = await oraclePass(files);
    git('checkout', '-q', '--', src);
    cleanUntracked();
    const clean = git('status', '--porcelain').split('\n').filter((l) => l && !(S.testonceConfig && l === '?? testonce.json')).join('\n'); // the variant's own config is not a leftover
    const sm = new Map(sing.results.map((r) => [r.file, r]));
    const newlyFailing = orc.results.filter((o) => o.code !== 0 && base.get(o.file)?.code === 0);
    const detected = newlyFailing.filter((o) => { const s = sm.get(o.file); return !s.skipped && s.code !== 0; });
    const missed = newlyFailing.filter((o) => { const s = sm.get(o.file); return s.skipped || s.code === 0; }).map((o) => ({ file: o.file, skipped: sm.get(o.file).skipped, singCode: sm.get(o.file).code }));
    rec.attempts.push({ source: src, directImporters: imps ? imps.size : null, effective: newlyFailing.length > 0, newlyFailing: newlyFailing.length, detected: detected.length, missed, revertedClean: clean === '' });
    log(`fault ${sha.slice(0, 7)} ${src}: oracle newly failing=${newlyFailing.length}, testonce detected=${detected.length}, missed=${missed.length}${clean ? ' REVERT DIRTY' : ''}`);
    if (newlyFailing.length > 0) break;
  }
  faultRecs.push(rec);
  writeFileSync(path.join(OUT, `${NAME}.partial.json`), JSON.stringify({ partial: true, commits: perCommit, faults: faultRecs }, null, 1));
}

// ---- summary ----
const rowsAll = perCommit.flatMap((c) => c.rows.map((r) => ({ ...r, commit: c.index })));
const warm = rowsAll.filter((r) => r.commit > 0);
const sum = (a, f) => a.reduce((x, r) => x + f(r), 0);
const hist = {};
for (const r of rowsAll) if (r.reason) hist[r.reason] = (hist[r.reason] ?? 0) + 1;
const cold = perCommit[0]?.rows ?? [];
const effective = faultRecs.map((f) => f.attempts.find((a) => a.effective)).filter(Boolean);
const summary = {
  subject, split: S.split, head, commits_replayed: perCommit.length, commits_requested: N, commits_dropped: dropped, files_per_commit: perCommit.map((c) => c.files),
  file_runs: rowsAll.length,
  false_skips: rowsAll.filter((r) => r.falseSkip).length,
  false_skips_confirmed: rowsAll.filter((r) => r.falseSkipConfirmed).length,
  skips: rowsAll.filter((r) => r.skipped).length,
  skip_rate_all: rowsAll.length ? +(rowsAll.filter((r) => r.skipped).length / rowsAll.length).toFixed(3) : null,
  skip_rate_after_first_commit: warm.length ? +(warm.filter((r) => r.skipped).length / warm.length).toFixed(3) : null,
  oracle_failing_file_runs: rowsAll.filter((r) => r.oracleCode !== 0).length,
  divergent_nonskipped_runs: rowsAll.filter((r) => r.divergent).length,
  audit_mismatches: rowsAll.filter((r) => r.auditMismatch).length,
  wall_s_testonce_total: +(sum(perCommit, (c) => c.singWallMs) / 1000).toFixed(1),
  wall_s_plain_total: +(sum(perCommit, (c) => c.oracleWallMs) / 1000).toFixed(1),
  wall_s_testonce_after_first: +(sum(perCommit.slice(1), (c) => c.singWallMs) / 1000).toFixed(1),
  wall_s_plain_after_first: +(sum(perCommit.slice(1), (c) => c.oracleWallMs) / 1000).toFixed(1),
  first_run_tracing_overhead: cold.length ? { sing_cpu_s: +(sum(cold, (r) => r.singMs) / 1000).toFixed(1), plain_cpu_s: +(sum(cold, (r) => r.oracleMs) / 1000).toFixed(1), ratio: +(sum(cold, (r) => r.singMs) / Math.max(1, sum(cold, (r) => r.oracleMs))).toFixed(2), wall_ratio: +(perCommit[0].singWallMs / Math.max(1, perCommit[0].oracleWallMs)).toFixed(2) } : null,
  uncacheable_reasons: hist,
  fault_injection: { slots: faultRecs.length, effective_faults: effective.length, newly_failing_tests: sum(effective, (a) => a.newlyFailing), detected_tests: sum(effective, (a) => a.detected), faults_fully_detected: effective.filter((a) => a.missed.length === 0).length, detection_rate_by_fault: effective.length ? +(effective.filter((a) => a.missed.length === 0).length / effective.length).toFixed(3) : null, detection_rate_by_test: sum(effective, (a) => a.newlyFailing) ? +(sum(effective, (a) => a.detected) / sum(effective, (a) => a.newlyFailing)).toFixed(3) : null, reverts_clean: faultRecs.every((f) => f.attempts.every((a) => a.revertedClean)) },
  total_runtime_s: +((Date.now() - t0) / 1000).toFixed(0),
  testonce_git_head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(HERE, '..'), encoding: 'utf8' }).trim(),
};
writeFileSync(path.join(OUT, `${NAME}.json`), JSON.stringify({ summary, faults: faultRecs, commits: perCommit }, null, 1));
console.log(JSON.stringify(summary, null, 1));
process.exit(summary.false_skips > 0 ? 1 : 0);
