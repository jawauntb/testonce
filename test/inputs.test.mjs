import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reduce, globRe } from '../src/inputs.mjs';

const root = '/work/repo';
const opts = { root, cacheDir: '/work/repo/.testonce', ignore: ['**/node_modules/.cache/**'] };
const r = (events) => reduce(events, opts);

test('a path first touched by a write is an output, not an input', () => {
  const out = r([{ kind: 'write', path: '/work/repo/out.json' }, { kind: 'read', path: '/work/repo/out.json' }]);
  assert.equal(out.inputs.size, 0);
  assert.ok(out.outputs.has('/work/repo/out.json'));
  assert.deepEqual(out.uncacheable, []);
});

test('a runner command file: a write-only append is an output; a read after the append, or before it, is not cached', () => {
  const S = '/home/runner/work/_temp/_runner_file_commands/step_summary_1';
  const sink = (events) => reduce(events, { ...opts, sinks: [S] });
  const append = [{ kind: 'read', path: S, kept: true, wo: true }, { kind: 'write', path: S }];
  const ok = sink(append);
  assert.deepEqual([ok.inputs.size, ok.uncacheable], [0, []]);
  assert.ok(ok.outputs.has(S));
  // An output's later reads are normally the run's own bytes; here they include what was there before.
  assert.match(sink([...append, { kind: 'read', path: S }]).uncacheable[0], /runner command file used other than by appending/);
  assert.match(sink([{ kind: 'stat', path: S, type: 'file' }, ...append]).uncacheable[0], /runner command file/);
  assert.match(sink([{ kind: 'read', path: S, kept: true }, { kind: 'write', path: S }]).uncacheable[0], /runner command file/, 'read-write open');
  // The same append to any other path still keeps its old bytes as an input.
  assert.match(reduce(append, opts).uncacheable[0], /input modified by the run/);
});

test('reading a file and then rewriting it makes the run uncacheable', () => {
  const out = r([{ kind: 'read', path: '/work/repo/snap.txt' }, { kind: 'write', path: '/work/repo/snap.txt' }]);
  assert.match(out.uncacheable[0], /input modified by the run: snap.txt/);
});

test('probing a missing path and then creating it is an output and an absent-input', () => {
  const out = r([{ kind: 'absent', path: '/work/repo/dist' }, { kind: 'write', path: '/work/repo/dist' }]);
  assert.deepEqual(out.uncacheable, []);
  assert.ok(out.outputs.has('/work/repo/dist'));
  assert.equal(out.inputs.get('/work/repo/dist'), 'absent');
});

test('outside tools are refused even when their binary sits in an ignored path', () => {
  const out = reduce([{ kind: 'exec', path: '/proc/self/git' }], opts);
  assert.match(out.uncacheable[0], /outside tool: git/);
});

test('network access is refused', () => {
  assert.match(r([{ kind: 'net', path: '1.2.3.4:443' }]).uncacheable[0], /network/);
});

test('ignore globs and system paths are dropped; the strongest access kind wins', () => {
  const out = r([
    { kind: 'read', path: '/work/repo/node_modules/.cache/x' },
    { kind: 'read', path: '/proc/self/maps' },
    { kind: 'stat', path: '/work/repo/a.js' },
    { kind: 'read', path: '/work/repo/a.js' },
    { kind: 'stat', path: '/work/repo/a.js' },
  ]);
  assert.deepEqual([...out.inputs], [['/work/repo/a.js', 'read']]);
});

test('the temp dir is not ignored: a pre-existing fixture there is an input, a created file is an output', () => {
  const t = path.join(tmpdir(), 'fixture.txt');
  assert.equal(reduce([{ kind: 'read', path: t }], opts).inputs.size, 1);
  const made = path.join(tmpdir(), 'made.txt');
  const out = reduce([{ kind: 'write', path: made }, { kind: 'read', path: made }], opts);
  assert.equal(out.inputs.size, 0);
});

test('a path checked missing and then created stays an input recorded as absent', () => {
  const out = r([{ kind: 'absent', path: '/work/repo/marker' }, { kind: 'write', path: '/work/repo/marker' }]);
  assert.equal(out.inputs.get('/work/repo/marker'), 'absent');
});

test('globRe', () => {
  assert.ok(globRe('**/__pycache__/**').test('src/__pycache__/a.pyc'));
  assert.ok(globRe('coverage').test('coverage/lcov.info'));
  assert.ok(!globRe('*.log').test('src/a.js'));
});

