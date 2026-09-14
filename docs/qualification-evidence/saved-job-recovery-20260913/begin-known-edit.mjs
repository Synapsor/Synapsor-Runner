// Qualification budget transition only: no provider, source, policy or launcher mutation.
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
const E=path.dirname(new URL(import.meta.url).pathname),plan=JSON.parse(await fs.readFile(path.join(E,'assignment-plan.json'))),id=process.argv[2];
assert(['fresh-tournament','fresh-software','recovery-tournament-original','recovery-software'].includes(id));const R=path.join(plan.owned_root,'runs',id),file=path.join(R,'run-state.json'),state=JSON.parse(await fs.readFile(file));
assert.equal(state.phase,'initial');assert(!state.edit_started_at);assert.equal(state.reserved_editing_calls,15);
await fs.access(path.join(R,'deterministic/initial-completion.json'));
const completion=JSON.parse(await fs.readFile(path.join(R,'deterministic/initial-completion.json')));
assert.equal(completion.artifact_tree,state.artifact_tree);assert.equal(completion.receipt_and_readback_verified,true);
const meter=path.join(R,'meter'),meterFile=path.join(meter,'plan.json'),before=JSON.parse(await fs.readFile(meterFile));
const attempts=(await fs.readdir(meter)).filter(n=>/^attempt-\d+\.json$/.test(n));assert(attempts.length<=state.maximum_initial_calls);
assert.equal(before.maximum_attempts,state.maximum_initial_calls);
const now=new Date().toISOString();state.edit_started_at=now;state.initial_authoring_calls=attempts.length;state.phase='editing';state.edit_deadline=new Date(Date.now()+45*60000).toISOString();
const after={...before,initial_closed_at:now,initial_attempts:attempts.length,maximum_attempts:attempts.length+15,deadline:state.edit_deadline};
await fs.writeFile(path.join(meter,'initial-plan-closed.json'),JSON.stringify(before,null,2)+'\n',{flag:'wx'});
await fs.writeFile(path.join(R,'edit-budget-transition.json'),JSON.stringify({at:now,before,after,initial_completion:completion},null,2)+'\n',{flag:'wx'});
await fs.writeFile(meterFile,JSON.stringify(after,null,2)+'\n');await fs.writeFile(file,JSON.stringify(state,null,2)+'\n');
console.log(JSON.stringify({case:id,initial_calls:attempts.length,reserved_edit_calls:15,deadline:state.edit_deadline}));
