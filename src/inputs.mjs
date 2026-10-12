// From traced access events to a manifest of inputs, and back: re-hash a manifest against today's disk.
import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync, statSync, lstatSync, readdirSync, readlinkSync, realpathSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_DENY_EXEC = ['git', 'curl', 'wget', 'ssh', 'scp', 'rsync', 'docker', 'podman', 'kubectl', 'gh', 'aws', 'gcloud', 'az', 'nc', 'ping'];
const ALWAYS_IGNORED = ['/proc', '/sys', '/dev', '/run'];
export const underIgnored = (abs) => ALWAYS_IGNORED.some((p) => abs === p || abs.startsWith(p + '/'));

// Glob with ** and *, matched against the stored (root-relative or absolute) path.
export function globRe(g) {
  const re = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp(`^${re}$|^${re}/`);
}

export function makeIgnore({ root, cacheDir, ignore = [] }) {
  // The temp dir is NOT ignored: a fixture there is an input like any other. Files a test creates
  // in it are outputs by the write-first rule, so they cost nothing.
  const cache = path.resolve(cacheDir);
  const res = ignore.map(globRe);
  return (abs, key) => underIgnored(abs) || abs === cache || abs.startsWith(cache + '/') || res.some((r) => r.test(key));
}

// Paths inside the repo are stored relative so manifests survive a checkout at a different path.
export const keyOf = (root, abs) => (abs === root ? '.' : abs.startsWith(root + '/') ? abs.slice(root.length + 1) : abs);
export const absOf = (root, key) => (path.isAbsolute(key) ? key : path.join(root, key));

// Runner command files (read by GitHub's runner after the step): a write-only append is an output, any other contact uncacheable.
export const runnerFiles = (env, cwd) => ['STEP_SUMMARY', 'OUTPUT', 'ENV', 'PATH', 'STATE'].filter((n) => env['GITHUB_' + n]).map((n) => path.resolve(cwd, env['GITHUB_' + n]));

const STRENGTH = { stat: 1, absent: 1, list: 2, read: 3, exec: 3 };

// Reduce ordered events to {inputs: Map<abs, kind>, outputs: Set<abs>, uncacheable: string[]}.
// A path whose first contact is a write is an output: later reads see the run's own bytes.
// A path whose content was read and later written is a mutated input: the bytes it saw are gone.
// `privateDirs`: the run's private temp dir (src/tmp.mjs). It was created empty for this run alone, so anything
// in it the run made itself, and none of it is an input. A path that reaches outside it through a symlink the
// run created is followed (see `follow`), so that escape is still recorded.
export function reduce(events, { root, cacheDir, ignore, denyExec = DEFAULT_DENY_EXEC, privateDirs = [], sinks = [] }) {
  const sink = new Set(sinks);
  const ignored = makeIgnore({ root, cacheDir, ignore });
  const inPrivate = (abs) => privateDirs.some((p) => abs === p || abs.startsWith(p + '/'));
  const dropped = (abs) => inPrivate(abs) || ignored(abs, keyOf(root, abs));
  const inputs = new Map();
  const seenType = new Map(); // abs -> type observed at the first stat, before the run changed it
  const outputs = new Set();
  const mutated = new Set();
  const linksSeen = new Set(); // symlinks the run looked at as links (readlink, lstat)
  const links = new Map(); // symlinks this run created: where (parent resolved) -> target as written
  const reasons = [];
  const deny = new Set(denyExec);
  const observe = (kind, abs, type) => {
    if (kind === 'exec' && deny.has(path.basename(abs))) reasons.push(`runs outside tool: ${path.basename(abs)}`);
    if (dropped(abs) || outputs.has(abs)) return;
    const prev = inputs.get(abs);
    if (kind === 'stat' && type && !seenType.has(abs)) seenType.set(abs, type);
    if (!prev || STRENGTH[kind] > STRENGTH[prev]) inputs.set(abs, kind === 'exec' ? 'read' : kind);
  };
  const write = (abs) => {
    if (dropped(abs) || outputs.has(abs)) return;
    const prev = inputs.get(abs);
    if (prev === 'read' || prev === 'exec' || prev === 'list' || linksSeen.has(abs)) mutated.add(abs);
    // Checked, then created: the run depended on the path being absent (or on its type), so that
    // observation stays an input. A leftover output makes the next run rerun, never wrongly skip.
    outputs.add(abs);
  };
  // Where a path really lands, through the run's own symlinks. Used only to add inputs or flag a mutation,
  // never to add an output, so a stale or wrong answer can cost a rerun but never cause a skip.
  const real = (p) => {
    const r = follow(p, links);
    if (r === null) reasons.push('a symlink the run created has a target testonce cannot read');
    return r;
  };
  const touchedVia = (abs, r) => { if (r && r !== abs && !dropped(r) && !outputs.has(r) && (['read', 'exec', 'list'].includes(inputs.get(r)) || linksSeen.has(r))) mutated.add(r); };
  // The same, for a call that acts on the last component itself (rename, link, unlink, symlink creation).
  const locate = (abs) => { const d = real(path.dirname(abs)); return d === null ? abs : path.join(d, path.basename(abs)); };
  // A write lands where the kernel resolves the path, through links older than the run too (resolved after it:
  // the path, else its parent). Only flags a mutation, so a stale answer costs a rerun, never a skip.
  const onDisk = (p) => { for (const q of [p, path.dirname(p)]) try { return path.join(realpathSync.native(q), p.slice(q.length)); } catch {} return null; };
  const wrote = (abs) => { write(abs); const l = locate(abs); touchedVia(abs, l); touchedVia(abs, onDisk(l)); };
  for (const e of events) {
    const abs = e.path;
    if (sink.has(abs) && e.kind !== 'write') {
      if (!(e.kind === 'read' && e.kept && e.wo)) reasons.push(`runner command file used other than by appending: ${abs}`);
      continue;
    }
    if (e.kind === 'net') {
      // A unix socket in the private temp dir belongs to a process this run started.
      if (!(abs.startsWith('unix:') && inPrivate(real(abs.slice(5)) ?? ''))) reasons.push(`network: ${abs}`);
      continue;
    }
    if (e.kind === 'symlink') {
      wrote(abs);
      links.set(locate(abs), e.target ?? null);
      continue;
    }
    if (e.kind === 'move') {
      // The bytes at `from` move to `to`. Moving a file the run did not create mutates an input.
      for (const f of new Set([abs, locate(abs)])) if (!dropped(f) && !outputs.has(f)) { observe('read', f); mutated.add(f); }
      wrote(e.to);
      const from = locate(abs), to = locate(e.to);
      for (const [l, t] of [...links]) if (l === from || l.startsWith(from + '/')) links.set(to + l.slice(from.length), t);
      continue;
    }
    if (e.kind === 'hardlink') {
      // A second name for a file the run did not create: writes through it would change that file unseen.
      for (const f of new Set([e.from, locate(e.from)])) if (!dropped(f) && !outputs.has(f)) reasons.push(`hard link to a file the run did not create: ${keyOf(root, f)}`);
      write(abs);
      continue;
    }
    if (e.kind === 'write') { wrote(abs); continue; }
    if (e.kind === 'link') { for (const q of new Set([abs, locate(e.via ?? abs)])) if (!dropped(q) && !outputs.has(q)) linksSeen.add(q); continue; }
    if (e.kept && inputs.get(abs) === 'absent') continue; // seen absent first: there were no old bytes to keep
    const r = real(e.via ?? abs);
    observe(e.kind, abs, e.type);
    if (r && r !== abs) observe(e.kind, r, e.type);
  }
  for (const m of mutated) reasons.push(`input modified by the run: ${keyOf(root, m)} (add it to "ignore" if it is a cache)`);
  return { inputs, linksSeen, outputs, seenType, uncacheable: [...new Set(reasons)] };
}

