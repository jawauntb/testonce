#!/usr/bin/env node
// Re-hash the results and versions files a receipt names and compare them with the receipt's sha256 values.
//   node bench/rtl/check-receipt.mjs bench/results/rtl/receipt-*.json
// Exit 0 when every file matches. The harness and wrapper hashes are reported against this checkout, which only
// matches when it is at the receipt's testonce_git_head (see `git log` for when each file last changed).
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
let bad = 0;
for (const f of process.argv.slice(2)) {
  const r = JSON.parse(readFileSync(f, 'utf8'));
  const dir = path.dirname(f);
  for (const [name, want] of Object.entries(r.sha256)) {
    const local = name.startsWith('out/') ? path.join(dir, path.basename(name)) : name;
    if (!existsSync(local)) { console.log(`${path.basename(f)}: ${name}: not here`); continue; }
    const ok = sha(local) === want;
    const data = name.startsWith('out/');
    if (!ok && data) bad++;
    console.log(`${path.basename(f)}: ${name}: ${ok ? 'match' : data ? 'MISMATCH' : 'differs from this checkout'}`);
  }
}
process.exit(bad ? 1 : 0);
