// `--linux`: run a testonce command inside a Linux container, so strace works on a Mac.
//
// Why this adds no wrong-skip risk: nothing here changes tracing, inputs or the skip decision. The
// container runs the same testonce code under the same Linux strace, and this module only decides
// where that process runs and forwards its arguments. Everything that could differ from the host is
// already covered by the existing rules: files (including the node binary and libraries inside the
// image) are traced and hashed; the environment is fingerprinted, and the container sees only the
// variables listed below, so a variable that is not passed is absent on every run; platform and arch
// are part of the run key. The one new hazard is a host file system that serves stale attributes
// through a VM mount, so off a Linux host the container re-hashes files instead of trusting
// inode/mtime (TESTONCE_TRUST_STAT=0).
import { accessSync, closeSync, constants, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAC_NOTICE = 'macOS: tracing needs Linux, so every test runs. Use --linux to run them in a Linux container and skip unchanged ones.';
export const INSTALL_HELP = 'no container runtime (docker or podman) found on PATH. On a Mac install OrbStack (https://orbstack.dev) or Docker Desktop (https://www.docker.com/products/docker-desktop/), start it, and retry; Colima and Podman also work.';

export const imageTag = (nodeVersion = process.versions.node) => `testonce-linux:node${nodeVersion.split('.')[0]}-v1`;

export const dockerfile = (nodeVersion = process.versions.node) => `FROM node:${nodeVersion.split('.')[0]}-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends strace ca-certificates git && rm -rf /var/lib/apt/lists/*
`;

// The flag is only read before the `--` separator (or as the first word when there is none).
// Everything else is returned verbatim.
export function splitLinuxFlag(args) {
  const sep = args.indexOf('--');
  const scope = sep < 0 ? Math.min(1, args.length) : sep;
  const i = args.slice(0, scope).indexOf('--linux');
  return i < 0 ? { flag: false, args } : { flag: true, args: [...args.slice(0, i), ...args.slice(i + 1)] };
}

// flag > TESTONCE_LINUX (1/true on, 0/false off) > testonce.json "linux".
export function wantsLinux({ flag, env, cfg }) {
  if (flag) return true;
  const v = env.TESTONCE_LINUX;
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return cfg.linux === true;
}

export const inContainer = (env = process.env) => env.TESTONCE_IN_CONTAINER === '1';

const isExecutable = (f) => { try { accessSync(f, constants.X_OK); return statSync(f).isFile(); } catch { return false; } };

// First of docker, podman found on PATH. Docker Desktop, OrbStack and Colima all provide `docker`.
export function findRuntime({ pathEnv = process.env.PATH ?? '', isExec = isExecutable } = {}) {
  for (const name of ['docker', 'podman']) {
    for (const dir of pathEnv.split(path.delimiter)) {
      if (dir && isExec(path.join(dir, name))) return { name, bin: path.join(dir, name) };
    }
  }
  return null;
}

// ---- Mach-O guard ----

// Mach-O 64-bit (either byte order) and universal ("fat") binaries.
export function machOKind(buf) {
  if (buf.length < 4) return null;
  const hex = buf.subarray(0, 4).toString('hex');
  return hex === 'feedfacf' || hex === 'cffaedfe' || hex === 'cafebabe' ? hex : null;
}

// `.node` addons under any node_modules that were built for macOS cannot load in Linux.
export function findDarwinAddons(root, { limit = 5 } = {}) {
  const found = [];
  const head = Buffer.alloc(4);
  const walk = (dir, inModules) => {
    if (found.length >= limit) return;
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (found.length >= limit) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== '.git' && e.name !== '.testonce') walk(p, inModules || e.name === 'node_modules');
      } else if (inModules && e.isFile() && e.name.endsWith('.node')) {
        let fd;
        try { fd = openSync(p, 'r'); const n = readSync(fd, head, 0, 4, 0); if (machOKind(head.subarray(0, n))) found.push(p); } catch {} finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
      }
    }
  };
  walk(root, false);
  return found;
}

// ---- the container command ----

