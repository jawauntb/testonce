// End to end through the real CLI. A stand-in `docker` (a shell script) plays the container runtime:
// it records its arguments, answers image inspect/build, and for `run` applies -w and -e and then
// execs the command on the host. That exercises the whole `--linux` path (routing, image build once,
// the inner `testonce each` with real strace, records persisting in .testonce between runs) on any
// Linux machine. Real Docker is exercised by the `linux-container` job in .github/workflows/ci.yml.
// A second stand-in, a preload that sets process.platform to 'darwin', covers the macOS fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canTrace } from '../src/trace.mjs';
import { INSTALL_HELP, MAC_NOTICE } from '../src/linux.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'testonce.mjs');
const SUITE = path.join(HERE, 'fixtures', 'suite');
const skip = !canTrace() && 'strace not available';
const TAG = `testonce-linux:node${process.versions.node.split('.')[0]}-v1`;

const FAKE_DOCKER = `#!/bin/sh
echo "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
image)
  if [ -n "$FAKE_DOCKER_DOWN" ]; then echo "Cannot connect to the Docker daemon at unix:///x. Is the docker daemon running?" >&2; exit 1; fi
  [ -f "$FAKE_DOCKER_DIR/image" ] && exit 0
  echo "Error response from daemon: No such image: $3" >&2; exit 1;;
build) cat > "$FAKE_DOCKER_DIR/dockerfile"; : > "$FAKE_DOCKER_DIR/image"; exit 0;;
run)
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --rm) shift;;
      --cap-add|--security-opt|--user|-v) shift 2;;
      -w) cd "$2" || exit 125; shift 2;;
      -e) case "$2" in *=*) export "$2";; esac; shift 2;;
      *) break;;
    esac
  done
  shift
  unset NODE_OPTIONS
  exec "$@";;
esac
`;
const FAKE_DARWIN = "Object.defineProperty(process, 'platform', { value: 'darwin' });\n";

function sandbox({ suite = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'lx-e2e-'));
  const repo = path.join(dir, 'repo');
  const bin = path.join(dir, 'bin');
  mkdirSync(repo); mkdirSync(bin);
  writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER); chmodSync(path.join(bin, 'docker'), 0o755);
  writeFileSync(path.join(dir, 'fake-darwin.cjs'), FAKE_DARWIN);
  spawnSync('git', ['init', '-q'], { cwd: repo });
  if (suite) cpSync(SUITE, repo, { recursive: true });
  const log = path.join(dir, 'docker.log');
  // NODE_TEST_CONTEXT is set by the outer `node --test`; a nested `node --test` would then skip running files.
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_LOG: log, FAKE_DOCKER_DIR: dir, TESTONCE_FULL: '', TESTONCE_LINUX: '', TESTONCE_QUIET_NOTRACE: '' };
  delete env.NODE_TEST_CONTEXT;
  const sh = (args, extra = {}) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd: repo, encoding: 'utf8', env: { ...env, ...extra } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { dir, repo, sh, calls, write: (f, c) => writeFileSync(path.join(repo, f), c), done: () => rmSync(dir, { recursive: true, force: true }) };
}
const EACH = ['each', '--linux', 'a.test.mjs', 'b.test.mjs', '--', process.execPath, '--test', '{}'];
const tally = (r) => /(\d+) files: (\d+) skipped, (\d+) ran, (\d+) failed/.exec(r.err)?.slice(1).map(Number);

