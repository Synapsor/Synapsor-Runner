import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {PublicMcp,PgRelay,operator,sourceSnapshot,ledgerSnapshot,hostSnapshot,runtime,timeout,schedule,log} from './runtime-driver.mjs';
const result={case:'A2 overall final slot with 8/3 rolling policy',status:'running',fixture_extension:'Only a new third-insurer portfolio and three claims. Original40 rows preserved at preparation; repeated CL-701 history uses ordinary public requests and correctly scoped supervised workers.'};
const clients=[],relay=new PgRelay();const id=n=>`b0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
try {
 await relay.start();const preparedSource=await sourceSnapshot('a2-overall-initial');
 const initial=ledgerSnapshot('a2-overall-initial');assert.equal(initial.approvals.length,1);
 const requests=[];
 for(const [index,tenant] of [1,3,5].entries()){
  const c=new PublicMcp();clients.push(c);await c.start({inspector:false,relay:index===1?relay:undefined,identity:{SYNAPSOR_TENANT_ID:id(tenant),SYNAPSOR_PRINCIPAL:id(2)}});
  await c.call('app.describe_actions',{});const rows=await c.call('app.explore_data',{plan:{kind:'rows',resource:'reserve_ops.claims',select:['claim_ref','reserve_cents']}});assert(rows.ok);
  requests.push((claim,desired=25000)=>{const index=rows.data.findIndex(x=>x.claim_ref===claim);assert(index>=0);return {outcome:'reserve_ops.adjust_claim_reserve',subject_refs:{selected_claim:rows.subjects.find(x=>x.row_index===index).ref},inputs:{desired_cents:desired}};});
 }
 result.history=[];result.history_workers=[];
 const grant=async(index,claim,desired=25000)=>{const label='overall-grant-'+index+'-'+claim+'-'+desired;const before=ledgerSnapshot(label+'-before');
  const r=await clients[index].call('app.request_change',requests[index](claim,desired));assert(r.ok);assert.equal(r.proposal.status,'approved');
  const after=ledgerSnapshot(label+'-after'),created=after.proposals.filter(p=>!before.proposals.some(b=>b.proposal_id===p.proposal_id));assert.equal(created.length,1);
  const p=created[0],change=JSON.parse(p.change_set_json);assert.equal(p.object_id,id(Number(claim.slice(3))));assert.equal(p.tenant_id,id([1,3,5][index]));assert.equal(change.patch.reserve_cents,desired);assert.equal(p.state,'approved');
  result.history.push({response:r,durable_proposal_id:p.proposal_id});return {proposal_id:p.proposal_id};};
 const worker=async(tenant,proposal)=>{const r=await operator(['worker','run','--supervised','--once','--yes','--config','synapsor.actions.runner.json','--worker-id','semantic_action_worker'],{SYNAPSOR_TENANT_ID:id(tenant),SYNAPSOR_PRINCIPAL:id(2)});result.history_workers.push(r);assert.equal(r.code,0);
  const snapshot=ledgerSnapshot('overall-history-worker-'+proposal.proposal_id);assert.equal(snapshot.proposals.find(p=>p.proposal_id===proposal.proposal_id).state,'applied');};
 for(const ref of ['CL-103','CL-901']){const r=await grant(0,ref);await worker(1,r);}
 const refreshSecond=async()=>{const rows=await clients[1].call('app.explore_data',{plan:{kind:'rows',resource:'reserve_ops.claims',select:['claim_ref','reserve_cents']}});assert(rows.ok);
  requests[1]=(claim,desired=25000)=>{const i=rows.data.findIndex(x=>x.claim_ref===claim);assert(i>=0);return {outcome:'reserve_ops.adjust_claim_reserve',subject_refs:{selected_claim:rows.subjects.find(x=>x.row_index===i).ref},inputs:{desired_cents:desired}};};};
 for(const desired of [25000,26000]){await refreshSecond();const r=await grant(1,'CL-701',desired);await worker(3,r);}
 await refreshSecond();for(const ref of ['CL-1001','CL-1002'])await grant(2,ref);
 const source=await sourceSnapshot('a2-overall-after-history');result.history_source_effects='Two insurer-one claims applied once, existing insurer-two CL-701 applied twice with fresh references/versions; all via existing supervised worker.';
 const before=ledgerSnapshot('a2-overall-before');assert.equal(before.approvals.length,7);
 schedule('A2 overall last slot');relay.arm();const held=once(relay,'held');
 const slow=clients[1].call('app.request_change',requests[1]('CL-701',27000));slow.catch(()=>{});await timeout(held,10000,'overall earlier fact hold');
 result.held_host=await hostSnapshot('a2-overall-held');
 result.winner=await clients[2].call('app.request_change',requests[2]('CL-1003'));assert(relay.held);
 const winner=ledgerSnapshot('a2-overall-winner');assert.equal(winner.approvals.length,8);
 relay.release();result.loser=await slow;assert(result.winner.ok&&result.loser.ok);assert.equal(result.loser.proposal.status,'pending_review');
 const after=ledgerSnapshot('a2-overall-after');assert.equal(after.approvals.length,8);assert.equal(after.proposals.length,before.proposals.length+2);
 assert.deepEqual(await sourceSnapshot('a2-overall-after'),source);
 const counts={};for(const a of after.approvals){const p=after.proposals.find(p=>p.proposal_id===a.proposal_id);counts[p.tenant_id]=(counts[p.tenant_id]??0)+1;}
 assert.deepEqual(Object.values(counts).sort(),[2,3,3]);result.counts=counts;result.new_approvals=after.approvals.filter(a=>!before.approvals.some(b=>a.approval_id===b.approval_id));result.status='pass';
}catch(e){result.status='failed_or_incomplete';result.error=e.stack;process.exitCode=1;log('a2_overall_failure',{message:e.message});}
finally{if(relay.held)relay.release();for(const c of clients)await c.close();await relay.close();await fs.writeFile(path.join(runtime,'a2-overall-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));}
