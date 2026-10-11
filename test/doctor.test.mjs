// `testonce doctor` and the no-strace fallback. Missing or broken tracing is simulated with a PATH
// that lacks strace, or holds a stand-in strace, so these pass on any machine (one test uses real strace).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeTrace } from '../src/trace.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'testonce.mjs');
const realStrace = probeTrace().ok ? spawnSync('sh', ['-c', 'command -v strace'], { encoding: 'utf8' }).stdout.trim() : null;

function sandbox({ strace } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sing-doctor-'));
  const bin = path.join(dir, 'bin');
  spawnSync('mkdir', ['-p', bin]);
  if (strace) { writeFileSync(path.join(bin, 'strace'), strace); chmodSync(path.join(bin, 'strace'), 0o755); }
  const env = { ...process.env, PATH: bin, TESTONCE_CACHE_DIR: path.join(dir, 'cache'), TESTONCE_FULL: '' };
  const sing = (args, extra = {}) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: { ...env, ...extra } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  return { dir, sing, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const VERSION = '[ "$1" = "-V" ] && { echo "strace -- version 0.0-fake"; exit 0; }';
const DENY = `#!/bin/sh\n${VERSION}\necho "strace: ptrace(PTRACE_TRACEME, ...): Operation not permitted" >&2\nexit 1\n`;
const SILENT = `#!/bin/sh\n${VERSION}\nexit 0\n`; // exits 0 and traces nothing

test('doctor passes on a machine that can trace', { skip: !realStrace && 'strace not usable here' }, () => {
  const s = sandbox();
  try {
    const r = spawnSync(process.execPath, [BIN, 'doctor'], { cwd: s.dir, encoding: 'utf8', env: { ...process.env, TESTONCE_CACHE_DIR: path.join(s.dir, 'cache') } });
    assert.equal(r.status, 0, r.stdout);
    for (const name of ['platform', 'strace', 'ptrace', 'cache dir']) assert.match(r.stdout, new RegExp(`^PASS  ${name}`, 'm'));
    assert.match(r.stdout, /caching will work here/);
    assert.doesNotMatch(r.stdout, /FAIL/);
    assert.ok(!existsSync(path.join(s.dir, 'cache')), 'doctor does not leave a cache directory behind');
  } finally { s.done(); }
});

test('doctor with no strace on PATH fails and says how to install it', () => {
  const s = sandbox();
  try {
    const r = s.sing(['doctor']);
    assert.equal(r.code, 1);
    assert.match(r.out, /^FAIL  strace .*not found/m);
    assert.match(r.out, /apt-get install -y strace/);
    assert.match(r.out, /caching will NOT work/);
  } finally { s.done(); }
});

test('doctor when ptrace is refused fails and gives the container fix', () => {
  const s = sandbox({ strace: DENY });
  try {
    const r = s.sing(['doctor']);
    assert.equal(r.code, 1);
    assert.match(r.out, /^PASS  strace .*0\.0-fake/m);
    assert.match(r.out, /^FAIL  ptrace .*Operation not permitted/m);
    assert.match(r.out, /docker run --cap-add SYS_PTRACE/);
  } finally { s.done(); }
});

test('an strace that exits 0 but traced nothing is not trusted', () => {
  const s = sandbox({ strace: SILENT });
  try {
    const r = s.sing(['doctor']);
    assert.equal(r.code, 1);
    assert.match(r.out, /^FAIL  ptrace /m);
  } finally { s.done(); }
});

test('doctor fails when the cache dir cannot be created', () => {
  const s = sandbox();
  try {
    const r = s.sing(['doctor'], { TESTONCE_CACHE_DIR: '/dev/null/cache' });
    assert.match(r.out, /^FAIL  cache dir .*\/dev\/null\/cache/m);
    assert.match(r.out, /TESTONCE_CACHE_DIR/);
    assert.equal(r.code, 1);
  } finally { s.done(); }
});

test('a failing --seccomp-bpf is a warning, not a failure', { skip: !realStrace && 'strace not usable here' }, () => {
  const s = sandbox({ strace: `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--seccomp-bpf" ] && { echo "strace: seccomp unsupported" >&2; exit 1; }; done\nexec ${realStrace} "$@"\n` });
  try {
    const r = s.sing(['doctor']);
    assert.match(r.out, /^PASS  ptrace/m);
    assert.match(r.out, /^WARN  seccomp-bpf .*seccomp unsupported/m);
    assert.equal(r.code, 0, r.out);
  } finally { s.done(); }
});

const marker = (dir) => path.join(dir, 'ran.log');
const writeTest = (dir, name, body) => writeFileSync(path.join(dir, name), body);
const APPEND = (dir) => `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(marker(dir))}, process.argv[2] + '\\n');\n`;

for (const [label, strace] of [['no strace on PATH', undefined], ['ptrace refused', DENY]]) {
  test(`run still runs the test, says once why nothing is cached, and caches nothing (${label})`, () => {
    const s = sandbox({ strace });
    try {
      writeTest(s.dir, 't.mjs', APPEND(s.dir));
      for (let i = 1; i <= 2; i++) {
        const r = s.sing(['run', '--name', 't', '--', process.execPath, 't.mjs', `run${i}`]);
        assert.equal(r.code, 0);
        assert.equal((r.err.match(/testonce doctor/g) ?? []).length, 1, r.err);
        assert.match(r.err, /nothing is cached/);
        assert.doesNotMatch(r.err, /skip t|cached t:/);
      }
      assert.equal(readFileSync(marker(s.dir), 'utf8'), 'run1\nrun2\n', 'second run was not skipped');
      assert.ok(!existsSync(path.join(s.dir, 'cache')), 'nothing written to the cache');
    } finally { s.done(); }
  });

  test(`run keeps the test's exit code (${label})`, () => {
    const s = sandbox({ strace });
    try {
      writeTest(s.dir, 'bad.mjs', 'process.exit(3);\n');
      assert.equal(s.sing(['run', '--', process.execPath, 'bad.mjs']).code, 3);
    } finally { s.done(); }
  });

  test(`each runs every file and prints the reason once, not once per file (${label})`, () => {
    const s = sandbox({ strace });
    try {
      for (const f of ['a', 'b', 'c', 'd']) writeTest(s.dir, `${f}.mjs`, APPEND(s.dir).replace('process.argv[2]', JSON.stringify(f)));
      writeTest(s.dir, 'bad.mjs', 'process.exit(1);\n');
      const r = s.sing(['each', '-j', '2', 'a.mjs', 'b.mjs', 'bad.mjs', 'c.mjs', 'd.mjs', '--', process.execPath, '{}']);
      assert.equal(r.code, 1, 'a failing test still fails the run');
      assert.equal((r.err.match(/testonce doctor/g) ?? []).length, 1, r.err);
      assert.match(r.err, /5 files: 0 skipped, 5 ran, 1 failed/);
      assert.match(r.err, /FAIL bad\.mjs/);
      assert.deepEqual(readFileSync(marker(s.dir), 'utf8').trim().split('\n').sort(), ['a', 'b', 'c', 'd']);
      assert.ok(!existsSync(path.join(s.dir, 'cache')) || !readdirSync(path.join(s.dir, 'cache')).length);
    } finally { s.done(); }
  });
}

test('the notice names the cause', () => {
  const none = sandbox();
  const denied = sandbox({ strace: DENY });
  try {
    for (const [s, re] of [[none, /strace is not installed/], [denied, /ptrace is not permitted here \(strace: ptrace\(PTRACE_TRACEME/]]) {
      writeTest(s.dir, 't.mjs', '');
      assert.match(s.sing(['run', '--', process.execPath, 't.mjs']).err, re);
    }
  } finally { none.done(); denied.done(); }
});
