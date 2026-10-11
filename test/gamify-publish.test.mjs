// `testonce publish`: no network. fetch is injected; the OIDC and API calls are stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { save, all } from '../src/cache.mjs';
import { main, parseArgs, apiBase, summarizeSince, buildBody, USAGE, DEFAULT_API, MAX_SAVED_MS } from '../src/gamify/publish.mjs';

const H = 3_600_000;
const TOKEN_REQ = 'REQTOKEN-do-not-print';
const OIDC_JWT = 'eyJhbGciOi.OIDC-JWT-do-not-print.sig';
const SHA = 'a'.repeat(40);
const ACTIONS = {
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/abc/idtoken?api-version=2.0',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: TOKEN_REQ,
  GITHUB_REPOSITORY: 'acme/widgets',
  GITHUB_SHA: SHA,
};
const sk = (at, savedMs) => ({ at, ok: true, ms: 0, skipped: true, savedMs });
const ran = (at, ms, ok = true) => ({ at, ok, ms, audit: false });

// A fetch stub: first call is the token request, second is the API. `api` may be a function.
function stub({ token = { ok: true, status: 200, json: { value: OIDC_JWT } }, api = { status: 201, json: { ok: true, level: { name: 'Ember' }, levelUp: true, streak: 2, badge: 'https://x/badge.svg' } } } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const isToken = String(url).includes('idtoken');
    if (isToken && token instanceof Error) throw token;
    if (!isToken && api instanceof Error) throw api;
    const r = isToken ? token : api;
    const status = r.status ?? (r.ok ? 200 : 500);
    return { ok: status >= 200 && status < 300, status, headers: { get: (k) => r.headers?.[k.toLowerCase()] ?? null }, json: async () => { if (r.json === undefined) throw new Error('no body'); return r.json; } };
  };
  return { fetch, calls };
}

