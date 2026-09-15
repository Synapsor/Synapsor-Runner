// Bind only harness metadata of unexecuted fixtures to the newly frozen build.
// This never edits a project configuration, policy, source or identity binding.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const E = path.dirname(new URL(import.meta.url).pathname);
const plan = JSON.parse(await fs.readFile(path.join(E, 'assignment-plan.json'), 'utf8'));
const F = plan.frozen_root;
const manifest = JSON.parse(await fs.readFile(path.join(F, 'installed-artifact-manifest.json'), 'utf8'));
execFileSync(process.execPath, [path.join(F, 'freeze-repair.mjs'), '--verify'], { stdio: 'pipe' });
const records = [];
for (const [run, selected] of Object.entries(plan.case_sources)) {
  const R = path.join(plan.owned_root, 'runs', run);
  const state = JSON.parse(await fs.readFile(path.join(R, 'run-state.json'), 'utf8'));
  assert.equal(state.status, 'PREPARED_AWAITING_FINAL_CANDIDATE');
  assert.equal(state.first_public_start, null); assert.equal(state.artifact_tree, null);
  assert.equal((await fs.readdir(path.join(R, 'meter'))).length, 0);
  assert(!(await fs.stat(path.join(R, 'public-invocations.jsonl')).catch(() => null)));
  const baseline = selected.checkpoint_root ?? path.join(selected.root, 'runs', selected.run, 'checkpoints', selected.checkpoint);
  const original = JSON.parse(await fs.readFile(path.join(baseline, 'project-manifest.json'), 'utf8'));
  for (const r of original) assert.equal(createHash('sha256').update(await fs.readFile(path.join(R, 'project', r.path))).digest('hex'), r.sha256);
  Object.assign(state, { artifact_tree: manifest.installed_tree_sha256, product_commit: manifest.product_commit,
    status: 'PREPARED_NOT_EXECUTED', candidate_bound_at: new Date().toISOString() });
  await fs.writeFile(path.join(R, 'run-state.json'), JSON.stringify(state, null, 2) + '\n');
  records.push({ run, artifact_tree: state.artifact_tree, source_counts: state.counts, prior_provider_calls: 0, project_unchanged: true });
}
await fs.writeFile(path.join(E, 'final-fixture-bindings.json'), JSON.stringify(records, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(records));
