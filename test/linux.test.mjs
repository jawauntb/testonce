// src/linux.mjs, the pure parts: flag handling, container argv, runtime detection, Mach-O guard, image tag.
// Platform, PATH and process spawning are injected, so all of this runs on Linux CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { splitLinuxFlag, wantsLinux, imageTag, dockerfile, findRuntime, machOKind, findDarwinAddons, runArgv, runInLinux, inContainer, MAC_NOTICE, INSTALL_HELP } from '../src/linux.mjs';
import { noTraceMessage, doctor, checks } from '../src/doctor.mjs';
import { loadConfig } from '../src/cache.mjs';

test('splitLinuxFlag strips --linux before the separator and keeps everything else verbatim', () => {
  assert.deepEqual(splitLinuxFlag(['--linux', 'a.mjs', '-j', '2', 'b.mjs', '--', 'node', '--test', '{}']), { flag: true, args: ['a.mjs', '-j', '2', 'b.mjs', '--', 'node', '--test', '{}'] });
  assert.deepEqual(splitLinuxFlag(['-j', '2', 'a.mjs', '--linux', '--', 'node', '{}']), { flag: true, args: ['-j', '2', 'a.mjs', '--', 'node', '{}'] });
  assert.deepEqual(splitLinuxFlag(['--name', 'x', '--linux', '--', 'cmd']), { flag: true, args: ['--name', 'x', '--', 'cmd'] });
});

test('a --linux after the separator belongs to the test command and is kept', () => {
  const args = ['a.mjs', '--', 'mytool', '--linux', '{}'];
  assert.deepEqual(splitLinuxFlag(args), { flag: false, args });
});

test('with no separator only a leading --linux counts', () => {
  assert.deepEqual(splitLinuxFlag(['--linux', 'node', 'x.mjs']), { flag: true, args: ['node', 'x.mjs'] });
  const args = ['node', 'x.mjs', '--linux'];
  assert.deepEqual(splitLinuxFlag(args), { flag: false, args });
  assert.deepEqual(splitLinuxFlag([]), { flag: false, args: [] });
});

test('wantsLinux: flag beats env beats config; TESTONCE_LINUX=0 turns config off', () => {
  assert.equal(wantsLinux({ flag: true, env: { TESTONCE_LINUX: '0' }, cfg: {} }), true);
  assert.equal(wantsLinux({ flag: false, env: { TESTONCE_LINUX: '1' }, cfg: {} }), true);
  assert.equal(wantsLinux({ flag: false, env: {}, cfg: { linux: true } }), true);
  assert.equal(wantsLinux({ flag: false, env: { TESTONCE_LINUX: '0' }, cfg: { linux: true } }), false);
  assert.equal(wantsLinux({ flag: false, env: {}, cfg: {} }), false);
  assert.equal(wantsLinux({ flag: false, env: { TESTONCE_LINUX: 'yes' }, cfg: {} }), false);
});

test('inside the container the route is never taken again', () => {
  assert.equal(inContainer({ TESTONCE_IN_CONTAINER: '1' }), true);
  assert.equal(inContainer({}), false);
});

test('image tag and Dockerfile follow the host node major', () => {
  assert.equal(imageTag('22.22.0'), 'testonce-linux:node22-v1');
  assert.equal(imageTag('18.0.1'), 'testonce-linux:node18-v1');
  const d = dockerfile('20.11.1');
  assert.match(d, /^FROM node:20-bookworm-slim$/m);
  assert.match(d, /apt-get install -y --no-install-recommends strace ca-certificates git/);
});