test('env fingerprint: default mode ignores CI noise; allowlist mode hashes only named vars', async () => {
  const { envFingerprint } = await import('../src/cache.mjs');
  const a = envFingerprint({ PATH: '/bin', GITHUB_RUN_ID: '1', FOO: 'x' });
  assert.equal(a.hash, envFingerprint({ PATH: '/bin', GITHUB_RUN_ID: '2', FOO: 'x' }).hash);
  assert.notEqual(a.hash, envFingerprint({ PATH: '/bin', GITHUB_RUN_ID: '1', FOO: 'y' }).hash);
  // two GitHub-hosted runners differ in SYSTEMD_EXEC_PID; a pass on one must still match on the other
  assert.equal(envFingerprint({ PATH: '/bin', SYSTEMD_EXEC_PID: '812' }).hash, envFingerprint({ PATH: '/bin', SYSTEMD_EXEC_PID: '1907' }).hash);
  const opts = { mode: 'allowlist', include: ['FOO'] };
  assert.equal(envFingerprint({ PATH: '/bin', FOO: 'x', SESSION: 'a' }, opts).hash, envFingerprint({ PATH: '/bin', FOO: 'x', SESSION: 'b' }, opts).hash);
  assert.notEqual(envFingerprint({ FOO: 'x' }, opts).hash, envFingerprint({ FOO: 'y' }, opts).hash);
});

// ---- the private temp dir (src/tmp.mjs) in reduce ----
const P = '/tmp/testonce-abc';
const priv = (events) => reduce(events, { ...opts, privateDirs: [P, '/tmp-alias/testonce-abc'] });

test('privateTmp: nothing under the private dir is an input or an output, and writing after reading there is fine', () => {
  const out = priv([
    { kind: 'list', path: `${P}/tmp` }, { kind: 'absent', path: `${P}/tmp/x` }, { kind: 'stat', path: `${P}/tmp/d`, type: 'dir' },
    { kind: 'read', path: `${P}/tmp/d/a` }, { kind: 'write', path: `${P}/tmp/d/a` }, { kind: 'exec', path: `${P}/tmp/bin/tool` },
    { kind: 'read', path: '/tmp-alias/testonce-abc/tmp/y' }, { kind: 'move', path: `${P}/tmp/a.part`, to: `${P}/tmp/a` },
    { kind: 'net', path: `unix:${P}/tmp/server.sock` },
  ]);
  assert.equal(out.inputs.size, 0);
  assert.equal(out.outputs.size, 0);
  assert.deepEqual(out.uncacheable, []);
});

test('soundness, privateTmp: the real temp dir outside the private dir is traced as before', () => {
  const out = priv([{ kind: 'read', path: '/tmp/fixture.txt' }, { kind: 'list', path: '/tmp' }, { kind: 'read', path: '/tmp/testonce-abcd/x' }]);
  assert.deepEqual([...out.inputs.keys()].sort(), ['/tmp', '/tmp/fixture.txt', '/tmp/testonce-abcd/x'], 'a sibling with a longer name is not the private dir');
  assert.match(priv([{ kind: 'net', path: 'unix:/tmp/other.sock' }]).uncacheable[0], /network: unix:\/tmp\/other.sock/);
});

test('soundness, privateTmp: reads, probes and runs through a symlink the run made are recorded at the target', () => {
  const out = priv([
    { kind: 'symlink', path: `${P}/tmp/proj/nm`, target: '/work/repo/node_modules' },
    { kind: 'symlink', path: `${P}/tmp/proj/rel`, target: '../../../../work/repo/lib' }, // relative to the link's directory
    { kind: 'read', path: `${P}/tmp/proj/nm/pkg/index.js` },
    { kind: 'absent', path: `${P}/tmp/proj/nm/missing` },
    { kind: 'stat', path: `${P}/tmp/proj/rel/a.js`, type: 'file' },
    { kind: 'exec', path: `${P}/tmp/proj/nm/.bin/tool` },
    { kind: 'absent', path: `${P}/tmp/proj/marker`, via: `${P}/tmp/proj/nm/../marker` }, // `..` climbs from the target
  ]);
  assert.deepEqual(Object.fromEntries(out.inputs), {
    '/work/repo/node_modules/pkg/index.js': 'read',
    '/work/repo/node_modules/missing': 'absent',
    '/work/repo/lib/a.js': 'stat',
    '/work/repo/node_modules/.bin/tool': 'read',
    '/work/repo/marker': 'absent',
  });
  assert.equal(out.seenType.get('/work/repo/lib/a.js'), 'file');
});

test('soundness: a write through a symlink the run made marks the target as mutated, never as an output', () => {
  const out = priv([
    { kind: 'symlink', path: `${P}/tmp/d`, target: '/work/repo/data' },
    { kind: 'read', path: `${P}/tmp/d/x.json` },
    { kind: 'write', path: `${P}/tmp/d/x.json` },
    { kind: 'read', path: '/work/repo/data/y.json' },
    { kind: 'write', path: `${P}/tmp/d/y.json` },
  ]);
  assert.match(out.uncacheable.join('\n'), /input modified by the run: data\/x.json/);
  assert.match(out.uncacheable.join('\n'), /input modified by the run: data\/y.json/);
  assert.ok(!out.outputs.has('/work/repo/data/x.json'));
});

