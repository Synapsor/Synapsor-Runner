import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {resolveSynapsorProject} from '../../../apps/runner/src/project-resolution.js';
const root = path.resolve(process.argv[2]!);
assert(root.includes('/blocked-closure-4b22b46-20260920/operational/'));
assert.equal(await fs.realpath(root), root);
const resolved = await resolveSynapsorProject(root);
if (resolved) {
  assert.equal(resolved.project_root, root);
  assert.equal(resolved.store_path, path.join(root,'.synapsor/local.db'));
  assert.equal(await fs.realpath(path.dirname(resolved.store_path)), path.join(root,'.synapsor'));
  const migration = JSON.parse(await fs.readFile(path.join(root,'.synapsor/control-policy/migration.json'),'utf8'));
  assert(JSON.stringify(migration).includes(resolved.store_path));
}
console.log(JSON.stringify({owned_project:root,effective_store:resolved?.store_path??null,fresh:!resolved,external_store:false}));
