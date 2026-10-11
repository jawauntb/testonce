// Levels, streaks, badges and the history tally: pure functions, no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
// The paid report add-on is absent from the free public build; its cross-checks run only where it exists.
const REPORT = new URL('../src/addons/report.mjs', import.meta.url);
const summarize = existsSync(REPORT) ? (await import(REPORT)).summarize : null;

import { LEVELS, HOUR_MS, DAY_MS, levelFor, hoursSaved, dayKey, streakFor, longestStreak, collect, badgesFor, BADGES } from '../src/gamify/levels.mjs';

const H = HOUR_MS;
const day = (n) => ({ skipped: n });
const NOW = Date.parse('2026-10-11T12:00:00Z');

test('levels: the seven thresholds, exact boundaries', () => {
  assert.deepEqual(LEVELS.map((l) => [l.name, l.minHours]), [['Spark', 0], ['Ember', 1], ['Flame', 10], ['Blaze', 50], ['Star', 100], ['Nova', 500], ['Singularity', 1000]]);
  const name = (ms) => levelFor(ms).name;
  assert.equal(name(0), 'Spark');
  assert.equal(name(H - 1), 'Spark');
  assert.equal(name(H), 'Ember');
  assert.equal(name(10 * H - 1), 'Ember');
  assert.equal(name(10 * H), 'Flame');
  assert.equal(name(50 * H), 'Blaze');
  assert.equal(name(100 * H), 'Star');
  assert.equal(name(500 * H - 1), 'Star');
  assert.equal(name(500 * H), 'Nova');
  assert.equal(name(1000 * H), 'Singularity');
  assert.equal(name(1e12), 'Singularity');
});

test('levelFor: progress and distance to the next level', () => {
  const l = levelFor(5.5 * H); // Ember covers 1 h to 10 h: 4.5 / 9 = 50%
  assert.equal(l.name, 'Ember');
  assert.equal(l.progress, 0.5);
  assert.deepEqual(l.next, { index: 2, name: 'Flame', atHours: 10, hoursToGo: 4.5 });
  assert.equal(levelFor(0).progress, 0);
  assert.equal(levelFor(30 * 60_000).progress, 0.5); // half an hour is half of Spark
  const top = levelFor(2000 * H);
  assert.equal(top.next, null);
  assert.equal(top.progress, 1);
});

test('levelFor and hoursSaved: junk in, Spark out', () => {
  for (const bad of [undefined, null, NaN, -5, 'x', Infinity]) assert.equal(levelFor(bad).name, 'Spark', String(bad));
  assert.equal(hoursSaved(90 * 60_000), 1.5);
  assert.equal(hoursSaved(undefined), 0);
});

test('streakFor: consecutive UTC days ending today or yesterday', () => {
  assert.equal(streakFor({}, NOW), 0);
  assert.equal(streakFor(undefined, NOW), 0);
  assert.equal(streakFor({ '2026-10-11': day(1) }, NOW), 1);
  assert.equal(streakFor({ '2026-10-10': day(1) }, NOW), 1, 'yesterday keeps it alive');
  assert.equal(streakFor({ '2026-10-09': day(1) }, NOW), 0, 'two days ago does not');
  assert.equal(streakFor({ '2026-10-11': day(2), '2026-10-10': day(1), '2026-10-09': day(5) }, NOW), 3);
  assert.equal(streakFor({ '2026-10-10': day(1), '2026-10-09': day(1), '2026-10-07': day(1) }, NOW), 2, 'a gap ends it');
  assert.equal(streakFor({ '2026-10-11': day(1), '2026-10-10': day(0), '2026-10-09': day(4) }, NOW), 1, 'a day with zero skips is a gap');
  // month and year boundaries
  assert.equal(streakFor({ '2026-10-01': day(1), '2026-09-30': day(1), '2026-09-29': day(1) }, Date.parse('2026-10-01T00:00:00Z')), 3);
  assert.equal(streakFor({ '2027-01-01': day(1), '2026-12-31': day(1) }, Date.parse('2027-01-01T23:59:59Z')), 2);
});

