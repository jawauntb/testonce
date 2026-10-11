// From traced access events to a manifest of inputs, and back: re-hash a manifest against today's disk.
import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync, statSync, readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_DENY_EXEC = ['git', 'curl', 'wget', 'ssh', 'scp', 'rsync', 'docker', 'podman', 'kubectl', 'gh', 'aws', 'gcloud', 'az', 'nc', 'ping'];
const ALWAYS_IGNORED = ['/proc', '/sys', '/dev', '/run'];

// Glob with ** and *, matched against the stored (root-relative or absolute) path.
export function globRe(g) {
  const re = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp(`^${re}$|^${re}/`);
}

export function makeIgnore({ root, cacheDir, ignore = [] }) {
  // The temp dir is NOT ignored: a fixture there is an input like any other. Files a test creates
  // in it are outputs by the write-first rule, so they cost nothing.
  const prefixes = [...ALWAYS_IGNORED, path.resolve(cacheDir)];
  const res = ignore.map(globRe);
  return (abs, key) => prefixes.some((p) => abs === p || abs.startsWith(p + '/')) || res.some((r) => r.test(key));
}

// Paths inside the repo are stored relative so manifests survive a checkout at a different path.
export const keyOf = (root, abs) => (abs === root ? '.' : abs.startsWith(root + '/') ? abs.slice(root.length + 1) : abs);
export const absOf = (root, key) => (path.isAbsolute(key) ? key : path.join(root, key));

const STRENGTH = { stat: 1, absent: 1, list: 2, read: 3, exec: 3 };

// Reduce ordered events to {inputs: Map<abs, kind>, outputs: Set<abs>, uncacheable: string[]}.
// A path whose first contact is a write is an output: later reads see the run's own bytes.
// A path whose content was read and later written is a mutated input: the bytes it saw are gone.
export function reduce(events, { root, cacheDir, ignore, denyExec = DEFAULT_DENY_EXEC }) {
  const skip = makeIgnore({ root, cacheDir, ignore });
  const inputs = new Map();
  const seenType = new Map(); // abs -> type observed at the first stat, before the run changed it
  const outputs = new Set();
  const mutated = new Set();
  const reasons = [];
  const deny = new Set(denyExec);
  for (const e of events) {
    if (e.kind === 'net') { reasons.push(`network: ${e.path}`); continue; }
    const abs = e.path;
    if (e.kind === 'exec' && deny.has(path.basename(abs))) reasons.push(`runs outside tool: ${path.basename(abs)}`);
    if (skip(abs, keyOf(root, abs))) continue;
    if (outputs.has(abs)) continue;
    if (e.kind === 'write') {
      const prev = inputs.get(abs);
      if (prev === 'read' || prev === 'exec' || prev === 'list') mutated.add(abs);
      // Checked, then created: the run depended on the path being absent (or on its type), so that
      // observation stays an input. A leftover output makes the next run rerun, never wrongly skip.
      outputs.add(abs);
      continue;
    }
    const prev = inputs.get(abs);
    if (e.kind === 'stat' && e.type && !seenType.has(abs)) seenType.set(abs, e.type);
    if (!prev || STRENGTH[e.kind] > STRENGTH[prev]) inputs.set(abs, e.kind === 'exec' ? 'read' : e.kind);
  }
  for (const m of mutated) reasons.push(`input modified by the run: ${keyOf(root, m)} (add it to "ignore" if it is a cache)`);
  return { inputs, outputs, seenType, uncacheable: [...new Set(reasons)] };
}

// ---- fingerprints of one input ----

// Content hashes are reused while (device, inode, size, mtime, ctime) are unchanged, as git's index does.
// Any write moves ctime, which user-space cannot set back. Turn off with "trustStat": false.
let store = null; // { file, map, dirty }
export function useHashStore(file) {
  let map = {};
  try { map = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  store = { file, map, dirty: false };
}
export function flushHashStore() {
  if (!store?.dirty) return;
  mkdirSync(path.dirname(store.file), { recursive: true });
  const tmp = `${store.file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store.map));
  renameSync(tmp, store.file);
  store.dirty = false;
}

function hashFile(abs) {
  if (!store) return hashBytes(abs);
  const s = statSync(abs, { bigint: true });
  const id = `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
  const hit = store.map[abs];
  if (hit && hit[0] === id) return hit[1];
  const h = hashBytes(abs);
  store.map[abs] = [id, h];
  store.dirty = true;
  return h;
}

function hashBytes(abs) {
  const h = createHash('sha256');
  const fd = openSync(abs, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { closeSync(fd); }
  return h.digest('hex');
}

function typeOf(abs) {
  try {
    const s = statSync(abs);
    return s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other';
  } catch { return 'absent'; }
}

// kind: read -> content hash; list -> sorted entry names minus the run's own outputs; stat/absent -> type.
export function fingerprint(abs, kind, excluded = []) {
  const t = typeOf(abs);
  if (t === 'absent') return 'absent';
  if (kind === 'read' && t === 'file') {
    try { return 'sha256:' + hashFile(abs); } catch (e) { return `error:${e.code}`; }
  }
  if (kind === 'list' && t === 'dir') {
    const skip = new Set(excluded);
    try {
      const names = readdirSync(abs).filter((n) => !skip.has(n)).sort();
      return 'dir:' + createHash('sha256').update(names.join('\0')).digest('hex');
    } catch (e) { return `error:${e.code}`; }
  }
  return t;
}

// Memoised per process: tests share most inputs (runtime, node_modules), so each file is hashed once.
const memo = new Map();
export function fingerprintCached(abs, kind, excluded) {
  const k = `${kind}\0${abs}\0${(excluded || []).join('/')}`;
  if (!memo.has(k)) memo.set(k, fingerprint(abs, kind, excluded));
  return memo.get(k);
}
export const resetMemo = () => memo.clear();


// Build the stored input list: [key, kind, fingerprint, excludedNames?].
export function snapshot(reduced, root) {
  const out = [];
  const outputsByDir = new Map();
  for (const o of reduced.outputs) {
    const d = path.dirname(o);
    if (!outputsByDir.has(d)) outputsByDir.set(d, []);
    outputsByDir.get(d).push(path.basename(o));
  }
  for (const [abs, kind] of [...reduced.inputs].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const excluded = kind === 'list' ? (outputsByDir.get(abs) ?? []).sort() : undefined;
    // absent and stat record what the trace observed during the run, not the disk afterwards:
    // a run that deletes or creates a path it checked must not rewrite what it saw.
    const fp = kind === 'absent' ? 'absent'
      : kind === 'stat' && reduced.seenType?.has(abs) ? reduced.seenType.get(abs)
      : fingerprint(abs, kind, excluded);
    const row = [keyOf(root, abs), kind, fp];
    if (excluded && excluded.length) row.push(excluded);
    out.push(row);
  }
  return out;
}

// The skip decision (mirrors `Testonce.Skip.decide` in formal/Testonce/Skip.lean):
// every recorded input must have the fingerprint it had when the test passed.
export function firstChanged(inputs, root) {
  for (const [key, kind, fp, excluded] of inputs) {
    const now = fingerprintCached(absOf(root, key), kind, excluded);
    if (now !== fp) return { key, was: fp, now };
  }
  return null;
}
