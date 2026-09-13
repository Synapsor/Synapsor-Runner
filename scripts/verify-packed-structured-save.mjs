import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// Explicit installed-command gate. The prepared synthetic fixture adapter owns
// the isolated installed CLI, effective-store preflight and independent source
// readback. It must invoke real CLI commands, never a mocked repository/parser.
// Reusable from a persistent-client schedule without disconnecting that client.
export async function verifyPackedStructuredSave({driver, spelling = 'onboard', file = './boundary-authoring.json'}) {
  const {operator, owner, runtime, ledgerSnapshot, sourceSnapshot} = driver;
  assert(['onboard', 'start'].includes(spelling));
  const prefix = spelling === 'start' ? ['start'] : ['onboard', 'db'];
  const before = ledgerSnapshot('draft-save-before'), source = await sourceSnapshot('draft-save-before');
  const active = rows => rows.control_policy_active.filter(row => row.kind !== 'management' || row.name !== 'read_authoring');
  const execution = before.control_policy_active.filter(row => row.kind === 'execution');
  assert.equal(execution.length, 1, 'Gate requires genuine current execution, not a proposal-only fixture');
  const config = await fs.readFile(path.join(owner.project, 'synapsor.actions.runner.json'), 'utf8');
  const commands = [];
  const invoke = async args => {
    const result = await operator([...prefix, '--project-root', '.', ...args, '--json']); commands.push(result);
    assert.equal(result.code, 0, result.stdout + result.stderr); return JSON.parse(result.stdout);
  };
  const result = {fixture: owner.case, spelling, artifact_tree: owner.artifact_tree, commands, status: 'running'};
  try {
    assert.equal((await invoke(['--export-draft', file])).state, 'exported');
    const input = JSON.parse(await fs.readFile(path.join(owner.project, file), 'utf8')), original = structuredClone(input);
    const action = input.actions.find(rule => rule.outcome === 'reserve_ops.adjust_claim_reserve'); assert(action);
    const limit = action.approval.shared_limits.find(limit => limit.id === 'reserve_adjustment_per_insurer_24h');
    assert.deepEqual({maximum: limit.maximum, scope: limit.scope, window_seconds: limit.window_seconds}, {maximum: 3, scope: 'tenant', window_seconds: 86400});
    limit.maximum = 1;
    const restored = structuredClone(input);
    restored.actions.find(rule => rule.outcome === action.outcome).approval.shared_limits.find(entry => entry.id === limit.id).maximum = 3;
    assert.deepEqual(restored, original, 'Only the named automatic limit changes');
    await fs.writeFile(path.join(runtime, 'draft-export-before.json'), JSON.stringify(original, null, 2) + '\n', {flag: 'wx'});
    await fs.writeFile(path.join(owner.project, file), JSON.stringify(input, null, 2) + '\n');
    result.preview = await invoke(['--draft', file, '--dry-run']);
    assert.equal(result.preview.state, 'validated_disabled_preview');
    assert.deepEqual(ledgerSnapshot('draft-preview-after'), before);
    result.save = await invoke(['--draft', file]);
    assert.equal(result.save.state, 'saved_disabled');
    const after = ledgerSnapshot('draft-save-after');
    assert.deepEqual(active(after), active(before), 'Active Read, Action and execution revisions remain exact');
    assert.deepEqual(await sourceSnapshot('draft-save-after'), source);
    assert.equal(await fs.readFile(path.join(owner.project, 'synapsor.actions.runner.json'), 'utf8'), config);
    for (const [table, rows] of Object.entries(before)) if (!table.startsWith('control_policy_')) assert.deepEqual(after[table], rows, table);
    assert.equal(after.control_policy_deployments[0].epoch, before.control_policy_deployments[0].epoch + 1);
    for (const table of ['control_policy_revisions', 'control_policy_events', 'control_policy_reviews']) for (const prior of before[table]) {
      assert(after[table].some(row => JSON.stringify(row) === JSON.stringify(prior)), `Retained ${table} history`);
    }
    const records = after.control_policy_revisions;
    const pointer = after.control_policy_drafts.find(row => row.kind === 'action'); assert(pointer);
    const revision = records.find(row => row.revision_id === pointer.revision_id); assert(revision);
    assert.equal(JSON.parse(revision.content_json).authority.state, 'disabled');
    result.saved_action_revision = revision;
    // Re-export uses the normal authoritative read path and demonstrates the
    // normalized saved business candidate, beyond a changed digest/message.
    await invoke(['--export-draft', 'draft-readback.json']);
    const saved = JSON.parse(await fs.readFile(path.join(owner.project, 'draft-readback.json'), 'utf8'));
    assert.deepEqual(saved.actions, input.actions);
    assert.deepEqual(saved.read, input.read);
    assert(input.action_authoring_catalog && saved.action_authoring_catalog);
    assert.deepEqual(saved.action_authoring_catalog, input.action_authoring_catalog);
    assert(input.read_authoring_catalog && saved.read_authoring_catalog);
    assert.deepEqual(saved.read_authoring_catalog, input.read_authoring_catalog);
    result.change = {outcome: action.outcome, id: limit.id, before: 3, after: 1, window_seconds: 86400, scope: 'tenant'};
    result.status = 'passed_disabled_save';
    return result;
  } catch (error) { result.status = 'failed'; result.error = error.stack; throw error; }
  finally { await fs.writeFile(path.join(runtime, 'packed-structured-save-result.json'), JSON.stringify(result, null, 2) + '\n', {flag: 'wx'}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
  assert(args.includes('--fixture-module'), 'Provide --fixture-module <owned prepared installed-runtime adapter>; no customer or implicit default fixture');
  const driver = await import(pathToFileURL(path.resolve(option('--fixture-module'))).href);
  const result = await verifyPackedStructuredSave({driver, spelling: args.includes('--spelling') ? option('--spelling') : 'onboard'});
  console.log(JSON.stringify({status: result.status, fixture: result.fixture, spelling: result.spelling, artifact_tree: result.artifact_tree}));
}
