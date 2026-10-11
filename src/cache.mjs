// The local result store: one JSON file per test name, holding the most recent passing manifests.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, renameSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const MAX_ENTRIES = 8; // passing input-sets kept per test, so switching branches still hits

const VOLATILE_EXACT = new Set(['_', 'PWD', 'OLDPWD', 'SHLVL', 'HOSTNAME', 'TERM_SESSION_ID', 'INVOCATION_ID', 'JOURNAL_STREAM', 'SSH_AUTH_SOCK', 'SSH_CLIENT', 'SSH_CONNECTION', 'SSH_TTY', 'WINDOWID', 'COLUMNS', 'LINES']);
// Excluding a variable is the unsafe direction: if a test reads one of these, a change won't rerun it.
// Kept to per-run CI bookkeeping; add a name to env.include to count it again. Listed in README.
const VOLATILE_PREFIX = ['GITHUB_', 'RUNNER_', 'ACTIONS_', 'BUILDKITE_', 'GITLAB_', 'CI_', 'CIRCLE_', 'BLACKSMITH_', 'TESTONCE_', 'TRAVIS_', 'JENKINS_', 'DRONE_'];
['BUILD_ID', 'BUILD_NUMBER', 'BUILD_URL', 'BUILD_TAG'].forEach((n) => VOLATILE_EXACT.add(n));
// systemd's per-process bookkeeping (PIDs, sockets, fd counts): different on every machine, so counting
// them meant a record from one GitHub-hosted runner never matched another (found by the two-machine e2e).
['SYSTEMD_EXEC_PID', 'MANAGER_PID', 'MAINPID', 'LISTEN_PID', 'LISTEN_FDS', 'LISTEN_FDNAMES', 'NOTIFY_SOCKET', 'WATCHDOG_PID', 'WATCHDOG_USEC'].forEach((n) => VOLATILE_EXACT.add(n));

// strace cannot see getenv, so every variable counts except per-run CI noise.
// That over-approximates what the test reads: sound, at some cost in hit rate.
// mode "allowlist" hashes only `include` plus a few variables that commonly change behaviour.
// It lets results travel between machines whose environments differ (laptops, agent sandboxes),
// at a price: an unlisted variable that changes a result no longer triggers a rerun; only an audit catches it.
const ALLOWLIST_DEFAULT = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'NODE_ENV', 'NODE_OPTIONS', 'PYTHONPATH', 'GOFLAGS', 'RUSTFLAGS', 'JAVA_HOME', 'CI'];
export function envFingerprint(env, { include = [], exclude = [], mode = 'all' } = {}) {
  const inc = new Set(include), exc = new Set(exclude);
  const allow = new Set([...ALLOWLIST_DEFAULT, ...include]);
  const keep = mode === 'allowlist'
    ? (n) => allow.has(n) && !exc.has(n)
    : (n) => inc.has(n) || (!exc.has(n) && !VOLATILE_EXACT.has(n) && !VOLATILE_PREFIX.some((p) => n.startsWith(p)));
  const names = Object.keys(env).filter(keep).sort();
  const h = createHash('sha256');
  for (const n of names) h.update(n).update('\0').update(env[n]).update('\0');
  return { hash: h.digest('hex'), names };
}

export function findRoot(cwd) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : cwd;
}

export function loadConfig(root) {
  const f = path.join(root, 'testonce.json');
  const cfg = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
  return {
    cacheDir: path.resolve(root, process.env.TESTONCE_CACHE_DIR || cfg.cacheDir || '.testonce'),
    auditEvery: cfg.auditEvery ?? 10,
    auditMaxAgeHours: cfg.auditMaxAgeHours ?? 24,
    ignore: cfg.ignore ?? [],
    denyExec: cfg.denyExec,
    env: cfg.env ?? {},
    trustStat: cfg.trustStat ?? true,
    noCache: cfg.noCache ?? [],
  };
}

const fileFor = (cacheDir, name) => path.join(cacheDir, 'tests', createHash('sha256').update(name).digest('hex').slice(0, 32) + '.json');

export function load(cacheDir, name) {
  try { return JSON.parse(readFileSync(fileFor(cacheDir, name), 'utf8')); } catch { return { name, entries: [], skips: 0 }; }
}

export function save(cacheDir, rec) {
  const f = fileFor(cacheDir, rec.name);
  mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec));
  renameSync(tmp, f); // atomic: parallel CI shards never read half a record
}

export function all(cacheDir) {
  const d = path.join(cacheDir, 'tests');
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(path.join(d, f), 'utf8')));
}

export function clear(cacheDir, name) {
  if (name) rmSync(fileFor(cacheDir, name), { force: true });
  else rmSync(path.join(cacheDir, 'tests'), { recursive: true, force: true });
}
