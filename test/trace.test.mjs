import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, network, splitArgs } from '../src/trace.mjs';

const log = (lines) => lines.join('\n');

test('joins unfinished/resumed lines even with a padded return column', () => {
  const ev = parse(log([
    '10  vfork( <unfinished ...>',
    '11  execve("/usr/bin/git", ["git", "status"], 0x55 /* 1 vars */ <unfinished ...>',
    '10  <... vfork resumed>)              = 11',
    '11  <... execve resumed>)             = 0',
  ]), '/repo');
  assert.deepEqual(ev, [{ kind: 'exec', path: '/usr/bin/git' }]);
});

test('resolves *at calls against the decoded dirfd and plain calls against the tracked cwd', () => {
  const ev = parse(log([
    '1  openat(AT_FDCWD</repo/src>, "a.js", O_RDONLY|O_CLOEXEC) = 3</repo/src/a.js>',
    '1  chdir("/repo/lib")                = 0',
    '1  stat("b.js", {st_mode=S_IFREG|0644, ...}) = 0',
    '1  openat(5</repo/pkg>, "c.json", O_RDONLY) = 6</repo/pkg/c.json>',
    '1  clone(child_stack=NULL, flags=CLONE_CHILD) = 2',
    '2  access("d.js", R_OK)               = -1 ENOENT (No such file or directory)',
  ]), '/repo');
  assert.deepEqual(ev, [
    { kind: 'read', path: '/repo/src/a.js' },
    { kind: 'stat', path: '/repo/lib/b.js', type: 'file' },
    { kind: 'read', path: '/repo/pkg/c.json' },
    { kind: 'absent', path: '/repo/lib/d.js' },
  ]);
});

test('classifies directory listings, writes, renames and read-write opens', () => {
  const ev = parse(log([
    '1  openat(AT_FDCWD</r>, "tests", O_RDONLY|O_NONBLOCK|O_CLOEXEC|O_DIRECTORY) = 3</r/tests>',
    '1  openat(AT_FDCWD</r>, "out.txt", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 4</r/out.txt>',
    '1  openat(AT_FDCWD</r>, "db.sqlite", O_RDWR) = 5</r/db.sqlite>',
    '1  renameat2(AT_FDCWD</r>, "a.tmp", AT_FDCWD</r>, "a", RENAME_NOREPLACE) = 0',
    '1  openat(AT_FDCWD</r>, "x\\"y.js", O_RDONLY) = 6</r/x"y.js>',
  ]), '/r');
  assert.deepEqual(ev.map((e) => `${e.kind} ${e.path}${e.to ? ` -> ${e.to}` : ''}`), [
    'list /r/tests', 'write /r/out.txt', 'read /r/db.sqlite', 'write /r/db.sqlite',
    'move /r/a.tmp -> /r/a', 'read /r/x"y.js',
  ]);
});

test('network: loopback is local, everything else is the outside world', () => {
  assert.equal(network('3<socket:[1]>, {sa_family=AF_INET, sin_port=htons(8080), sin_addr=inet_addr("127.0.0.1")}, 16'), null);
  assert.equal(network('3, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("140.82.112.3")}, 16'), '140.82.112.3:443');
  assert.equal(network('3, {sa_family=AF_INET6, sin6_port=htons(5432), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, "::1", &sin6_addr), sin6_scope_id=0}, 28'), null);
  assert.equal(network('3, {sa_family=AF_UNIX, sun_path="/var/run/docker.sock"}, 110'), 'unix:/var/run/docker.sock');
});

test('splitArgs respects quotes, braces and fd annotations', () => {
  assert.deepEqual(splitArgs('AT_FDCWD</a,b>, "x, y", {a=1, b=2}, [1, 2], 0'), ['AT_FDCWD</a,b>', '"x, y"', '{a=1, b=2}', '[1, 2]', '0']);
});

test('a failed connect to a missing unix socket is an absent probe, not network', () => {
  const ev = parse('1  connect(3<socket:[9]>, {sa_family=AF_UNIX, sun_path="/var/run/nscd/socket"}, 110) = -1 ENOENT (No such file or directory)', '/');
  assert.deepEqual(ev, [{ kind: 'absent', path: '/var/run/nscd/socket' }]);
});