// Resolve `p` through the symlinks the run itself created, component by component as the kernel does, so a
// `..` after such a link climbs from its target. null: a link whose target strace did not show.
// Links that existed before the run need no help: their paths are fingerprinted through them at check time.
export function follow(p, links, depth = 0) {
  if (!links.size) return path.resolve(p);
  const parts = p.split('/');
  let cur = '';
  for (let i = 0; i < parts.length; i++) {
    const c = parts[i];
    if (c === '' || c === '.') continue;
    if (c === '..') { cur = path.dirname(cur || '/'); if (cur === '/') cur = ''; continue; }
    cur += '/' + c;
    if (!links.has(cur)) continue;
    const t = links.get(cur);
    if (t == null || depth > 40) return null;
    const rest = parts.slice(i + 1).join('/');
    const base = t[0] === '/' ? t : `${path.dirname(cur)}/${t}`;
    return follow(rest ? `${base}/${rest}` : base, links, depth + 1);
  }
  return cur || '/';
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
  } catch {
    // A dangling symlink is not absent: mkdir, symlink, link and O_EXCL fail on it.
    try { lstatSync(abs); return 'dangling'; } catch { return 'absent'; }
  }
}

// kind: read -> content hash; list -> sorted entry names minus the run's own outputs; link -> link target;
// stat/absent -> type.
export function fingerprint(abs, kind, excluded = []) {
  if (kind === 'link') { try { return 'link:' + readlinkSync(abs); } catch (e) { return e.code === 'EINVAL' ? 'notlink' : 'absent'; } }
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
    // A stat'ed file the run never wrote counts by content: tools act on its size and mtime (a .pyc vs its .py).
    const k = kind === 'stat' && reduced.seenType?.get(abs) === 'file' && !reduced.outputs?.has(abs) ? 'read' : kind;
    const fp = k === 'absent' ? 'absent'
      : k === 'stat' && reduced.seenType?.has(abs) ? reduced.seenType.get(abs)
      : fingerprint(abs, k, excluded);
    const row = [keyOf(root, abs), k, fp];
    if (excluded && excluded.length) row.push(excluded);
    out.push(row);
  }
  // Beside the path's other row: the target as written, so a repointed link is a change.
  for (const abs of [...(reduced.linksSeen ?? [])].sort()) out.push([keyOf(root, abs), 'link', fingerprint(abs, 'link')]);
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