test('--linux: first run builds the image once and records; second run skips everything; an edit reruns only the dependent test', { skip }, () => {
  const s = sandbox();
  try {
    const r1 = s.sh(EACH);
    assert.equal(r1.code, 0, r1.err);
    assert.match(r1.err, new RegExp(`building ${TAG} once`));
    assert.deepEqual(tally(r1), [2, 0, 2, 0]);

    const r2 = s.sh(EACH);
    assert.equal(r2.code, 0, r2.err);
    assert.deepEqual(tally(r2), [2, 2, 0, 0], r2.err);
    assert.doesNotMatch(r2.err, /building/);

    s.write('src.mjs', 'export const value = 2;\n');
    const r3 = s.sh(EACH);
    assert.equal(r3.code, 0, r3.err);
    assert.deepEqual(tally(r3), [2, 1, 1, 0], r3.err);
    assert.match(r3.err, /pass a\.test\.mjs/);
    assert.match(r3.err, /skip b\.test\.mjs/);

    const calls = s.calls();
    assert.equal(calls.filter((c) => c.startsWith('build ')).length, 1, 'image built once');
    const runs = calls.filter((c) => c.startsWith('run '));
    assert.equal(runs.length, 3);
    for (const c of runs) {
      assert.doesNotMatch(c, /--linux/, 'the flag is not forwarded into the container');
      assert.match(c, /--cap-add SYS_PTRACE --security-opt seccomp=unconfined/);
      assert.ok(c.includes(`-v ${s.repo}:${s.repo}`), 'repo mounted at its own path');
      assert.ok(c.includes(`-w ${s.repo}`));
      assert.ok(c.includes(`${path.join(HERE, '..')}:${path.join(HERE, '..')}:ro`) || c.includes(':ro'), 'install dir mounted read-only');
      assert.match(c, new RegExp(`${TAG} node .*bin/testonce\\.mjs each a\\.test\\.mjs b\\.test\\.mjs -- `));
    }
    assert.ok(existsSync(path.join(s.repo, '.testonce', 'tests')), 'records live in the repo, so they persist across runs');
  } finally { s.done(); }
});

test('--linux never skips a test whose input changed to make it fail (the wrong skip this product must not have)', { skip }, () => {
  const s = sandbox();
  try {
    assert.equal(s.sh(EACH).code, 0);
    assert.deepEqual(tally(s.sh(EACH)), [2, 2, 0, 0]);
    s.write('src.mjs', 'export const value = -1;\n');
    const broken = s.sh(EACH);
    assert.equal(broken.code, 1, broken.err);
    assert.match(broken.err, /FAIL a\.test\.mjs/);
    assert.match(broken.err, /skip b\.test\.mjs/);
    assert.deepEqual(tally(broken), [2, 1, 1, 1], 'a ran and failed, b skipped');
    s.write('src.mjs', 'export const value = 1;\n');
    assert.equal(s.sh(EACH).code, 0, 'restored bytes pass again');
  } finally { s.done(); }
});

test('run --linux passes the exit code through; env, config and the 0 override choose the route', { skip }, () => {
  const s = sandbox({ suite: false });
  try {
    s.write('bad.mjs', 'process.exit(3);\n');
    s.write('ok.mjs', '');
    assert.equal(s.sh(['run', '--linux', '--', process.execPath, 'bad.mjs']).code, 3);
    assert.equal(s.calls().filter((c) => c.startsWith('run ')).length, 1);

    assert.equal(s.sh(['run', '--', process.execPath, 'ok.mjs'], { TESTONCE_LINUX: '1' }).code, 0);
    assert.equal(s.calls().filter((c) => c.startsWith('run ')).length, 2, 'TESTONCE_LINUX=1 routes to the container');

    s.write('testonce.json', JSON.stringify({ linux: true }));
    assert.equal(s.sh(['run', '--', process.execPath, 'ok.mjs']).code, 0);
    assert.equal(s.calls().filter((c) => c.startsWith('run ')).length, 3, 'config linux:true routes to the container');

    assert.equal(s.sh(['run', '--', process.execPath, 'ok.mjs'], { TESTONCE_LINUX: '0' }).code, 0);
    assert.equal(s.calls().filter((c) => c.startsWith('run ')).length, 3, 'TESTONCE_LINUX=0 runs natively');
  } finally { s.done(); }
});

test('--linux with no docker or podman says how to install one, exits 2 and runs nothing', () => {
  const s = sandbox({ suite: false });
  try {
    s.write('t.mjs', "import { writeFileSync } from 'node:fs'; writeFileSync('ran', '1');\n");
    const empty = path.join(s.dir, 'empty'); mkdirSync(empty);
    const r = s.sh(['run', '--linux', '--', process.execPath, 't.mjs'], { PATH: empty });
    assert.equal(r.code, 2);
    assert.ok(r.err.includes(INSTALL_HELP), r.err);
    assert.ok(!existsSync(path.join(s.repo, 'ran')), 'the test did not run natively either: no silent fallback');
  } finally { s.done(); }
});

