// testonce publish: post this CI run's summary (counts only) to the hosted API, from GitHub Actions.
// Sends exactly: repo, sha, files, skipped, ran, failed, savedMs, ranMs, public. Never a file path,
// test name, environment variable or any code. Publishing is a courtesy: when it is unavailable
// (not in Actions, no id-token permission, offline, server error) it says why and exits 0.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collect } from './levels.mjs';
import { readRecords } from './score.mjs';

export const USAGE = '  testonce publish [--public] [--api URL] [--dry-run]   post this run\'s counts (no paths, names or code) to the hosted API from GitHub Actions';

// Placeholder: the orchestrator sets the real hosted URL here. Override with TESTONCE_API or --api.
export const DEFAULT_API = 'https://testonce-production.up.railway.app';
export const AUDIENCE = 'testonce';
export const LAST_PUBLISH = 'last-publish';
export const TIMEOUT_MS = 10_000;
// Gateway statuses that mean "I stopped waiting", not "the server refused": the run may be stored.
const AMBIGUOUS_STATUS = new Set([408, 502, 504]);
// Connection errors that happen before any byte of the request is delivered: safe to retry later.
const NOT_DELIVERED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']);
// The hosted API rejects a run above these (server/lib/app.mjs). Clamped here so one big first
// publish does not fail forever; the warning says when it happened.
export const MAX_SAVED_MS = 24 * 3_600_000;
export const MAX_RAN_MS = 7 * 24 * 3_600_000;

// -> { public, api, dryRun } or { error }
export function parseArgs(args) {
  const o = { public: false, api: null, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    let a = args[i], inline;
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    if (eq > 0) { inline = a.slice(eq + 1); a = a.slice(0, eq); }
    if (a === '--public' && inline === undefined) o.public = true;
    else if (a === '--dry-run' && inline === undefined) o.dryRun = true;
    else if (a === '--api') {
      const v = inline !== undefined ? inline : args[++i];
      if (!v) return { error: '--api needs a URL' };
      o.api = v;
    } else return { error: a.startsWith('-') ? `unknown option ${args[i]}` : `unexpected argument ${args[i]}` };
  }
  return o;
}

