import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {operator,owner,runtime,ledgerSnapshot,sourceSnapshot} from './runtime-driver.mjs';
const attempt=process.argv[2]??'';
const result={case:'exact automatic insurer limit edit preparation',status:'running'};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const prefix=owner.case==='before_start'?['start']:['onboard','db'];
const beforeLedger=ledgerSnapshot('before'+attempt),beforeSource=await sourceSnapshot('before'+attempt);
const configs={};for(const file of ['synapsor.runner.json','synapsor.actions.runner.json','.synapsor/local-test-runtime.json'])configs[file]=await fs.readFile(path.join(owner.project,file),'utf8');
try {
 const file='automatic-limit-edit.json';
 result.export=await operator([...prefix,'--project-root','.','--export-draft',file,'--json']);assert.equal(result.export.code,0);
 const candidate=JSON.parse(await fs.readFile(path.join(owner.project,file),'utf8')),before=structuredClone(candidate);
 const action=candidate.actions.find(a=>a.outcome==='reserve_ops.adjust_claim_reserve');assert(action);
 const limits=action.approval.shared_limits.filter(l=>l.kind==='count'&&l.scope==='tenant');assert.equal(limits.length,1);
 assert.equal(limits[0].maximum,3);assert.equal(limits[0].window_seconds,86400);limits[0].maximum=1;
 const changed=structuredClone(candidate);changed.actions.find(a=>a.outcome===action.outcome).approval.shared_limits.find(l=>l.id===limits[0].id).maximum=3;
 assert.deepEqual(changed,before,'Only the exact existing automatic insurer maximum may change');
 result.change={outcome:action.outcome,id:limits[0].id,scope:limits[0].scope,window_seconds:86400,before:3,after:1};
 result.input_identity={before_sha256:hash(before),after_sha256:hash(candidate)};
 await fs.writeFile(path.join(runtime,'edit-export-before.json'),JSON.stringify(before,null,2)+'\n',{flag:'wx'});
 await fs.writeFile(path.join(owner.project,file),JSON.stringify(candidate,null,2)+'\n');
 result.dry_run=await operator([...prefix,'--project-root','.','--draft',file,'--dry-run','--json']);assert.equal(result.dry_run.code,0);
 result.save=await operator([...prefix,'--project-root','.','--draft',file,'--json']);assert.equal(result.save.code,2);assert.equal(JSON.parse(result.save.stdout).code,'POLICY_EXECUTION_CONTEXT_REQUIRED');
 assert.deepEqual(ledgerSnapshot('after'),beforeLedger);assert.deepEqual(await sourceSnapshot('after'),beforeSource);
 for(const [file,bytes] of Object.entries(configs))assert.equal(await fs.readFile(path.join(owner.project,file),'utf8'),bytes);
 result.independent_state_unchanged=true;
 result.status='expected_product_failure_reproduced';
} catch(e) {result.status='blocked_or_failed_preparation';result.error=e.stack;process.exitCode=1;}
finally {await fs.writeFile(path.join(runtime,'edit-preparation'+attempt+'.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));}
