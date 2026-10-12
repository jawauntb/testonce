import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as bloom from './bloom.mjs';
import { bloomKey, queryKeys } from './bloom.mjs';
export { bloomKey, queryKeys };
import { traced, traceStatus } from './trace.mjs';
import { doctor, noTraceMessage } from './doctor.mjs';
import { splitLinuxFlag, wantsLinux, inContainer, runInLinux, realIo } from './linux.mjs';
import { reduce, runnerFiles, snapshot, firstChanged, keyOf, globRe, useHashStore, flushHashStore, underIgnored, resetMemo } from './inputs.mjs';
import { unlock } from './unlock.mjs';
import { makePrivateTmp, removeTree, sweepSometimes } from './tmp.mjs';
import { envFingerprint, PRIVATE_TMP_PLACEHOLDER, findRoot, loadConfig, load, save, all, clear, MAX_ENTRIES } from './cache.mjs';

const say = (msg) => process.stderr.write(`testonce: ${msg}\n`);

const USAGE = `usage:
  testonce run [--name NAME] [--full] -- <command...>   run, or skip if it passed on identical inputs
  testonce each [-j N] FILE... -- <command with {}>     run once per file, in parallel, each cached on its own
  (run and each take --linux, or TESTONCE_LINUX=1, or "linux": true in testonce.json: run inside a Linux container, for macOS)
  testonce affected [--base REF] [PATH...]              tests whose inputs may include these paths
  testonce share pull|push [--remote NAME]             team cache on the repo's own git remote (branch testonce-cache)
  testonce mcp                                          local MCP server on stdio, for Claude Code, Cursor and other agents
  testonce api status | explain NAME | affected PATH... the same facts as JSON
add-ons (Team add-ons, see COMMERCIAL.md):
  testonce flaky | shard | order | report | fix          run any of them with --help or no args for usage
  testonce score                                        time and money saved, level, streak, badges
  testonce publish [--public]                           send this CI run's counts to the leaderboard (GitHub Actions only)
  testonce status                                       cached tests and why any are not cached
  testonce explain NAME                                 what a test read and whether it would skip now
  testonce clear [NAME]                                 forget cached results
  testonce doctor                                       check this machine can trace and cache; prints the fix for anything that cannot`;

function ago(iso) {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 120 ? `${s}s ago` : s < 7200 ? `${Math.round(s / 60)}m ago` : s < 172800 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
}

// Said once per command (each() says it once and silences its children): why nothing will be cached.
function noTraceNotice(tr) {
  say(noTraceMessage(tr));
}

function passthrough(argv, cwd, env = process.env) {
  return new Promise((resolve) => {
    const c = spawn(argv[0], argv.slice(1), { cwd, env, stdio: 'inherit' });
    c.on('exit', (code, sig) => resolve(sig ? 129 : code ?? 1));
    c.on('error', () => resolve(127));
  });
}

function privateTmpOrNull() {
  try { return makePrivateTmp(); } catch (e) { say(`cannot create a private temp dir (${e.message}); this run uses the shared one`); return null; }
}

// Which stored entry, if any, still matches the disk exactly?
function hit(rec, key, root) {
  for (const e of rec.entries) {
    if (e.key !== key) continue;
    if (!firstChanged(e.inputs, root)) return e;
  }
  return null;
}

function whyMiss(rec, key, root, envNow, privateTmp) {
  const same = rec.entries.filter((e) => e.key === key);
  if (!rec.entries.length) return 'no passing run recorded';
  if (!same.length && !!rec.entries[0].privateTmp !== privateTmp) return `privateTmp turned ${privateTmp ? 'on' : 'off'} since the last pass (TMPDIR, TMP, TEMP)`;
  if (!same.length) {
    const was = new Set(rec.entries[0].envNames ?? []);
    const now = new Set(envNow ?? []);
    const added = [...now].filter((n) => !was.has(n)), removed = [...was].filter((n) => !now.has(n));
    const diff = [...added.map((n) => `+${n}`), ...removed.map((n) => `-${n}`)].slice(0, 5).join(' ');
    return `command or environment changed${diff ? ` (env ${diff})` : ''}`;
  }
  const c = firstChanged(same[0].inputs, root);
  return c ? `${c.key} changed` : 'changed';
}

