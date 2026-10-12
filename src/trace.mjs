// Run a command under strace and turn the syscall log into an access record:
// which paths it read, listed, probed and wrote, which programs it ran, and where it connected.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, constants } from 'node:os';
import { MARKER } from './tmp.mjs';
import path from 'node:path';

const SYSCALLS = [
  'open', 'openat', 'openat2', 'creat', 'stat', 'lstat', 'newfstatat', 'statx', 'access', 'faccessat',
  'faccessat2', 'readlink', 'readlinkat', 'execve', 'execveat', 'connect', 'sendto', 'sendmsg', 'sendmmsg',
  'socket', 'bind', 'getsockname', 'getsockopt', 'setsockopt',
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
  writeFileSync(path.join(dir, MARKER), ''); // so a log left by a killed testonce is swept (src/tmp.mjs)
  const log = path.join(dir, 'strace.log');
  const args = ['-f', '-y', '-qq', '-s', '65535', '-e', 'signal=none', '-e', `trace=${SYSCALLS.join(',')}`, '-o', log];
  if (probeSeccomp().ok) args.unshift('--seccomp-bpf');
  // A signal to testonce goes to the test too; testonce waits for it to stop, so the caller can clean up.
  // (strace -o FILE blocks fatal signals itself, so it is the traced processes that are signalled.)
  let signal = null;
  const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const code = await new Promise((resolve) => {
    const child = spawn('strace', [...args, '--', ...argv], { cwd, env, stdio: 'inherit' });
    const forward = (sig) => { signal = sig; signalTracees(child.pid, sig); };
    for (const s of SIGNALS) process.on(s, forward);
    const done = (c) => { for (const s of SIGNALS) process.off(s, forward); resolve(c); };
    child.on('exit', (c, sig) => done(signal ? 128 + constants.signals[signal] : sig ? 128 + 1 : c ?? 1));
    child.on('error', () => done(127));
  });
  let text = '';
  try { text = readFileSync(log, 'utf8'); } catch {}
  rmSync(dir, { recursive: true, force: true });
  return { code, signal, accesses: parse(text, cwd) };
}

