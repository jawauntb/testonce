// src/unlock.mjs and the CLI's paid() path against a local fake service: no network, no real key.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlock } from '../src/unlock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => mkdtempSync(path.join(tmpdir(), 'testonce-unlock-'));

// Serves `reply(req)` -> [status, body] on a free port.
async function fake(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    const [status, body] = reply(req);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { api: `http://127.0.0.1:${server.address().port}`, seen, close: () => { server.closeAllConnections(); server.close(); } };
}
const files = (f) => () => [200, { version: '0', files: f }];

test('unlock writes the entitled files under the install root, with the key as bearer', async (t) => {
  const root = tmp();
  const svc = await fake(files({ 'src/share.mjs': 'export const x = 1;\n', 'src/addons/flaky.mjs': 'export const y = 2;\n' }));
  t.after(() => { svc.close(); rmSync(root, { recursive: true, force: true }); });
  const written = await unlock({ key: 'to_abc', api: svc.api, root });
  assert.deepEqual(written.sort(), ['src/addons/flaky.mjs', 'src/share.mjs']);
  assert.equal(readFileSync(path.join(root, 'src/share.mjs'), 'utf8'), 'export const x = 1;\n');
  assert.equal(readFileSync(path.join(root, 'src/addons/flaky.mjs'), 'utf8'), 'export const y = 2;\n');
  assert.deepEqual(svc.seen, [{ url: '/v1/paid/files', auth: 'Bearer to_abc' }]);
});

test('unlock refuses ../ and anything that is not a paid module (core files included), and writes nothing before refusing', async (t) => {
  const root = tmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const bad of ['../evil.mjs', 'src/../evil.mjs', 'src/../../evil.mjs', '/etc/evil.mjs', 'bin/testonce.mjs', 'src/evil.js', 'src/Evil.mjs', 'src//x.mjs', 'src/a b.mjs', 'package.json', '..', 'src/cli.mjs', 'src/inputs.mjs', 'src/unlock.mjs', 'src/addons/../cli.mjs']) {
    const svc = await fake(files({ [bad]: 'boom', 'src/addons/ok.mjs': 'ok' }));
    try {
      await assert.rejects(unlock({ key: 'k', api: svc.api, root }), /refusing unexpected path/, bad);
    } finally { svc.close(); }
    assert.ok(!existsSync(path.join(path.dirname(root), 'evil.mjs')) && !existsSync(path.join(root, 'src/addons/ok.mjs')), bad);
  }
  const svc = await fake(files({ 'src/addons/ok.mjs': 42 }));
  t.after(() => svc.close());
  await assert.rejects(unlock({ key: 'k', api: svc.api, root }), /refusing unexpected path/, 'non-string contents');
});

test('unlock turns 401, 429, 500, bad JSON, an unreachable host and a read-only root into one-line errors', async (t) => {
  const root = tmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const case_ = async (reply, pattern) => {
    const svc = await fake(reply);
    try { await assert.rejects(unlock({ key: 'k', api: svc.api, root }), pattern); } finally { svc.close(); }
  };
  await case_(() => [401, { ok: false, error: { code: 'invalid_license' } }], /TESTONCE_KEY was not accepted/);
  await case_(() => [429, {}], /too many download attempts/);
  await case_(() => [500, {}], /answered 500/);
  await case_(() => [200, 'not json'], /not JSON/);
  await case_(() => [200, { version: '1' }], /sent no files/);
  const dead = await fake(() => [200, {}]);
  const api = dead.api;
  dead.close();
  await assert.rejects(unlock({ key: 'k', api, root }), /could not reach/);
  // A root that cannot be written to (a file where the directory should be).
  const svc = await fake(files({ 'src/share.mjs': 'x' }));
  t.after(() => svc.close());
  writeFileSync(path.join(root, 'blocker'), 'a file, not a directory');
  await assert.rejects(unlock({ key: 'k', api: svc.api, root: path.join(root, 'blocker', 'nested') }), (e) => /^cannot write .*ENOTDIR/.test(e.message) && !/\n/.test(e.message));
});

// The whole path: a free install (no paid modules) + TESTONCE_KEY + a service that has them.
function freeInstall() {
  const dir = tmp();
  cpSync(path.join(HERE, '..', 'bin'), path.join(dir, 'bin'), { recursive: true });
  cpSync(path.join(HERE, '..', 'src'), path.join(dir, 'src'), { recursive: true });
  cpSync(path.join(HERE, '..', 'package.json'), path.join(dir, 'package.json'));
  rmSync(path.join(dir, 'src', 'share.mjs'), { force: true }); // absent in the public build
  rmSync(path.join(dir, 'src', 'addons'), { recursive: true, force: true });
  rmSync(path.join(dir, 'src', 'connectors'), { recursive: true, force: true });
  return dir;
}
function run(dir, args, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(dir, 'bin', 'testonce.mjs'), ...args], { cwd: dir, env: { ...process.env, TESTONCE_KEY: '', TESTONCE_API: '', ...env } });
    let err = '', out = '';
    c.stderr.on('data', (d) => (err += d));
    c.stdout.on('data', (d) => (out += d));
    c.on('exit', (code) => resolve({ code, err, out }));
  });
}

test('CLI: no key says how to buy; with a key the module is downloaded once and then runs', async (t) => {
  const dir = freeInstall();
  const svc = await fake(files({ 'src/addons/flaky.mjs': "export async function main(args) { console.log('flaky ran ' + args.join(',')); return 0; }\n" }));
  t.after(() => { svc.close(); rmSync(dir, { recursive: true, force: true }); });

  const none = await run(dir, ['flaky']);
  assert.equal(none.code, 2);
  assert.match(none.err, /paid features.*TESTONCE_KEY/s);
  assert.equal(svc.seen.length, 0);

  const ok = await run(dir, ['flaky', 'a', 'b'], { TESTONCE_KEY: 'to_good', TESTONCE_API: svc.api });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.out.trim(), 'flaky ran a,b');
  assert.ok(existsSync(path.join(dir, 'src/addons/flaky.mjs')));
  assert.equal(svc.seen.length, 1);
  await run(dir, ['flaky'], { TESTONCE_KEY: 'to_good', TESTONCE_API: svc.api });
  assert.equal(svc.seen.length, 1, 'already installed: no second download');
});

test('CLI: a key that does not cover the feature, a rejected key and a dead service: one line, exit 2, no stack', async (t) => {
  const dir = freeInstall();
  const svc = await fake((req) => (req.headers.authorization === 'Bearer to_good' ? [200, { version: '0', files: { 'src/share.mjs': 'export {};\n' } }] : [401, { ok: false }]));
  t.after(() => { svc.close(); rmSync(dir, { recursive: true, force: true }); });

  const notIncluded = await run(dir, ['flaky'], { TESTONCE_KEY: 'to_good', TESTONCE_API: svc.api });
  assert.equal(notIncluded.code, 2);
  assert.match(notIncluded.err, /`testonce flaky` is not included in your testonce plan\. See https:\/\//);

  const rejected = await run(dir, ['order'], { TESTONCE_KEY: 'to_revoked', TESTONCE_API: svc.api });
  assert.equal(rejected.code, 2);
  assert.match(rejected.err, /cannot unlock .*not accepted/);

  const api = svc.api;
  svc.close();
  const dead = await run(dir, ['mcp'], { TESTONCE_KEY: 'to_good', TESTONCE_API: api });
  assert.equal(dead.code, 2);
  assert.match(dead.err, /cannot unlock .*could not reach/);
  for (const r of [notIncluded, rejected, dead]) assert.doesNotMatch(r.err, /\n\s+at /, 'no stack trace');
});
