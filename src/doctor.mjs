// `testonce doctor`: can this machine trace and cache? One PASS/FAIL line per check, each failure with an exact fix.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeTrace, probeSeccomp } from './trace.mjs';
import { findRoot, loadConfig } from './cache.mjs';
import { MAC_NOTICE, INSTALL_HELP, findRuntime } from './linux.mjs';

const FIX = {
  platform: 'testonce records file reads with strace, which is Linux only. Run your tests on a Linux runner or container (macOS: use a Linux Docker container or CI). Until then every test runs uncached.',
  missing: 'Install strace: `apt-get update && apt-get install -y strace` (Debian/Ubuntu), `apk add strace` (Alpine), `dnf install strace` (Fedora/RHEL). In a Dockerfile, add the same line. On GitHub Actions use `uses: jawauntb/testonce@main`, which installs it.',
  ptrace: 'The kernel or sandbox refuses ptrace. Docker: `docker run --cap-add SYS_PTRACE ...` (add `--security-opt seccomp=unconfined` if it still fails). docker compose: `cap_add: [SYS_PTRACE]`. Kubernetes: `securityContext.capabilities.add: ["SYS_PTRACE"]`. Hosts with `/proc/sys/kernel/yama/ptrace_scope` = 3: `sudo sysctl kernel.yama.ptrace_scope=1`. Where you cannot change this (some hosted sandboxes, gVisor), tests still run every time, uncached.',
};

// Why nothing is cached, in one clause.
export function whyNoTrace(p) {
  return { platform: `no strace on ${process.platform}`, missing: 'strace is not installed', ptrace: `ptrace is not permitted here (${p.detail})` }[p.reason] ?? 'tracing is unavailable';
}

// The run/each fallback notice. On macOS it points at --linux instead of at `doctor`.
export function noTraceMessage(p, platform = process.platform) {
  if (platform === 'darwin' && p.reason === 'platform') return MAC_NOTICE;
  return `${whyNoTrace(p)}, so every test runs and nothing is cached. Run \`testonce doctor\` for the fix.`;
}

function cacheDirCheck(cacheDir) {
  const probe = path.join(cacheDir, `.doctor-${process.pid}`);
  try {
    const created = mkdirSync(cacheDir, { recursive: true });
    writeFileSync(probe, 'ok');
    const back = readFileSync(probe, 'utf8');
    rmSync(probe, { force: true });
    if (created) rmSync(created, { recursive: true, force: true }); // leave no directory behind that we made
    return back === 'ok' ? { ok: true, detail: `${cacheDir} is writable` } : { ok: false, detail: `${cacheDir} did not read back what was written` };
  } catch (e) {
    return { ok: false, detail: `${cacheDir}: ${e.code ?? e.message}` };
  }
}

export function checks({ env = process.env, cwd = process.cwd(), platform = process.platform } = {}) {
  const out = [];
  const add = (name, ok, detail, fix, optional = false) => out.push({ name, ok, detail, fix, optional });
  const linux = platform === 'linux';
  const t = linux ? probeTrace(env) : null;
  add('platform', linux, `${platform} ${os.arch()}, Node ${process.versions.node}`, platform === 'darwin' ? 'macOS has no strace, so natively every test runs uncached. The two routes that do work are below.' : FIX.platform);
  if (platform === 'darwin') {
    const rt = findRuntime({ pathEnv: env.PATH ?? '' });
    add('container', !!rt, rt ? `${rt.name} at ${rt.bin}` : 'no docker or podman on PATH', INSTALL_HELP, true);
  }
  if (linux) {
    add('strace', t.reason !== 'missing', t.reason === 'missing' ? 'strace not found on PATH' : t.version, FIX.missing);
    if (t.reason === 'missing') add('ptrace', false, 'cannot test without strace', FIX.missing);
    else add('ptrace', t.ok, t.ok ? 'strace traced a child process' : `strace could not trace a child: ${t.detail}`, FIX.ptrace);
    if (t.ok) {
      const s = probeSeccomp(env);
      add('seccomp-bpf', s.ok, s.ok ? '--seccomp-bpf works (faster tracing)' : `--seccomp-bpf failed (${s.detail}); tracing still works, only slower`, 'Optional. Use a newer strace and a kernel with seccomp filters enabled; nothing else to do.', true);
    }
  }
  const root = findRoot(cwd);
  const c = cacheDirCheck(loadConfig(root).cacheDir);
  add('cache dir', c.ok, c.detail, `Make it writable (\`mkdir -p ${loadConfig(root).cacheDir} && chmod u+w ${loadConfig(root).cacheDir}\`), or point TESTONCE_CACHE_DIR at a writable directory, or set "cacheDir" in testonce.json.`);
  return out;
}

export function doctor(args = [], { env = process.env, cwd = process.cwd(), write = (l) => console.log(l), platform = process.platform } = {}) {
  const results = checks({ env, cwd, platform });
  for (const r of results) {
    write(`${r.ok ? 'PASS' : r.optional ? 'WARN' : 'FAIL'}  ${r.name.padEnd(11)} ${r.detail}`);
    if (!r.ok) write(`      fix: ${r.fix}`);
  }
  const ok = results.every((r) => r.ok || r.optional);
  if (platform === 'darwin') {
    const c = results.find((r) => r.name === 'container');
    write('');
    write('On a Mac there are two real ways to get skips:');
    write('  (a) Your CI and cloud coding agents run Linux: add `uses: jawauntb/testonce@main` there (see README, Install).');
    write(`  (b) Locally, run \`testonce each --linux FILE... -- <command> {}\` (or \`testonce run --linux -- <command>\`). It runs the same command in a Linux container: ${c?.ok ? `a runtime was found (${c.detail}; doctor does not check that its daemon is running).` : 'no runtime was found yet, see the container line above.'}`);
    write('Records made in the container match later --linux runs on this Mac only, not your CI (different paths and toolchain). Details: docs/mac.md');
    write('testonce doctor: caching will NOT work natively here. Tests still run, uncached, unless you use --linux.');
    return 1;
  }
  write(ok ? 'testonce doctor: caching will work here.' : 'testonce doctor: caching will NOT work here. Tests still run, uncached. Apply the fixes above.');
  return ok ? 0 : 1;
}