test('findRuntime prefers docker, then podman, in PATH order, and reads only PATH', () => {
  const have = (...files) => (f) => files.includes(f);
  assert.deepEqual(findRuntime({ pathEnv: '/a:/b', isExec: have('/a/podman', '/b/docker') }), { name: 'docker', bin: '/b/docker' });
  assert.deepEqual(findRuntime({ pathEnv: '/a:/b', isExec: have('/b/podman') }), { name: 'podman', bin: '/b/podman' });
  assert.deepEqual(findRuntime({ pathEnv: '/a:/b', isExec: have('/a/docker', '/b/docker') }), { name: 'docker', bin: '/a/docker' });
  assert.equal(findRuntime({ pathEnv: '/a:/b', isExec: have() }), null);
  assert.equal(findRuntime({ pathEnv: '', isExec: () => true }), null, 'empty PATH finds nothing, not the cwd');
  assert.equal(findRuntime({ pathEnv: '::', isExec: () => true }), null);
});

test('findRuntime with a real fake PATH', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lx-path-'));
  try {
    assert.equal(findRuntime({ pathEnv: dir }), null);
    writeFileSync(path.join(dir, 'docker'), '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(findRuntime({ pathEnv: dir }).name, 'docker');
    rmSync(path.join(dir, 'docker'));
    writeFileSync(path.join(dir, 'podman'), '#!/bin/sh\n', { mode: 0o644 });
    assert.equal(findRuntime({ pathEnv: dir }), null, 'a file that is not executable is not a runtime');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('machOKind recognises 64-bit Mach-O in both byte orders and universal binaries, not ELF', () => {
  assert.equal(machOKind(Buffer.from([0xfe, 0xed, 0xfa, 0xcf, 0, 0])), 'feedfacf');
  assert.equal(machOKind(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0])), 'cffaedfe');
  assert.equal(machOKind(Buffer.from([0xca, 0xfe, 0xba, 0xbe])), 'cafebabe');
  assert.equal(machOKind(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])), null, 'ELF');
  assert.equal(machOKind(Buffer.from([0xcf, 0xfa])), null, 'too short');
  assert.equal(machOKind(Buffer.alloc(0)), null);
});

