// `testonce score`: arg parsing, rendering, color rules, and main() over synthetic cache records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { save } from '../src/cache.mjs';
import { DEFAULT_PRICE_PER_MINUTE } from '../src/price.mjs';
import { main, parseArgs, progressBar, useColor, buildScore, renderText, USAGE } from '../src/gamify/score.mjs';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const H = 3_600_000;

function sandbox() {
  const root = mkdtempSync(path.join(tmpdir(), 'testonce-score-'));
  const cacheDir = path.join(root, '.testonce');
  let err = [], outp = [];
  const run = (args, extra = {}) => (err = [], outp = [], main(args, { root, cfg: { cacheDir }, say: (m) => err.push(m), out: (s) => outp.push(s), env: {}, isTTY: false, now: () => NOW, ...extra }).then((code) => ({ code, out: outp.join(''), err: err.join('\n') })));
  const rec = (name, history, extra = {}) => save(cacheDir, { name, entries: [], skips: 0, history, ...extra });
  return { root, cacheDir, run, rec, done: () => rmSync(root, { recursive: true, force: true }) };
}
const sk = (at, savedMs) => ({ at, ok: true, ms: 0, skipped: true, savedMs });
const ran = (at, ms, ok = true) => ({ at, ok, ms, audit: false });

test('USAGE is one line in the cli.mjs shape', () => {
  assert.match(USAGE, /^  testonce score /);
  assert.ok(!USAGE.includes('\n'));
});

test('parseArgs: defaults, options, = forms, errors', () => {
  assert.deepEqual(parseArgs([]), { json: false, price: DEFAULT_PRICE_PER_MINUTE, priceIsDefault: true });
  const o = parseArgs(['--json', '--price-per-minute', '$0.01']);
  assert.deepEqual([o.json, o.price, o.priceIsDefault], [true, 0.01, false]);
  assert.equal(parseArgs(['--price-per-minute=0']).price, 0);
  for (const bad of [['--price-per-minute'], ['--price-per-minute', '-1'], ['--price-per-minute', 'abc'], ['--price-per-minute', ''], ['--json=1'], ['--nope'], ['stray']]) {
    assert.ok(parseArgs(bad).error, `rejects ${JSON.stringify(bad)}`);
  }
});

test('progressBar: ASCII, floored, clamped', () => {
  assert.deepEqual(progressBar(0), { bar: '[--------------------]', percent: 0 });
  assert.deepEqual(progressBar(0.5), { bar: '[##########----------]', percent: 50 });
  assert.deepEqual(progressBar(0.999), { bar: '[###################-]', percent: 99 });
  assert.deepEqual(progressBar(1), { bar: '[####################]', percent: 100 });
  assert.equal(progressBar(7).percent, 100);
  assert.equal(progressBar(-3).percent, 0);
  assert.equal(progressBar(NaN).percent, 0);
  assert.equal(progressBar(0.25, 8).bar, '[##------]');
});

test('useColor: only on a TTY, never when NO_COLOR is set', () => {
  assert.equal(useColor({ isTTY: true, env: {} }), true);
  assert.equal(useColor({ isTTY: false, env: {} }), false);
  assert.equal(useColor({ isTTY: undefined, env: {} }), false);
  assert.equal(useColor({ isTTY: true, env: { NO_COLOR: '1' } }), false);
  assert.equal(useColor({ isTTY: true, env: { NO_COLOR: '' } }), true, 'empty NO_COLOR is ignored (no-color.org)');
});

test('empty cache: Spark, zeros, a pointer, exit 0', async () => {
  const s = sandbox();
  const r = await s.run([]);
  assert.equal(r.code, 0);
  assert.match(r.out, /Spark/);
  assert.match(r.out, /0 days/);
  assert.match(r.out, /0 of 5/);
  assert.match(r.err, /nothing recorded yet/);
  s.done();
});

