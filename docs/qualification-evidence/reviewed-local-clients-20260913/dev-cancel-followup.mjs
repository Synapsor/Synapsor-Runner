import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {PublicMcp,operator,owner,runtime,ledgerSnapshot,sourceSnapshot} from './runtime-driver.mjs';
const profiles=JSON.parse(await fs.readFile(path.join(owner.owned,'reviewed-clients.json')));const c=new PublicMcp();const result={case:'development public cancellation history prerequisite',status:'running'};
try{
 await c.start({localClient:profiles['second-insurer'],inspector:false});await c.call('app.describe_actions',{});
 const rows=await c.call('app.explore_data',{plan:{kind:'rows',resource:'reserve_ops.claims',select:['claim_ref','reserve_cents']}});assert(rows.ok);const i=rows.data.findIndex(r=>r.claim_ref==='CL-701');assert(i>=0);
 const ref=rows.subjects.find(s=>s.row_index===i).ref;const before=ledgerSnapshot('dev-cancel-followup-before'),source=await sourceSnapshot('dev-cancel-followup-before');result.requests=[];result.cancellations=[];
 for(const desired of [16000]){
  const prior=ledgerSnapshot('dev-cancel-followup-pre-'+desired);const request=await c.call('app.request_change',{outcome:'reserve_ops.adjust_claim_reserve',subject_refs:{selected_claim:ref},inputs:{desired_cents:desired}});result.requests.push(request);assert(request.ok&&request.proposal.status==='approved');
  const admitted=ledgerSnapshot('dev-cancel-followup-admitted-'+desired);const created=admitted.proposals.filter(p=>!prior.proposals.some(b=>b.proposal_id===p.proposal_id));assert.equal(created.length,1);
  const cancel=await operator(['worker','cancel',created[0].proposal_id,'--yes','--reason','Owned synthetic history control; cancel unstarted execution and retain committed approval','--config','synapsor.actions.runner.json','--json']);result.cancellations.push(cancel);assert.equal(cancel.code,0);
  const after=ledgerSnapshot('dev-cancel-followup-cancelled-'+desired);assert.deepEqual(after.approvals,admitted.approvals);assert.equal(after.proposals.find(p=>p.proposal_id===created[0].proposal_id).state,'canceled');
 }
 const after=ledgerSnapshot('dev-cancel-followup-after');assert.equal(after.approvals.length,before.approvals.length+1);assert.deepEqual(await sourceSnapshot('dev-cancel-followup-after'),source);result.status='pass_development_existing_operator_route';
}catch(e){result.status='failed_or_incomplete';result.error=e.stack;process.exitCode=1;}
finally{await c.close();await fs.writeFile(path.join(runtime,'dev-cancel-followup-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));}
