// testonce score: your level, streak and badges, and the time and money skipping saved, read from
// the run history testonce already keeps. Reads only; runs nothing; no network.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { all } from '../cache.mjs';
import { DEFAULT_PRICE_PER_MINUTE, PRICE_LABEL, fmtMs, fmtUsd, moneySaved } from '../price.mjs';
import { badgesFor, collect, hoursSaved, levelFor, longestStreak, streakFor } from './levels.mjs';

export const USAGE = '  testonce score [--json] [--price-per-minute USD]   your level, streak and badges, and the time and money skipping saved (estimates)';

const BAR_WIDTH = 20;

// -> { json, price, priceIsDefault } or { error }
export function parseArgs(args) {
  const o = { json: false, price: DEFAULT_PRICE_PER_MINUTE, priceIsDefault: true };
  for (let i = 0; i < args.length; i++) {
    let a = args[i], inline;
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    if (eq > 0) { inline = a.slice(eq + 1); a = a.slice(0, eq); }
    if (a === '--json' && inline === undefined) o.json = true;
    else if (a === '--price-per-minute') {
      const v = inline !== undefined ? inline : args[++i];
      const s = String(v ?? '').replace(/^\$/, '');
      const n = Number(s);
      if (s === '' || !Number.isFinite(n) || n < 0) return { error: `--price-per-minute needs a non-negative number of US dollars, got "${v ?? ''}"` };
      o.price = n; o.priceIsDefault = false;
    } else return { error: a.startsWith('-') ? `unknown option ${args[i]}` : `unexpected argument ${args[i]}` };
  }
  return o;
}

// "[#######-------------]" plus a floored percent, so 99.9% never reads as 100%.
export function progressBar(fraction, width = BAR_WIDTH) {
  const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  const filled = Math.floor(f * width);
  return { bar: `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`, percent: Math.floor(f * 100) };
}

// Color only on a terminal, and never when NO_COLOR is set to anything non-empty (no-color.org).
export const useColor = ({ isTTY, env }) => !!isTTY && !(env.NO_COLOR !== undefined && env.NO_COLOR !== '');