test('text report: level, bar, time, money labelled as estimate, streak, badges, no escape codes', async () => {
  const s = sandbox();
  // 3 h saved over 3 consecutive days ending today, one failed run
  s.rec('a', [sk('2026-10-09T08:00:00Z', 1 * H), sk('2026-10-10T08:00:00Z', 1 * H), sk('2026-10-11T08:00:00Z', 1 * H), ran('2026-10-11T09:00:00Z', 5000, false)]);
  s.rec('b', [ran('2026-10-11T09:00:00Z', 5000)]);
  const r = await s.run([]);
  assert.equal(r.code, 0);
  assert.match(r.out, /Level\s+Ember/);
  assert.match(r.out, /\[#{4}-{16}\] 22%\s+7 h to Flame \(10 h\)/); // (3-1)/9 = 22.2%
  assert.match(r.out, /Time saved\s+~3h 00m \(estimate\)/);
  assert.match(r.out, /Money saved\s+~\$1\.08 \(estimate: 180\.00 min x \$0\.006\/min, GitHub Actions standard Linux 2-core list price\)/);
  assert.match(r.out, /5 \(3 skipped, 2 ran, 1 failed\), skip rate 60\.0%/);
  assert.match(r.out, /3 days in a row \(best 3\)/);
  assert.match(r.out, /\[x\] First skip/);
  assert.match(r.out, /\[x\] Hour back/);
  assert.match(r.out, /\[x\] Zero wrong skips/);
  assert.match(r.out, /\[ \] 100 skips\s+to earn: skip 100 test runs/);
  assert.match(r.out, /\[ \] Unbroken week/);
  assert.match(r.out, /Badges\s+3 of 5/);
  assert.match(r.out, /not billing/);
  assert.ok(!r.out.includes('\x1b'), 'no escape codes when not a TTY');
  s.done();
});

test('--price-per-minute changes the money and the label', async () => {
  const s = sandbox();
  s.rec('a', [sk('2026-10-11T08:00:00Z', 60 * 60_000)]);
  const r = await s.run(['--price-per-minute', '0.1', '--json']);
  const j = JSON.parse(r.out);
  assert.equal(j.pricePerMinute, 0.1);
  assert.equal(j.priceBasis, 'price you gave');
  assert.ok(Math.abs(j.estimatedUsdSaved - 6) < 1e-9);
  const t = await s.run(['--price-per-minute=0.1']);
  assert.match(t.out, /\$0\.1\/min, price you gave/);
  s.done();
});

test('--json: every field, estimate flagged, machine-readable', async () => {
  const s = sandbox();
  s.rec('a', [sk('2026-10-11T08:00:00Z', 2 * H), ran('2026-10-11T09:00:00Z', 1000)]);
  const r = await s.run(['--json']);
  const j = JSON.parse(r.out);
  assert.equal(j.estimate, true);
  assert.equal(j.runs, 2); assert.equal(j.skipped, 1); assert.equal(j.ran, 1); assert.equal(j.failed, 0);
  assert.equal(j.skipRate, 0.5);
  assert.equal(j.savedMs, 2 * H);
  assert.equal(j.hoursSaved, 2);
  assert.equal(j.level.name, 'Ember');
  assert.equal(j.streak, 1); assert.equal(j.longestStreak, 1);
  assert.deepEqual(j.badges.filter((b) => b.earned).map((b) => b.id), ['first-skip', 'zero-wrong-skips', 'hour-back']);
  assert.equal(r.err, '', 'no chatter on stderr in --json when there is history');
  const empty = JSON.parse((await sandbox().run(['--json'])).out);
  assert.equal(empty.skipRate, null);
  s.done();
});

test('a quarantine or failed audit takes away Zero wrong skips, and says so', async () => {
  const s = sandbox();
  s.rec('good', [sk('2026-10-11T08:00:00Z', 1000)]);
  s.rec('bad', [{ at: '2026-10-11T08:00:00Z', ok: false, ms: 10, audit: true }], { quarantined: 'audit failed ...' });
  const j = JSON.parse((await s.run(['--json'])).out);
  assert.equal(j.badges.find((b) => b.id === 'zero-wrong-skips').earned, false);
  assert.equal(j.auditMismatches, 1);
  assert.equal(j.quarantined, 1);
  s.done();
});

test('earned-badge footnote says audits sample', async () => {
  const s = sandbox();
  s.rec('a', [sk('2026-10-11T08:00:00Z', 1000)]);
  assert.match((await s.run([])).out, /Audits sample the skips/);
  s.done();
});

test('a 7-day streak earns Unbroken week; a streak that ended two days ago does not count today', async () => {
  const s = sandbox();
  const days = [5, 6, 7, 8, 9, 10, 11].map((d) => sk(`2026-10-${String(d).padStart(2, '0')}T10:00:00Z`, 1000));
  s.rec('a', days);
  const j = JSON.parse((await s.run(['--json'])).out);
  assert.equal(j.streak, 7);
  assert.equal(j.badges.find((b) => b.id === 'unbroken-week').earned, true);
  const later = JSON.parse((await s.run(['--json'], { now: () => Date.parse('2026-10-14T00:00:00Z') })).out);
  assert.equal(later.streak, 0);
  assert.equal(later.longestStreak, 7);
  assert.equal(later.badges.find((b) => b.id === 'unbroken-week').earned, true, 'earned stays earned');
  s.done();
});

test('color: bold and green escapes only on a TTY without NO_COLOR; same words either way', async () => {
  const s = sandbox();
  s.rec('a', [sk('2026-10-11T08:00:00Z', 2 * H)]);
  const plain = (await s.run([])).out;
  const col = (await s.run([], { isTTY: true, env: {} })).out;
  const nocol = (await s.run([], { isTTY: true, env: { NO_COLOR: '1' } })).out;
  assert.ok(col.includes('\x1b['));
  assert.equal(nocol, plain);
  assert.equal(col.replace(/\x1b\[[0-9;]*m/g, ''), plain);
  s.done();
});

test('top level and levels beyond Ember render', () => {
  const s = buildScore([{ name: 'a', history: [sk('2026-10-11T08:00:00Z', 1500 * H)] }], { price: 0.006, nowMs: NOW });
  assert.equal(s.level.name, 'Singularity');
  assert.match(renderText(s), /\[#{20}\] top level/);
});

test('a corrupt record file is skipped with a note, not a crash', async () => {
  const s = sandbox();
  s.rec('a', [sk('2026-10-11T08:00:00Z', 1000)]);
  mkdirSync(path.join(s.cacheDir, 'tests'), { recursive: true });
  writeFileSync(path.join(s.cacheDir, 'tests', 'broken.json'), '{nope');
  const r = await s.run(['--json']);
  assert.equal(r.code, 0);
  assert.match(r.err, /skipped 1 unreadable record file/);
  assert.equal(JSON.parse(r.out).skipped, 1);
  s.done();
});

test('bad arguments: message, usage, exit 2', async () => {
  const s = sandbox();
  const r = await s.run(['--bogus']);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown option --bogus/);
  assert.match(r.err, /testonce score/);
  s.done();
});

test('score time saved equals `report` for the same history (regression: it was 4-5x)', { skip: !(await import('node:fs')).existsSync(new URL('../src/addons/report.mjs', import.meta.url)) && 'report add-on not in this build' }, async () => {
  const s = sandbox();
  s.rec('x.test.mjs', [
    { at: '2026-10-10T10:00:00Z', ok: true, ms: 1000 },
    { at: '2026-10-10T11:00:00Z', ok: true, skipped: true, ms: 0, savedMs: 5000 },
    { at: '2026-10-10T12:00:00Z', ok: true, skipped: true, ms: 0, savedMs: 5000 },
  ]);
  const { all } = await import('../src/cache.mjs');
  const { summarize } = await import('../src/addons/report.mjs');
  const j = JSON.parse((await s.run(['--json'])).out);
  assert.equal(summarize(all(s.cacheDir)).savedMs, 2000);
  assert.equal(j.savedMs, 2000);
  assert.equal(j.skipsUncapped, 0);
  assert.match((await s.run([])).out, /same cap `report` applies/);
  // no earlier real run: the recorded figure is used and the text says so
  const u = sandbox();
  u.rec('y', [sk('2026-10-11T08:00:00Z', 5000)]);
  assert.match((await u.run([])).out, /1 skip had no earlier real run/);
  s.done(); u.done();
});
