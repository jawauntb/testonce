// End to end: a real repo in a temp dir, real strace.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canTrace } from '../src/trace.mjs';
import { queryKeys } from '../src/cli.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'testonce.mjs');
const skip = !canTrace() && 'strace not available';

function repo(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sing-e2e-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  for (const [f, c] of Object.entries(files)) writeFileSync(path.join(dir, f), c);
  const env = { ...process.env, TESTONCE_FULL: '' };
  const sh = (...args) => {
    const r = spawnSync('node', [BIN, ...args], { cwd: dir, encoding: 'utf8', env });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const write = (f, c) => writeFileSync(path.join(dir, f), c);
  return { dir, sh, write, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const ADD = 'export const add = (a, b) => a + b;\n';
const TEST = "import { add } from './add.mjs';\nif (add(2, 2) !== 4) { console.error('FAIL'); process.exit(1); }\n";

test('pass, skip, break, restore', { skip }, () => {
  const r = repo({ 'add.mjs': ADD, 't.mjs': TEST });
  try {
    assert.match(r.sh('run', '--name', 't', '--', 'node', 't.mjs').err, /cached t/);
    assert.match(r.sh('run', '--name', 't', '--', 'node', 't.mjs').err, /skip t/);
    r.write('add.mjs', 'export const add = (a, b) => a - b;\n');
    const broken = r.sh('run', '--name', 't', '--', 'node', 't.mjs');
    assert.equal(broken.code, 1);
    assert.match(broken.err, /add\.mjs changed/);
    r.write('add.mjs', ADD);
    assert.match(r.sh('run', '--name', 't', '--', 'node', 't.mjs').err, /skip t/, 'identical bytes to a passing run skip again');
    assert.equal(r.sh('affected', 'add.mjs').out.trim(), 't');
    assert.equal(r.sh('affected', 'README.md').out.trim(), '');
  } finally { r.done(); }
});

test('files read by a subprocess the test starts are inputs', { skip }, () => {
  const r = repo({
    'data.txt': 'ok',
    'server.mjs': "import { readFileSync } from 'node:fs'; process.exit(readFileSync(new URL('./data.txt', import.meta.url), 'utf8') === 'ok' ? 0 : 1);\n",
    't.mjs': "import { spawn, spawnSync } from 'node:child_process'; process.exit(spawnSync('node', ['server.mjs']).status);\n",
  });
  try {
    assert.match(r.sh('run', '--name', 's', '--', 'node', 't.mjs').err, /cached s/);
    r.write('data.txt', 'no');
    const out = r.sh('run', '--name', 's', '--', 'node', 't.mjs');
    assert.equal(out.code, 1);
    assert.match(out.err, /data\.txt changed/);
  } finally { r.done(); }
});

test('a changed environment variable reruns the test', { skip }, () => {
  const r = repo({ 't.mjs': 'process.exit(0)\n' });
  try {
    r.sh('run', '--name', 'e', '--', 'node', 't.mjs');
    const env = { ...process.env, SOME_FLAG: 'on' };
    const out = spawnSync('node', [BIN, 'run', '--name', 'e', '--', 'node', 't.mjs'], { cwd: r.dir, encoding: 'utf8', env });
    assert.match(out.stderr, /command or environment changed/);
  } finally { r.done(); }
});

test('outside tools and network are never cached', { skip }, () => {
  const r = repo({});
  try {
    assert.match(r.sh('run', '--name', 'g', '--', 'sh', '-c', 'git status >/dev/null').err, /not caching g: runs outside tool: git/);
    assert.match(r.sh('run', '--name', 'g', '--', 'sh', '-c', 'git status >/dev/null').err, /not caching/);
  } finally { r.done(); }
});

test('an audit that fails on unchanged inputs quarantines the test', { skip: skip || (!existsSync('/dev/shm') && 'no /dev/shm') }, () => {
  // /dev is never traced, so this flag file is an input testonce cannot see: a stand-in for a clock or RNG.
  const flag = `/dev/shm/testonce-flag-${process.pid}`;
  writeFileSync(flag, 'pass');
  const r = repo({
    'testonce.json': '{"auditEvery": 2}',
    't.mjs': `import { readFileSync } from 'node:fs'; process.exit(readFileSync('${flag}', 'utf8') === 'pass' ? 0 : 1);\n`,
  });
  try {
    assert.match(r.sh('run', '--name', 'f', '--', 'node', 't.mjs').err, /cached f/);
    assert.match(r.sh('run', '--name', 'f', '--', 'node', 't.mjs').err, /skip f/);
    writeFileSync(flag, 'fail');
    const audit = r.sh('run', '--name', 'f', '--', 'node', 't.mjs');
    assert.equal(audit.code, 1);
    assert.match(audit.err, /AUDIT MISMATCH f/);
    writeFileSync(flag, 'pass');
    assert.doesNotMatch(r.sh('run', '--name', 'f', '--', 'node', 't.mjs').err, /skip f/, 'quarantined tests always run');
    assert.match(r.sh('status').out, /QUARANTINED\s+f/);
  } finally { r.done(); rmSync(flag, { force: true }); }
});

test('queryKeys covers the path and every ancestor listing', () => {
  assert.deepEqual(queryKeys(['src/a/b.js']).sort(), ['list:.', 'list:src', 'list:src/a', 'src/a/b.js']);
});

test('each runs files in parallel and reports skips and failures', { skip }, () => {
  const r = repo({ 'add.mjs': ADD, 'a.mjs': TEST, 'b.mjs': TEST, 'c.mjs': 'process.exit(1)\n' });
  try {
    const first = r.sh('each', '-j', '3', 'a.mjs', 'b.mjs', 'c.mjs', '--', 'node', '{}');
    assert.equal(first.code, 1);
    assert.match(first.err, /3 files: 0 skipped, 3 ran, 1 failed/);
    const second = r.sh('each', 'a.mjs', 'b.mjs', 'c.mjs', '--', 'node', '{}');
    assert.match(second.err, /3 files: 2 skipped, 1 ran, 1 failed/);
    assert.match(second.err, /FAIL c\.mjs/);
  } finally { r.done(); }
});

test('soundness: each -j 1 decides a skip at the file\'s turn, after an earlier file changed its input', { skip }, () => {
  const r = repo({ 'data.txt': 'original\n', 'a.sh': 'echo changed > data.txt\n', 'b.sh': 'grep -q original data.txt\n' });
  try {
    assert.match(r.sh('each', 'b.sh', '--', 'sh', '{}').err, /1 files: 0 skipped, 1 ran, 0 failed/);
    assert.match(r.sh('each', 'b.sh', '--', 'sh', '{}').err, /1 files: 1 skipped, 0 ran, 0 failed/);
    const out = r.sh('each', '-j', '1', 'a.sh', 'b.sh', '--', 'sh', '{}');
    assert.doesNotMatch(out.err, /skip b\.sh/, 'wrong skip: a.sh changed data.txt before b.sh started');
    assert.equal(out.code, 1, 'b.sh must rerun and fail');
    assert.match(out.err, /FAIL b\.sh/);
  } finally { r.done(); }
});

const recOf = (dir, name) => JSON.parse(readFileSync(path.join(dir, '.testonce', 'tests', createHash('sha256').update(name).digest('hex').slice(0, 32) + '.json'), 'utf8'));

test('a skip in each records the same history, skip count and entries as a skip in run', { skip }, () => {
  const r = repo({ 'add.mjs': ADD, 't.mjs': TEST });
  try {
    assert.match(r.sh('each', 't.mjs', '--', 'node', '{}').err, /0 skipped, 1 ran/);
    const cached = recOf(r.dir, 't.mjs');
    assert.match(r.sh('each', 't.mjs', '--', 'node', '{}').err, /1 skipped, 0 ran/);
    const viaEach = recOf(r.dir, 't.mjs');
    assert.match(r.sh('run', '--name', 't.mjs', '--', 'node', 't.mjs').err, /skip t\.mjs: passed .* on identical inputs/);
    const viaRun = recOf(r.dir, 't.mjs');
    assert.equal(viaEach.skips, 1);
    assert.equal(viaRun.skips, 2);
    assert.deepEqual(viaEach.entries, cached.entries, 'a skip leaves the recorded pass as it was');
    assert.deepEqual(viaRun.entries, cached.entries);
    const [, a, b] = viaRun.history.map(({ at, ...h }) => h);
    assert.equal(viaRun.history.length, 3);
    assert.deepEqual(a, { ok: true, skipped: true, ms: 0, savedMs: cached.entries[0].ms });
    assert.deepEqual(a, b, 'each and run write the same skip row');
    assert.deepEqual(viaEach.history, viaRun.history.slice(0, 2));
    assert.match(r.sh('status').out, /cached\s+t\.mjs .*2 skips/);
  } finally { r.done(); }
});

test('each audits a due skip instead of skipping it, and a failing audit quarantines the file', { skip: skip || (!existsSync('/dev/shm') && 'no /dev/shm') }, () => {
  const flag = `/dev/shm/testonce-each-flag-${process.pid}`;
  writeFileSync(flag, 'pass');
  const r = repo({
    'testonce.json': '{"auditEvery": 2}',
    't.mjs': `import { readFileSync } from 'node:fs'; process.exit(readFileSync('${flag}', 'utf8') === 'pass' ? 0 : 1);\n`,
  });
  const each = () => r.sh('each', 't.mjs', '--', 'node', '{}');
  try {
    assert.match(each().err, /0 skipped, 1 ran, 0 failed/);
    assert.match(each().err, /1 skipped, 0 ran/, 'skip 1');
    assert.match(each().err, /0 skipped, 1 ran, 0 failed/, 'skip 2 is due an audit: it runs');
    assert.equal(recOf(r.dir, 't.mjs').history.at(-1).audit, true);
    assert.match(each().err, /1 skipped, 0 ran/, 'skip 3');
    writeFileSync(flag, 'fail');
    const audit = each();
    assert.equal(audit.code, 1);
    assert.match(audit.err, /0 skipped, 1 ran, 1 failed/);
    assert.match(audit.out, /AUDIT MISMATCH t\.mjs/);
    assert.equal(recOf(r.dir, 't.mjs').entries.length, 0, 'the failing audit removed the pass it contradicted');
    writeFileSync(flag, 'pass');
    assert.match(each().err, /0 skipped, 1 ran, 0 failed/, 'quarantined files always run');
    assert.match(each().err, /0 skipped, 1 ran, 0 failed/);
    const rec = recOf(r.dir, 't.mjs');
    assert.match(rec.quarantined, /audit failed/);
    assert.match(r.sh('status').out, /QUARANTINED\s+t\.mjs/);
  } finally { r.done(); rmSync(flag, { force: true }); }
});

test('each audits a file that has not really run for auditMaxAgeHours', { skip }, () => {
  const r = repo({ 'testonce.json': '{"auditEvery": 0, "auditMaxAgeHours": 0.00001}', 'add.mjs': ADD, 't.mjs': TEST });
  try {
    assert.match(r.sh('each', 't.mjs', '--', 'node', '{}').err, /0 skipped, 1 ran/);
    assert.match(r.sh('each', 't.mjs', '--', 'node', '{}').err, /0 skipped, 1 ran/, 'older than 36 ms: audited, not skipped');
    const rec = recOf(r.dir, 't.mjs');
    assert.equal(rec.history.at(-1).audit, true);
    assert.equal(rec.skips, 1);
  } finally { r.done(); }
});

test('soundness: a test that checks a marker is missing, then creates it, reruns once the marker is back', { skip }, () => {
  // Claim-check repro A: the absent probe must stay an input even though the run created the path.
  const r = repo({ 't.mjs': "import { existsSync, writeFileSync, rmSync } from 'node:fs'; const ok = !existsSync('marker'); writeFileSync('marker', 'x'); rmSync('marker'); process.exit(ok ? 0 : 1);\n" });
  try {
    assert.match(r.sh('run', '--name', 'm', '--', 'node', 't.mjs').err, /cached m/);
    r.write('marker', 'someone else made this');
    const out = r.sh('run', '--name', 'm', '--', 'node', 't.mjs');
    assert.equal(out.code, 1, 'must rerun and fail, not skip');
  } finally { r.done(); }
});

test('soundness: a fixture in the temp dir is an input', { skip }, () => {
  // Claim-check repro B.
  const fixture = path.join(tmpdir(), `sing-fixture-${process.pid}.txt`);
  writeFileSync(fixture, 'ok');
  const r = repo({ 't.mjs': `import { readFileSync } from 'node:fs'; process.exit(readFileSync(${JSON.stringify(fixture)}, 'utf8') === 'ok' ? 0 : 1);\n` });
  try {
    assert.match(r.sh('run', '--name', 'x', '--', 'node', 't.mjs').err, /cached x/);
    writeFileSync(fixture, 'changed');
    assert.equal(r.sh('run', '--name', 'x', '--', 'node', 't.mjs').code, 1, 'changed tmp fixture must rerun');
  } finally { r.done(); rmSync(fixture, { force: true }); }
});

test('noCache tests always run', { skip }, () => {
  const r = repo({ 'testonce.json': '{"noCache": ["slow-clock*"]}', 't.mjs': 'process.exit(0)\n' });
  try {
    r.sh('run', '--name', 'slow-clock-1', '--', 'node', 't.mjs');
    assert.match(r.sh('run', '--name', 'slow-clock-1', '--', 'node', 't.mjs').err, /noCache, always runs/);
  } finally { r.done(); }
});

test('a test with no real run in auditMaxAgeHours is audited even if its inputs are unchanged', { skip }, async () => {
  const r = repo({ 'testonce.json': '{"auditEvery": 0, "auditMaxAgeHours": 24}', 't.mjs': 'process.exit(0)\n' });
  try {
    r.sh('run', '--name', 'old', '--', 'node', 't.mjs');
    assert.match(r.sh('run', '--name', 'old', '--', 'node', 't.mjs').err, /skip old/);
    // Age the record by two days.
    const { load, save } = await import('../src/cache.mjs');
    const cacheDir = path.join(r.dir, '.testonce');
    const rec = load(cacheDir, 'old');
    const twoDaysAgo = new Date(Date.now() - 48 * 3600_000).toISOString();
    rec.entries[0].passedAt = twoDaysAgo;
    rec.history = rec.history.map((h) => ({ ...h, at: twoDaysAgo }));
    save(cacheDir, rec);
    assert.match(r.sh('run', '--name', 'old', '--', 'node', 't.mjs').err, /audit old: .*no real run in 24 h/);
    assert.match(r.sh('run', '--name', 'old', '--', 'node', 't.mjs').err, /skip old/, 'after the audit passes, it skips again');
  } finally { r.done(); }
});

// ---- private temp dir (src/tmp.mjs) ----
// The real temp dir of this harness, where a private dir lives while its test runs.
const realTmp = () => realpathSync(tmpdir());
const PRIVATE = (s) => s.match(/^TMP=(.*)$/m)?.[1];
const withEnv = (r, extra, ...args) => {
  const out = spawnSync('node', [BIN, ...args], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, TESTONCE_FULL: '', ...extra } });
  return { code: out.status, out: out.stdout, err: out.stderr };
};

test('privateTmp: a test that makes, lists and reads files in os.tmpdir() is cached and skips; its dir is removed', { skip }, () => {
  const r = repo({ 't.mjs': `import { tmpdir } from 'node:os'; import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs'; import path from 'node:path';
const t = tmpdir(); console.log('TMP=' + t);
if (readdirSync(t).length) process.exit(3); // starts empty, whatever is lying around in the real temp dir
const d = mkdtempSync(path.join(t, 'x-')); writeFileSync(path.join(d, 'a.txt'), 'hello');
const ok = readFileSync(path.join(d, 'a.txt'), 'utf8') === 'hello' && readdirSync(t).length === 1 && statSync(d).isDirectory();
writeFileSync(path.join(t, 'left-behind'), 'junk'); // never cleaned up by the test
process.exit(ok ? 0 : 1);\n` });
  try {
    const first = r.sh('run', '--name', 'p', '--', 'node', 't.mjs');
    assert.match(first.err, /cached p/, first.err);
    const d = PRIVATE(first.out);
    assert.ok(d.startsWith(realTmp() + '/testonce-'), d);
    assert.ok(!existsSync(path.dirname(d)), 'the private dir is gone after a pass');
    assert.match(r.sh('run', '--name', 'p', '--', 'node', 't.mjs').err, /skip p/, 'temp files are not inputs, so the second run skips');
    assert.match(r.sh('explain', 'p').out, /temp dir: private to each run/);
  } finally { r.done(); }
});

test('privateTmp: the dir is removed when the test fails, and when testonce is stopped by a signal', { skip }, async () => {
  const r = repo({
    'fail.mjs': "import { tmpdir } from 'node:os'; import { writeFileSync } from 'node:fs'; console.log('TMP=' + tmpdir()); writeFileSync(tmpdir() + '/f', 'x'); process.exit(1);\n",
    'hang.mjs': "import { tmpdir } from 'node:os'; import { writeFileSync } from 'node:fs'; writeFileSync(tmpdir() + '/f', 'x'); console.log('TMP=' + tmpdir()); setInterval(() => {}, 1000);\n",
  });
  try {
    const failed = r.sh('run', '--name', 'f', '--', 'node', 'fail.mjs');
    assert.equal(failed.code, 1);
    assert.ok(!existsSync(path.dirname(PRIVATE(failed.out))), 'gone after a failure');
    // A CI step timeout: SIGTERM to testonce once the test is running. It stops the test, removes the dir, records nothing.
    const { spawn } = await import('node:child_process');
    const c = spawn('node', [BIN, 'run', '--name', 'h', '--', 'node', 'hang.mjs'], { cwd: r.dir, env: { ...process.env, TESTONCE_FULL: '' } });
    let out = '';
    const d = await new Promise((resolve) => c.stdout.on('data', (b) => { out += b; if (out.includes('\n')) resolve(PRIVATE(out)); }));
    assert.ok(existsSync(d), 'the dir exists while the test runs');
    c.kill('SIGTERM');
    const code = await new Promise((resolve) => c.on('exit', (x) => resolve(x)));
    assert.equal(code, 128 + 15);
    assert.ok(!existsSync(path.dirname(d)), 'gone after SIGTERM');
    assert.doesNotMatch(r.sh('status').out, /cached\s+h/);
  } finally { r.done(); }
});

test('soundness, privateTmp on: a fixture the harness wrote in the real temp dir is still an input', { skip }, () => {
  // Hole B stays closed: only the run's own private dir is left out, not the temp dir it lives in.
  const fixture = path.join(realTmp(), `sing-fixture-priv-${process.pid}.txt`);
  writeFileSync(fixture, 'ok');
  const r = repo({ 't.mjs': `import { readFileSync } from 'node:fs'; import { tmpdir } from 'node:os';
if (!tmpdir().startsWith(${JSON.stringify(realTmp() + '/testonce-')})) process.exit(2);
process.exit(readFileSync(${JSON.stringify(fixture)}, 'utf8') === 'ok' ? 0 : 1);\n` });
  try {
    assert.match(r.sh('run', '--name', 'x', '--', 'node', 't.mjs').err, /cached x/);
    assert.match(r.sh('run', '--name', 'x', '--', 'node', 't.mjs').err, /skip x/);
    writeFileSync(fixture, 'changed');
    const out = r.sh('run', '--name', 'x', '--', 'node', 't.mjs');
    assert.equal(out.code, 1, 'changed fixture in the real temp dir must rerun and fail');
    assert.match(out.err, /sing-fixture-priv-.*changed/);
  } finally { r.done(); rmSync(fixture, { force: true }); }
});

test('privateTmp: different junk in the real temp dir between runs does not stop a test that lists os.tmpdir() from skipping', { skip }, () => {
  const junk = (n) => path.join(realTmp(), `sing-junk-${process.pid}-${n}`);
  const r = repo({ 't.mjs': "import { tmpdir } from 'node:os'; import { readdirSync } from 'node:fs'; process.exit(readdirSync(tmpdir()).length === 0 ? 0 : 1);\n" });
  try {
    writeFileSync(junk(1), 'a');
    assert.match(r.sh('run', '--name', 'l', '--', 'node', 't.mjs').err, /cached l/);
    rmSync(junk(1)); writeFileSync(junk(2), 'b');
    assert.match(r.sh('run', '--name', 'l', '--', 'node', 't.mjs').err, /skip l/);
  } finally { r.done(); rmSync(junk(1), { force: true }); rmSync(junk(2), { force: true }); }
});

test('soundness, privateTmp on: a variable other than TMPDIR, TMP, TEMP still reruns the test; those three do not', { skip }, () => {
  const r = repo({ 't.mjs': "process.exit(process.env.MODE === 'a' ? 0 : 1);\n" });
  const other = mkdtempSync(path.join(tmpdir(), 'sing-othertmp-'));
  try {
    assert.match(withEnv(r, { MODE: 'a' }, 'run', '--name', 'v', '--', 'node', 't.mjs').err, /cached v/);
    // The parent's TMPDIR only says where the private dir is made; the test never sees it.
    assert.match(withEnv(r, { MODE: 'a', TMPDIR: other, TMP: other, TEMP: other }, 'run', '--name', 'v', '--', 'node', 't.mjs').err, /skip v/);
    const changed = withEnv(r, { MODE: 'b' }, 'run', '--name', 'v', '--', 'node', 't.mjs');
    assert.equal(changed.code, 1, 'MODE changed: must rerun and fail, not skip');
    assert.match(changed.err, /command or environment changed/);
  } finally { r.done(); rmSync(other, { recursive: true, force: true }); }
});

test('privateTmp false (config or TESTONCE_PRIVATE_TMP=0) restores the shared temp dir exactly', { skip }, () => {
  const fixture = path.join(tmpdir(), `sing-fixture-off-${process.pid}.txt`);
  const junk = path.join(tmpdir(), `sing-junk-off-${process.pid}`);
  writeFileSync(fixture, 'ok');
  const t = `import { readFileSync, readdirSync } from 'node:fs'; import { tmpdir } from 'node:os';
if (tmpdir() !== ${JSON.stringify(tmpdir())}) process.exit(2);
readdirSync(tmpdir());
process.exit(readFileSync(${JSON.stringify(fixture)}, 'utf8') === 'ok' ? 0 : 1);\n`;
  const r = repo({ 'testonce.json': '{"privateTmp": false}', 't.mjs': t });
  const e = repo({ 't.mjs': t });
  try {
    for (const [x, extra] of [[r, {}], [e, { TESTONCE_PRIVATE_TMP: '0' }]]) {
      writeFileSync(fixture, 'ok');
      assert.match(withEnv(x, extra, 'run', '--name', 'o', '--', 'node', 't.mjs').err, /cached o/);
      writeFileSync(junk, 'new entry in the shared temp dir');
      assert.match(withEnv(x, extra, 'run', '--name', 'o', '--', 'node', 't.mjs').err, /run o: list:.*changed|run o: .* changed/, 'the shared temp dir listing is an input, as before');
      rmSync(junk);
      writeFileSync(fixture, 'changed');
      assert.equal(withEnv(x, extra, 'run', '--name', 'o', '--', 'node', 't.mjs').code, 1);
      assert.doesNotMatch(withEnv(x, extra, 'explain', 'o').out, /temp dir: private/);
    }
  } finally { r.done(); e.done(); rmSync(fixture, { force: true }); rmSync(junk, { force: true }); }
});

test('soundness, privateTmp on: a symlink the test makes in its temp dir does not hide what it points at', { skip }, () => {
  // A temp project with a link back into the repo, read and probed through the link, then deleted.
  const r = repo({ 't.mjs': `import { tmpdir } from 'node:os'; import { mkdirSync, symlinkSync, readFileSync, existsSync, rmSync } from 'node:fs'; import path from 'node:path';
const proj = path.join(tmpdir(), 'proj'); mkdirSync(proj);
symlinkSync(path.resolve('fixtures'), path.join(proj, 'data'));
symlinkSync(path.resolve('fixtures/sub'), path.join(proj, 'deep'));
const content = readFileSync(path.join(proj, 'data', 'x.txt'), 'utf8');
const flag = existsSync(path.join(proj, 'data', 'flag'));
const up = existsSync(proj + '/deep/../marker'); // the kernel climbs from the link's target: fixtures/marker
rmSync(proj, { recursive: true });
process.exit(content === 'ok' && !flag && !up ? 0 : 1);\n` });
  try {
    mkdirSync(path.join(r.dir, 'fixtures/sub'), { recursive: true });
    r.write('fixtures/x.txt', 'ok');
    assert.match(r.sh('run', '--name', 's', '--', 'node', 't.mjs').err, /cached s/);
    assert.match(r.sh('run', '--name', 's', '--', 'node', 't.mjs').err, /skip s/);
    r.write('fixtures/x.txt', 'changed');
    assert.equal(r.sh('run', '--name', 's', '--', 'node', 't.mjs').code, 1, 'content read through the link changed: must rerun');
    r.write('fixtures/x.txt', 'ok');
    assert.match(r.sh('run', '--name', 's', '--', 'node', 't.mjs').err, /skip s/);
    r.write('fixtures/flag', '');
    assert.equal(r.sh('run', '--name', 's', '--', 'node', 't.mjs').code, 1, 'a path probed missing through the link appeared: must rerun');
    rmSync(path.join(r.dir, 'fixtures/flag'));
    assert.match(r.sh('run', '--name', 's', '--', 'node', 't.mjs').err, /skip s/);
    r.write('fixtures/marker', '');
    assert.equal(r.sh('run', '--name', 's', '--', 'node', 't.mjs').code, 1, 'a path reached by .. after the link appeared: must rerun');
  } finally { r.done(); }
});

test('soundness: a file the test only stats (size, mtime) is an input by content', { skip }, () => {
  const r = repo({ 'data.txt': 'short', 'meta.mjs': "import { statSync } from 'node:fs'; process.exit(statSync('data.txt').size < 10 ? 0 : 1);\n" });
  try {
    assert.match(r.sh('run', '--name', 'meta', '--', 'node', 'meta.mjs').err, /cached meta/);
    assert.match(r.sh('run', '--name', 'meta', '--', 'node', 'meta.mjs').err, /skip meta/);
    r.write('data.txt', 'much longer than ten bytes');
    const after = r.sh('run', '--name', 'meta', '--', 'node', 'meta.mjs');
    assert.equal(after.code, 1, 'a stat-only file changed: the test must rerun (and fail), not skip');
    assert.match(after.err, /data\.txt changed/);
  } finally { r.done(); }
});

const python = spawnSync('python3', ['-c', 'pass']).status === 0;
test('soundness: a Python module loaded from a valid .pyc reruns its test when the .py changes', { skip: skip || (!python && 'python3 not available') }, () => {
  // Python loads __pycache__/mod.*.pyc after only a stat of mod.py; the edit is seen through mod.py's content.
  const r = repo({ 'mod.py': 'X = 1\n', 't.py': 'import sys, mod\nsys.exit(0 if mod.X == 1 else 1)\n' });
  const env = { ...process.env, TESTONCE_FULL: '' };
  delete env.PYTHONDONTWRITEBYTECODE; delete env.PYTHONPYCACHEPREFIX;
  const py = () => spawnSync('node', [BIN, 'run', '--name', 't', '--', 'python3', 't.py'], { cwd: r.dir, encoding: 'utf8', env });
  try {
    for (let i = 0; i < 2; i++) assert.equal(py().status, 0); // the first run writes the .pyc, the second records the run that reads it
    assert.match(py().stderr, /skip t/);
    r.write('mod.py', 'X = 22\n');
    assert.equal(py().status, 1, 'mod.py changed behind a valid .pyc: the test must rerun and fail');
  } finally { r.done(); }
});

test('soundness: moving or hard-linking a file the test did not create is never cached', { skip }, () => {
  const r = repo({
    'fixture.txt': 'ok',
    'mv.mjs': "import { renameSync, readFileSync } from 'node:fs'; renameSync('fixture.txt', 'moved.txt'); const ok = readFileSync('moved.txt', 'utf8') === 'ok'; renameSync('moved.txt', 'fixture.txt'); process.exit(ok ? 0 : 1);\n",
    'ln.mjs': "import { tmpdir } from 'node:os'; import { linkSync, readFileSync } from 'node:fs'; linkSync('fixture.txt', tmpdir() + '/h'); process.exit(readFileSync(tmpdir() + '/h', 'utf8') === 'ok' ? 0 : 1);\n",
  });
  try {
    assert.match(r.sh('run', '--name', 'mv', '--', 'node', 'mv.mjs').err, /not caching mv: input modified by the run: fixture.txt/);
    assert.match(r.sh('run', '--name', 'ln', '--', 'node', 'ln.mjs').err, /not caching ln: hard link to a file the run did not create: fixture.txt/);
    r.write('fixture.txt', 'changed');
    assert.equal(r.sh('run', '--name', 'mv', '--', 'node', 'mv.mjs').code, 1);
    assert.equal(r.sh('run', '--name', 'ln', '--', 'node', 'ln.mjs').code, 1);
  } finally { r.done(); }
});

test('soundness: a write through a symlink that existed before the run modifies the file it points at', { skip: skip || (!python && 'python3 not available') }, () => {
  // Each test reads a fixture, then empties or deletes it through a link the repo already had.
  // truncate(2) by path (Python's os.truncate; Node's truncateSync opens the file instead), open(O_TRUNC), unlink.
  const r = repo({
    'a.txt': 'ok', 'b.txt': 'ok',
    'trunc.py': "import os, sys\nok = open('a.txt').read() == 'ok'\nos.truncate('a-link', 0)\nsys.exit(0 if ok else 1)\n",
    'open.mjs': "import { readFileSync, writeFileSync } from 'node:fs'; const ok = readFileSync('b.txt', 'utf8') === 'ok'; writeFileSync('b-link', ''); process.exit(ok ? 0 : 1);\n",
    'rm.mjs': "import { readFileSync, unlinkSync } from 'node:fs'; const ok = readFileSync('fx/x.txt', 'utf8') === 'ok'; unlinkSync('fx-link/x.txt'); process.exit(ok ? 0 : 1);\n",
  });
  try {
    mkdirSync(path.join(r.dir, 'fx'));
    r.write('fx/x.txt', 'ok');
    symlinkSync('a.txt', path.join(r.dir, 'a-link'));
    symlinkSync('b.txt', path.join(r.dir, 'b-link'));
    symlinkSync('fx', path.join(r.dir, 'fx-link'));
    for (const [t, f, cmd] of [['trunc', 'a.txt', ['python3', 'trunc.py']], ['open', 'b.txt', ['node', 'open.mjs']], ['rm', 'fx/x.txt', ['node', 'rm.mjs']]]) {
      const first = r.sh('run', '--name', t, '--', ...cmd);
      assert.equal(first.code, 0, first.err);
      // The fixture is now empty or gone, so a plain run fails.
      const second = r.sh('run', '--name', t, '--', ...cmd);
      assert.doesNotMatch(second.err, new RegExp(`skip ${t}`), `${t}: wrong skip, the run emptied ${f} through a link`);
      assert.equal(second.code, 1, `${t}: must rerun and fail`);
      assert.match(first.err, new RegExp(`not caching ${t}: input modified by the run: ${f.replace('.', '\\.')}`));
    }
  } finally { r.done(); }
});

test('soundness: where a symlink points is an input (readlink, lstat)', { skip }, () => {
  const r = repo({
    'a.txt': 'same', 'b.txt': 'same',
    'rl.mjs': "import { readlinkSync } from 'node:fs'; process.exit(readlinkSync('cur') === 'a.txt' ? 0 : 1);\n",
    'ls.mjs': "import { lstatSync } from 'node:fs'; process.exit(lstatSync('cur2').isSymbolicLink() ? 0 : 1);\n",
  });
  try {
    symlinkSync('a.txt', path.join(r.dir, 'cur'));
    symlinkSync('a.txt', path.join(r.dir, 'cur2'));
    for (const t of ['rl', 'ls']) {
      assert.match(r.sh('run', '--name', t, '--', 'node', `${t}.mjs`).err, new RegExp(`cached ${t}`));
      assert.match(r.sh('run', '--name', t, '--', 'node', `${t}.mjs`).err, new RegExp(`skip ${t}`));
    }
    rmSync(path.join(r.dir, 'cur')); symlinkSync('b.txt', path.join(r.dir, 'cur')); // repointed, same target type and bytes
    rmSync(path.join(r.dir, 'cur2')); r.write('cur2', 'same'); // a regular file in place of the link
    for (const t of ['rl', 'ls']) {
      const out = r.sh('run', '--name', t, '--', 'node', `${t}.mjs`);
      assert.doesNotMatch(out.err, new RegExp(`skip ${t}`), `${t}: wrong skip, the link changed`);
      assert.equal(out.code, 1, `${t}: must rerun and fail`);
    }
  } finally { r.done(); }
});

test('soundness: talking to an abstract unix socket is network, never cached', { skip }, async () => {
  // A server outside the run, on an abstract socket (no file): its answer is an input testonce cannot hash.
  const name = `testonce-abstract-${process.pid}`;
  const serve = async (answer) => {
    const c = spawn('node', ['-e', `require('net').createServer((s) => s.end(${JSON.stringify(answer)})).listen('\\0${name}', () => console.log('ready'))`]);
    await new Promise((resolve) => c.stdout.on('data', resolve));
    return c;
  };
  const r = repo({ 't.mjs': `import net from 'node:net'; let got = ''; net.connect('\\0${name}').on('data', (d) => { got += d; }).on('close', () => process.exit(got === 'ok' ? 0 : 1));\n` });
  let server = await serve('ok');
  try {
    const first = r.sh('run', '--name', 'a', '--', 'node', 't.mjs');
    assert.equal(first.code, 0, first.err);
    server.kill(); await new Promise((resolve) => server.on('exit', resolve));
    server = await serve('no');
    const second = r.sh('run', '--name', 'a', '--', 'node', 't.mjs');
    assert.doesNotMatch(second.err, /skip a/, 'wrong skip: the server now answers no');
    assert.equal(second.code, 1);
    assert.match(first.err, new RegExp(`not caching a: network: unix:@${name}`));
  } finally { server.kill(); r.done(); }
});

const cc = spawnSync('cc', ['--version']).status === 0;
test('soundness: a non-loopback destination sent through sendmmsg is network, never cached', { skip: skip || (!cc && 'no C compiler') }, () => {
  // One sendmmsg call, loopback first and an outside address second: every destination in the call counts.
  const r = repo({ 'mm.c': `#define _GNU_SOURCE
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <string.h>
int main(void) {
  int s = socket(AF_INET, SOCK_DGRAM, 0);
  struct sockaddr_in a[2]; struct mmsghdr m[2]; struct iovec v = { "x", 1 };
  const char *ip[2] = { "127.0.0.1", "192.0.2.1" };
  memset(a, 0, sizeof a); memset(m, 0, sizeof m);
  for (int i = 0; i < 2; i++) {
    a[i].sin_family = AF_INET; a[i].sin_port = htons(9); inet_pton(AF_INET, ip[i], &a[i].sin_addr);
    m[i].msg_hdr.msg_name = &a[i]; m[i].msg_hdr.msg_namelen = sizeof a[i]; m[i].msg_hdr.msg_iov = &v; m[i].msg_hdr.msg_iovlen = 1;
  }
  sendmmsg(s, m, 2, 0);
  return 0;
}
` });
  try {
    assert.equal(spawnSync('cc', ['-o', 'mm', 'mm.c'], { cwd: r.dir }).status, 0);
    const first = r.sh('run', '--name', 'n', '--', './mm');
    assert.equal(first.code, 0, first.err);
    assert.doesNotMatch(r.sh('run', '--name', 'n', '--', './mm').err, /skip n/, 'wrong skip: the run sent to 192.0.2.1');
    assert.match(first.err, /not caching n: network: 192\.0\.2\.1:9/);
  } finally { r.done(); }
});

// ---- loopback: the run's own world only at an (address, port) the run itself bound ----
// A server outside the run, in its own process (spawnSync blocks this one), answering each connection
// with the current bytes of `answer`. `once`: answer one connection, then exit and free the port.
const loopbackServer = (answer, { host = '127.0.0.1', port = 0, once = false } = {}) => new Promise((resolve, reject) => {
  const src = `const fs = require('fs'); const s = require('net').createServer((c) => { c.on('error', () => {}).end(fs.readFileSync(${JSON.stringify(answer)})); ${once ? 's.close();' : ''} }).listen(${port}, ${JSON.stringify(host)}, () => console.log(s.address().port));`;
  const child = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.once('data', (d) => resolve({ port: Number(String(d).trim()), child, stop: () => new Promise((r) => { if (child.exitCode !== null) r(); else { child.once('exit', r); child.kill(); } }) }));
  child.once('error', reject);
});
const dialer = (host, port, bindFirst = '') => `import net from 'node:net';
${bindFirst}
let got = '';
net.connect(${port}, '${host}').on('data', (d) => { got += d; }).on('close', () => process.exit(got === 'ok' ? 0 : 1)).on('error', () => process.exit(1));\n`;

test('soundness: a loopback server the run did not start (a dev server, a CI service, a daemon) is network, never cached', { skip }, async () => {
  const answer = path.join(mkdtempSync(path.join(tmpdir(), 'sing-answer-')), 'a');
  writeFileSync(answer, 'ok');
  const outside = await loopbackServer(answer);
  const { port } = outside;
  // Same port, other loopback address: binding 127.0.0.2:P does not make 127.0.0.1:P the run's own.
  const r = repo({
    'plain.mjs': dialer('127.0.0.1', port),
    'other-addr.mjs': dialer('127.0.0.1', port, `await new Promise((res) => net.createServer().listen(${port}, '127.0.0.2', res));`),
  });
  try {
    const first = {};
    for (const t of ['plain', 'other-addr']) { first[t] = r.sh('run', '--name', t, '--', 'node', `${t}.mjs`); assert.equal(first[t].code, 0, first[t].err); }
    writeFileSync(answer, 'no'); // the server now answers differently; a plain run fails
    const second = Object.fromEntries(['plain', 'other-addr'].map((t) => [t, r.sh('run', '--name', t, '--', 'node', `${t}.mjs`)]));
    assert.deepEqual(Object.keys(second).filter((t) => /skip /.test(second[t].err)), [], 'wrong skips: the outside server now answers no');
    for (const t in second) {
      assert.equal(second[t].code, 1);
      assert.match(first[t].err, new RegExp(`not caching ${t}: network: 127\\.0\\.0\\.1:${port} `), `${t}: ${first[t].err}`);
    }
  } finally { r.done(); await outside.stop(); rmSync(path.dirname(answer), { recursive: true, force: true }); }
});

test('soundness: a connect that got through before the run bound that address reached someone else', { skip }, async () => {
  const answer = path.join(mkdtempSync(path.join(tmpdir(), 'sing-answer-')), 'a');
  writeFileSync(answer, 'ok');
  const outside = await loopbackServer(answer, { once: true });
  const { port } = outside;
  // Talk to the outside server, then (once it has gone) start a server of the run's own at the same address.
  const script = `import net from 'node:net';
let got = '';
await new Promise((res, rej) => net.connect(${port}, '127.0.0.1').on('data', (d) => { got += d; }).on('close', res).on('error', rej));
for (let i = 0; ; i++) {
  try { await new Promise((res, rej) => { const s = net.createServer().once('error', rej).listen(${port}, '127.0.0.1', () => s.close(res)); }); break; }
  catch (e) { if (i > 100) throw e; await new Promise((r) => setTimeout(r, 20)); }
}
process.exit(got === 'ok' ? 0 : 1);\n`;
  const r = repo({ 'o.mjs': script });
  try {
    const first = r.sh('run', '--name', 'o', '--', 'node', 'o.mjs');
    assert.equal(first.code, 0, first.err);
    await outside.stop(); // nobody answers now; a plain run fails
    const second = r.sh('run', '--name', 'o', '--', 'node', 'o.mjs');
    assert.doesNotMatch(second.err, /skip o/, 'wrong skip: the outside server is gone');
    assert.equal(second.code, 1);
    assert.match(first.err, new RegExp(`not caching o: network: 127\\.0\\.0\\.1:${port} `));
  } finally { r.done(); await outside.stop(); rmSync(path.dirname(answer), { recursive: true, force: true }); }
});

test('a loopback server the run starts itself stays local: bound first, or dialled until it is up', { skip }, () => {
  const own = "import net from 'node:net'; const s = net.createServer((c) => c.end('ok')).listen(0, '127.0.0.1', () => { let got = ''; net.connect(s.address().port, '127.0.0.1').on('data', (d) => { got += d; }).on('close', () => process.exit(got === 'ok' ? 0 : 1)); });\n";
  // Node's default listen() binds the IPv6 wildcard, which also answers 127.0.0.1 (supertest's pattern).
  const wildcard = "import net from 'node:net'; const s = net.createServer((c) => c.end('ok')).listen(0, () => { let got = ''; net.connect(s.address().port, '127.0.0.1').on('data', (d) => { got += d; }).on('close', () => process.exit(got === 'ok' ? 0 : 1)); });\n";
  const retry = `import net from 'node:net';
const port = 40000 + (process.pid % 20000);
setTimeout(() => net.createServer((c) => c.end('ok')).listen(port, '127.0.0.1'), 300);
const dial = () => { let got = ''; net.connect(port, '127.0.0.1').on('data', (d) => { got += d; }).on('close', () => got && process.exit(got === 'ok' ? 0 : 1)).on('error', () => setTimeout(dial, 50)); };
dial();\n`;
  const r = repo({ 'own.mjs': own, 'wildcard.mjs': wildcard, 'retry.mjs': retry });
  try {
    for (const t of ['own', 'wildcard', 'retry']) {
      assert.match(r.sh('run', '--name', t, '--', 'node', `${t}.mjs`).err, new RegExp(`cached ${t}`));
      assert.match(r.sh('run', '--name', t, '--', 'node', `${t}.mjs`).err, new RegExp(`skip ${t}`));
    }
  } finally { r.done(); }
});

// ---- a write that keeps a file's old bytes, and calls that succeed only on what was there ----
test('soundness: a write that keeps the bytes a file held before the run (append, a+, truncate to a length) makes them an input', { skip }, () => {
  const r = repo({
    'data.txt': 'ok',
    'kept.txt': 'okay',
    // Appends a line, then requires it to be the only one: a plain second run finds two.
    'append.mjs': "import { appendFileSync, readFileSync } from 'node:fs'; appendFileSync('log.txt', 'x\\n'); process.exit(readFileSync('log.txt', 'utf8') === 'x\\n' ? 0 : 1);\n",
    // O_RDWR|O_CREAT|O_APPEND, as sqlite and lock files open: the descriptor reads the fixture's bytes.
    'rw.mjs': "import { openSync, readSync } from 'node:fs'; const b = Buffer.alloc(8); const n = readSync(openSync('data.txt', 'a+'), b, 0, 8, 0); process.exit(b.subarray(0, n).toString() === 'ok' ? 0 : 1);\n",
    'trunc.py': "import os, sys\nos.truncate('kept.txt', 2)\nok = open('kept.txt').read() == 'ok'\nopen('kept.txt', 'w').write('okay')\nsys.exit(0 if ok else 1)\n",
  });
  try {
    const cases = [['append', ['node', 'append.mjs'], null], ['rw', ['node', 'rw.mjs'], ['data.txt', 'no']]];
    if (python) cases.push(['trunc', ['python3', 'trunc.py'], ['kept.txt', 'nope']]);
    for (const [t, cmd] of cases) assert.equal(r.sh('run', '--name', t, '--', ...cmd).code, 0);
    for (const [, , edit] of cases) if (edit) r.write(...edit);
    const second = cases.map(([t, cmd]) => [t, r.sh('run', '--name', t, '--', ...cmd)]);
    assert.deepEqual(second.filter(([t, o]) => o.err.includes(`skip ${t}`)).map(([t]) => t), [], 'wrong skips: a plain run fails now');
    for (const [t, o] of second) assert.equal(o.code, 1, `${t}: must rerun and fail`);
  } finally { r.done(); }
});

// ---- GitHub Actions' runner command files ($GITHUB_STEP_SUMMARY and friends) ----
const RUNNER_VARS = ['GITHUB_STEP_SUMMARY', 'GITHUB_OUTPUT', 'GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_STATE'];
// A fresh set of runner files, as the runner makes for each step, already holding an earlier step's lines.
function runnerFiles(tag) {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), 'sing-runner-')));
  const env = {};
  for (const n of RUNNER_VARS) { env[n] = path.join(d, `${n.toLowerCase()}_${tag}`); writeFileSync(env[n], `earlier ${tag}\n`); }
  return { d, env, done: () => rmSync(d, { recursive: true, force: true }) };
}
const runWith = (r, env, name, ...cmd) => {
  const o = spawnSync('node', [BIN, 'run', '--name', name, '--', ...cmd], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, TESTONCE_FULL: '', ...env } });
  return { code: o.status, err: o.stderr };
};