test('longestStreak: best run anywhere in the history', () => {
  assert.equal(longestStreak({}), 0);
  assert.equal(longestStreak({ '2026-01-05': day(1) }), 1);
  const week = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [dayKey(Date.parse('2026-03-01T00:00:00Z') + i * DAY_MS), day(1)]));
  assert.equal(longestStreak({ ...week, '2026-09-01': day(1), '2026-09-02': day(1) }), 7);
  assert.equal(longestStreak({ '2026-01-01': day(1), '2026-01-03': day(1), '2026-01-04': day(0), '2026-01-05': day(1) }), 1);
});

const sk = (at, savedMs) => ({ at, ok: true, ms: 0, skipped: true, savedMs });
const ran = (at, ms, ok = true, audit = false) => ({ at, ok, ms, audit });

test('collect: totals, daily buckets, mismatches, quarantine', () => {
  const t = collect([
    { name: 'a', history: [ran('2026-10-10T01:00:00Z', 1000), sk('2026-10-10T02:00:00Z', 1000), sk('2026-10-11T02:00:00Z', 2000), ran('2026-10-11T03:00:00Z', 500, false)] },
    { name: 'b', history: [ran('2026-10-11T04:00:00Z', 700, false, true)], quarantined: 'audit failed ...' },
    { name: 'c' },
    null, 'junk',
  ]);
  assert.equal(t.tests, 2);
  assert.equal(t.runs, 5);
  assert.equal(t.skipped, 2);
  assert.equal(t.ran, 3);
  assert.equal(t.failed, 2);
  assert.equal(t.savedMs, 2000, 'both skips are capped at the 1000 ms real run before them');
  assert.equal(t.uncapped, 0);
  assert.equal(t.ranMs, 2200);
  assert.equal(t.mismatches, 1);
  assert.equal(t.quarantined, 1);
  assert.deepEqual(t.daily, { '2026-10-10': { skipped: 1, savedMs: 1000 }, '2026-10-11': { skipped: 1, savedMs: 1000 } });
  assert.equal(t.latestMs, Date.parse('2026-10-11T04:00:00Z'));
});

test('collect: odd fields never throw or poison a sum', () => {
  const t = collect([{ name: 'x', history: [{ skipped: true, savedMs: NaN }, { skipped: true, savedMs: -4 }, { skipped: true, savedMs: '9' }, { at: 'not a date', ok: false, ms: 'x' }, null] }]);
  assert.equal(t.runs, 4);
  assert.equal(t.skipped, 3);
  assert.equal(t.savedMs, 0);
  assert.equal(t.ranMs, 0);
  assert.deepEqual(t.daily, {});
  assert.equal(t.latestMs, null);
  assert.equal(collect(undefined).runs, 0);
  assert.equal(collect({}).runs, 0);
});

test('collect: afterMs is strict and leaves out entries it cannot place', () => {
  const recs = [{ name: 'a', history: [sk('2026-10-10T00:00:00Z', 5), sk('2026-10-11T00:00:00Z', 7), { ok: true, ms: 1 }] }];
  const t = collect(recs, { afterMs: Date.parse('2026-10-10T00:00:00Z') });
  assert.equal(t.runs, 1);
  assert.equal(t.savedMs, 7);
  assert.equal(collect(recs, { afterMs: Date.parse('2026-10-11T00:00:00Z') }).runs, 0);
  assert.equal(collect(recs).runs, 3);
});

