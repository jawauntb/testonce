// A private temp directory per test run: created empty before the test starts, removed when it ends.
// The test sees it as TMPDIR, TMP and TEMP, so whatever it finds there it made itself during this run.
// That is what lets src/inputs.mjs leave the directory out of the recorded inputs (see `privateDirs`).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, lstatSync, statSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const MARKER = '.testonce-tmp';
export const VARS = ['TMPDIR', 'TMP', 'TEMP'];
const PREFIX = 'testonce-';
const SWEEP_AGE_MS = 24 * 3600_000;
// Constant bytes, so the directory a test starts with is identical on every run.
const MARKER_TEXT = 'Made by testonce for one test run. Safe to delete once no testonce run is using it.\n';

const realTmp = () => { const t = tmpdir(); try { return realpathSync(t); } catch { return t; } };

// Owned dir `base` (marked, swept if testonce is killed) and the test's TMPDIR inside it, `dir`, which starts empty.
// `prefixes` are the spellings a traced path may use for `base`: canonical, and via the configured temp dir.
export function makePrivateTmp() {
  const real = realTmp();
  const base = mkdtempSync(path.join(real, PREFIX));
  writeFileSync(path.join(base, MARKER), MARKER_TEXT);
  const dir = path.join(base, 'tmp');
  mkdirSync(dir);
  const prefixes = [...new Set([base, path.join(tmpdir(), path.basename(base))])];
  return { base, dir, prefixes, env: Object.fromEntries(VARS.map((v) => [v, dir])) };
}

// Recursive removal that also gets through directories a test left without write or search permission.
export function removeTree(p) {
  try { rmSync(p, { recursive: true, force: true }); return true; } catch {}
  const open = (d) => {
    try { chmodSync(d, 0o700); } catch {}
    let names = [];
    try { names = readdirSync(d); } catch {}
    for (const n of names) {
      const c = path.join(d, n);
      try { if (lstatSync(c).isDirectory()) open(c); } catch {}
    }
  };
  open(p);
  try { rmSync(p, { recursive: true, force: true }); return true; } catch { return false; }
}

// Leftovers from a testonce that was SIGKILLed: `testonce-*` directories in the real temp dir that hold the
// marker as a regular file, belong to this user, and whose marker is older than 24 h. Nothing else is touched.
export function sweep({ dir = realTmp(), now = Date.now(), maxAgeMs = SWEEP_AGE_MS } = {}) {
  const removed = [];
  let names = [];
  try { names = readdirSync(dir); } catch { return removed; }
  const uid = process.getuid?.();
  for (const n of names) {
    if (!n.startsWith(PREFIX)) continue;
    const p = path.join(dir, n);
    try {
      const d = lstatSync(p);
      if (!d.isDirectory() || (uid !== undefined && d.uid !== uid)) continue;
      const m = lstatSync(path.join(p, MARKER));
      if (!m.isFile() || now - m.mtimeMs < maxAgeMs) continue;
    } catch { continue; }
    if (removeTree(p)) removed.push(p);
  }
  return removed;
}

// At most one sweep an hour per cache dir (a stamp file there), so a temp dir with many entries costs little.
export function sweepSometimes(cacheDir, now = Date.now()) {
  const stamp = path.join(cacheDir, 'tmp-swept');
  try { if (now - statSync(stamp).mtimeMs < 3600_000) return []; } catch {}
  try { mkdirSync(cacheDir, { recursive: true }); writeFileSync(stamp, ''); } catch {}
  return sweep({ now });
}