test('findDarwinAddons finds macOS .node files under any node_modules and ignores the rest', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lx-macho-'));
  const put = (rel, bytes) => { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), Buffer.from(bytes)); };
  try {
    put('node_modules/good/build/elf.node', [0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
    put('node_modules/bad/build/mac.node', [0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]);
    put('packages/x/node_modules/y/fat.node', [0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]);
    put('node_modules/bad/readme.txt', [0xcf, 0xfa, 0xed, 0xfe]);
    put('src/not-in-modules.node', [0xcf, 0xfa, 0xed, 0xfe]);
    put('node_modules/tiny.node', [0xcf]);
    const found = findDarwinAddons(root).map((f) => path.relative(root, f)).sort();
    assert.deepEqual(found, ['node_modules/bad/build/mac.node', 'packages/x/node_modules/y/fat.node']);
    assert.equal(findDarwinAddons(root, { limit: 1 }).length, 1);
    assert.deepEqual(findDarwinAddons(path.join(root, 'nope')), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const base = { runtime: 'docker', tag: 'testonce-linux:node22-v1', root: '/Users/me/proj', cwd: '/Users/me/proj/pkg', installDir: '/opt/testonce', cacheDir: '/Users/me/proj/.testonce', env: {}, include: [], hostPlatform: 'darwin', cmd: 'each', args: ['a.mjs', '--', 'node', '--test', '{}'] };
const pairs = (argv, flag) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));

test('runArgv on a Mac: same-path mounts, ptrace caps, same cwd, no uid mapping, stat not trusted, command at the end', () => {
  const a = runArgv(base);
  assert.deepEqual(a.slice(0, 3), ['docker', 'run', '--rm']);
  assert.deepEqual(pairs(a, '--cap-add'), ['SYS_PTRACE']);
  assert.deepEqual(pairs(a, '--security-opt'), ['seccomp=unconfined']);
  assert.deepEqual(pairs(a, '-v'), ['/Users/me/proj:/Users/me/proj', '/opt/testonce:/opt/testonce:ro']);
  assert.deepEqual(pairs(a, '-w'), ['/Users/me/proj/pkg']);
  assert.ok(!a.includes('--user'));
  assert.ok(pairs(a, '-e').includes('TESTONCE_TRUST_STAT=0'));
  assert.ok(pairs(a, '-e').includes('TESTONCE_IN_CONTAINER=1'));
  assert.ok(!a.includes('-i') && !a.includes('-t'), 'stdin stays closed, so it is never a hidden input');
  assert.deepEqual(a.slice(a.indexOf(base.tag)), [base.tag, 'node', '/opt/testonce/bin/testonce.mjs', 'each', 'a.mjs', '--', 'node', '--test', '{}']);
});

test('runArgv on a Linux host runs as the host user, keeps trustStat as configured', () => {
  const a = runArgv({ ...base, hostPlatform: 'linux', uid: 1000, gid: 1001 });
  assert.deepEqual(pairs(a, '--user'), ['1000:1001']);
  assert.ok(pairs(a, '-e').includes('HOME=/tmp'));
  assert.ok(!pairs(a, '-e').some((e) => e.startsWith('TESTONCE_TRUST_STAT')));
  assert.ok(!runArgv({ ...base, hostPlatform: 'linux', uid: 0, gid: 0 }).includes('--user'), 'root host needs no mapping');
  assert.ok(!runArgv({ ...base, hostPlatform: 'linux', runtime: 'podman', uid: 1000, gid: 1000 }).includes('--user'), 'rootless podman already maps root to you');
});

test('runArgv mounts: install dir inside the repo is not mounted twice; cwd outside the root and a cache dir elsewhere are mounted', () => {
  assert.deepEqual(pairs(runArgv({ ...base, installDir: '/Users/me/proj/node_modules/testonce-ci' }), '-v'), ['/Users/me/proj:/Users/me/proj']);
  assert.deepEqual(pairs(runArgv({ ...base, cacheDir: '/var/cache/to' }), '-v'), ['/Users/me/proj:/Users/me/proj', '/opt/testonce:/opt/testonce:ro', '/var/cache/to:/var/cache/to']);
  const out = runArgv({ ...base, root: '/private/tmp/r', cwd: '/tmp/r/sub', cacheDir: '/tmp/r/sub/.testonce' });
  assert.deepEqual(pairs(out, '-v')[0], '/tmp/r/sub:/tmp/r/sub');
  assert.deepEqual(pairs(out, '-w'), ['/tmp/r/sub']);
});

test('runArgv passes TESTONCE_* and env.include by name only, never their values, and never TESTONCE_LINUX', () => {
  const env = { TESTONCE_CACHE_DIR: '/x', TESTONCE_KEY: 'sekrit-value', TESTONCE_LINUX: '1', API_URL: 'https://u', UNLISTED: 'no', PATH: '/bin', TESTONCE_IN_CONTAINER: '0' };
  const a = runArgv({ ...base, env, include: ['API_URL', 'ABSENT'] });
  const e = pairs(a, '-e');
  for (const n of ['TESTONCE_CACHE_DIR', 'TESTONCE_KEY', 'API_URL']) assert.ok(e.includes(n), n);
  for (const n of ['TESTONCE_LINUX', 'UNLISTED', 'PATH', 'ABSENT']) assert.ok(!e.includes(n), n);
  assert.equal(e.filter((x) => x.startsWith('TESTONCE_IN_CONTAINER')).length, 1, 'ours wins, the host value is not forwarded');
  assert.ok(!a.join(' ').includes('sekrit-value') && !a.join(' ').includes('https://u'));
});

// ---- runInLinux with a fake runtime ----
function fakeIo({ present = true, inspectErr = 'Error: No such image: x', builds = [] } = {}) {
  const calls = [];
  const state = { present };
  return {
    calls, builds,
    uid: 1000, gid: 1000,
    isExec: (f) => f.endsWith('/docker'),
    exec: (argv, opts) => {
      calls.push(argv);
      if (argv[1] === 'image') return state.present ? { status: 0, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: inspectErr };
      if (argv[1] === 'build') { builds.push(opts.input); state.present = true; return { status: 0, stdout: '', stderr: '' }; }
      throw new Error('unexpected ' + argv.join(' '));
    },
    mkctx: () => '/ctx', rmctx: () => {},
    run: async (argv) => { calls.push(argv); return 7; },
  };
}
const lx = (io, over = {}) => {
  const said = [];
  const root = mkdtempSync(path.join(tmpdir(), 'lx-run-'));
  const p = runInLinux('run', ['--', 'true'], { root, cwd: root, cfg: { cacheDir: path.join(root, '.testonce') }, env: { PATH: '/fake' }, io, say: (m) => said.push(m), hostPlatform: 'darwin', installDir: '/opt/t', nodeVersion: '22.1.0', ...over });
  return p.then((code) => { rmSync(root, { recursive: true, force: true }); return { code, said }; });
};

test('runInLinux builds the image once from stdin, then runs, and passes the exit code through', async () => {
  const io = fakeIo({ present: false });
  const r = await lx(io);
  assert.equal(r.code, 7);
  assert.equal(io.builds.length, 1);
  assert.match(io.builds[0], /FROM node:22-bookworm-slim/);
  const build = io.calls.find((c) => c[1] === 'build');
  assert.deepEqual(build.slice(1, 6), ['build', '-t', 'testonce-linux:node22-v1', '-f', '-']);
  const run = io.calls.at(-1);
  assert.equal(run[0], '/fake/docker');
  assert.deepEqual(run.slice(-5), ['node', '/opt/t/bin/testonce.mjs', 'run', '--', 'true']);
});

test('runInLinux reuses an existing image', async () => {
  const io = fakeIo({ present: true });
  await lx(io);
  assert.equal(io.builds.length, 0);
});

test('runInLinux with no runtime says how to install one and exits 2 without running anything', async () => {
  const io = fakeIo();
  const r = await lx(io, { env: { PATH: '/nowhere' }, io: { ...io, isExec: () => false } });
  assert.equal(r.code, 2);
  assert.deepEqual(r.said, [INSTALL_HELP]);
  assert.match(INSTALL_HELP, /OrbStack/);
  assert.match(INSTALL_HELP, /Docker Desktop/);
  assert.equal(io.calls.length, 0);
});

test('runInLinux with the daemon stopped says so, and does not try to build', async () => {
  const io = fakeIo({ present: false, inspectErr: 'Cannot connect to the Docker daemon at unix:///x. Is the docker daemon running?' });
  const r = await lx(io);
  assert.equal(r.code, 2);
  assert.match(r.said[0], /cannot talk to docker \(Cannot connect/);
  assert.equal(io.builds.length, 0);
});

test('runInLinux refuses darwin native addons before touching the runtime', async () => {
  const io = fakeIo();
  const root = mkdtempSync(path.join(tmpdir(), 'lx-guard-'));
  mkdirSync(path.join(root, 'node_modules/p'), { recursive: true });
  writeFileSync(path.join(root, 'node_modules/p/m.node'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
  const said = [];
  try {
    const code = await runInLinux('each', ['f', '--', 'x'], { root, cwd: root, cfg: { cacheDir: path.join(root, '.testonce') }, env: { PATH: '/fake' }, io, say: (m) => said.push(m), hostPlatform: 'darwin' });
    assert.equal(code, 2);
    assert.match(said[0], /built for macOS and cannot load in Linux: node_modules\/p\/m\.node/);
    assert.match(said[0], /false failures, not wrong skips/);
    assert.equal(io.calls.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a cache dir outside the repo is created on the host before mounting', async () => {
  const io = fakeIo();
  const outside = path.join(mkdtempSync(path.join(tmpdir(), 'lx-out-')), 'cache');
  try {
    await lx(io, { cfg: { cacheDir: outside } });
    assert.ok(existsSync(outside));
    assert.ok(io.calls.at(-1).includes(`${outside}:${outside}`));
  } finally { rmSync(path.dirname(outside), { recursive: true, force: true }); }
});

// ---- the macOS side ----
test('the macOS notice is exactly the one-liner; other platforms keep the old text', () => {
  assert.equal(noTraceMessage({ reason: 'platform' }, 'darwin'), 'macOS: tracing needs Linux, so every test runs. Use --linux to run them in a Linux container and skip unchanged ones.');
  assert.equal(noTraceMessage({ reason: 'platform' }, 'darwin'), MAC_NOTICE);
  assert.match(noTraceMessage({ reason: 'missing' }, 'linux'), /strace is not installed, so every test runs and nothing is cached\. Run `testonce doctor` for the fix\./);
  assert.match(noTraceMessage({ reason: 'platform' }, 'win32'), /no strace on/);
  assert.match(noTraceMessage({ reason: 'missing' }, 'darwin'), /strace is not installed/, 'only the platform cause gets the Mac text');
});

function doctorOut(env) {
  const lines = [];
  const code = doctor([], { platform: 'darwin', env, cwd: mkdtempSync(path.join(tmpdir(), 'lx-doc-')), write: (l) => lines.push(l) });
  return { code, text: lines.join('\n') };
}

test('doctor on macOS without a runtime prints both routes and says no runtime was found', () => {
  const r = doctorOut({ PATH: '/nowhere', TESTONCE_CACHE_DIR: path.join(tmpdir(), 'lx-doc-cache') });
  assert.equal(r.code, 1);
  assert.match(r.text, /^FAIL  platform .*darwin/m);
  assert.match(r.text, /^WARN  container +no docker or podman on PATH/m);
  assert.match(r.text, /\(a\) Your CI and cloud coding agents run Linux: add `uses: jawauntb\/testonce@main`/);
  assert.match(r.text, /\(b\) Locally, run `testonce each --linux FILE\.\.\. -- <command> \{\}`/);
  assert.match(r.text, /no runtime was found yet/);
  assert.match(r.text, /OrbStack/);
  assert.match(r.text, /match later --linux runs on this Mac only, not your CI/);
});

test('doctor on macOS with docker on PATH says a runtime was found', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lx-docbin-'));
  try {
    writeFileSync(path.join(dir, 'docker'), '#!/bin/sh\n', { mode: 0o755 });
    const r = doctorOut({ PATH: dir, TESTONCE_CACHE_DIR: path.join(dir, 'cache') });
    assert.equal(r.code, 1);
    assert.match(r.text, /^PASS  container +docker at /m);
    assert.match(r.text, /a runtime was found \(docker at /);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('checks() on Linux is unchanged: no container line', () => {
  assert.ok(!checks({ platform: 'linux' }).some((c) => c.name === 'container'));
});

test('loadConfig: "linux" is read from testonce.json, and TESTONCE_TRUST_STAT=0 forces re-hashing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lx-cfg-'));
  const old = process.env.TESTONCE_TRUST_STAT;
  try {
    assert.equal(loadConfig(dir).linux, false);
    writeFileSync(path.join(dir, 'testonce.json'), JSON.stringify({ linux: true, trustStat: true }));
    assert.equal(loadConfig(dir).linux, true);
    delete process.env.TESTONCE_TRUST_STAT;
    assert.equal(loadConfig(dir).trustStat, true);
    process.env.TESTONCE_TRUST_STAT = '0';
    assert.equal(loadConfig(dir).trustStat, false);
  } finally { if (old === undefined) delete process.env.TESTONCE_TRUST_STAT; else process.env.TESTONCE_TRUST_STAT = old; rmSync(dir, { recursive: true, force: true }); }
});