// Every process this strace is tracing right now: their TracerPid is strace's pid, so no stray pid is hit.
function signalTracees(tracer, sig) {
  let pids = [];
  try { pids = readdirSync('/proc').filter((p) => /^\d+$/.test(p)); } catch {}
  for (const p of pids) {
    try {
      if (/^TracerPid:\s*(\d+)$/m.exec(readFileSync(`/proc/${p}/status`, 'utf8'))?.[1] === String(tracer)) process.kill(+p, sig);
    } catch {}
  }
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
// strace -y prints a decoded fd path in <...>, escaping bytes such as `>` as octal (\76) or hex.
const unesc = (s) => s.replace(/\\(x[0-9a-fA-F]{2}|[0-7]{1,3}|.)/g, (_, c) =>
  c[0] === 'x' && c.length === 3 ? String.fromCharCode(parseInt(c.slice(1), 16))
    : /^[0-7]+$/.test(c) ? String.fromCharCode(parseInt(c, 8))
      : c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c);
const fdPath = (a) => { const m = /<(.*)>$/.exec(a || ''); return m ? unesc(m[1]) : null; };

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
  // path.resolve folds `..` lexically. Keep the spelling too (`via`), so src/inputs.mjs can follow a symlink the
  // run created before the `..`, as the kernel does. Opens need no help: their fd path is the kernel's answer.
  const via = (rawArg, dirArg) => {
    const p = lit(rawArg);
    if (p == null || !/(^|\/)\.\.(\/|$)/.test(p)) return {};
    return { via: p[0] === '/' ? p : `${(dirArg && fdPath(dirArg)) || here()}/${p}` };
  };
  const push = (kind, p, extra) => { if (p) events.push({ kind, path: p, ...extra }); };
  // A readlink, or a no-follow stat that saw a link, looked at the link itself: where it points is an input too.
  const stat = (name, args, p, v) => { push('stat', p, { ...typeFrom(args), ...v }); if (name.startsWith('readlink') || /_mode=S_IFLNK/.test(args.join())) push('link', p, v); };
  const sockType = new Map(), v6only = new Map(), unbound = new Set(), pending = new Map();
  const bound = [], dials = [];
  let t = 0;

  for (const c of calls(text)) {
    const { name, args, ret } = c;
    pid = c.pid;
    t++;
    switch (name) {
      case 'clone': case 'clone3': case 'fork': case 'vfork':
        if (/^\d+$/.test(ret)) cwds.set(ret, here()); break;
      case 'chdir': if (ok(ret)) cwds.set(pid, noDir(lit(args[0]))); break;
      case 'fchdir': if (ok(ret) && fdPath(args[0])) cwds.set(pid, fdPath(args[0])); break;
      case 'open': case 'openat': case 'openat2': case 'creat': {
        const p = name === 'open' || name === 'creat' ? noDir(lit(args[0])) : at(args[0], lit(args[1]));
        const flags = name === 'creat' ? 'O_WRONLY|O_CREAT|O_TRUNC' : (name === 'open' ? args[1] : args[2]) || '';
        if (!ok(ret)) { if (enoent(ret)) push('absent', p, name === 'open' || name === 'creat' ? via(args[0]) : via(args[1], args[0])); continue; }
        // The opened fd's path, as the kernel resolved it (`-y`): through any symlink, including one the run made.
        const real = fdPath(ret);
        for (const q of real && real[0] === '/' && real !== p ? [p, real] : [p]) {
          if (flags.includes('O_PATH')) push('stat', q);
          else if (/O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND/.test(flags)) {
            // O_EXCL succeeds only where nothing was. Without it or O_TRUNC the open keeps the bytes the file
            // held before the run, which the descriptor can read or measure (an append's offset): an input.
            if (/O_CREAT/.test(flags) && /O_EXCL/.test(flags)) push('absent', q);
            else if (!/O_TRUNC|O_TMPFILE/.test(flags)) push('read', q, { kept: true });
            push('write', q);
          } else push(flags.includes('O_DIRECTORY') ? 'list' : 'read', q);
        }
        break;
      }
      case 'stat': case 'lstat': case 'access': case 'readlink': {
        const p = noDir(lit(args[0]));
        if (ok(ret)) stat(name, args, p, via(args[0])); else if (enoent(ret)) push('absent', p, via(args[0]));
        break;
      }
      case 'newfstatat': case 'statx': case 'faccessat': case 'faccessat2': case 'readlinkat': {
        const rel = lit(args[1]);
        if (rel === '') continue; // fd-relative (AT_EMPTY_PATH): already counted at open
        const p = at(args[0], rel);
        if (ok(ret)) stat(name, args, p, via(args[1], args[0])); else if (enoent(ret)) push('absent', p, via(args[1], args[0]));
        break;
      }
      case 'execve': case 'execveat': {
        const p = name === 'execve' ? noDir(lit(args[0])) : at(args[0], lit(args[1]));
        const v = name === 'execve' ? via(args[0]) : via(args[1], args[0]);
        if (ok(ret)) push('exec', p, v); else if (enoent(ret)) push('absent', p, v);
        break;
      }
      // A rename moves content (`move`); a hard link gives a file a second name (`hardlink`); a symlink
      // redirects later lookups (`symlink`, target kept as written). src/inputs.mjs decides what each means.
      case 'rename': case 'renameat': case 'renameat2': {
        const [from, to] = name === 'rename' ? [noDir(lit(args[0])), noDir(lit(args[1]))] : [at(args[0], lit(args[1])), at(args[2], lit(args[3]))];
        if (!from || !to) break;
        if (ok(ret)) {
          events.push({ kind: 'move', path: from, to });
          if (/RENAME_EXCHANGE/.test(args[4] || '')) events.push({ kind: 'move', path: to, to: from });
        } else if (enoent(ret)) push('absent', from);
        else if (/^-1 (EEXIST|ENOTEMPTY)/.test(ret)) push('stat', to);
        break;
      }
      case 'link': case 'linkat': {
        const [from, to] = name === 'link' ? [noDir(lit(args[0])), noDir(lit(args[1]))] : [at(args[0], lit(args[1])), at(args[2], lit(args[3]))];
        if (!from || !to) break;
        if (ok(ret)) { push('absent', to); events.push({ kind: 'hardlink', path: to, from }); } // only where nothing was
        else if (enoent(ret)) push('absent', from);
        else if (/^-1 EEXIST/.test(ret)) push('stat', to);
        break;
      }
      case 'symlink': case 'symlinkat': {
        const target = lit(args[0]);
        const link = name === 'symlink' ? noDir(lit(args[1])) : at(args[1], lit(args[2]));
        if (!link) break;
        if (ok(ret)) { push('absent', link); events.push({ kind: 'symlink', path: link, target }); } // only where nothing was
        else if (/^-1 EEXIST/.test(ret)) push('stat', link);
        else if (enoent(ret)) push('absent', path.dirname(link));
        break;
      }
      // A call that succeeds only on what was there observed it: mkdir saw the path absent, unlink and rmdir
      // saw it present, truncate to a length kept that many of its old bytes.
      case 'mkdir': case 'mkdirat': {
        const p = name === 'mkdir' ? noDir(lit(args[0])) : at(args[0], lit(args[1]));
        if (ok(ret)) { push('absent', p); push('write', p); } else if (/^-1 EEXIST/.test(ret)) push('stat', p); else if (enoent(ret) && p) push('absent', path.dirname(p));
        break;
      }
      case 'unlink': case 'rmdir': case 'unlinkat': {
        const p = name === 'unlinkat' ? lit(args[1]) && at(args[0], lit(args[1])) : noDir(lit(args[0]));
        if (ok(ret)) { push('stat', p, { type: name === 'rmdir' || /AT_REMOVEDIR/.test(args[2]) ? 'dir' : 'file' }); push('write', p); } else if (enoent(ret)) push('absent', p);
        break;
      }
      case 'truncate': if (ok(ret)) { const p = noDir(lit(args[0])); push(args[1] === '0' ? 'stat' : 'read', p, { type: 'file' }); push('write', p); } break;
      // A new mode or timestamp leaves the bytes as they were: the path stays an input.
      case 'chmod': if (ok(ret)) push('stat', noDir(lit(args[0]))); break;
      case 'fchmodat': case 'utimensat': if (ok(ret) && lit(args[1])) push('stat', at(args[0], lit(args[1]))); break;
      case 'socket': if (inode(ret)) sockType.set(inode(ret), /SOCK_[A-Z]+/.exec(args[1])?.[0]); break;
      case 'setsockopt': if (ok(ret) && args[2] === 'IPV6_V6ONLY') v6only.set(inode(args[0]), args[3] === '[1]'); break;
      case 'getsockopt': {
        const d = args[2] === 'SO_ERROR' && ok(ret) && pending.get(inode(args[0]));
        if (d) { pending.delete(inode(args[0])); d.outcome = outcome(/^\[(\w+)\]/.exec(args[3])?.[1]); }
        break;
      }
      case 'bind': case 'getsockname': {
        const ino = inode(args[0]), [a] = inet(args.join(', '));
        if (!ok(ret) || !ino || !a) break;
        // A bind to port 0 lets the kernel pick; the getsockname after it says which.
        if (name === 'bind' && !a.port) { unbound.add(ino); break; }
        if (name === 'getsockname' && !unbound.delete(ino)) break;
        bound.push({ t, type: sockType.get(ino), ...a, v6only: v6only.get(ino) ?? bindV6only() });
        break;
      }
      case 'connect': case 'sendto': case 'sendmsg': case 'sendmmsg': {
        const addr = network(args.join(', '));
        // A unix socket that isn't there (glibc probing nscd) is an absent path, not a connection.
        if (addr && addr.startsWith('unix:/') && !ok(ret)) push('absent', addr.slice(5));
        else if (addr) events.push({ kind: 'net', path: addr });
        const ino = inode(args[0]);
        for (const to of inet(args.join(', ')).filter((a) => isLoopback(a.host) && a.port)) {
          const d = { t, type: sockType.get(ino), to: dialled(to), outcome: name !== 'connect' || ret === '0' ? 'ok' : outcome(/^-1 (\w+)/.exec(ret)?.[1]) };
          if (/^-1 EINPROGRESS/.test(ret)) pending.set(ino, d);
          dials.push(d);
        }
        break;
      }
    }
  }
  // Loopback is the run's own only where the run bound a same-type socket answering it before reaching it (or the
  // reach was refused: a client waiting for its own server). Else it is a dev server, a CI service, a daemon.
  for (const d of dials) {
    if (!bound.some((b) => b.type && b.type === d.type && b.port === d.to.port && answers(b, d.to.host) && (b.t < d.t || d.outcome === 'refused'))) {
      events.push({ kind: 'net', path: `${d.to.host.includes(':') ? `[${d.to.host}]` : d.to.host}:${d.to.port} (loopback, but no server the run started)` });
    }
  }
  return events;
}