test('--linux with the daemon stopped says so and does not build or run', () => {
  const s = sandbox({ suite: false });
  try {
    s.write('t.mjs', "import { writeFileSync } from 'node:fs'; writeFileSync('ran', '1');\n");
    const r = s.sh(['run', '--linux', '--', process.execPath, 't.mjs'], { FAKE_DOCKER_DOWN: '1' });
    assert.equal(r.code, 2);
    assert.match(r.err, /cannot talk to docker \(Cannot connect to the Docker daemon/);
    assert.deepEqual(s.calls().filter((c) => !c.startsWith('image ')), []);
    assert.ok(!existsSync(path.join(s.repo, 'ran')));
  } finally { s.done(); }
});

test('--linux refuses node_modules addons built for macOS, before any container call', () => {
  const s = sandbox({ suite: false });
  try {
    mkdirSync(path.join(s.repo, 'node_modules/native/build'), { recursive: true });
    writeFileSync(path.join(s.repo, 'node_modules/native/build/addon.node'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 12, 0, 0, 1]));
    const r = s.sh(['run', '--linux', '--', process.execPath, '-e', '']);
    assert.equal(r.code, 2);
    assert.match(r.err, /node_modules\/native\/build\/addon\.node/);
    assert.match(r.err, /Linux dev container/);
    assert.deepEqual(s.calls(), []);
  } finally { s.done(); }
});

// ---- macOS fallback, simulated by a preload that reports process.platform = 'darwin' ----
const darwin = (s) => ({ NODE_OPTIONS: `--require ${path.join(s.dir, 'fake-darwin.cjs')}` });

test('on macOS without --linux, each says once that every test runs and points at --linux, then runs them', () => {
  const s = sandbox();
  try {
    const r = s.sh(['each', 'a.test.mjs', 'b.test.mjs', '--', process.execPath, '--test', '{}'], darwin(s));
    assert.equal(r.code, 0, r.err);
    assert.equal(r.err.split(MAC_NOTICE).length - 1, 1, r.err);
    assert.deepEqual(tally(r), [2, 0, 2, 0]);
    assert.ok(!existsSync(path.join(s.repo, '.testonce')), 'nothing cached');
    assert.deepEqual(s.calls(), [], 'no container is started unless asked');
  } finally { s.done(); }
});

test('on macOS without --linux, run says it once and keeps the exit code', () => {
  const s = sandbox({ suite: false });
  try {
    s.write('bad.mjs', 'process.exit(4);\n');
    const r = s.sh(['run', '--', process.execPath, 'bad.mjs'], darwin(s));
    assert.equal(r.code, 4);
    assert.equal(r.err.split(MAC_NOTICE).length - 1, 1, r.err);
  } finally { s.done(); }
});

test('on macOS, --linux routes into the container and the second run skips', { skip }, () => {
  const s = sandbox();
  try {
    assert.deepEqual(tally(s.sh(EACH, darwin(s))), [2, 0, 2, 0]);
    const r2 = s.sh(EACH, darwin(s));
    assert.deepEqual(tally(r2), [2, 2, 0, 0], r2.err);
    assert.doesNotMatch(r2.err, /macOS: tracing needs Linux/);
    assert.match(s.calls().find((c) => c.startsWith('run ')), /TESTONCE_TRUST_STAT=0/, 'stat is not trusted through a VM file share');
  } finally { s.done(); }
});

test('doctor on macOS prints the --linux route, whether a runtime was found, and exits 1', () => {
  const s = sandbox({ suite: false });
  try {
    const r = s.sh(['doctor'], darwin(s));
    assert.equal(r.code, 1);
    assert.match(r.out, /\(a\) Your CI and cloud coding agents run Linux/);
    assert.match(r.out, /\(b\) Locally, run `testonce each --linux/);
    assert.match(r.out, /^PASS  container +docker at /m);
    const empty = path.join(s.dir, 'empty'); mkdirSync(empty);
    assert.match(s.sh(['doctor'], { ...darwin(s), PATH: empty }).out, /^WARN  container +no docker or podman on PATH/m);
  } finally { s.done(); }
});