test('a test that appends to $GITHUB_STEP_SUMMARY (and the other runner command files) is cached, and skips on the next step\'s files', { skip }, () => {
  // What Vitest's github-actions reporter does: writeFileSync(GITHUB_STEP_SUMMARY, summary, { flag: 'a' }).
  const r = repo({ 'add.mjs': ADD, 't.mjs': `import { appendFileSync } from 'node:fs'; import { add } from './add.mjs';
for (const n of ${JSON.stringify(RUNNER_VARS)}) appendFileSync(process.env[n], 'ran\\n');
process.exit(add(2, 2) === 4 ? 0 : 1);\n` });
  const a = runnerFiles('a'), b = runnerFiles('b');
  try {
    assert.match(runWith(r, a.env, 't', 'node', 't.mjs').err, /cached t/);
    assert.equal(readFileSync(a.env.GITHUB_STEP_SUMMARY, 'utf8'), 'earlier a\nran\n');
    assert.match(runWith(r, b.env, 't', 'node', 't.mjs').err, /skip t/, 'another step: other paths, other earlier lines');
    r.write('add.mjs', 'export const add = (a, b) => a - b;\n');
    assert.equal(runWith(r, b.env, 't', 'node', 't.mjs').code, 1, 'its real inputs still count');
  } finally { r.done(); a.done(); b.done(); }
});

