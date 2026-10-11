// Paid modules are not in the free build. With TESTONCE_KEY set, fetch the ones the key covers from
// the testonce service and write them under the install root, where cli.mjs imports them from.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_API = 'https://testonce-production.up.railway.app';
// Only paid-module paths: a compromised server must never be able to overwrite the free core.
const SAFE = /^src\/(?:share|addons\/[a-z0-9_-]+|connectors\/[a-z0-9_-]+)\.mjs$/;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Downloads and writes the entitled files. -> the relative paths written.
// Throws an Error whose message is the whole story, one line, no stack needed.
export async function unlock({ key, api = DEFAULT_API, root = ROOT }) {
  let res;
  try {
    res = await fetch(`${api.replace(/\/+$/, '')}/v1/paid/files`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new Error(e?.name === 'TimeoutError' ? `${api} did not answer within 30 s` : `could not reach ${api} (${e?.cause?.code ?? e?.message ?? e})`);
  }
  if (res.status === 401) throw new Error('your TESTONCE_KEY was not accepted (unknown or revoked); the license page or your receipt has the current key');
  if (res.status === 429) throw new Error('too many download attempts from this address; try again in a few minutes');
  if (!res.ok) throw new Error(`${api} answered ${res.status}`);
  let files;
  try { ({ files } = await res.json()); } catch { throw new Error(`${api} sent a reply that is not JSON`); }
  if (!files || typeof files !== 'object') throw new Error(`${api} sent no files`);

  // Check every name before writing any of them.
  const entries = Object.entries(files);
  for (const [rel, text] of entries) {
    if (!SAFE.test(rel) || rel.includes('..') || rel.includes('//') || typeof text !== 'string') throw new Error(`refusing unexpected path from the server: ${JSON.stringify(rel).slice(0, 80)}`);
  }
  for (const [rel, text] of entries) {
    const dest = path.join(root, rel);
    try {
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, text);
    } catch (e) {
      const why = ['EACCES', 'EPERM', 'EROFS'].includes(e.code) ? '; install testonce somewhere writable, or use the GitHub Action, then retry' : '';
      throw new Error(`cannot write ${dest} (${e.code ?? e.message})${why}`);
    }
  }
  return entries.map(([rel]) => rel);
}