// Why a test is never cached, or null. Every file under /proc, /sys, /dev and /run is ignored: a repo there would skip forever.
function refusal(root, cwd, cfg, name) {
  const hidden = [root, cwd].find(underIgnored);
  if (hidden) return `${hidden} is under /proc, /sys, /dev or /run, which testonce never traces; not caching (move the repo)`;
  return cfg.noCache.some((g) => g === name || globRe(g).test(name)) ? 'listed in noCache, always runs' : null;
}

// The skip decision, shared by `run` and `each`: a skip is recorded and returned as {skipped}; else nothing is written.
function gate({ root, cwd, cfg, name, argv, full, procEnv = process.env }) {
  const env = envFingerprint(procEnv, cfg.env, { privateTmp: cfg.privateTmp });
  // inputs: 4 = loopback is local only where the run bound it, kept bytes and create/remove calls are observed;
  // older records never match.
  const key = createHash('sha256').update(JSON.stringify({ argv, cwd: keyOf(root, cwd), env: env.hash, platform: process.platform, arch: process.arch, inputs: 4 })).digest('hex');
  const rec = load(cfg.cacheDir, name);
  let audit = false, note;
  if (!full && !rec.quarantined) {
    const e = hit(rec, key, root);
    if (e) {
      rec.skips = (rec.skips ?? 0) + 1;
      // Audit every Nth skip, and whenever the test hasn't really run for auditMaxAgeHours:
      // that caps how long a clock- or randomness-dependent test can ride on an old pass.
      const lastReal = [...(rec.history ?? [])].reverse().find((h) => !h.skipped)?.at ?? e.passedAt;
      const stale = cfg.auditMaxAgeHours > 0 && Date.now() - Date.parse(lastReal) > cfg.auditMaxAgeHours * 3600_000;
      audit = (cfg.auditEvery > 0 && rec.skips % cfg.auditEvery === 0) || stale;
      if (!audit) {
        rec.history = [...(rec.history ?? []), { at: new Date().toISOString(), ok: true, skipped: true, ms: 0, savedMs: e.ms }].slice(-30);
        save(cfg.cacheDir, rec);
        return { skipped: `skip ${name}: passed ${ago(e.passedAt)} on identical inputs (${e.inputs.length} files, same command and env)` };
      }
      note = `audit ${name}: inputs unchanged, running anyway (${stale ? `no real run in ${cfg.auditMaxAgeHours} h` : `every ${cfg.auditEvery}th skip is checked`})`;
    } else if (rec.entries.length) note = `run ${name}: ${whyMiss(rec, key, root, env.names, cfg.privateTmp)}`;
  }
  return { rec, key, env, audit, note };
}