function sandbox() {
  const root = mkdtempSync(path.join(tmpdir(), 'testonce-publish-'));
  const cacheDir = path.join(root, '.testonce');
  const log = [];
  const run = (args, { env = ACTIONS, fetch } = {}) => main(args, { root, cfg: { cacheDir }, say: (m) => log.push(m), env, fetch: fetch ?? (async () => { throw new Error('network must not be touched'); }) }).then((code) => ({ code, log: log.join('\n') }));
  const rec = (name, history) => save(cacheDir, { name, entries: [], skips: 0, history });
  return { cacheDir, log, run, rec, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('USAGE is one line in the cli.mjs shape', () => {
  assert.match(USAGE, /^  testonce publish /);
  assert.ok(!USAGE.includes('\n'));
});

test('parseArgs: flags, = form, errors', () => {
  assert.deepEqual(parseArgs([]), { public: false, api: null, dryRun: false });
  assert.deepEqual(parseArgs(['--public', '--api', 'https://a.example', '--dry-run']), { public: true, api: 'https://a.example', dryRun: true });
  assert.equal(parseArgs(['--api=https://b.example']).api, 'https://b.example');
  for (const bad of [['--api'], ['--api='], ['--public=1'], ['--nope'], ['stray']]) assert.ok(parseArgs(bad).error, JSON.stringify(bad));
});

test('apiBase: https only, localhost may be http, no credentials, trailing slash trimmed', () => {
  assert.equal(apiBase('https://api.example.com/').url, 'https://api.example.com');
  assert.equal(apiBase('https://api.example.com/base//').url, 'https://api.example.com/base');
  assert.equal(apiBase('http://localhost:8080').url, 'http://localhost:8080');
  assert.equal(apiBase('http://127.0.0.1:3000').url, 'http://127.0.0.1:3000');
  for (const bad of ['http://api.example.com', 'ftp://x', 'nonsense', 'https://u:p@api.example.com']) assert.ok(apiBase(bad).error, bad);
});

test('summarizeSince: counts only entries after the cut, files = skipped + ran', () => {
  const recs = [{ name: 'a', history: [sk('2026-10-10T00:00:00Z', 100), sk('2026-10-11T00:00:00Z', 200), ran('2026-10-11T01:00:00Z', 50, false)] }, { name: 'b', history: [ran('2026-10-11T02:00:00Z', 30)] }];
  const all = summarizeSince(recs, null);
  assert.deepEqual([all.files, all.skipped, all.ran, all.failed, all.savedMs, all.ranMs], [4, 2, 2, 1, 300, 80]);
  const cut = summarizeSince(recs, Date.parse('2026-10-10T00:00:00Z'));
  assert.deepEqual([cut.files, cut.skipped, cut.ran, cut.failed, cut.savedMs, cut.ranMs], [3, 1, 2, 1, 200, 80]);
  assert.equal(cut.latestMs, Date.parse('2026-10-11T02:00:00Z'));
  assert.equal(summarizeSince(recs, Date.parse('2026-10-11T02:00:00Z')).files, 0);
  const big = summarizeSince([{ name: 'x', history: [sk('2026-10-11T00:00:00Z', 30 * H)] }], null);
  assert.equal(big.savedMs, MAX_SAVED_MS);
  assert.equal(big.capped, true);
  assert.equal(all.capped, false);
});

test('buildBody: exactly the nine documented keys, whatever the summary holds', () => {
  const s = { files: 3, skipped: 2, ran: 1, failed: 0, savedMs: 10, ranMs: 4, latestMs: 1, capped: false, name: 'tests/secret.test.mjs', paths: ['/home/x'] };
  const b = buildBody({ repo: 'a/b', sha: SHA, env: { SECRET: 'x' } }, s, false);
  assert.deepEqual(Object.keys(b), ['repo', 'sha', 'files', 'skipped', 'ran', 'failed', 'savedMs', 'ranMs', 'public']);
  assert.equal(b.public, false);
});

test('outside GitHub Actions: one line, exit 0, no network, no file written', async () => {
  const s = sandbox();
  s.rec('a', [sk('2026-10-11T00:00:00Z', 1000)]);
  for (const env of [{}, { GITHUB_REPOSITORY: 'a/b', GITHUB_SHA: SHA }, { ...ACTIONS, ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined }]) {
    const r = await s.run([], { env });
    assert.equal(r.code, 0);
  }
  assert.match(s.log[0], /only inside GitHub Actions/);
  assert.match(s.log[0], /id-token: write/);
  assert.ok(!s.log[0].includes('\n'));
  assert.ok(!existsSync(path.join(s.cacheDir, 'last-publish')));
  s.done();
});

test('malformed GITHUB_REPOSITORY or GITHUB_SHA: exit 0, nothing sent', async () => {
  const s = sandbox();
  s.rec('a', [sk('2026-10-11T00:00:00Z', 1000)]);
  assert.equal((await s.run([], { env: { ...ACTIONS, GITHUB_SHA: 'zzz' } })).code, 0);
  assert.equal((await s.run([], { env: { ...ACTIONS, GITHUB_REPOSITORY: 'nope' } })).code, 0);
  assert.equal(s.log.filter((l) => /missing or malformed/.test(l)).length, 2);
  s.done();
});

test('happy path: token request, then POST with exactly the counts; last-publish written', async () => {
  const s = sandbox();
  s.rec('tests/secret-name.test.mjs', [sk('2026-10-11T00:00:00Z', 5000), sk('2026-10-11T00:01:00Z', 7000), ran('2026-10-11T00:02:00Z', 3000, false)]);
  s.rec('tests/other.test.mjs', [ran('2026-10-11T00:03:00Z', 2000)]);
  const f = stub();
  const r = await s.run([], { fetch: f.fetch });
  assert.equal(r.code, 0);
  assert.equal(f.calls.length, 2);

  const [tok, post] = f.calls;
  const tu = new URL(tok.url);
  assert.equal(tu.origin + tu.pathname, 'https://pipelines.actions.githubusercontent.com/abc/idtoken');
  assert.equal(tu.searchParams.get('audience'), 'testonce');
  assert.equal(tu.searchParams.get('api-version'), '2.0', 'existing query kept');
  assert.equal(tok.init.headers.Authorization, `Bearer ${TOKEN_REQ}`);
  assert.equal(tok.init.method, undefined, 'GET');

  assert.equal(post.url, `${DEFAULT_API}/v1/runs`);
  assert.equal(post.init.method, 'POST');
  assert.equal(post.init.headers.Authorization, `Bearer ${OIDC_JWT}`);
  assert.equal(post.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(post.init.body), { repo: 'acme/widgets', sha: SHA, files: 4, skipped: 2, ran: 2, failed: 1, savedMs: 12000, ranMs: 5000, public: false });

  const last = readFileSync(path.join(s.cacheDir, 'last-publish'), 'utf8').trim();
  assert.equal(last, '2026-10-11T00:03:00.000Z');
  assert.match(r.log, /sent 2 skipped and 2 ran \(private\), level Ember \(level up!\), streak 2\. Badge: https:\/\/x\/badge\.svg/);
  s.done();
});

test('privacy: the body has no test names, paths or env values; secrets never reach the log', async () => {
  const s = sandbox();
  s.rec('tests/very-secret-name.test.mjs', [sk('2026-10-11T00:00:00Z', 5000)]);
  const f = stub();
  const r = await s.run([], { fetch: f.fetch, env: { ...ACTIONS, MY_SECRET: 'hunter2' } });
  const body = f.calls[1].init.body;
  for (const leak of ['very-secret-name', 'tests/', '.test.mjs', 'hunter2', 'MY_SECRET', TOKEN_REQ, OIDC_JWT, '/home', s.cacheDir]) assert.ok(!body.includes(leak), `body leaks ${leak}`);
  for (const leak of [TOKEN_REQ, OIDC_JWT, 'hunter2']) assert.ok(!r.log.includes(leak), `log leaks ${leak}`);
  s.done();
});

test('the next publish sends only what was recorded since the last one, and nothing when there is none', async () => {
  const s = sandbox();
  s.rec('a', [sk('2026-10-11T00:00:00Z', 1000)]);
  await s.run([], { fetch: stub().fetch });
  s.log.length = 0;

  const f2 = stub();
  const again = await s.run([], { fetch: f2.fetch });
  assert.equal(again.code, 0);
  assert.equal(f2.calls.length, 0, 'no new entries: no token request, no POST');
  assert.match(again.log, /nothing new since 2026-10-11T00:00:00.000Z/);

  s.rec('a', [sk('2026-10-11T00:00:00Z', 1000), sk('2026-10-11T00:05:00Z', 4000), ran('2026-10-11T00:06:00Z', 900)]);
  const f3 = stub();
  await s.run([], { fetch: f3.fetch });
  assert.deepEqual(JSON.parse(f3.calls[1].init.body), { repo: 'acme/widgets', sha: SHA, files: 2, skipped: 1, ran: 1, failed: 0, savedMs: 4000, ranMs: 900, public: false });
  s.done();
});

test('--public sends public: true; default sends public: false', async () => {
  const s = sandbox();
  s.rec('a', [sk('2026-10-11T00:00:00Z', 1000)]);
  const f = stub();
  await s.run(['--public'], { fetch: f.fetch });
  assert.equal(JSON.parse(f.calls[1].init.body).public, true);
  assert.match(s.log.join('\n'), /\(public\)/);
  s.done();
});

test('API URL: default constant, then TESTONCE_API, then --api', async () => {
  const s = sandbox();
  s.rec('a', [sk('2026-10-11T00:00:00Z', 1000)]);
  const post = async (args, env) => { const f = stub(); await s.run(args, { fetch: f.fetch, env: { ...ACTIONS, ...env } }); const u = f.calls[1].url; rmSync(path.join(s.cacheDir, 'last-publish'), { force: true }); return u; };
  assert.equal(await post([], {}), `${DEFAULT_API}/v1/runs`);
  assert.equal(await post([], { TESTONCE_API: 'https://env.example/' }), 'https://env.example/v1/runs');
  assert.equal(await post(['--api', 'https://flag.example'], { TESTONCE_API: 'https://env.example' }), 'https://flag.example/v1/runs');
  s.done();
});

test('an insecure --api is a usage error (2); a bad TESTONCE_API only warns (0); nothing is sent either way', async () => {
  const s = sandbox();
  s.rec('a', [sk('2026-10-11T00:00:00Z', 1000)]);
  assert.equal((await s.run(['--api', 'http://evil.example'])).code, 2);
  assert.equal((await s.run([], { env: { ...ACTIONS, TESTONCE_API: 'http://evil.example' } })).code, 0);
  assert.match(s.log.join('\n'), /must be https/);
  s.done();
});

test('network failure, timeout, bad token reply: warn, exit 0, last-publish untouched', async () => {
  const s = sandbox();
  s.rec('a', [sk('2026-10-11T00:00:00Z', 1000)]);
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const cases = [
    [stub({ api: refused }), /could not reach the API \(ECONNREFUSED\)/],
    [stub({ token: new Error('boom') }), /could not reach the API/],
    [stub({ token: { status: 403, json: { message: 'no' } } }), /could not get an identity token \(HTTP 403\)/],
    [stub({ token: { status: 200, json: {} } }), /could not get an identity token/],
    [stub({ token: { status: 200 } }), /could not get an identity token/],
  ];
  for (const [f, re] of cases) {
    s.log.length = 0;
    const r = await s.run([], { fetch: f.fetch });
    assert.equal(r.code, 0);
    assert.match(r.log, re);
    assert.ok(!existsSync(path.join(s.cacheDir, 'last-publish')));
  }
  s.done();
});

test('API errors (401, 400, 429, 500, non-JSON): warn with the reason, exit 0, runs kept for next time', async () => {
  const s = sandbox();
  s.rec('a', [sk('2026-10-11T00:00:00Z', 1000)]);
  const cases = [
    [{ status: 401, json: { error: { code: 'invalid_token', message: 'token audience must be "testonce"' } } }, /HTTP 401: token audience must be "testonce"/],
    [{ status: 400, json: { error: { code: 'invalid_run', message: 'skipped + ran must not exceed files' } } }, /HTTP 400: skipped \+ ran/],
    [{ status: 429, headers: { 'retry-after': '90' }, json: { error: { message: 'rate_limited' } } }, /HTTP 429: rate_limited \(retry in 90 s\)/],
    [{ status: 500 }, /HTTP 500\./],
  ];
  for (const [api, re] of cases) {
    s.log.length = 0;
    const r = await s.run([], { fetch: stub({ api }).fetch });
    assert.equal(r.code, 0);
    assert.match(r.log, re);
    assert.match(r.log, /next publish will include these runs/);
    assert.ok(!existsSync(path.join(s.cacheDir, 'last-publish')));
  }
  s.done();
});

test('a server-controlled error message is clipped to one line', async () => {
  const s = sandbox();
  s.rec('a', [sk('2026-10-11T00:00:00Z', 1000)]);
  const r = await s.run([], { fetch: stub({ api: { status: 400, json: { error: { message: `line1\nline2 ${'x'.repeat(500)}` } } } }).fetch });
  assert.equal(r.log.split('\n').length, 1);
  assert.ok(r.log.length < 400);
  s.done();
});

test('--dry-run prints the exact body, touches no network, works outside Actions, records nothing', async () => {
  const s = sandbox();
  s.rec('tests/a.test.mjs', [sk('2026-10-11T00:00:00Z', 1000), ran('2026-10-11T00:01:00Z', 300)]);
  const r = await s.run(['--dry-run'], { env: {} });
  assert.equal(r.code, 0);
  const json = JSON.parse(s.log.at(-1));
  assert.deepEqual(Object.keys(json), ['repo', 'sha', 'files', 'skipped', 'ran', 'failed', 'savedMs', 'ranMs', 'public']);
  assert.equal(json.files, 2);
  assert.ok(!existsSync(path.join(s.cacheDir, 'last-publish')));
  s.done();
});

test('empty cache: nothing to send, exit 0, no network', async () => {
  const s = sandbox();
  const r = await s.run([]);
  assert.equal(r.code, 0);
  assert.match(r.log, /nothing new/);
  s.done();
});

test('a huge first publish is capped at the API\'s limit, with a warning, and still goes through', async () => {
  const s = sandbox();
  s.rec('a', [sk('2026-10-11T00:00:00Z', 30 * H)]);
  const f = stub();
  const r = await s.run([], { fetch: f.fetch });
  assert.equal(JSON.parse(f.calls[1].init.body).savedMs, MAX_SAVED_MS);
  assert.match(r.log, /capped/);
  s.done();
});

test('bad arguments: message, usage, exit 2', async () => {
  const s = sandbox();
  const r = await s.run(['--bogus']);
  assert.equal(r.code, 2);
  assert.match(r.log, /unknown option --bogus/);
  assert.match(r.log, /testonce publish/);
  s.done();
});

test('publish sends the same capped savedMs as `report` (regression: it sent 4-5x)', async () => {
  const s = sandbox();
  s.rec('x.test.mjs', [ran('2026-10-10T10:00:00Z', 1000), sk('2026-10-10T11:00:00Z', 5000), sk('2026-10-10T12:00:00Z', 5000)]);
  const f = stub();
  await s.run([], { fetch: f.fetch });
  const body = JSON.parse(f.calls[1].init.body);
  assert.equal(body.savedMs, 2000);
  assert.equal(summarizeSince(all(s.cacheDir), null).savedMs, 2000);
  s.done();
});

test('no answer after the POST started: the run is not resent, so the server cannot count it twice', async () => {
  const s = sandbox();
  s.rec('a', [sk('2026-10-11T00:00:00Z', 1000)]);
  // A server that stores every POST it receives, then the client times out before the reply.
  let stored = 0;
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const lossy = async (url, init) => {
    if (String(url).includes('idtoken')) return { ok: true, status: 200, json: async () => ({ value: OIDC_JWT }) };
    stored++;
    throw timeout;
  };
  const r1 = await s.run([], { fetch: lossy });
  assert.equal(r1.code, 0);
  assert.equal(stored, 1);
  assert.match(r1.log, /may or may not have recorded/);
  assert.doesNotMatch(r1.log, /nothing sent/, 'it must not claim nothing was sent');
  assert.ok(existsSync(path.join(s.cacheDir, 'last-publish')), 'cursor moved past the ambiguous runs');
  // a later publish with new history sends only the new entry; the old one is not resent
  s.rec('b', [sk('2026-10-11T05:00:00Z', 2000)]);
  const f = stub();
  await s.run([], { fetch: f.fetch });
  assert.equal(JSON.parse(f.calls[1].init.body).skipped, 1);
  // and with nothing new there is no POST at all
  const g = stub();
  const r3 = await s.run([], { fetch: g.fetch });
  assert.equal(g.calls.length, 0);
  assert.match(r3.log, /nothing new/);
  s.done();
});

test('gateway timeouts (502, 504, 408) are ambiguous too; plain refusals and token failures stay retryable', async () => {
  for (const status of [502, 504, 408]) {
    const s = sandbox();
    s.rec('a', [sk('2026-10-11T00:00:00Z', 1000)]);
    const r = await s.run([], { fetch: stub({ api: { status } }).fetch });
    assert.match(r.log, new RegExp(`HTTP ${status}.*may or may not`));
    assert.ok(existsSync(path.join(s.cacheDir, 'last-publish')), String(status));
    s.done();
  }
  for (const status of [400, 401, 429, 500, 503]) {
    const s = sandbox();
    s.rec('a', [sk('2026-10-11T00:00:00Z', 1000)]);
    await s.run([], { fetch: stub({ api: { status } }).fetch });
    assert.ok(!existsSync(path.join(s.cacheDir, 'last-publish')), String(status));
    s.done();
  }
  // the identity-token step never reaches the API, whatever the error
  const s = sandbox();
  s.rec('a', [sk('2026-10-11T00:00:00Z', 1000)]);
  const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
  const r = await s.run([], { fetch: stub({ token: timeout }).fetch });
  assert.match(r.log, /nothing sent/);
  assert.ok(!existsSync(path.join(s.cacheDir, 'last-publish')));
  s.done();
});
