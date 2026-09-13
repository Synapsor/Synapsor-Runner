import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {PublicMcp,sourceSnapshot,ledgerSnapshot,runtime,schedule,log} from './runtime-driver.mjs';
const result={case:'A4 legitimate local configured identities',status:'running'};
const id=n=>`b0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const contexts=[{name:'original',tenant:1,principal:2,claim:'CL-904'},
 {name:'other_principal',tenant:1,principal:4,claim:'CL-801'},
 {name:'other_insurer',tenant:3,principal:2,claim:'CL-701'}];
const clients=[];
try {
 const source=await sourceSnapshot('a4-before');const before=ledgerSnapshot('a4-before');
 result.contexts=[];
 for(const context of contexts){
  const client=new PublicMcp();clients.push(client);
  await client.start({inspector:false,identity:{SYNAPSOR_TENANT_ID:id(context.tenant),SYNAPSOR_PRINCIPAL:id(context.principal)}});
  await client.call('app.describe_data',{});await client.call('app.describe_actions',{});
  const rows=await client.call('app.explore_data',{plan:{kind:'rows',resource:'reserve_ops.claims',select:['claim_ref','reserve_cents']}});
  assert(rows.ok);const index=rows.data.findIndex(x=>x.claim_ref===context.claim);assert(index>=0);
  const ref=rows.subjects.find(x=>x.row_index===index).ref;
  result.contexts.push({...context,ref,visible_claims:rows.data.map(x=>x.claim_ref)});
 }
 schedule('A4 legitimate references across principal and insurer');
 result.foreign=[];
 for(const other of [1,2]){
  for(const [clientIndex,refIndex] of [[0,other],[other,0]]){
   const r=await clients[clientIndex].call('app.request_change',{outcome:'reserve_ops.adjust_claim_reserve',subject_refs:{selected_claim:result.contexts[refIndex].ref},inputs:{desired_cents:25000}});
   result.foreign.push({client:result.contexts[clientIndex].name,reference_owner:result.contexts[refIndex].name,response:r});assert.equal(r.ok,false);
  }
 }
 const rejected=ledgerSnapshot('a4-rejected');for(const t of ['proposals','approvals','worker_queue','writeback_receipts'])assert.deepEqual(rejected[t],before[t]);
 result.own=[];result.own_proposal_ids=[];
 for(let i=0;i<clients.length;i++){
  const prior=ledgerSnapshot('a4-own-'+i+'-before');const r=await clients[i].call('app.request_change',{outcome:'reserve_ops.adjust_claim_reserve',subject_refs:{selected_claim:result.contexts[i].ref},inputs:{desired_cents:25000}});
  result.own.push(r);assert(r.ok);assert(['approved','pending_review'].includes(r.proposal.status));
  const current=ledgerSnapshot('a4-own-'+i+'-after'),created=current.proposals.filter(p=>!prior.proposals.some(b=>b.proposal_id===p.proposal_id));assert.equal(created.length,1);
  const p=created[0],change=JSON.parse(p.change_set_json);assert.equal(p.tenant_id,id(contexts[i].tenant));assert.equal(p.object_id,id(Number(contexts[i].claim.slice(3))));assert.equal(change.principal.id,id(contexts[i].principal));assert.equal(change.patch.reserve_cents,25000);result.own_proposal_ids.push(p.proposal_id);
 }
 const after=ledgerSnapshot('a4-after');assert.equal(after.proposals.length,before.proposals.length+3);assert.deepEqual(await sourceSnapshot('a4-after'),source);
 result.status='pass_owned_environment_contexts';result.identity='Fixed synthetic trusted local environment bindings, not production authentication';
}catch(e){result.status='failed_or_incomplete';result.error=e.stack;process.exitCode=1;log('a4_failure',{message:e.message});}
finally{for(const c of clients)await c.close();await fs.writeFile(path.join(runtime,'a4-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));}
