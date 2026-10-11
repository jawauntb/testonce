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
  const opts = { mode: 'allowlist', include: ['FOO'] };
  assert.equal(envFingerprint({ PATH: '/bin', FOO: 'x', SESSION: 'a' }, opts).hash, envFingerprint({ PATH: '/bin', FOO: 'x', SESSION: 'b' }, opts).hash);
  assert.notEqual(envFingerprint({ FOO: 'x' }, opts).hash, envFingerprint({ FOO: 'y' }, opts).hash);
});