const within = (dir, p) => { const r = path.relative(dir, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

// Pure: the full `docker run` argv. `cmd` is "run" or "each"; `args` is the rest, --linux already removed.
export function runArgv({ runtime, tag, root, cwd, installDir, cacheDir, env, include = [], hostPlatform, uid, gid, cmd, args }) {
  const mountRoot = within(root, cwd) ? root : cwd;
  const mounts = [`${mountRoot}:${mountRoot}`];
  if (!within(mountRoot, installDir)) mounts.push(`${installDir}:${installDir}:ro`);
  if (!within(mountRoot, cacheDir)) mounts.push(`${cacheDir}:${cacheDir}`);

  // Run as the host user on a Linux host so files in the repo and .testonce stay yours. Docker Desktop
  // on a Mac maps ownership itself; rootless podman already maps container root to the host user.
  const asUser = hostPlatform === 'linux' && runtime === 'docker' && uid !== undefined && uid !== 0;
  const fixed = {
    TESTONCE_IN_CONTAINER: '1',
    // A VM file share may serve stale inode/mtime; hash every byte instead. (See top of file.)
    ...(hostPlatform !== 'linux' ? { TESTONCE_TRUST_STAT: '0' } : {}),
    ...(asUser ? { HOME: '/tmp' } : {}),
    // Repo owner may differ from the container user; without this git refuses and the root moves.
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*',
  };
  // Names only (`-e NAME`): values come from the environment of the runtime process, never from argv.
  const pass = Object.keys(env)
    .filter((n) => (n.startsWith('TESTONCE_') && n !== 'TESTONCE_LINUX' && !(n in fixed)) || (include.includes(n) && !(n in fixed)))
    .sort();
  return [
    runtime, 'run', '--rm',
    '--cap-add', 'SYS_PTRACE', '--security-opt', 'seccomp=unconfined',
    ...(asUser ? ['--user', `${uid}:${gid}`] : []),
    ...mounts.flatMap((m) => ['-v', m]),
    '-w', cwd,
    ...Object.entries(fixed).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ...pass.flatMap((n) => ['-e', n]),
    // No -i / -t: stdin is empty on every run, so it is never a hidden input.
    tag, 'node', path.join(installDir, 'bin', 'testonce.mjs'), cmd, ...args,
  ];
}

const here = () => path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Returns the exit code. `io` is injectable: exec(argv, {input}) -> {status, stdout, stderr}; run(argv, env) -> Promise<code>.
export async function runInLinux(cmd, args, { root, cwd = process.cwd(), cfg, env = process.env, io, say, hostPlatform = process.platform, installDir = here(), nodeVersion = process.versions.node }) {
  const rt = findRuntime({ pathEnv: env.PATH ?? '', isExec: io.isExec });
  if (!rt) { say(INSTALL_HELP); return 2; }
  const bad = findDarwinAddons(root);
  if (bad.length) {
    say(`these native addons were built for macOS and cannot load in Linux: ${bad.map((f) => path.relative(root, f)).join(', ')}. Install dependencies inside a Linux dev container instead (this check prevents false failures, not wrong skips).`);
    return 2;
  }
  const tag = imageTag(nodeVersion);
  const have = io.exec([rt.name, 'image', 'inspect', tag]);
  if (have.status !== 0) {
    if (!/no such|not known|not found/i.test(have.stderr ?? '')) {
      say(`cannot talk to ${rt.name} (${(have.stderr ?? '').trim().split('\n')[0] || `exit ${have.status}`}). Start Docker Desktop, OrbStack, Colima or Podman and retry.`);
      return 2;
    }
    say(`building ${tag} once (Node ${nodeVersion.split('.')[0]} + strace); later runs reuse it`);
    const ctx = io.mkctx();
    try {
      const b = io.exec([rt.name, 'build', '-t', tag, '-f', '-', ctx], { input: dockerfile(nodeVersion) });
      if (b.status !== 0) { say(`image build failed:\n${(b.stderr || b.stdout || '').trim().split('\n').slice(-12).join('\n')}`); return 2; }
    } finally { io.rmctx(ctx); }
  }
  const cacheDir = cfg.cacheDir;
  if (!within(within(root, cwd) ? root : cwd, cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const argv = runArgv({ runtime: rt.name, tag, root, cwd, installDir, cacheDir, env, include: cfg.env?.include ?? [], hostPlatform, uid: io.uid, gid: io.gid, cmd, args });
  return io.run([rt.bin, ...argv.slice(1)], env);
}

// Real process plumbing for runInLinux.
export async function realIo() {
  const { spawn, spawnSync } = await import('node:child_process');
  return {
    isExec: isExecutable,
    uid: process.getuid?.(), gid: process.getgid?.(),
    exec: (argv, { input } = {}) => { const r = spawnSync(argv[0], argv.slice(1), { input, encoding: 'utf8' }); return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error?.message ?? '') }; },
    mkctx: () => mkdtempSync(path.join(tmpdir(), 'testonce-ctx-')),
    rmctx: (d) => rmSync(d, { recursive: true, force: true }),
    run: (argv, env) => new Promise((resolve) => {
      const c = spawn(argv[0], argv.slice(1), { stdio: 'inherit', env });
      for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => c.kill(s)); // stop the container with us
      c.on('exit', (code, sig) => resolve(sig ? 128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[sig] ?? 1) : code ?? 1));
      c.on('error', () => resolve(127));
    }),
  };
}
