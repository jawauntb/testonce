// Bridge between formal/Testonce/Bloom.lean and src/bloom.mjs: the proof assumes every
// index is a natural number taken mod m. These tests check that the code honours that.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as bloom from '../src/bloom.mjs';

const keys = (n) => Array.from({ length: n }, () => randomBytes(12).toString('hex') + '/x.mjs');

test('indices are integers in [0, m)', () => {
  for (const k of keys(2000)) for (const m of [64, 97, 1 << 20]) for (const i of bloom.indices(k, m, 8)) {
    assert.ok(Number.isInteger(i) && i >= 0 && i < m, `${i} out of range for m=${m}`);
  }
});

test('no false negatives on random sets', () => {
  for (const n of [0, 1, 7, 100, 5000]) {
    const ks = keys(n);
    const f = bloom.decode(bloom.encode(bloom.create(ks)));
    for (const k of ks) assert.equal(bloom.has(f, k), true);
  }
});

test('false-positive rate is near the 1% target', () => {
  const f = bloom.create(keys(5000));
  const probes = keys(20000);
  const fp = probes.filter((k) => bloom.has(f, k)).length / probes.length;
  assert.ok(fp < 0.03, `false-positive rate ${fp}`);
});
