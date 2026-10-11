// End to end: a real repo in a temp dir, real strace.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
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
    't.mjs': "import { spawnSync } from 'node:child_process'; process.exit(spawnSync('node', ['server.mjs']).status);\n",
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
