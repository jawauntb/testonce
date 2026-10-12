// The private temp dir: what it starts with, and the sweeper that removes leftovers of a killed testonce.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, utimesSync, existsSync, readdirSync, readFileSync, chmodSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makePrivateTmp, removeTree, sweep, MARKER } from '../src/tmp.mjs';

test('a private temp dir starts empty, sits in the real temp dir beside a constant marker, and is removed whole', () => {
  const a = makePrivateTmp(), b = makePrivateTmp();
  try {
    assert.deepEqual(readdirSync(a.dir), []);
    assert.equal(path.dirname(a.base), realpathSync(tmpdir()));
    assert.ok(path.basename(a.base).startsWith('testonce-'));
    assert.notEqual(a.dir, b.dir);
    assert.deepEqual(a.env, { TMPDIR: a.dir, TMP: a.dir, TEMP: a.dir });
    assert.equal(readFileSync(path.join(a.base, MARKER), 'utf8'), readFileSync(path.join(b.base, MARKER), 'utf8'), 'same bytes every run');
    assert.ok(a.prefixes.includes(a.base));
    // A test that leaves a directory it cannot write into still gets cleaned up.
    mkdirSync(path.join(a.dir, 'locked/inner'), { recursive: true });
    writeFileSync(path.join(a.dir, 'locked/inner/f'), 'x');
    chmodSync(path.join(a.dir, 'locked/inner'), 0o500);
    chmodSync(path.join(a.dir, 'locked'), 0o000);
    assert.ok(removeTree(a.base));
    assert.ok(!existsSync(a.base));
  } finally { removeTree(a.base); removeTree(b.base); }
});

test('the sweeper deletes only testonce-* dirs that hold the marker and are older than 24 h', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sing-sweep-'));
  const old = (Date.now() - 25 * 3600_000) / 1000;
  const make = (name, { marker = true, age = old, markerAs = 'file' } = {}) => {
    const p = path.join(dir, name);
    mkdirSync(path.join(p, 'tmp'), { recursive: true });
    writeFileSync(path.join(p, 'tmp', 'data'), 'x');
    if (marker) {
      const m = path.join(p, MARKER);
      if (markerAs === 'file') writeFileSync(m, '');
      else if (markerAs === 'dir') mkdirSync(m);
      else symlinkSync('/etc/hostname', m);
      if (markerAs !== 'symlink') utimesSync(m, age, age);
    }
    return p;
  };
  try {
    const gone = make('testonce-old');
    const fresh = make('testonce-fresh', { age: Date.now() / 1000 - 3600 });
    const unmarked = make('testonce-unmarked', { marker: false });
    const other = make('la-old');
    const markerDir = make('testonce-markerdir', { markerAs: 'dir' });
    const markerLink = make('testonce-markerlink', { markerAs: 'symlink' });
    // A symlink named like ours, pointing at a marked old dir elsewhere: never followed.
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'sing-sweep-target-'));
    writeFileSync(path.join(elsewhere, MARKER), ''); utimesSync(path.join(elsewhere, MARKER), old, old);
    symlinkSync(elsewhere, path.join(dir, 'testonce-link'));
    writeFileSync(path.join(dir, 'testonce-file'), 'not a dir');

    assert.deepEqual(sweep({ dir }), [gone]);
    assert.ok(!existsSync(gone));
    for (const p of [fresh, unmarked, other, markerDir, markerLink, elsewhere, path.join(dir, 'testonce-file')]) assert.ok(existsSync(p), p);
    assert.ok(existsSync(path.join(elsewhere, MARKER)));
    rmSync(elsewhere, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the sweeper is quiet when the temp dir cannot be read', () => {
  assert.deepEqual(sweep({ dir: '/nonexistent/testonce-sweep' }), []);
});

test('sweepSometimes sweeps at most once an hour per cache dir', async () => {
  const { sweepSometimes } = await import('../src/tmp.mjs');
  const cache = mkdtempSync(path.join(tmpdir(), 'sing-sweepstamp-'));
  try {
    sweepSometimes(cache);
    assert.ok(existsSync(path.join(cache, 'tmp-swept')));
    const old = (Date.now() - 2 * 3600_000) / 1000;
    utimesSync(path.join(cache, 'tmp-swept'), old, old);
    sweepSometimes(cache);
    assert.ok(Date.now() - (await import('node:fs')).statSync(path.join(cache, 'tmp-swept')).mtimeMs < 60_000, 'stamp renewed after an hour');
  } finally { rmSync(cache, { recursive: true, force: true }); }
});