test('soundness: a test that reads a runner command file, or opens it read-write, is never cached', { skip }, () => {
  const r = repo({
    // Passes only while the summary holds one line: what an earlier test appended changes that.
    'readonly.mjs': "import { readFileSync } from 'node:fs'; process.exit(readFileSync(process.env.GITHUB_STEP_SUMMARY, 'utf8').split('\\n').length === 2 ? 0 : 1);\n",
    'readappend.mjs': "import { readFileSync, appendFileSync } from 'node:fs'; const ok = readFileSync(process.env.GITHUB_OUTPUT, 'utf8').split('\\n').length === 2; appendFileSync(process.env.GITHUB_OUTPUT, 'x=1\\n'); process.exit(ok ? 0 : 1);\n",
    // O_RDWR|O_APPEND: the descriptor itself can read what the file held.
    'rw.mjs': "import { openSync, readSync } from 'node:fs'; const b = Buffer.alloc(64); const n = readSync(openSync(process.env.GITHUB_ENV, 'a+'), b, 0, 64, 0); process.exit(b.subarray(0, n).toString() === 'earlier a\\n' ? 0 : 1);\n",
  });
  const a = runnerFiles('a');
  try {
    for (const t of ['readonly', 'readappend', 'rw']) {
      const o = runWith(r, a.env, t, 'node', `${t}.mjs`);
      assert.equal(o.code, 0, `${t}: ${o.err}`);
      assert.match(o.err, new RegExp(`not caching ${t}: runner command file used other than by appending`), t);
    }
    for (const n of RUNNER_VARS) writeFileSync(a.env[n], 'earlier a\nmore\n');
    for (const t of ['readonly', 'readappend', 'rw']) {
      const o = runWith(r, a.env, t, 'node', `${t}.mjs`);
      assert.doesNotMatch(o.err, new RegExp(`skip ${t}`), `${t}: wrong skip`);
      assert.equal(o.code, 1, `${t}: must rerun and fail`);
    }
  } finally { r.done(); a.done(); }
});

