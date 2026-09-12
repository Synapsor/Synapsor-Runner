import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { qualificationSandboxArguments, qualificationEnvironment } from './qualification-sandbox.mjs';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const sandboxTest = test.skipIf(process.platform !== 'linux'
  || spawnSync('bwrap', ['--ro-bind', '/', '/', '--', '/bin/true'], { stdio: 'pipe' }).status !== 0);
async function fixture() {
  // /var/tmp is not hidden by the sandbox's private /tmp mount.
  const base = await fs.mkdtemp('/var/tmp/synapsor-isolation-sentinel-');
  roots.push(base);
  const owned = path.join(base, 'owned'), original = path.join(base, 'original');
  const copy = path.join(owned, 'copy'), home = path.join(owned, 'home');
  for (const directory of [original, copy, home]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  for (const directory of [original, copy]) await fs.writeFile(path.join(directory, 'ledger.db'), 'sentinel', { mode: 0o600 });
  return { base, owned, original, copy, home };
}
async function run(f, code, mounts = []) {
  const args = await qualificationSandboxArguments({ ownedRoot: f.owned, mounts, cwd: f.copy, home: f.home });
  const result = spawnSync('bwrap', [...args, process.execPath, '-e', code], {
    encoding: 'utf8', env: qualificationEnvironment(), timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
sandboxTest('kernel refuses original ledger, companion, parent and rename writes even without preflight', async () => {
  const f = await fixture();
  const code = `const fs=require('node:fs'),assert=require('node:assert/strict');
    const p=${JSON.stringify(f.original)};
    for(const name of ['ledger.db','ledger.db-wal','ledger.db-shm','ledger.db-journal','extra']) {
      assert.throws(()=>fs.writeFileSync(p+'/'+name,'bad'),e=>e.code==='EROFS');
    }
    assert.throws(()=>fs.mkdirSync(p+'/new'),e=>e.code==='EROFS');
    assert.throws(()=>fs.renameSync(p+'/ledger.db',p+'/moved.db'),e=>e.code==='EROFS');
    assert.throws(()=>fs.chmodSync(p,0o777),e=>e.code==='EROFS');
    assert.equal(fs.existsSync('/run/docker.sock'),false);
    console.log('read-only enforcement passed');`;
  assert.equal(await run(f, code), 'read-only enforcement passed');
  assert.equal(await fs.readFile(path.join(f.original, 'ledger.db'), 'utf8'), 'sentinel');
  assert.deepEqual(await fs.readdir(f.original), ['ledger.db']);
});
sandboxTest('same logical project binds the entire owned directory including SQLite companions', async () => {
  const f = await fixture(), mounts = [{ logical: f.original, physical: f.copy }];
  const code = `const fs=require('node:fs'),assert=require('node:assert/strict');
    const logical=${JSON.stringify(f.original)}, physical=${JSON.stringify(f.copy)};
    assert.equal(fs.statSync(logical).ino,fs.statSync(physical).ino);
    assert.equal(fs.statSync(logical).dev,fs.statSync(physical).dev);
    fs.writeFileSync(logical+'/ledger.db','owned save');
    fs.writeFileSync(logical+'/ledger.db-wal','owned companion');
    console.log('owned directory remap passed');`;
  assert.equal(await run(f, code, mounts), 'owned directory remap passed');
  assert.equal(await fs.readFile(path.join(f.copy, 'ledger.db'), 'utf8'), 'owned save');
  assert.equal(await fs.readFile(path.join(f.copy, 'ledger.db-wal'), 'utf8'), 'owned companion');
  assert.equal(await fs.readFile(path.join(f.original, 'ledger.db'), 'utf8'), 'sentinel');
  assert.deepEqual(await fs.readdir(f.original), ['ledger.db']);
});
sandboxTest('retains read-only resolver contents without exposing control sockets', async () => {
  const f = await fixture();
  const expected = await fs.readFile('/etc/resolv.conf', 'utf8');
  const code = `const fs=require('node:fs'),assert=require('node:assert/strict');
    assert.equal(fs.readFileSync('/etc/resolv.conf','utf8'),${JSON.stringify(expected)});
    assert.throws(()=>fs.writeFileSync('/etc/resolv.conf','bad'),e=>e.code==='EROFS');
    assert.equal(fs.existsSync('/run/docker.sock'),false);
    assert.equal(fs.existsSync('/run/systemd/resolve/io.systemd.Resolve'),false);
    console.log('resolver preserved, control sockets hidden');`;
  assert.equal(await run(f, code), 'resolver preserved, control sockets hidden');
});
sandboxTest('refuses a writable source outside the declared owner and a client HOME outside the run', async () => {
  const f = await fixture();
  await assert.rejects(qualificationSandboxArguments({ ownedRoot: f.owned, mounts: [{ logical: f.copy, physical: f.original }], cwd: f.copy, home: f.home }), /must be owned/);
  await assert.rejects(qualificationSandboxArguments({ ownedRoot: f.owned, cwd: f.copy, home: os.homedir() }), /HOME must be owned/);
});
test('environment does not inherit configuration, database or loader overrides', () => {
  const env = qualificationEnvironment({ OWNED_CASE: 'one' });
  assert.equal(env.OWNED_CASE, 'one');
  for (const key of ['SYNAPSOR_LOCAL_STORE','SYNAPSOR_CONTROL_DATABASE_URL','SYNAPSOR_RUNNER_CONFIG','DATABASE_URL','LD_PRELOAD','NODE_OPTIONS','SSH_AUTH_SOCK','DOCKER_HOST']) assert.equal(env[key], undefined);
});
