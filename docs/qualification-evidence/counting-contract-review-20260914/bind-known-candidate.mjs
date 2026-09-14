// Bind fixture-harness metadata only after the new installation is frozen.
// No project authority, identity, source row or receipt is rewritten.
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
process.umask(0o077);
const E=path.dirname(fileURLToPath(import.meta.url)),plan=JSON.parse(await fs.readFile(path.join(E,'assignment-plan.json'))),O=plan.owned_root,F=path.join(O,'frozen');
const run=process.argv[2];assert(['recovery-tournament-assisted','recovery-tournament-original','recovery-software'].includes(run));
execFileSync(process.execPath,[path.join(F,'freeze-repair.mjs'),'--verify'],{stdio:'pipe'});
const manifest=JSON.parse(await fs.readFile(path.join(F,'installed-artifact-manifest.json'))),R=path.join(O,'runs',run),file=path.join(R,'run-state.json'),state=JSON.parse(await fs.readFile(file));
assert.equal(state.status,'PREPARED_AWAITING_FINAL_CANDIDATE');assert.equal(state.artifact_tree,null);assert.equal(state.first_public_start,null);
assert(!(await fs.stat(path.join(R,'public-invocations.jsonl')).catch(()=>null)),'Do not replace an already-used candidate');
const baseline=JSON.parse(await fs.readFile(path.join(state.prior_run,'checkpoints',state.checkpoint,'project-manifest.json')));
for(const item of baseline)assert.equal(createHash('sha256').update(await fs.readFile(path.join(R,'project',item.path))).digest('hex'),item.sha256);
state.artifact_tree=manifest.installed_tree_sha256;state.product_commit=manifest.product_commit;state.artifact_directory=F;state.status='PREPARED_NOT_EXECUTED';state.candidate_bound_at=new Date().toISOString();
await fs.writeFile(file,JSON.stringify(state,null,2)+'\n');
const record={run,candidate_bound_at:state.candidate_bound_at,artifact_tree:state.artifact_tree,product_commit:state.product_commit,fixture_prepared_at:state.fixture_prepared_at,project_baseline_unchanged:true,public_calls:0,authority_or_identity_changed:false};
await fs.writeFile(path.join(E,run+'-candidate-binding.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(record));