test('soundness: a call that succeeds only where a path was absent (mkdir, O_EXCL, symlink, link) or present (unlink, rmdir) observed it', { skip }, () => {
  const r = repo({
    'fixture.tmp': 'x',
    'own.txt': 'x',
    'del.mjs': "import { unlinkSync } from 'node:fs'; unlinkSync('fixture.tmp');\n",
    'rmdir.mjs': "import { rmdirSync } from 'node:fs'; rmdirSync('empty');\n",
    'mkdir.mjs': "import { mkdirSync } from 'node:fs'; mkdirSync('out');\n",
    'excl.mjs': "import { writeFileSync } from 'node:fs'; writeFileSync('lock', 'x', { flag: 'wx' });\n",
    'symlink.mjs': "import { symlinkSync } from 'node:fs'; symlinkSync('nowhere', 'l');\n",
    'link.mjs': "import { writeFileSync, linkSync } from 'node:fs'; writeFileSync('made.txt', 'x'); linkSync('made.txt', 'hard.txt');\n",
  });
  try {
    mkdirSync(path.join(r.dir, 'empty'));
    const names = ['del', 'rmdir', 'mkdir', 'excl', 'symlink', 'link'];
    for (const t of names) { const first = r.sh('run', '--name', t, '--', 'node', `${t}.mjs`); assert.equal(first.code, 0, `${t}: ${first.err}`); }
    // Each first run changed what its call needs, so a plain second run fails (ENOENT or EEXIST).
    const second = names.map((t) => [t, r.sh('run', '--name', t, '--', 'node', `${t}.mjs`)]);
    assert.deepEqual(second.filter(([t, o]) => o.err.includes(`skip ${t}`)).map(([t]) => t), [], 'wrong skips: a plain run fails now');
    for (const [t, o] of second) assert.equal(o.code, 1, `${t}: must rerun and fail`);
  } finally { r.done(); }
});

