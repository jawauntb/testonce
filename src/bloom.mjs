// Bloom filter over input paths. Answers "could this test have read path p?".
// A `false` answer is certain (no false negatives; proved in formal/Testonce/Bloom.lean).
// A `true` answer may be a false positive, which only costs a re-run.
import { createHash } from 'node:crypto';

// Index i of key x is (h1 + i*h2) mod m (Kirsch-Mitzenmacher double hashing).
export function indices(key, m, k) {
  const d = createHash('sha256').update(key).digest();
  // Unsigned throughout: `x | 1` alone yields a signed int, hence negative indices and lost bits.
  const h1 = BigInt(d.readUInt32BE(0));
  const h2 = BigInt((d.readUInt32BE(4) | 1) >>> 0);
  const M = BigInt(m);
  const out = [];
  for (let i = 0n; i < BigInt(k); i++) out.push(Number((h1 + i * h2) % M));
  return out;
}

// Size for n keys at false-positive rate p.
export function size(n, p = 0.01) {
  const m = Math.max(64, Math.ceil((-Math.max(n, 1) * Math.log(p)) / Math.LN2 ** 2));
  const k = Math.min(16, Math.max(1, Math.round((m / Math.max(n, 1)) * Math.LN2)));
  return { m, k };
}

export function create(keys, p = 0.01) {
  const { m, k } = size(keys.length, p);
  const bits = new Uint8Array(Math.ceil(m / 8));
  for (const key of keys) for (const i of indices(key, m, k)) bits[i >> 3] |= 1 << (i & 7);
  return { m, k, bits };
}

export function has(filter, key) {
  return indices(key, filter.m, filter.k).every((i) => (filter.bits[i >> 3] >> (i & 7)) & 1);
}

export const encode = (f) => ({ m: f.m, k: f.k, bits: Buffer.from(f.bits).toString('base64') });
export const decode = (o) => ({ m: o.m, k: o.k, bits: new Uint8Array(Buffer.from(o.bits, 'base64')) });