test('collect: skips are capped like `report` (regression: score/publish counted 4-5x report)', () => {
  const recs = [{ name: 'x.test.mjs', history: [
    { at: '2026-10-10T10:00:00Z', ok: true, ms: 1000 },
    { at: '2026-10-10T11:00:00Z', ok: true, skipped: true, ms: 0, savedMs: 5000 },
    { at: '2026-10-10T12:00:00Z', ok: true, skipped: true, ms: 0, savedMs: 5000 },
  ] }];
  if (summarize) assert.equal(summarize(recs).savedMs, 2000);
  assert.equal(collect(recs).savedMs, 2000);
  assert.equal(collect(recs).daily['2026-10-10'].savedMs, 2000);
  // a skip is never raised above its recorded savedMs
  assert.equal(collect([{ history: [ran('2026-10-10T10:00:00Z', 9000), sk('2026-10-10T11:00:00Z', 400)] }]).savedMs, 400);
  // the cap comes from the whole history, also when afterMs hides the real run
  assert.equal(collect(recs, { afterMs: Date.parse('2026-10-10T10:30:00Z') }).savedMs, 2000);
  // a failed run is not a cap; the nearest earlier PASSING run is
  const h = [ran('2026-10-10T09:00:00Z', 300), ran('2026-10-10T10:00:00Z', 8000, false), sk('2026-10-10T11:00:00Z', 5000)];
  assert.equal(collect([{ history: h }]).savedMs, 300);
  if (summarize) assert.equal(summarize([{ name: 'h', history: h }]).savedMs, 300);
  // with no earlier real run left, savedMs is used as is and counted
  const t = collect([{ history: [sk('2026-10-10T11:00:00Z', 5000)] }]);
  assert.equal(t.savedMs, 5000);
  assert.equal(t.uncapped, 1);
  // agrees with report's summarize on a mixed set, with and without a window
  const mixed = [...recs, { name: 'y', history: [sk('2026-10-09T00:00:00Z', 700), ran('2026-10-09T01:00:00Z', 50), sk('2026-10-09T02:00:00Z', 90), sk('2026-10-09T03:00:00Z', 10), { at: '2026-10-09T04:00:00Z', skipped: true, savedMs: NaN }] }];
  if (summarize) assert.equal(collect(mixed).savedMs, summarize(mixed).savedMs);
  if (summarize) assert.equal(collect(mixed).uncapped, summarize(mixed).skipsUncapped);
  const since = Date.parse('2026-10-09T02:00:00Z');
  if (summarize) assert.equal(collect(mixed, { afterMs: since - 1 }).savedMs, summarize(mixed, { sinceMs: since }).savedMs);
});

test('badges: each one earns exactly at its threshold', () => {
  const base = { skipped: 0, savedMs: 0, longestStreak: 0, mismatches: 0, quarantined: 0 };
  const earned = (s) => badgesFor({ ...base, ...s }).filter((b) => b.earned).map((b) => b.name);
  assert.deepEqual(BADGES.map((b) => b.name), ['First skip', '100 skips', 'Unbroken week', 'Zero wrong skips', 'Hour back']);
  assert.deepEqual(earned({}), [], 'nothing earned with no history, including Zero wrong skips');
  assert.deepEqual(earned({ skipped: 1 }), ['First skip', 'Zero wrong skips']);
  assert.ok(!earned({ skipped: 99 }).includes('100 skips'));
  assert.ok(earned({ skipped: 100 }).includes('100 skips'));
  assert.ok(!earned({ longestStreak: 6 }).includes('Unbroken week'));
  assert.ok(earned({ longestStreak: 7 }).includes('Unbroken week'));
  assert.ok(!earned({ savedMs: H - 1 }).includes('Hour back'));
  assert.ok(earned({ savedMs: H }).includes('Hour back'));
  assert.ok(!earned({ skipped: 50, mismatches: 1 }).includes('Zero wrong skips'));
  assert.ok(!earned({ skipped: 50, quarantined: 1 }).includes('Zero wrong skips'));
  const b = badgesFor(base)[0];
  assert.deepEqual(Object.keys(b).sort(), ['earned', 'how', 'id', 'name']);
});

test('levels agree with the hosted API\'s copy (server/lib/gamify.mjs)', async (t) => {
  const f = new URL('../server/lib/gamify.mjs', import.meta.url);
  if (!existsSync(f)) return t.skip('server copy not present');
  const srv = await import(f.href);
  assert.deepEqual(LEVELS, srv.LEVELS);
  for (const ms of [0, 1, H - 1, H, 5 * H, 10 * H, 49.9 * H, 100 * H, 777 * H, 1000 * H, 5000 * H]) assert.deepEqual(levelFor(ms), srv.levelFor(ms), `${ms}`);
  const daily = { '2026-10-11': day(1), '2026-10-10': day(1), '2026-10-08': day(1) };
  assert.equal(streakFor(daily, NOW), srv.streakFor(daily, NOW));
});