test('soundness: changing a file\'s mode or times (chmod, utimes) keeps it an input', { skip }, () => {
  const r = repo({
    's.sh': '#!/bin/sh\nexit 0\n',
    'f.txt': 'ok',
    'chmod.mjs': "import { chmodSync } from 'node:fs'; import { spawnSync } from 'node:child_process'; chmodSync('s.sh', 0o755); process.exit(spawnSync('./s.sh').status);\n",
    'utimes.mjs': "import { utimesSync, readFileSync } from 'node:fs'; utimesSync('f.txt', 1, 1); process.exit(readFileSync('f.txt', 'utf8') === 'ok' ? 0 : 1);\n",
  });
  try {
    for (const t of ['chmod', 'utimes']) {
      assert.match(r.sh('run', '--name', t, '--', 'node', `${t}.mjs`).err, new RegExp(`cached ${t}`));
      assert.match(r.sh('run', '--name', t, '--', 'node', `${t}.mjs`).err, new RegExp(`skip ${t}`), `${t}: unchanged inputs still skip`);
    }
    r.write('s.sh', '#!/bin/sh\nexit 1\n');
    r.write('f.txt', 'no');
    const out = ['chmod', 'utimes'].map((t) => [t, r.sh('run', '--name', t, '--', 'node', `${t}.mjs`)]);
    assert.deepEqual(out.filter(([t, o]) => o.err.includes(`skip ${t}`)).map(([t]) => t), [], 'wrong skips: the file changed');
    for (const [t, o] of out) assert.equal(o.code, 1, `${t}: must rerun and fail`);
  } finally { r.done(); }
});