// all() throws on one corrupt record file; survive that and say what was skipped.
export function readRecords(cacheDir, say, tag = 'score') {
  try { return all(cacheDir); } catch { /* fall through to a per-file read */ }
  const d = path.join(cacheDir, 'tests');
  const recs = [];
  let bad = 0;
  for (const f of existsSync(d) ? readdirSync(d).filter((x) => x.endsWith('.json')) : []) {
    try { recs.push(JSON.parse(readFileSync(path.join(d, f), 'utf8'))); } catch { bad++; }
  }
  say(`${tag}: skipped ${bad} unreadable record file${bad === 1 ? '' : 's'} in ${d}`);
  return recs;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const hrs = (h) => `${Number.isInteger(h) ? h : h.toFixed(1)} h`;

// The whole score as data (this is `--json`).
export function buildScore(records, { price, priceIsDefault = true, nowMs }) {
  const t = collect(records);
  const streak = streakFor(t.daily, nowMs), best = longestStreak(t.daily);
  const level = levelFor(t.savedMs);
  const badges = badgesFor({ skipped: t.skipped, savedMs: t.savedMs, longestStreak: best, mismatches: t.mismatches, quarantined: t.quarantined });
  return {
    estimate: true,
    window: 'retained run history (the cache keeps the last 30 runs per test)',
    tests: t.tests,
    runs: t.runs, skipped: t.skipped, ran: t.ran, failed: t.failed,
    skipRate: t.runs ? t.skipped / t.runs : null,
    savedMs: t.savedMs,
    skipsUncapped: t.uncapped,
    hoursSaved: hoursSaved(t.savedMs),
    pricePerMinute: price,
    priceBasis: priceIsDefault ? PRICE_LABEL : 'price you gave',
    estimatedUsdSaved: moneySaved(t.savedMs, price),
    level,
    streak, longestStreak: best,
    auditMismatches: t.mismatches, quarantined: t.quarantined,
    badges,
  };
}

export function renderText(s, { color = false } = {}) {
  const p = (code) => (x) => (color ? `\x1b[${code}m${x}\x1b[0m` : x);
  const bold = p('1'), green = p('32'), dim = p('2'), cyan = p('1;36');
  const L = [];
  const row = (k, v) => L.push(`  ${k.padEnd(12)}  ${v}`);
  const { bar, percent } = progressBar(s.level.progress);
  const fill = bar.replace(/#+/, (m) => green(m));
  L.push(bold('testonce score'), '');
  row('Level', `${cyan(s.level.name)} (level ${s.level.index + 1} of 7)`);
  row('', s.level.next
    ? `${fill} ${percent}%   ${hrs(s.level.next.hoursToGo)} to ${s.level.next.name} (${hrs(s.level.next.atHours)})`
    : `${fill} top level`);
  row('Time saved', `~${fmtMs(s.savedMs)} (estimate)`);
  row('Money saved', `~${fmtUsd(s.estimatedUsdSaved)} (estimate: ${(s.savedMs / 60000).toFixed(2)} min x $${s.pricePerMinute}/min, ${s.priceBasis})`);
  row('Test runs', s.runs
    ? `${s.runs} (${s.skipped} skipped, ${s.ran} ran, ${s.failed} failed), skip rate ${(100 * s.skipRate).toFixed(1)}%`
    : 'none recorded yet');
  row('Streak', s.streak
    ? `${plural(s.streak, 'day')} in a row (best ${s.longestStreak})`
    : `0 days${s.longestStreak ? ` (best ${s.longestStreak})` : ''}: skip a test today to start one`);
  const earned = s.badges.filter((b) => b.earned).length;
  row('Badges', `${earned} of ${s.badges.length}`);
  L.push('');
  const w = Math.max(...s.badges.map((b) => b.name.length));
  for (const b of s.badges) L.push(b.earned ? `  ${green('[x]')} ${bold(b.name)}` : `  ${dim('[ ]')} ${dim(b.name.padEnd(w))}  ${dim(`to earn: ${b.how}`)}`);
  L.push('');
  L.push('Estimates from your local run history, not billing. Each skip counts at most the duration of the real run before it (the same cap `report` applies), so this matches `report`, but that run was traced with strace and is longer than an untraced one.');
  if (s.skipsUncapped) L.push(`${plural(s.skipsUncapped, 'skip')} had no earlier real run left in the retained history, so the cache entry's recorded duration is used; it includes input-hashing time and can overstate that skip's saving.`);
  L.push('Money is time saved x the price per minute shown; CI bills job minutes and tests run in parallel, so real savings differ.');
  L.push('The cache keeps the last 30 runs per test, so totals, streaks and badges cover that window, not your lifetime.');
  if (s.badges.find((b) => b.id === 'zero-wrong-skips')?.earned) L.push('"Zero wrong skips" means no audit mismatch or quarantine is recorded. Audits sample the skips; they do not check every one.');
  return `${L.join('\n')}\n`;
}

export async function main(args, { root, cfg, say, out = (s) => process.stdout.write(s), env = process.env, isTTY = process.stdout.isTTY, now = Date.now }) {
  const o = parseArgs(args);
  if (o.error) { say(`score: ${o.error}`); say(USAGE.trim()); return 2; }
  const records = readRecords(cfg.cacheDir, say);
  const s = buildScore(records, { price: o.price, priceIsDefault: o.priceIsDefault, nowMs: now() });
  if (!o.json && !s.runs) say('score: nothing recorded yet. Run your tests under `testonce each` first; this reads the history that writes.');
  out(o.json ? `${JSON.stringify(s, null, 2)}\n` : renderText(s, { color: useColor({ isTTY, env }) }));
  return 0;
}
