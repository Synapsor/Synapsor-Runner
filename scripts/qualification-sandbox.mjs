import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Linux qualification harness only. Never alters a locator, reviewed payload,
// authority hash or original directory. All remapping is private to the child.
export async function qualificationSandboxArguments({ ownedRoot, mounts = [], cwd, home }) {
  const root = await fs.realpath(ownedRoot);
  const contains = (base, file) => {
    const relative = path.relative(base, file);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  assert.notEqual(root, '/');
  const rootInfo = await fs.stat(root);
  assert(rootInfo.isDirectory() && rootInfo.uid === process.getuid());
  const writable = [{ logical: root, physical: root }];
  for (const mount of mounts) {
    const physical = await fs.realpath(mount.physical);
    const logical = path.resolve(mount.logical);
    assert(contains(root, physical), 'A writable bind source must be owned by this run');
    assert((await fs.stat(physical)).isDirectory(), 'Bind whole owned directories, never individual SQLite files');
    assert.notEqual(logical, '/');
    assert.notEqual(logical, root);
    assert(!contains(logical, root), 'A remap cannot shadow the evidence/ownership root');
    assert(!['/proc', '/dev', '/run', '/tmp', '/sys', '/etc', '/usr', '/bin'].some(base => contains(base, logical))
      && (!contains('/var', logical) || (contains('/var/tmp', logical) && logical !== '/var/tmp')), 'Remap only a test project path');
    assert.equal(await fs.realpath(logical), logical, 'Logical destination cannot be a symlink alias');
    assert(!writable.some(prior => prior.logical === logical), 'Duplicate logical bind');
    writable.push({ logical, physical });
  }
  const work = path.resolve(cwd), userHome = path.resolve(home);
  assert(writable.some(mount => contains(mount.logical, work)), 'Working directory must be in an owned mount');
  assert(contains(root, userHome), 'Client HOME must be owned by this run');
  assert((await fs.stat(userHome)).isDirectory());
  // Preserve DNS without exposing /run's control sockets. On systemd hosts
  // /etc/resolv.conf is a symlink into the otherwise private /run mount.
  const resolver = await fs.realpath('/etc/resolv.conf');
  assert((await fs.stat(resolver)).isFile(), 'Resolver must be a regular file');
  const resolverMount = contains('/run', resolver) ? ['--ro-bind', resolver, resolver] : [];
  return [
    '--ro-bind', '/', '/', '--unshare-user', '--unshare-pid', '--unshare-ipc',
    '--disable-userns', '--cap-drop', 'ALL', '--die-with-parent',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run',
    ...resolverMount,
    ...writable.flatMap(mount => ['--bind', mount.physical, mount.logical]),
    '--setenv', 'HOME', userHome, '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'XDG_CONFIG_HOME', path.join(userHome, '.config'),
    '--setenv', 'XDG_CACHE_HOME', path.join(userHome, '.cache'),
    '--setenv', 'XDG_STATE_HOME', path.join(userHome, '.local/state'),
    '--chdir', work, '--',
  ];
}

export function qualificationEnvironment(extra = {}) {
  // No inherited DB/store/config, socket, credential-helper or loader overrides.
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', TERM: 'xterm-256color',
    COLUMNS: '140', LINES: '42', ...extra };
}