test('a stat that sees a symlink records no type, so the check that follows the link can match, and the link itself', () => {
  const ev = parse('1  newfstatat(AT_FDCWD</r>, "node_modules", {st_mode=S_IFLNK|0777, st_size=34, ...}, AT_SYMLINK_NOFOLLOW) = 0', '/r');
  assert.deepEqual(ev, [{ kind: 'stat', path: '/r/node_modules' }, { kind: 'link', path: '/r/node_modules' }]);
  assert.deepEqual(parse('1  readlink("cur", "a.txt", 4096) = 5', '/r'), [{ kind: 'stat', path: '/r/cur' }, { kind: 'link', path: '/r/cur' }]);
});

test('network: abstract unix sockets, and every destination of a sendmmsg', () => {
  assert.equal(network('21<socket:[1]>, {sa_family=AF_UNIX, sun_path=@"some-server"}, 14'), 'unix:@some-server');
  const two = (a, b) => `3, [{msg_hdr={msg_name={sa_family=AF_INET, sin_port=htons(9), sin_addr=inet_addr("${a}")}, msg_namelen=16, msg_iov=[{iov_base="x", iov_len=1}], msg_iovlen=1, msg_controllen=0, msg_flags=0}, msg_len=1}, {msg_hdr={msg_name={sa_family=AF_INET, sin_port=htons(9), sin_addr=inet_addr("${b}")}, msg_namelen=16, msg_iov=[{iov_base="x", iov_len=1}], msg_iovlen=1, msg_controllen=0, msg_flags=0}, msg_len=1}], 2, 0`;
  assert.equal(network(two('127.0.0.1', '192.0.2.1')), '192.0.2.1:9');
  assert.equal(network(two('127.0.0.1', '127.0.0.2')), null);
  // The loopback destination too: nothing in the run bound 127.0.0.1:9.
  assert.deepEqual(parse(`1  sendmmsg(${two('127.0.0.1', '192.0.2.1')}) = 2`, '/'), [{ kind: 'net', path: '192.0.2.1:9' }, { kind: 'net', path: '127.0.0.1:9 (loopback, but no server the run started)' }]);
});

test('rename, link and symlink: what moved, what got a second name, where a link points; failures are probes', () => {
  const ev = parse(log([
    '1  rename("a.part", "a")              = 0',
    '1  renameat2(AT_FDCWD</r>, "x", AT_FDCWD</r>, "y", RENAME_EXCHANGE) = 0',
    '1  rename("gone", "b")                = -1 ENOENT (No such file or directory)',
    '1  rename("c", "/other/c")            = -1 EXDEV (Invalid cross-device link)',
    '1  link("fixture.txt", "/t/h")        = 0',
    '1  symlinkat("../lib", AT_FDCWD</r>, "t/l") = 0',
    '1  symlink("/abs", "exists")          = -1 EEXIST (File exists)',
    '1  openat(AT_FDCWD</r>, "t/l/a.js", O_RDONLY) = 3</lib/a.js>',
    '1  newfstatat(AT_FDCWD</r>, "t/l/../m", 0x7ffd, 0) = -1 ENOENT (No such file or directory)',
  ]), '/r');
  assert.deepEqual(ev, [
    { kind: 'move', path: '/r/a.part', to: '/r/a' },
    { kind: 'move', path: '/r/x', to: '/r/y' }, { kind: 'move', path: '/r/y', to: '/r/x' },
    { kind: 'absent', path: '/r/gone' },
    { kind: 'absent', path: '/t/h' }, { kind: 'hardlink', path: '/t/h', from: '/r/fixture.txt' },
    { kind: 'absent', path: '/r/t/l' }, { kind: 'symlink', path: '/r/t/l', target: '../lib' },
    { kind: 'stat', path: '/r/exists' },
    { kind: 'read', path: '/r/t/l/a.js' }, { kind: 'read', path: '/lib/a.js' },
    { kind: 'absent', path: '/r/t/m', via: '/r/t/l/../m' },
  ]);
});

// ---- loopback is the run's own world only at an (address, port) the run bound ----
const V4 = (host, port) => `{sa_family=AF_INET, sin_port=htons(${port}), sin_addr=inet_addr("${host}")}`;
const V6 = (host, port) => `{sa_family=AF_INET6, sin6_port=htons(${port}), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, "${host}", &sin6_addr), sin6_scope_id=0}`;
const sock = (ino, fam = 'AF_INET', type = 'SOCK_STREAM') => `1  socket(${fam}, ${type}|SOCK_CLOEXEC, IPPROTO_IP) = 3<socket:[${ino}]>`;
const nets = (lines) => parse(log(lines), '/r').filter((e) => e.kind === 'net').map((e) => e.path.split(' ')[0]);

