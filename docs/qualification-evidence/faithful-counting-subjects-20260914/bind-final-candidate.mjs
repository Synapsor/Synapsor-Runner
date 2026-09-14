// Bind harness metadata to the new immutable installation, without changing any
// project, identity, policy or ledger binding. Preparation used historical tools.
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';
const E=path.dirname(new URL(import.meta.url).pathname),file=path.join(E,'assignment-plan.json'),p=JSON.parse(await fs.readFile(file)),F=path.join(p.owned_root,'frozen');
execFileSync(process.execPath,[path.join(F,'freeze-repair.mjs'),'--verify'],{stdio:'pipe'});const m=JSON.parse(await fs.readFile(path.join(F,'installed-artifact-manifest.json')));
for(const runId of Object.keys(p.case_sources)){
 const R=path.join(p.owned_root,'runs',runId),sfile=path.join(R,'run-state.json'),s=JSON.parse(await fs.readFile(sfile));
 assert.equal(s.first_public_start,null);assert.equal((await fs.readFile(path.join(R,'meter/events.jsonl'),'utf8').catch(()=>'' )).trim(),'');
 await fs.copyFile(sfile,path.join(R,'preparation-state-historical-tools.json'),fs.constants.COPYFILE_EXCL);
 Object.assign(s,{artifact_directory:F,artifact_tree:m.installed_tree_sha256,product_commit:m.product_commit,final_candidate_bound_at:new Date().toISOString(),development_only:false,phase:'add',maximum_initial_calls:p.budgets.authoring_calls_per_case,reserved_restart_calls:p.budgets.authoring_allocations.restart_reserved,reserved_editing_calls:p.budgets.authoring_allocations.remove,status:'FINAL_CANDIDATE_PREPARED_NOT_EXECUTED'});
 await fs.writeFile(sfile,JSON.stringify(s,null,2)+'\n');
}
p.historical_preparation_artifact={directory:p.frozen_root,tree:p.artifact_tree};p.frozen_root=F;p.artifact_tree=m.installed_tree_sha256;await fs.writeFile(file,JSON.stringify(p,null,2)+'\n');
console.log(JSON.stringify({installed_tree:m.installed_tree_sha256,runs:Object.keys(p.case_sources),project_or_authority_changes:false}));
