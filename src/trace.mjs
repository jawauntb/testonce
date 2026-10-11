// Run a command under strace and turn the syscall log into an access record:
// which paths it read, listed, probed and wrote, which programs it ran, and where it connected.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SYSCALLS = [
  'open', 'openat', 'openat2', 'creat', 'stat', 'lstat', 'newfstatat', 'statx', 'access', 'faccessat',
  'faccessat2', 'readlink', 'readlinkat', 'execve', 'execveat', 'connect', 'sendto', 'sendmsg',
  'rename', 'renameat', 'renameat2', 'unlink', 'unlinkat', 'mkdir', 'mkdirat', 'rmdir', 'truncate',
  'link', 'linkat', 'symlink', 'symlinkat', 'chmod', 'fchmodat', 'utimensat',
  'chdir', 'fchdir', 'clone', 'clone3', 'fork', 'vfork',
];

// A command that exists on any Linux image, to trace in the probes below.
const TRUE_CMD = ['/bin/true', '/usr/bin/true'].find((f) => existsSync(f));
const probeCmd = TRUE_CMD ? [TRUE_CMD] : [process.execPath, '-e', ''];

// Can this machine trace a child? Returns {ok, reason, version?, detail}. reason is one of
// 'platform' | 'missing' | 'ptrace' when not ok. Used by `doctor` and by the fallback notice.
export function probeTrace(env = process.env) {
  if (process.platform !== 'linux') return { ok: false, reason: 'platform', detail: `${process.platform} has no strace` };
  const v = spawnSync('strace', ['-V'], { encoding: 'utf8', env });
  if (v.error) return { ok: false, reason: 'missing', detail: 'strace not found on PATH' };
  const version = (v.stdout || '').split('\n')[0].trim() || 'unknown version';
  const dir = mkdtempSync(path.join(tmpdir(), 'testonce-probe-'));
  const log = path.join(dir, 'strace.log');
  const r = spawnSync('strace', ['-f', '-qq', '-e', 'trace=execve', '-o', log, ...probeCmd], { encoding: 'utf8', env });
  let text = '';
  try { text = readFileSync(log, 'utf8'); } catch {}
  rmSync(dir, { recursive: true, force: true });
  // Exit 0 is not enough: a wrapper that exits 0 but traced nothing would cache everything as "reads no files".
  if (r.status === 0 && /execve\(/.test(text)) return { ok: true, version };
  const detail = (r.stderr || '').trim().split('\n')[0] || `strace exited ${r.status ?? r.signal ?? 'abnormally'}`;
  return { ok: false, reason: 'ptrace', version, detail };
}

// --seccomp-bpf only makes tracing faster; caching works without it.
export function probeSeccomp(env = process.env) {
  const r = spawnSync('strace', ['--seccomp-bpf', '-f', '-qq', '-o', '/dev/null', ...probeCmd], { encoding: 'utf8', env });
  return r.status === 0 ? { ok: true } : { ok: false, detail: (r.stderr || '').trim().split('\n')[0] || `strace exited ${r.status}` };
}

let status;
export function traceStatus() { return (status ??= probeTrace()); }
export const canTrace = () => traceStatus().ok;

export async function traced(argv, { cwd = process.cwd(), env = process.env } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'testonce-'));
  const log = path.join(dir, 'strace.log');
  const args = ['-f', '-y', '-qq', '-s', '65535', '-e', 'signal=none', '-e', `trace=${SYSCALLS.join(',')}`, '-o', log];
  if (probeSeccomp().ok) args.unshift('--seccomp-bpf');
  const code = await new Promise((resolve) => {
    const child = spawn('strace', [...args, '--', ...argv], { cwd, env, stdio: 'inherit' });
    child.on('exit', (c, sig) => resolve(sig ? 128 + 1 : c ?? 1));
    child.on('error', () => resolve(127));
  });
  let text = '';
  try { text = readFileSync(log, 'utf8'); } catch {}
  rmSync(dir, { recursive: true, force: true });
  return { code, accesses: parse(text, cwd) };
}

// ---- parsing ----