test('loopback: a destination nothing in the run bound is the outside world (a dev server, a DNS stub, a database)', () => {
  assert.deepEqual(nets([sock(1), `1  connect(3<socket:[1]>, ${V4('127.0.0.1', 5432)}, 16) = 0`]), ['127.0.0.1:5432']);
  assert.deepEqual(nets([sock(1, 'AF_INET', 'SOCK_DGRAM'), `1  sendto(3<socket:[1]>, "x", 1, 0, ${V4('127.0.0.53', 53)}, 16) = 1`]), ['127.0.0.53:53']);
  assert.deepEqual(nets([sock(1, 'AF_INET6'), `1  connect(3<socket:[1]>, ${V6('::1', 6379)}, 28) = 0`]), ['[::1]:6379']);
  assert.deepEqual(nets([sock(1, 'AF_INET6'), `1  connect(3<socket:[1]>, ${V6('::ffff:127.0.0.1', 80)}, 28) = 0`]), ['127.0.0.1:80']);
  assert.deepEqual(nets([sock(1), `1  connect(3<socket:[1]>, ${V4('0.0.0.0', 80)}, 16) = 0`]), ['127.0.0.1:80'], 'the wildcard dials loopback');
});

test('loopback: bound by the run at that address and port, before the connect, is local; port 0 is read from getsockname', () => {
  assert.deepEqual(nets([sock(1), `1  bind(3<socket:[1]>, ${V4('127.0.0.1', 8080)}, 16) = 0`, sock(2), `2  connect(4<socket:[2]>, ${V4('127.0.0.1', 8080)}, 16) = 0`]), []);
  assert.deepEqual(nets([
    sock(1), `1  bind(3<socket:[1]>, ${V4('127.0.0.1', 0)}, 16) = 0`, `1  getsockname(3<socket:[1]>, ${V4('127.0.0.1', 46509)}, [128 => 16]) = 0`,
    sock(2), `2  connect(4<socket:[2]>, ${V4('127.0.0.1', 46509)}, 16) = -1 EINPROGRESS (Operation now in progress)`,
  ]), []);
  // getsockname of a client socket names its own end, not a server.
  assert.deepEqual(nets([sock(1), `1  connect(3<socket:[1]>, ${V4('127.0.0.1', 80)}, 16) = 0`, `1  getsockname(3<socket:[1]>, ${V4('127.0.0.1', 40000)}, [16]) = 0`, sock(2), `1  connect(4<socket:[2]>, ${V4('127.0.0.1', 40000)}, 16) = 0`]), ['127.0.0.1:80', '127.0.0.1:40000']);
});

test('loopback: keyed by address, port and socket type, never the port alone', () => {
  assert.deepEqual(nets([sock(1), `1  bind(3<socket:[1]>, ${V4('127.0.0.2', 8080)}, 16) = 0`, sock(2), `1  connect(4<socket:[2]>, ${V4('127.0.0.1', 8080)}, 16) = 0`]), ['127.0.0.1:8080']);
  assert.deepEqual(nets([sock(1), `1  bind(3<socket:[1]>, ${V4('127.0.0.1', 53)}, 16) = 0`, sock(2, 'AF_INET', 'SOCK_DGRAM'), `1  sendto(4<socket:[2]>, "x", 1, 0, ${V4('127.0.0.1', 53)}, 16) = 1`]), ['127.0.0.1:53'], 'a TCP server does not answer UDP');
  assert.deepEqual(nets([sock(1), `1  bind(3<socket:[1]>, ${V4('127.0.0.1', 9000)}, 16) = -1 EADDRINUSE (Address already in use)`, sock(2), `1  connect(4<socket:[2]>, ${V4('127.0.0.1', 9000)}, 16) = 0`]), ['127.0.0.1:9000'], 'a failed bind starts no server');
  // A wildcard answers every address of its family; the IPv6 one answers IPv4 too unless IPv6-only.
  assert.deepEqual(nets([sock(1), `1  bind(3<socket:[1]>, ${V4('0.0.0.0', 80)}, 16) = 0`, sock(2), `1  connect(4<socket:[2]>, ${V4('127.0.0.9', 80)}, 16) = 0`, sock(3, 'AF_INET6'), `1  connect(5<socket:[3]>, ${V6('::1', 80)}, 28) = 0`]), ['[::1]:80']);
  const dual = (v6only) => [sock(1, 'AF_INET6'), ...(v6only == null ? [] : [`1  setsockopt(3<socket:[1]>, SOL_IPV6, IPV6_V6ONLY, [${v6only}], 4) = 0`]), `1  bind(3<socket:[1]>, ${V6('::', 80)}, 28) = 0`, sock(2), `1  connect(4<socket:[2]>, ${V4('127.0.0.1', 80)}, 16) = 0`];
  assert.deepEqual(nets(dual(0)), []);
  assert.deepEqual(nets(dual(1)), ['127.0.0.1:80']);
});