export async function run(args) {
  let name, full = process.env.TESTONCE_FULL === '1';
  const sep = args.indexOf('--');
  const opts = sep < 0 ? [] : args.slice(0, sep);
  const argv = sep < 0 ? args : args.slice(sep + 1);
  for (let i = 0; i < opts.length; i++) {
    if (opts[i] === '--name') name = opts[++i];
    else if (opts[i] === '--full') full = true;
  }
  if (!argv.length) { say(USAGE); return 2; }
  const cwd = process.cwd();
  const root = findRoot(cwd);
  const cfg = loadConfig(root);
  name ??= argv.join(' ');

  const tr = traceStatus();
  if (!tr.ok) {
    if (!process.env.TESTONCE_QUIET_NOTRACE) noTraceNotice(tr);
    return passthrough(argv, cwd);
  }

  if (!process.env.TESTONCE_NO_SWEEP) sweepSometimes(cfg.cacheDir);
  const why = refusal(root, cwd, cfg, name);
  if (why) {
    say(`run ${name}: ${why}`);
    const t = cfg.privateTmp ? privateTmpOrNull() : null;
    try { return await passthrough(argv, cwd, t ? { ...process.env, ...t.env } : process.env); } finally { if (t) removeTree(t.base); }
  }
  const g = gate({ root, cwd, cfg, name, argv, full });
  if (g.skipped) { say(g.skipped); return 0; }
  if (g.note) say(g.note);
  const { rec, key, env, audit } = g;

  const started = Date.now();
  // The test's own empty TMPDIR, removed when it ends however it ends (a SIGKILLed testonce leaves it to `sweep`).
  const tmp = cfg.privateTmp ? privateTmpOrNull() : null;
  let code, accesses, signal;
  try {
    ({ code, accesses, signal } = await traced(argv, { cwd, env: tmp ? { ...process.env, ...tmp.env } : process.env }));
  } finally {
    if (tmp && !removeTree(tmp.base)) say(`could not remove the private temp dir ${tmp.base}`);
  }
  if (signal) { say(`run ${name}: stopped by ${signal}, nothing recorded`); return code; }
  // Run history (newest last, 30 kept): what the add-ons (flaky, shard, order, report) read.
  rec.history = [...(rec.history ?? []), { at: new Date().toISOString(), ok: code === 0, ms: Date.now() - started, audit }].slice(-30);
  if (code !== 0) {
    if (audit) {
      rec.quarantined = `audit failed ${new Date().toISOString()}: same inputs passed before, failed now. The test is flaky or reads something testonce cannot see (clock, randomness, an unlisted env var). It will always run until \`testonce clear\`.`;
      say(`AUDIT MISMATCH ${name}: ${rec.quarantined}`);
    }
    rec.entries = rec.entries.filter((e) => e.key !== key || firstChanged(e.inputs, root));
    save(cfg.cacheDir, rec);
    return code;
  }
  const reduced = reduce(accesses, { root, cacheDir: cfg.cacheDir, ignore: cfg.ignore, denyExec: cfg.denyExec, privateDirs: tmp?.prefixes, sinks: runnerFiles(process.env, cwd) });
  // The pass must hold under the configuration the key claims: with privateTmp on, a run that fell back to the
  // shared temp dir is not recorded.
  if (cfg.privateTmp && !tmp) reduced.uncacheable.unshift('could not create a private temp dir, so this run used the shared one');
  if (reduced.uncacheable.length) {
    rec.uncacheable = reduced.uncacheable.slice(0, 20);
    save(cfg.cacheDir, rec);
    say(`not caching ${name}: ${reduced.uncacheable[0]}${reduced.uncacheable.length > 1 ? ` (+${reduced.uncacheable.length - 1} more; see \`testonce status\`)` : ''}`);
    return 0;
  }
  const inputs = snapshot(reduced, root);
  const entry = { key, argv, cwd: keyOf(root, cwd), envNames: env.names, ...(cfg.privateTmp ? { privateTmp: true } : {}), passedAt: new Date().toISOString(), ms: Date.now() - started, inputs, bloom: bloom.encode(bloom.create(inputs.map(bloomKey))) };
  delete rec.uncacheable;
  rec.entries = [entry, ...rec.entries.filter((e) => !(e.key === key && JSON.stringify(e.inputs) === JSON.stringify(inputs)))].slice(0, MAX_ENTRIES);
  save(cfg.cacheDir, rec);
  say(`cached ${name}: passed with ${inputs.length} recorded inputs`);
  return 0;
}

function changedPaths(base, root) {
  const out = new Set();
  const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' }).stdout || '';
  if (base) for (const l of git('diff', '--name-only', `${base}...HEAD`).split('\n')) if (l) out.add(l);
  for (const l of git('status', '--porcelain', '--untracked-files=all').split('\n')) {
    if (!l) continue;
    const p = l.slice(3);
    for (const part of p.split(' -> ')) out.add(part.replace(/^"|"$/g, ''));
  }
  return [...out];
}

export function affected(args) {
  const root = findRoot(process.cwd());
  const cfg = loadConfig(root);
  let base;
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--base') base = args[++i];
    else if (args[i] === '-') paths.push(...readFileSync(0, 'utf8').split('\n').filter(Boolean));
    else paths.push(keyOf(root, path.resolve(args[i])));
  }
  const changed = queryKeys(paths.length ? paths : changedPaths(base, root));
  for (const rec of all(cfg.cacheDir)) {
    // Every stored entry, not just the newest: any of them could be the one that matches next.
    const hitAny = rec.entries.some((e) => changed.some((k) => bloom.has(bloom.decode(e.bloom), k)));
    if (!rec.entries.length || rec.quarantined || hitAny) console.log(rec.name);
  }
  return 0;
}

export function status() {
  const root = findRoot(process.cwd());
  const cfg = loadConfig(root);
  const recs = all(cfg.cacheDir);
  if (!recs.length) { say('nothing cached yet'); return 0; }
  for (const r of recs) {
    const e = r.entries[0];
    const state = r.quarantined ? 'QUARANTINED' : r.uncacheable ? 'uncacheable' : e ? 'cached' : 'not cached';
    console.log(`${state.padEnd(12)} ${r.name}${e ? `  (${e.inputs.length} inputs, passed ${ago(e.passedAt)}, ${r.skips ?? 0} skips)` : ''}`);
    for (const why of r.uncacheable ?? []) console.log(`             - ${why}`);
    if (r.quarantined) console.log(`             - ${r.quarantined}`);
  }
  return 0;
}

export function explain([name]) {
  const root = findRoot(process.cwd());
  const cfg = loadConfig(root);
  const rec = load(cfg.cacheDir, name);
  const e = rec.entries[0];
  if (!e) { say(`${name}: no passing run recorded`); return 1; }
  const c = firstChanged(e.inputs, root);
  console.log(`${name}\n  passed ${ago(e.passedAt)} in ${e.ms} ms, ${e.inputs.length} inputs, ${e.envNames.length} env vars`);
  console.log(c ? `  would RUN: ${c.key} was ${c.was}, now ${c.now}` : '  would SKIP: every input is byte-identical');
  if (e.privateTmp) console.log(`  temp dir: private to each run, removed after it; TMPDIR, TMP, TEMP hashed as ${PRIVATE_TMP_PLACEHOLDER}`);
  const kinds = {};
  for (const [, k] of e.inputs) kinds[k] = (kinds[k] ?? 0) + 1;
  console.log(`  by kind: ${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')}`);
  for (const [k, kind] of e.inputs.filter(([k]) => !path.isAbsolute(k)).slice(0, 50)) console.log(`    ${kind.padEnd(6)} ${k}`);
  return 0;
}

export async function main(argv) {
  let [cmd, ...rest] = argv;
  if (cmd === 'run' || cmd === 'each' || cmd === 'explain') {
    const root = findRoot(process.cwd());
    const cfg = loadConfig(root);
    if (cmd !== 'explain') {
      const { flag, args } = splitLinuxFlag(rest);
      rest = args;
      if (!inContainer() && wantsLinux({ flag, env: process.env, cfg })) return runInLinux(cmd, rest, { root, cfg, io: await realIo(), say });
    }
    if (cfg.trustStat) useHashStore(path.join(cfg.cacheDir, 'hashes.json'));
  }
  try { return await dispatch(cmd, rest); } finally { flushHashStore(); }
}

// One cached run per file, N at a time. A skip is decided here at the file's turn, by run's gate on a fresh look at
// the disk; anything else is its own `testonce run`, which decides again and records it, so traces never mix.
export async function each(args) {
  const sep = args.indexOf('--');
  if (sep < 0) { say(USAGE); return 2; }
  let jobs = Math.max(1, (await import('node:os')).availableParallelism?.() ?? 4);
  const files = [];
  const head = args.slice(0, sep);
  for (let i = 0; i < head.length; i++) {
    if (head[i] === '-j') jobs = Number(head[++i]);
    else files.push(head[i]);
  }
  const template = args.slice(sep + 1);
  if (!template.some((a) => a.includes('{}'))) template.push('{}');
  const self = process.argv[1];
  const cwd = process.cwd(), root = findRoot(cwd), cfg = loadConfig(root), full = process.env.TESTONCE_FULL === '1';
  const tr = traceStatus();
  if (!tr.ok) noTraceNotice(tr);
  if (tr.ok) sweepSometimes(cfg.cacheDir);
  const childEnv = { ...process.env, TESTONCE_NO_SWEEP: '1', ...(tr.ok ? {} : { TESTONCE_QUIET_NOTRACE: '1' }) };
  const tally = { skip: 0, ran: 0, failed: [] };
  const queue = [...files];
  const worker = async () => {
    for (let f; (f = queue.shift()) !== undefined;) {
      const argv = template.map((a) => a.replaceAll('{}', f));
      if (tr.ok && !refusal(root, cwd, cfg, f)) {
        resetMemo(); // fingerprints taken before an earlier test ran may be stale
        if (gate({ root, cwd, cfg, name: f, argv, full, procEnv: childEnv }).skipped) { tally.skip++; say(`skip ${f}`); continue; }
      }
      const out = await new Promise((resolve) => {
        const c = spawn(process.execPath, [self, 'run', '--name', f, '--', ...argv], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
        let text = '';
        c.stdout.on('data', (d) => (text += d));
        c.stderr.on('data', (d) => (text += d));
        c.on('exit', (code) => resolve({ code, text }));
      });
      const skipped = /^testonce: skip /m.test(out.text);
      if (skipped) tally.skip++; else tally.ran++;
      if (out.code !== 0) { tally.failed.push(f); process.stdout.write(out.text); }
      else say(skipped ? `skip ${f}` : `pass ${f}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker));
  say(`${files.length} files: ${tally.skip} skipped, ${tally.ran} ran, ${tally.failed.length} failed`);
  for (const f of tally.failed) say(`FAIL ${f}`);
  return tally.failed.length ? 1 : 0;
}

// Paid modules (shared cache, add-ons, connectors) ship only in the private package. In the free
// build they are absent: with TESTONCE_KEY set they are downloaded once (src/unlock.mjs), else the
// command says where to get them instead of crashing.
const PRICING = 'https://testonce-production.up.railway.app/#price';
const missing = (e) => e?.code === 'ERR_MODULE_NOT_FOUND';
async function paid(spec, feature) {
  try { return await import(spec); }
  catch (e) {
    if (!missing(e)) throw e;
    const key = process.env.TESTONCE_KEY;
    if (!key) { say(`${feature} is part of testonce's paid features, not this free build. Buy a plan at ${PRICING}, then set TESTONCE_KEY to the license key from checkout.`); return null; }
    try { await unlock({ key, api: process.env.TESTONCE_API || undefined }); } catch (err) { say(`cannot unlock ${feature}: ${err.message}`); return null; }
    try { return await import(spec); }
    catch (e2) {
      if (!missing(e2)) throw e2;
      say(`${feature} is not included in your testonce plan. See ${PRICING}`);
      return null;
    }
  }
}

async function shareCmd([sub, ...rest]) {
  const share = await paid('./share.mjs', '`testonce share` (the shared team cache)');
  if (!share) return 2;
  const root = findRoot(process.cwd());
  const cfg = loadConfig(root);
  const remote = rest[0] === '--remote' ? rest[1] : 'origin';
  try {
    if (sub === 'pull') { const r = share.pull(root, cfg.cacheDir, remote); say(r.note ?? `pulled ${r.pulled} test records from ${remote}/${share.BRANCH}`); return 0; }
    if (sub === 'push') { const r = share.push(root, cfg.cacheDir, remote); say(`pushed ${r.pushed} test records to ${remote}/${share.BRANCH}`); return 0; }
  } catch (e) { say(e.message); return 1; }
  say(USAGE);
  return 2;
}

// Connectors: the JSON API. `api status`, `api explain NAME`, `api affected PATH...`.
async function apiCmd([sub, ...rest]) {
  const api = await paid('./connectors/api.mjs', '`testonce api` (Connectors)');
  if (!api) return 2;
  const root = findRoot(process.cwd());
  const cfg = loadConfig(root);
  const out = (v) => { console.log(JSON.stringify(v, null, 2)); return 0; };
  if (sub === 'status') return out(api.status(cfg));
  if (sub === 'explain' && rest[0]) return out(api.explain({ ...cfg, root }, rest[0]));
  if (sub === 'affected') return out(api.affected(cfg, rest.map((p) => keyOf(root, path.resolve(p)))));
  say('usage: testonce api status | explain NAME | affected PATH...');
  return 2;
}

// Add-ons (paid: src/addons/) and gamification (free: src/gamify/) live in their own modules.
async function addon(name, rest, dir = 'addons') {
  const mod = dir === 'addons' ? await paid(`./${dir}/${name}.mjs`, `\`testonce ${name}\``) : await import(`./${dir}/${name}.mjs`);
  if (!mod) return 2;
  const root = findRoot(process.cwd());
  return mod.main(rest, { root, cfg: loadConfig(root), say });
}

async function dispatch(cmd, rest) {
  switch (cmd) {
    case 'run': return run(rest);
    case 'each': return each(rest);
    case 'share': return await shareCmd(rest);
    case 'flaky': case 'shard': case 'order': case 'report': case 'fix':
      return addon(cmd, rest);
    case 'score': case 'publish':
      return addon(cmd, rest, 'gamify');
    case 'mcp': { const m = await paid('./connectors/mcp.mjs', '`testonce mcp` (Connectors)'); if (!m) return 2; const { serve } = m; const root = findRoot(process.cwd()); return serve({ root, cfg: loadConfig(root) }); }
    case 'api': return apiCmd(rest);
    case 'affected': return affected(rest);
    case 'status': return status();
    case 'explain': return explain(rest);
    case 'doctor': return doctor(rest);
    case 'clear': clear(loadConfig(findRoot(process.cwd())).cacheDir, rest[0]); return 0;
    default: console.log(USAGE); return cmd ? 2 : 0;
  }
}