test('soundness: moving a file the run did not create mutates an input; moving its own file is free', () => {
  assert.match(r([{ kind: 'move', path: '/work/repo/fixture.txt', to: '/work/repo/moved.txt' }]).uncacheable[0], /input modified by the run: fixture.txt/);
  const own = r([{ kind: 'write', path: '/work/repo/a.tmp' }, { kind: 'move', path: '/work/repo/a.tmp', to: '/work/repo/a' }, { kind: 'read', path: '/work/repo/a' }]);
  assert.deepEqual(own.uncacheable, []);
  assert.equal(own.inputs.size, 0);
  // The private dir's own file moved into the repo is an output there.
  assert.ok(priv([{ kind: 'move', path: `${P}/tmp/build`, to: '/work/repo/dist' }]).outputs.has('/work/repo/dist'));
  // A rename of a link inside the private dir moves the link, not its target.
  const ln = priv([{ kind: 'symlink', path: `${P}/tmp/a`, target: '/work/repo/src' }, { kind: 'move', path: `${P}/tmp/a`, to: `${P}/tmp/b` }, { kind: 'read', path: `${P}/tmp/b/x.js` }]);
  assert.deepEqual(ln.uncacheable, []);
  assert.deepEqual([...ln.inputs.keys()], ['/work/repo/src/x.js']);
});

test('soundness: a hard link to a file the run did not create is uncacheable; to its own file it is free', () => {
  assert.match(priv([{ kind: 'hardlink', path: `${P}/tmp/h`, from: '/work/repo/fixture.txt' }]).uncacheable[0], /hard link to a file the run did not create: fixture.txt/);
  assert.deepEqual(priv([{ kind: 'write', path: `${P}/tmp/a` }, { kind: 'hardlink', path: `${P}/tmp/h`, from: `${P}/tmp/a` }]).uncacheable, []);
});

test('a symlink whose target strace did not show makes paths through it uncacheable', () => {
  const out = priv([{ kind: 'symlink', path: `${P}/tmp/l`, target: null }, { kind: 'read', path: `${P}/tmp/l/x` }]);
  assert.match(out.uncacheable[0], /symlink the run created has a target testonce cannot read/);
});

test('follow resolves through the run\'s own links like the kernel, and leaves other paths alone', async () => {
  const { follow } = await import('../src/inputs.mjs');
  const links = new Map([['/t/a', '/r/x/y'], ['/t/b', 'a/../z'], ['/t/loop', 'loop']]);
  assert.equal(follow('/t/a/f', links), '/r/x/y/f');
  assert.equal(follow('/t/a/../f', links), '/r/x/f');
  assert.equal(follow('/t/b/f', links), '/r/x/z/f', 'b -> a/../z: a is a link, so .. climbs from /r/x/y');
  assert.equal(follow('/t/c/../d', links), '/t/d');
  assert.equal(follow('/t/loop/x', links), null);
  assert.equal(follow('/u/../v', new Map()), '/v');
});

test('env fingerprint, privateTmp: TMPDIR, TMP and TEMP are a fixed placeholder and always counted; other variables still count', async () => {
  const { envFingerprint, PRIVATE_TMP_PLACEHOLDER } = await import('../src/cache.mjs');
  const on = { privateTmp: true };
  const a = envFingerprint({ PATH: '/bin', TMPDIR: '/tmp/1', MODE: 'a' }, {}, on);
  assert.equal(a.hash, envFingerprint({ PATH: '/bin', TMPDIR: '/var/tmp/2', TMP: '/x', MODE: 'a' }, {}, on).hash);
  assert.notEqual(a.hash, envFingerprint({ PATH: '/bin', TMPDIR: '/tmp/1', MODE: 'b' }, {}, on).hash);
  assert.deepEqual(a.names, ['MODE', 'PATH', 'TEMP', 'TMP', 'TMPDIR']);
  assert.ok(PRIVATE_TMP_PLACEHOLDER.includes('private-tmp'));
  // Turning it on or off always changes the hash, whatever the mode or exclude list, so neither pass serves the other.
  for (const cfg of [{}, { exclude: ['TMPDIR', 'TMP', 'TEMP'] }, { mode: 'allowlist' }]) {
    for (const env of [{ PATH: '/bin' }, { PATH: '/bin', TMPDIR: '/tmp' }]) {
      assert.notEqual(envFingerprint(env, cfg, on).hash, envFingerprint(env, cfg).hash, JSON.stringify({ cfg, env }));
    }
  }
});

test('a write that keeps old bytes is a modified input, unless the run saw the path absent first', () => {
  const kept = [{ kind: 'read', path: '/work/repo/log', kept: true }, { kind: 'write', path: '/work/repo/log' }];
  assert.match(r(kept).uncacheable[0], /input modified by the run: log/);
  const fresh = r([{ kind: 'absent', path: '/work/repo/log' }, ...kept]);
  assert.deepEqual(fresh.uncacheable, []);
  assert.equal(fresh.inputs.get('/work/repo/log'), 'absent');
});
