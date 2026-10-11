// Levels, streaks, badges and the history tally behind `testonce score` and `testonce publish`.
// Pure functions: no I/O, no clock (callers pass `nowMs`). Input is cache records as written by
// cache.mjs: { name, history: [{ at, ok, ms, skipped?, savedMs?, audit? }], quarantined? }.
// The levels match server/lib/gamify.mjs (test/gamify-levels.test.mjs checks the two agree).

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

// By hours of test time saved (the recorded duration of each skipped test's last passing run).
export const LEVELS = Object.freeze([
  { index: 0, name: 'Spark', minHours: 0 },
  { index: 1, name: 'Ember', minHours: 1 },
  { index: 2, name: 'Flame', minHours: 10 },
  { index: 3, name: 'Blaze', minHours: 50 },
  { index: 4, name: 'Star', minHours: 100 },
  { index: 5, name: 'Nova', minHours: 500 },
  { index: 6, name: 'Singularity', minHours: 1000 },
].map(Object.freeze));

const round = (x, dp) => Math.round(x * 10 ** dp) / 10 ** dp;
const num = (x) => (Number.isFinite(x) && x >= 0 ? x : 0);

export const hoursSaved = (savedMs) => round(num(savedMs) / HOUR_MS, 2);

// Compares integers (ms), not rounded hours, so 59 min 59.9 s is still Spark.
// -> { index, name, atHours, next: { index, name, atHours, hoursToGo } | null, progress: 0..1 }
export function levelFor(savedMs) {
  const ms = num(savedMs);
  let i = 0;
  while (i + 1 < LEVELS.length && ms >= LEVELS[i + 1].minHours * HOUR_MS) i++;
  const cur = LEVELS[i], next = LEVELS[i + 1] ?? null;
  const progress = next ? (ms - cur.minHours * HOUR_MS) / ((next.minHours - cur.minHours) * HOUR_MS) : 1;
  return {
    index: cur.index,
    name: cur.name,
    atHours: cur.minHours,
    next: next && { index: next.index, name: next.name, atHours: next.minHours, hoursToGo: round((next.minHours * HOUR_MS - ms) / HOUR_MS, 2) },
    progress: round(progress, 4),
  };
}

export const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayNumber = (key) => Math.floor(Date.parse(`${key}T00:00:00Z`) / DAY_MS);
const skipDays = (daily) => new Set(Object.entries(daily ?? {}).filter(([, b]) => b && b.skipped > 0).map(([k]) => dayNumber(k)));

// daily: { 'YYYY-MM-DD': { skipped } } -> consecutive UTC days with skipped > 0, counting back from
// today, or from yesterday when today has none yet (a streak is alive until a whole day passes
// without a skip). 0 when neither has one.
export function streakFor(daily, nowMs) {
  const days = skipDays(daily);
  const today = Math.floor(nowMs / DAY_MS);
  let d = days.has(today) ? today : days.has(today - 1) ? today - 1 : null;
  if (d === null) return 0;
  let n = 0;
  while (days.has(d)) { n++; d--; }
  return n;
}

// Longest run of consecutive UTC skip days anywhere in the history.
export function longestStreak(daily) {
  const days = [...skipDays(daily)].sort((a, b) => a - b);
  let best = 0, run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && days[i] === days[i - 1] + 1 ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

// Tally run history. With `afterMs`, only entries with a valid `at` strictly after it count (entries
// with no valid time cannot be placed, so they are left out). Never throws on odd records.
// History is newest-last and the cache keeps at most 30 entries per test, so this is that window,
// not lifetime totals.
// -> { tests, runs, skipped, ran, failed, savedMs, ranMs, mismatches, quarantined, daily, latestMs }
//   mismatches: ran entries that were audits and failed (same inputs passed before, failed now)
//   quarantined: records currently quarantined by an audit mismatch
//   daily: { 'YYYY-MM-DD': { skipped, savedMs } } (UTC), skipped entries with a valid time only
//   latestMs: newest `at` among the entries counted, or null
//   uncapped: skips with no earlier real run left in the history, counted at their recorded savedMs
// savedMs is capped exactly as `testonce report` caps it (src/addons/report.mjs summarize()): a
// skip's savedMs is the cache entry's `ms`, stamped after input hashing, so it is longer than the
// test. Each skip counts at most the `ms` of the nearest earlier passing real run in the whole
// history (also when `afterMs` hides that run). With none left in the 30 kept, savedMs is used as is.
export function collect(records, { afterMs = null } = {}) {
  const t = { tests: 0, runs: 0, skipped: 0, ran: 0, failed: 0, savedMs: 0, ranMs: 0, mismatches: 0, quarantined: 0, daily: {}, latestMs: null, uncapped: 0 };
  for (const rec of Array.isArray(records) ? records : []) {
    if (!rec || typeof rec !== 'object') continue;
    if (typeof rec.quarantined === 'string' && rec.quarantined) t.quarantined++;
    let counted = false;
    const hist = (Array.isArray(rec.history) ? rec.history : []).filter((h) => h && typeof h === 'object');
    let baseMs = null;
    const caps = hist.map((h) => {
      if (h.skipped) return baseMs;
      if (h.ok !== false && Number.isFinite(h.ms) && h.ms >= 0) baseMs = h.ms;
      return null;
    });
    for (const [idx, h] of hist.entries()) {
      const at = Date.parse(h.at);
      if (afterMs !== null && !(at > afterMs)) continue;
      counted = true;
      t.runs++;
      if (h.skipped) {
        let saved = num(h.savedMs);
        if (caps[idx] === null) { if (Number.isFinite(h.savedMs) && h.savedMs >= 0) t.uncapped++; } else saved = Math.min(saved, caps[idx]);
        t.skipped++; t.savedMs += saved;
        if (Number.isFinite(at)) {
          const b = (t.daily[dayKey(at)] ??= { skipped: 0, savedMs: 0 });
          b.skipped++; b.savedMs += saved;
        }
      } else {
        t.ran++; t.ranMs += num(h.ms);
        if (h.ok === false) { t.failed++; if (h.audit === true) t.mismatches++; }
      }
      if (Number.isFinite(at) && (t.latestMs === null || at > t.latestMs)) t.latestMs = at;
    }
    if (counted) t.tests++;
  }
  return t;
}

// Badges. `stats` = { skipped, savedMs, longestStreak, mismatches, quarantined }.
// "Zero wrong skips" means no audit mismatch and no quarantine is recorded. Audits sample (every
// 10th would-be skip by default), so this is "none detected", and it needs at least one skip to
// be about anything.
export const BADGES = Object.freeze([
  { id: 'first-skip', name: 'First skip', how: 'skip one test on identical inputs', test: (s) => s.skipped >= 1 },
  { id: 'hundred-skips', name: '100 skips', how: 'skip 100 test runs', test: (s) => s.skipped >= 100 },
  { id: 'unbroken-week', name: 'Unbroken week', how: 'skip at least one test on 7 UTC days in a row', test: (s) => s.longestStreak >= 7 },
  { id: 'zero-wrong-skips', name: 'Zero wrong skips', how: 'skip at least once with no audit mismatch or quarantine recorded', test: (s) => s.skipped >= 1 && s.mismatches === 0 && s.quarantined === 0 },
  { id: 'hour-back', name: 'Hour back', how: 'save 1 hour of test time', test: (s) => s.savedMs >= HOUR_MS },
]);

export const badgesFor = (stats) => BADGES.map((b) => ({ id: b.id, name: b.name, how: b.how, earned: !!b.test(stats) }));
