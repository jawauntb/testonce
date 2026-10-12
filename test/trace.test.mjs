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
  assert.deepEqual(parse(`1  sendmmsg(${two('127.0.0.1', '192.0.2.1')}) = 2`, '/'), [{ kind: 'net', path: '192.0.2.1:9' }]);
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
    { kind: 'hardlink', path: '/t/h', from: '/r/fixture.txt' },
    { kind: 'symlink', path: '/r/t/l', target: '../lib' },
    { kind: 'stat', path: '/r/exists' },
    { kind: 'read', path: '/r/t/l/a.js' }, { kind: 'read', path: '/lib/a.js' },
    { kind: 'absent', path: '/r/t/m', via: '/r/t/l/../m' },
  ]);
});