const inode = (fd) => /socket:\[(\d+)\]/.exec(fd || '')?.[1];
const outcome = (err) => (err === '0' ? 'ok' : err === 'ECONNREFUSED' ? 'refused' : 'unknown');
const isLoopback = (h) => h.startsWith('127.') || h === '0.0.0.0' || h === '::1' || h === '::';
// Every inet address in a call, IPv4-mapped IPv6 as plain IPv4.
const inet = (s) => [...s.matchAll(NET)].filter((m) => m[2] || m[4]).map((m) => (m[2] ? { host: m[2], port: +m[1] } : { host: m[4].replace(/^::ffff:(?=\d+\.)/i, ''), port: +m[3] }));
// Dialling a wildcard reaches loopback.
const dialled = ({ host, port }) => ({ host: host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host, port });
// A wildcard bind answers its whole family; the IPv6 one IPv4 too, unless IPv6-only.
const answers = (b, host) => b.host === host || (b.host === '0.0.0.0' && !host.includes(':')) || (b.host === '::' && (host.includes(':') || !b.v6only));
let v6default;
const bindV6only = () => (v6default ??= (() => { try { return readFileSync('/proc/sys/net/ipv6/bindv6only', 'utf8').trim() !== '0'; } catch { return true; } })());

// The outside world: non-loopback IPs, unix sockets at file paths, abstract ones (@name: no file to hash).
// Every destination counts (sendmmsg carries one per message).
const NET = /sa_family=AF_INET,.*?sin_port=htons\((\d+)\).*?inet_addr\("([^"]+)"\)|sa_family=AF_INET6,.*?sin6_port=htons\((\d+)\).*?inet_pton\(AF_INET6, "([^"]+)"|sa_family=AF_UNIX, sun_path=(@?)"([^"]+)"/g;
export function network(s) {
  for (const m of s.matchAll(NET)) {
    if (m[2] && !(m[2].startsWith('127.') || m[2] === '0.0.0.0')) return `${m[2]}:${m[1]}`;
    if (m[4] && !(m[4] === '::1' || m[4] === '::' || m[4].startsWith('::ffff:127.'))) return `[${m[4]}]:${m[3]}`;
    if (m[6] && (m[5] || m[6][0] === '/')) return `unix:${m[5]}${m[6]}`;
  }
  return null;
}