test('loopback: a connect before the run bound the address is local only if it was refused (a client waiting for its own server)', () => {
  const late = (result) => [sock(2), ...result, sock(1), `1  bind(3<socket:[1]>, ${V4('127.0.0.1', 8081)}, 16) = 0`];
  assert.deepEqual(nets(late([`2  connect(4<socket:[2]>, ${V4('127.0.0.1', 8081)}, 16) = -1 ECONNREFUSED (Connection refused)`])), []);
  assert.deepEqual(nets(late([`2  connect(4<socket:[2]>, ${V4('127.0.0.1', 8081)}, 16) = -1 EINPROGRESS (Operation now in progress)`, `2  getsockopt(4<socket:[2]>, SOL_SOCKET, SO_ERROR, [ECONNREFUSED], [4]) = 0`])), []);
  assert.deepEqual(nets(late([`2  connect(4<socket:[2]>, ${V4('127.0.0.1', 8081)}, 16) = -1 EINPROGRESS (Operation now in progress)`, `2  getsockopt(4<socket:[2]>, SOL_SOCKET, SO_ERROR, [0], [4]) = 0`])), ['127.0.0.1:8081'], 'it got through: someone else answered');
  assert.deepEqual(nets(late([`2  connect(4<socket:[2]>, ${V4('127.0.0.1', 8081)}, 16) = -1 EINPROGRESS (Operation now in progress)`])), ['127.0.0.1:8081'], 'never settled: unknown');
  assert.deepEqual(nets(late([`2  connect(4<socket:[2]>, ${V4('127.0.0.1', 8081)}, 16) = 0`])), ['127.0.0.1:8081']);
  assert.deepEqual(nets([sock(2), `2  connect(4<socket:[2]>, ${V4('127.0.0.1', 8082)}, 16) = -1 ECONNREFUSED (Connection refused)`]), ['127.0.0.1:8082'], 'refused with no server of the run\'s own: it depended on nothing being there');
});

test('a call that succeeds only on what was there observed it; a write that keeps old bytes reads them', () => {
  const ev = (l) => parse(l, '/r');
  assert.deepEqual(ev('1  mkdir("out", 0777) = 0'), [{ kind: 'absent', path: '/r/out' }, { kind: 'write', path: '/r/out' }]);
  assert.deepEqual(ev('1  mkdir("out", 0777) = -1 EEXIST (File exists)'), [{ kind: 'stat', path: '/r/out' }]);
  assert.deepEqual(ev('1  unlinkat(AT_FDCWD</r>, "d", AT_REMOVEDIR) = 0'), [{ kind: 'stat', path: '/r/d', type: 'dir' }, { kind: 'write', path: '/r/d' }]);
  assert.deepEqual(ev('1  unlink("f") = -1 ENOENT (No such file or directory)'), [{ kind: 'absent', path: '/r/f' }]);
  assert.deepEqual(ev('1  openat(AT_FDCWD</r>, "lock", O_WRONLY|O_CREAT|O_EXCL, 0666) = 3</r/lock>'), [{ kind: 'absent', path: '/r/lock' }, { kind: 'write', path: '/r/lock' }]);
  assert.deepEqual(ev('1  openat(AT_FDCWD</r>, "log", O_WRONLY|O_CREAT|O_APPEND, 0666) = 3</r/log>'), [{ kind: 'read', path: '/r/log', kept: true, wo: true }, { kind: 'write', path: '/r/log' }]);
  // Read-write: the descriptor can read the kept bytes, so it is not marked write-only.
  assert.deepEqual(ev('1  openat(AT_FDCWD</r>, "db", O_RDWR|O_CREAT|O_APPEND, 0666) = 3</r/db>'), [{ kind: 'read', path: '/r/db', kept: true }, { kind: 'write', path: '/r/db' }]);
  assert.deepEqual(ev('1  openat(AT_FDCWD</r>, "out", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3</r/out>'), [{ kind: 'write', path: '/r/out' }]);
  assert.deepEqual(ev('1  truncate("f", 2) = 0'), [{ kind: 'read', path: '/r/f', type: 'file' }, { kind: 'write', path: '/r/f' }]);
  assert.deepEqual(ev('1  chmod("s.sh", 0755) = 0'), [{ kind: 'stat', path: '/r/s.sh' }]);
});
