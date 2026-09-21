import assert from 'node:assert/strict';
import { readdir, lstat, readFile, readlink, realpath, writeFile, mkdir, copyFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const evidence = dirname(fileURLToPath(import.meta.url));
const repo = '/home/sandesh-tiwari/Desktop/C++/synapsor-runner';
const root = join(evidence, 'installed');
const digest = data => createHash('sha256').update(data).digest('hex');
const fileHash = async file => digest(await readFile(file));
const run = (command, args, cwd = repo) => execFileSync(command, args, { cwd, encoding: 'utf8' });
const sourceStatus = () => run('git', ['status', '--porcelain']).trim();
const coherentSource = value => value === '' || value === '?? .claude/';
// The credential-free HOME exposes this existing global-ignore directory. It
// is outside the runner pack and is neither opened, changed nor included.
if (process.argv.includes('--install')) {
  assert(coherentSource(sourceStatus()), 'Commit the coherent tested source before freezing');
  await mkdir(root);
  // Use the same workspace-aware packer as the passing packed-package gate.
  // The parent has already built and tested the bytes; retain pack output as-is.
  const runnerPack = { filename: 'synapsor-runner-1.8.0.tgz' };
  await writeFile(join(evidence, 'artifact-pack.log'), run('corepack', ['pnpm', '--config.ignore-scripts=true', 'pack',
    '--out', join(evidence, runnerPack.filename)], join(repo, 'apps/runner')), { flag: 'wx' });
  const spec = join(evidence, 'synapsor-spec-1.11.0.tgz');
  await writeFile(join(evidence,'artifact-spec-pack.log'),run('corepack',['pnpm','--config.ignore-scripts=true','pack','--out',spec],join(repo,'packages/spec')),{flag:'wx'});
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'faithful-authoring-artifact', private: true,
    version: '0.0.0', dependencies: { '@synapsor/runner': `file:${join(evidence, runnerPack.filename)}`, '@synapsor/spec': `file:${spec}` } }, null, 2), { flag: 'wx' });
  await writeFile(join(evidence, 'artifact-install.log'), run('npm', ['install', '--no-audit', '--no-fund'], root), { flag: 'wx' });
  await writeFile(join(evidence, 'installed-dependency-tree.json'), run('npm', ['ls', '--all', '--json'], root), { flag: 'wx' });
}
// Seal the new installation before hashing. Verification never changes modes.
async function protect(directory) {
  for (const name of await readdir(directory)) {
    const item = join(directory, name), info = await lstat(item);
    if (info.isDirectory()) await protect(item);
    else if (info.isFile()) await chmod(item, (info.mode & 0o777) & ~0o222);
  }
  const info = await lstat(directory);
  await chmod(directory, (info.mode & 0o777) & ~0o222);
}
if (process.argv.includes('--install')) await protect(root);
const records = [];
if (!process.argv.includes('--verify')) {
  for (const name of ['cli.js','runner.mjs','runtime.mjs','authoring.mjs','shadow.mjs']) {
    assert.equal(await fileHash(join(root,'node_modules/@synapsor/runner/dist',name)),
      await fileHash(join(repo,'apps/runner/dist',name)), `Installed entrypoint differs from tested build: ${name}`);
  }
}
async function walk(directory) {
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name), info = await lstat(path), entry = { path: relative(root, path), mode: info.mode & 0o777 };
    if (info.isSymbolicLink()) {
      assert((await realpath(path)).startsWith(`${root}/`), `Artifact symlink escapes installation: ${entry.path}`);
      records.push({ ...entry, kind: 'symlink', target: await readlink(path) });
    } else if (info.isDirectory()) { records.push({ ...entry, kind: 'directory' }); await walk(path); }
    else { assert(info.isFile()); records.push({ ...entry, kind: 'file', bytes: info.size, sha256: await fileHash(path) }); }
  }
}
await walk(root);
const treeHash = digest(JSON.stringify(records));
if (process.argv.includes('--verify')) {
  const baseline = JSON.parse(await readFile(join(evidence, 'installed-artifact-manifest.json'), 'utf8'));
  assert.equal(treeHash, baseline.installed_tree_sha256);
  assert.equal(await fileHash(process.execPath), baseline.node.sha256);
  console.log(JSON.stringify({ verified_at: new Date().toISOString(), installed_tree_sha256: treeHash, entries: records.length }));
} else {
  const runner = JSON.parse(await readFile(join(root, 'node_modules/@synapsor/runner/package.json'), 'utf8'));
  const spec = JSON.parse(await readFile(join(root, 'node_modules/@synapsor/spec/package.json'), 'utf8'));
  assert.equal(runner.version, '1.8.0'); assert.equal(spec.version, '1.11.0');
  const manifest = { frozen_at: new Date().toISOString(), purpose: 'Portable native discovery and known-case deployed runtime/edit continuation',
    cases: ['Main A deployed continuation', 'Independent tester B deployed continuation'], product_commit: JSON.parse(await readFile(join(evidence,'product-revision.json'),'utf8')).product_commit, test_commit: JSON.parse(await readFile(join(evidence,'product-revision.json'),'utf8')).test_commit, report_commit: 'recorded separately after verification',
    source_commit: run('git', ['rev-parse', 'HEAD']).trim(), source_status: sourceStatus(), unpackaged_unrelated_directory: '.claude/ (preserved, no contents read)',
    installed_root: root, installed_tree_sha256: treeHash, node: { version: process.version, executable: process.execPath, sha256: await fileHash(process.execPath) },
    runner_version: runner.version, spec_version: spec.version, package_lock_sha256: await fileHash(join(root, 'package-lock.json')),
    tarballs: await Promise.all(['synapsor-runner-1.8.0.tgz', 'synapsor-spec-1.11.0.tgz'].map(async name => ({ name, sha256: await fileHash(join(evidence, name)) }))), records };
  assert(coherentSource(manifest.source_status));
  await writeFile(join(evidence, 'installed-artifact-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  run('tar', ['-czf', join(evidence, 'installed-artifact.tar.gz'), '-C', evidence, 'installed']);
  console.log(JSON.stringify({ frozen_at: manifest.frozen_at, source_commit: manifest.source_commit, installed_tree_sha256: treeHash,
    manifest_sha256: await fileHash(join(evidence, 'installed-artifact-manifest.json')), archive_sha256: await fileHash(join(evidence, 'installed-artifact.tar.gz')),
    package_lock_sha256: manifest.package_lock_sha256, entries: records.length, tarballs: manifest.tarballs }));
}