// ---- a repo where every file would be ignored ----
test('soundness: a repo under /dev, /proc, /sys or /run is never cached: every file it reads would be ignored', { skip: skip || (!existsSync('/dev/shm') && 'no /dev/shm') }, () => {
  const dir = mkdtempSync('/dev/shm/sing-ignored-');
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    writeFileSync(path.join(dir, 'add.mjs'), ADD);
    writeFileSync(path.join(dir, 't.mjs'), TEST);
    const sh = (...a) => { const o = spawnSync('node', [BIN, ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, TESTONCE_FULL: '' } }); return { code: o.status, err: o.stderr }; };
    const first = sh('run', '--name', 't', '--', 'node', 't.mjs');
    assert.equal(first.code, 0, first.err);
    writeFileSync(path.join(dir, 'add.mjs'), 'export const add = (a, b) => a - b;\n');
    const second = sh('run', '--name', 't', '--', 'node', 't.mjs');
    assert.doesNotMatch(second.err, /skip t/, 'wrong skip: add.mjs changed');
    assert.equal(second.code, 1, 'the edited source reruns the test');
    assert.match(first.err, /run t: .* is under \/proc, \/sys, \/dev or \/run/);
    const each = sh('each', 't.mjs', '--', 'node', '{}');
    assert.equal(each.code, 1);
    assert.match(each.err, /: 0 skipped,/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