// https only (the OIDC token goes with the request), except a local server for development.
export function apiBase(raw) {
  let u;
  try { u = new URL(raw); } catch { return { error: `"${raw}" is not a URL` }; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return { error: `API URL must be https (http is allowed only for localhost), got "${raw}"` };
  if (u.username || u.password) return { error: 'API URL must not contain credentials' };
  return { url: `${u.origin}${u.pathname.replace(/\/+$/, '')}` };
}

// The run summary: history entries recorded after afterMs. files = skipped + ran (one per test run).
// -> { files, skipped, ran, failed, savedMs, ranMs, latestMs, capped }
export function summarizeSince(records, afterMs) {
  const t = collect(records, { afterMs });
  const capped = t.savedMs > MAX_SAVED_MS || t.ranMs > MAX_RAN_MS;
  return {
    files: t.skipped + t.ran, skipped: t.skipped, ran: t.ran, failed: t.failed,
    savedMs: Math.min(Math.round(t.savedMs), MAX_SAVED_MS), ranMs: Math.min(Math.round(t.ranMs), MAX_RAN_MS),
    latestMs: t.latestMs, capped,
  };
}

// The request body. Built field by field from this whitelist, so nothing else can leak into it.
export const buildBody = ({ repo, sha }, s, isPublic) => ({
  repo, sha, files: s.files, skipped: s.skipped, ran: s.ran, failed: s.failed, savedMs: s.savedMs, ranMs: s.ranMs, public: !!isPublic,
});

const lastPublishFile = (cacheDir) => path.join(cacheDir, LAST_PUBLISH);
function readLastPublish(cacheDir) {
  try { const ms = Date.parse(readFileSync(lastPublishFile(cacheDir), 'utf8').trim()); return Number.isFinite(ms) ? ms : null; } catch { return null; }
}

const clip = (x) => String(x).replace(/[\r\n]+/g, ' ').slice(0, 200);
async function readJson(res) { try { return await res.json(); } catch { return null; } }

export async function main(args, { root, cfg, say, env = process.env, fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS }) {
  const o = parseArgs(args);
  if (o.error) { say(`publish: ${o.error}`); say(USAGE.trim()); return 2; }
  const raw = o.api ?? env.TESTONCE_API ?? DEFAULT_API;
  const base = apiBase(raw);
  if (base.error) { say(`publish: ${base.error}`); return o.api ? 2 : 0; }

  const reqUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL, reqToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const repo = env.GITHUB_REPOSITORY, sha = env.GITHUB_SHA;
  if (!o.dryRun) {
    if (!reqUrl || !reqToken) {
      say('publish: nothing sent. This runs only inside GitHub Actions, and the job needs `permissions: id-token: write` to get the identity token.');
      return 0;
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !/^[0-9a-f]{7,64}$/i.test(sha ?? '')) {
      say('publish: nothing sent. GITHUB_REPOSITORY or GITHUB_SHA is missing or malformed.');
      return 0;
    }
  }

  const after = readLastPublish(cfg.cacheDir);
  const s = summarizeSince(readRecords(cfg.cacheDir, say, 'publish'), after);
  if (!s.files) { say(`publish: nothing new since ${after === null ? 'the beginning' : new Date(after).toISOString()}, nothing sent.`); return 0; }
  const body = buildBody({ repo: repo ?? '(GITHUB_REPOSITORY)', sha: sha ?? '(GITHUB_SHA)' }, s, o.public);
  if (s.capped) say('publish: this summary is above the API\'s per-run limit, so savedMs / ranMs are capped at it.');
  if (o.dryRun) { say(`publish: dry run, would POST to ${base.url}/v1/runs (nothing sent, nothing recorded):`); say(JSON.stringify(body)); return 0; }

  const advance = () => {
    mkdirSync(cfg.cacheDir, { recursive: true });
    writeFileSync(lastPublishFile(cfg.cacheDir), `${new Date(s.latestMs ?? Date.now()).toISOString()}\n`);
  };
  let posted = false; // true once the POST has started: after that, the server may have stored the run
  try {
    const tu = new URL(reqUrl);
    tu.searchParams.set('audience', AUDIENCE);
    const tr = await fetch(tu, { headers: { Authorization: `Bearer ${reqToken}`, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    const tj = tr.ok ? await readJson(tr) : null;
    if (!tj || typeof tj.value !== 'string' || !tj.value) { say(`publish: could not get an identity token (HTTP ${tr.status}); nothing sent.`); return 0; }

    posted = true;
    const res = await fetch(`${base.url}/v1/runs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tj.value}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await readJson(res);
    if (!res.ok) {
      if (AMBIGUOUS_STATUS.has(res.status)) {
        // A gateway gave up waiting; the server may still have stored the run.
        try { advance(); } catch { /* the line below says what happened */ }
        say(`publish: the API answered HTTP ${res.status}; it may or may not have recorded this run. These runs are not sent again, so they are never counted twice.`);
        return 0;
      }
      const why = j?.error?.message ?? j?.message ?? j?.error ?? '';
      say(`publish: the API said HTTP ${res.status}${why ? `: ${clip(typeof why === 'string' ? why : JSON.stringify(why))}` : ''}${res.status === 429 && res.headers?.get?.('retry-after') ? ` (retry in ${clip(res.headers.get('retry-after'))} s)` : ''}. Nothing recorded; the next publish will include these runs.`);
      return 0;
    }
    try { advance(); } catch (e) { say(`publish: sent, but could not write ${lastPublishFile(cfg.cacheDir)}: ${e.message}. The next publish may repeat these runs.`); }
    const lvl = j?.level?.name ? `, level ${clip(j.level.name)}${j.levelUp ? ' (level up!)' : ''}` : '';
    const streak = Number.isInteger(j?.streak) ? `, streak ${j.streak}` : '';
    say(`publish: sent ${s.skipped} skipped and ${s.ran} ran (${o.public ? 'public' : 'private'})${lvl}${streak}.${typeof j?.badge === 'string' ? ` Badge: ${clip(j.badge)}` : ''}`);
  } catch (e) {
    const code = e?.cause?.code ?? e?.code;
    const why = clip(code ?? e?.name ?? 'error');
    if (!posted || NOT_DELIVERED.has(code)) say(`publish: could not reach the API (${why}); nothing sent. The next publish will include these runs. Your tests are unaffected.`);
    else {
      // The request left this machine and no answer came back: the server may have stored it.
      // Resending would count it twice (the API has no idempotency key), so these runs are dropped
      // from the next publish. An undercount is the safe error for a leaderboard.
      try { advance(); } catch { /* best effort */ }
      say(`publish: no answer from the API (${why}); it may or may not have recorded this run. These runs are not sent again, so they are never counted twice. Your tests are unaffected.`);
    }
  }
  return 0;
}