// Read a C-escaped string literal starting at s[i] === '"'. Returns [value, nextIndex].
function str(s, i) {
  let out = '';
  for (i++; i < s.length && s[i] !== '"'; i++) {
    if (s[i] !== '\\') { out += s[i]; continue; }
    const c = s[++i];
    if (c === 'n') out += '\n'; else if (c === 't') out += '\t'; else if (c === 'r') out += '\r';
    else if (c === 'x') { out += String.fromCharCode(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else if (c >= '0' && c <= '7') { let j = i; while (j < i + 3 && s[j] >= '0' && s[j] <= '7') j++; out += String.fromCharCode(parseInt(s.slice(i, j), 8)); i = j - 1; }
    else out += c;
  }
  if (s[i + 1] === '.' && s[i + 2] === '.' && s[i + 3] === '.') i += 3; // truncated string
  return [out, i + 1];
}

// Split the top-level comma-separated arguments of a syscall.
export function splitArgs(s) {
  const args = [];
  let depth = 0, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') { const [, j] = str(s, i); cur += s.slice(i, j); i = j - 1; continue; }
    if (c === '<') { const j = s.indexOf('>', i); if (j > 0 && depth === 0 && /^\d|AT_FDCWD$/.test(cur.trim())) { cur += s.slice(i, j + 1); i = j; continue; } }
    if ('{[('.includes(c)) depth++;
    if ('}])'.includes(c)) depth--;
    if (c === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

const lit = (a) => (a && a[0] === '"' ? str(a, 0)[0] : null);
const fdPath = (a) => { const m = /<(.*)>$/.exec(a || ''); return m ? m[1] : null; };

// Join "<unfinished ...>" / "<... resumed>" fragments and yield {pid, name, args, ret}.
export function* calls(text) {
  const pending = new Map();
  for (const raw of text.split('\n')) {
    const m = /^(\d+)\s+(.*)$/.exec(raw);
    if (!m) continue;
    const pid = m[1];
    let line = m[2];
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.endsWith('<unfinished ...>')) { pending.set(pid, line.slice(0, -'<unfinished ...>'.length)); continue; }
    const r = /^<\.\.\. \w+ resumed>(.*)$/.exec(line);
    if (r) { line = (pending.get(pid) ?? '') + r[1]; pending.delete(pid); }
    const open = line.indexOf('(');
    // strace pads the return column, e.g. `<... execve resumed>)    = 0`; take the last `)  = `.
    let eq = -1, len = 0;
    for (const m of line.matchAll(/\)\s+= /g)) { eq = m.index; len = m[0].length; }
    if (open < 0 || eq < 0) continue;
    yield { pid, name: line.slice(0, open), args: splitArgs(line.slice(open + 1, eq)), ret: line.slice(eq + len).trim() };
  }
}

// The type strace saw at the moment of a stat, from st_mode / stx_mode.
const typeFrom = (args) => {
  const m = /(?:st|stx)_mode=S_IF(\w+)/.exec(args.join(', '));
  // Only regular files and directories: an lstat of a symlink reports LNK while the later check
  // follows the link, so recording LNK would never match again (a rerun every time, never a skip).
  return m && (m[1] === 'REG' || m[1] === 'DIR') ? { type: m[1] === 'REG' ? 'file' : 'dir' } : undefined;
};
const ok = (ret) => !ret.startsWith('-1') && ret !== '?';
const enoent = (ret) => /^-1 (ENOENT|ENOTDIR)/.test(ret);

// Turn calls into ordered access events: {kind, path} with kind in
// read | list | stat | absent | write | exec | net.
export function parse(text, cwd) {
  const events = [];
  const cwds = new Map(); // pid -> working directory, inherited on fork, moved by chdir
  let pid;
  const here = () => cwds.get(pid) ?? cwd;
  const at = (dirArg, p) => {
    if (p == null) return null;
    const base = fdPath(dirArg);
    if (base && dirArg.startsWith('AT_FDCWD')) cwds.set(pid, base);
    return path.resolve(base ?? here(), p);
  };
  const noDir = (p) => (p == null ? null : path.resolve(here(), p)); // non-*at calls carry no dirfd annotation
  const push = (kind, p, extra) => { if (p) events.push({ kind, path: p, ...extra }); };

  for (const c of calls(text)) {
    const { name, args, ret } = c;
    pid = c.pid;
    switch (name) {
      case 'clone': case 'clone3': case 'fork': case 'vfork':
        if (/^\d+$/.test(ret)) cwds.set(ret, here()); break;
      case 'chdir': if (ok(ret)) cwds.set(pid, noDir(lit(args[0]))); break;
      case 'fchdir': if (ok(ret) && fdPath(args[0])) cwds.set(pid, fdPath(args[0])); break;
      case 'open': case 'openat': case 'openat2': case 'creat': {
        const p = name === 'open' || name === 'creat' ? noDir(lit(args[0])) : at(args[0], lit(args[1]));
        const flags = name === 'creat' ? 'O_WRONLY|O_CREAT|O_TRUNC' : (name === 'open' ? args[1] : args[2]) || '';
        if (!ok(ret)) { if (enoent(ret)) push('absent', p); continue; }
        if (flags.includes('O_PATH')) push('stat', p);
        else if (/O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND/.test(flags)) {
          if (flags.includes('O_RDWR') && !/O_CREAT|O_TRUNC/.test(flags)) push('read', p);
          push('write', p);
        } else push(flags.includes('O_DIRECTORY') ? 'list' : 'read', p);
        break;
      }
      case 'stat': case 'lstat': case 'access': case 'readlink': {
        const p = noDir(lit(args[0]));
        if (ok(ret)) push('stat', p, typeFrom(args)); else if (enoent(ret)) push('absent', p);
        break;
      }
      case 'newfstatat': case 'statx': case 'faccessat': case 'faccessat2': case 'readlinkat': {
        const rel = lit(args[1]);
        if (rel === '') continue; // fd-relative (AT_EMPTY_PATH): already counted at open
        const p = at(args[0], rel);
        if (ok(ret)) push('stat', p, typeFrom(args)); else if (enoent(ret)) push('absent', p);
        break;
      }
      case 'execve': case 'execveat': {
        const p = name === 'execve' ? noDir(lit(args[0])) : at(args[0], lit(args[1]));
        if (ok(ret)) push('exec', p); else if (enoent(ret)) push('absent', p);
        break;
      }
      case 'rename': case 'link': case 'symlink':
        push('write', noDir(lit(args[0]))); push('write', noDir(lit(args[1]))); break;
      case 'renameat': case 'renameat2': case 'linkat':
        push('write', at(args[0], lit(args[1]))); push('write', at(args[2], lit(args[3]))); break;
      case 'symlinkat': push('write', at(args[1], lit(args[2]))); break;
      case 'unlink': case 'rmdir': case 'mkdir': case 'truncate': case 'chmod':
        if (ok(ret)) push('write', noDir(lit(args[0]))); break;
      case 'unlinkat': case 'mkdirat': case 'fchmodat': case 'utimensat':
        if (ok(ret) && lit(args[1])) push('write', at(args[0], lit(args[1]))); break;
      case 'connect': case 'sendto': case 'sendmsg': {
        const addr = network(args.join(', '));
        // A unix socket that isn't there (glibc probing nscd) is an absent path, not a connection.
        if (addr && addr.startsWith('unix:') && !ok(ret)) push('absent', addr.slice(5));
        else if (addr) events.push({ kind: 'net', path: addr });
        break;
      }
    }
  }
  return events;
}

// Non-loopback IP destinations, and unix sockets at filesystem paths, count as the outside world.
export function network(s) {
  let m = /sa_family=AF_INET,.*?sin_port=htons\((\d+)\).*?inet_addr\("([^"]+)"\)/.exec(s);
  if (m) return m[2].startsWith('127.') || m[2] === '0.0.0.0' ? null : `${m[2]}:${m[1]}`;
  m = /sa_family=AF_INET6,.*?sin6_port=htons\((\d+)\).*?inet_pton\(AF_INET6, "([^"]+)"/.exec(s);
  if (m) return m[2] === '::1' || m[2] === '::' || m[2].startsWith('::ffff:127.') ? null : `[${m[2]}]:${m[1]}`;
  m = /sa_family=AF_UNIX, sun_path="([^"]+)"/.exec(s);
  if (m && m[1][0] === '/') return `unix:${m[1]}`;
  return null;
}
