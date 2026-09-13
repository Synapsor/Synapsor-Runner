import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PublicMcp,operator,owner,runtime,ledgerSnapshot,sourceSnapshot} from './runtime-driver.mjs';
const profiles=JSON.parse(await fs.readFile(path.join(owner.owned,'reviewed-clients.json')));
const expected={'primary':'CL-103','colleague':'CL-801','second-insurer':'CL-701','third-insurer':'CL-1001'};
const source=await sourceSnapshot('reviewed-contexts-before'),before=ledgerSnapshot('reviewed-contexts-before');
const result={case:'reviewed local clients prerequisite',artifact_tree:owner.artifact_tree,status:'running',contexts:{},common_store:path.join(owner.logical,'.synapsor/local.db')};
const clients=[];
try{
 for(const [alias,reference] of Object.entries(profiles)){
  const doctor=await operator(['mcp','status','claude-code','--project','--project-root','.','--local-client',reference,'--check-launch','--json']);
  assert.equal(doctor.code,0,alias+' managed launcher diagnostic');const diagnostic=JSON.parse(doctor.stdout);assert(diagnostic.launch.checked&&diagnostic.launch.ok);
  const identityBytes=await fs.readFile(path.join(owner.project,'.synapsor/local-test-runtime.'+reference+'.json'));
  const identity=JSON.parse(identityBytes);const row=source.claims.find(r=>r.claim_ref===expected[alias]);assert(row);
  for(const binding of identity.bindings)assert.equal(identity.values[binding.environment],row[binding.role==='tenant'?'insurer_id':'adjuster_id']);
  const c=new PublicMcp();clients.push(c);await c.start({localClient:reference,inspector:false});
  const rows=await c.call('app.explore_data',{plan:{kind:'rows',resource:'reserve_ops.claims',select:['claim_ref','reserve_cents']}});assert(rows.ok);assert(rows.data.some(r=>r.claim_ref===expected[alias]));
  const allowed=new Set(source.claims.filter(r=>r.insurer_id===row.insurer_id&&r.adjuster_id===row.adjuster_id).map(r=>r.claim_ref));assert(rows.data.every(r=>allowed.has(r.claim_ref)));
  await c.close();const restarted=new PublicMcp();clients.push(restarted);await restarted.start({localClient:reference,inspector:false});
  const again=await restarted.call('app.explore_data',{plan:{kind:'rows',resource:'reserve_ops.claims',select:['claim_ref','reserve_cents']}});assert(again.ok);assert.deepEqual(again.data,rows.data);await restarted.close();
  result.contexts[alias]={reference,diagnostic_exit:doctor.code,tools:diagnostic.tools,identity_sha256:createHash('sha256').update(identityBytes).digest('hex'),identity_contract:identity.project_binding,initial_scoped_rows:rows.data.length,restart_scoped_rows:again.data.length,own_context_positive:true,unauthorized_rows_absent:true};
 }
 const after=ledgerSnapshot('reviewed-contexts-after');for(const table of ['approvals','proposals','worker_queue','writeback_jobs','writeback_receipts','control_policy_active','control_policy_revisions']){assert(Array.isArray(before[table]),table+' must exist');assert.deepEqual(after[table],before[table]);}
 assert.deepEqual(await sourceSnapshot('reviewed-contexts-after'),source);
 assert.equal(new Set(Object.values(result.contexts).map(x=>x.identity_contract)).size,1);
 result.status='passed_configured_clients_before_schedules';
}catch(error){result.status='failed_or_blocked_prerequisite';result.error=error.stack;process.exitCode=1;}
finally{await Promise.allSettled(clients.map(c=>c.close()));await fs.writeFile(path.join(runtime,'reviewed-contexts-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));}
