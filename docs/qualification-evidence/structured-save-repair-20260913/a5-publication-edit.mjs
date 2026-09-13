import fs from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {PublicMcp,PgRelay,operator,owner,sourceSnapshot,ledgerSnapshot,runtime,timeout,schedule,log} from './runtime-driver.mjs';
const active=()=>{const db=new DatabaseSync(path.join(owner.project,'.synapsor/local.db'),{readOnly:true});try {
 const rows=db.prepare("SELECT a.name,a.revision_id,r.content_json FROM control_policy_active a JOIN control_policy_revisions r USING(deployment_id,scope_key,kind,name,revision_id) WHERE a.kind='action' AND a.revision_id IS NOT NULL").all();
 assert.equal(rows.length,1);return {...rows[0],content:JSON.parse(rows[0].content_json)};
}finally{db.close();}};
const result={case:'installed reviewed automatic-limit publication',status:'running'},relay=new PgRelay(),client=new PublicMcp();
try {
 const prepared=JSON.parse(await fs.readFile(path.join(runtime,'edit-preparation.json'),'utf8'));assert.equal(prepared.status,'prepared_disabled_only');
 await relay.start();await client.start({relay,inspector:false});
 await client.call('app.describe_actions',{});
 const rows=await client.call('app.explore_data',{plan:{kind:'rows',resource:'reserve_ops.claims',select:['claim_ref','reserve_cents']}});assert(rows.ok);
 const args=(claim,desired)=>{const i=rows.data.findIndex(r=>r.claim_ref===claim);assert(i>=0);return {outcome:'reserve_ops.adjust_claim_reserve',subject_refs:{selected_claim:rows.subjects.find(s=>s.row_index===i).ref},inputs:{desired_cents:desired}};};
 const baseline=ledgerSnapshot('edit-before'),source=await sourceSnapshot('edit-before'),original=active();assert.equal(baseline.approvals.length,1);
 schedule('installed replacement-first exact automatic limit edit');
 result.unstarted=await client.call('app.request_change',args('CL-901',25000));assert(result.unstarted.ok);assert.equal(result.unstarted.proposal.status,'approved');
 const unstarted=ledgerSnapshot('edit-unstarted');assert.equal(unstarted.approvals.length,2);
 const added=unstarted.proposals.filter(p=>!baseline.proposals.some(b=>b.proposal_id===p.proposal_id));assert.equal(added.length,1);result.unstarted_proposal_id=added[0].proposal_id;
 assert.equal(unstarted.worker_queue.find(q=>q.proposal_id===added[0].proposal_id).status,'queued');
 relay.arm();const held=once(relay,'held');const waiting=client.call('app.request_change',args('CL-103',25000));waiting.catch(()=>{});
 await timeout(held,8000,'old rule facts held');
 await fs.writeFile(path.join(runtime,'publication-ready.json'),JSON.stringify({at:new Date().toISOString(),revision_id:original.revision_id,history:2})+'\n',{flag:'wx'});
 console.log('PUBLICATION_READY: the existing operator review may now confirm the prepared exact replacement.');
 const deadline=Date.now()+20000;let replacement;
 while(Date.now()<deadline){const current=active();if(current.revision_id!==original.revision_id){replacement=current;break;}await new Promise(r=>setTimeout(r,50));}
 assert(replacement,'The prepared operator publication must finish within the unchanged request timeout');
 const oldAuthority=original.content.authority.authority,newAuthority=replacement.content.authority.authority;
 assert.deepEqual(newAuthority.catalog,oldAuthority.catalog);
 const ruleSource=rules=>rules.map(({activated_at,...rule})=>rule);
 assert.deepEqual(ruleSource(newAuthority.rules),ruleSource(oldAuthority.rules));
 const expectedClasses=structuredClone(oldAuthority.approval_classes);let edits=0;
 for(const approval of expectedClasses)for(const limit of approval.shared_limits??[])if(limit.scope==='tenant'&&limit.kind==='count'){
   assert.equal(limit.maximum,3);assert.equal(limit.window_seconds,86400);limit.maximum=1;edits++;
 }
 assert.equal(edits,1);assert.deepEqual(newAuthority.approval_classes,expectedClasses);
 result.exact_edit={tenant_maximum:[3,1],unchanged_catalog:true,unchanged_rule_verification_effect:true,unchanged_other_approval_semantics:true};
 result.revisions={before:original.revision_id,after:replacement.revision_id};log('installed_publication_observed',result.revisions);
 relay.release();result.old_request=await waiting;assert.equal(result.old_request.ok,false);assert(JSON.stringify(result.old_request).includes('SEMANTIC_ACTION_UNAVAILABLE'));
 const refused=ledgerSnapshot('edit-stale-refused');assert.deepEqual(refused.approvals,unstarted.approvals);assert.deepEqual(refused.worker_queue,unstarted.worker_queue);
 const currentRows=await client.call('app.explore_data',{plan:{kind:'rows',resource:'reserve_ops.claims',select:['claim_ref','reserve_cents']}});assert(currentRows.ok);
 const i=currentRows.data.findIndex(r=>r.claim_ref==='CL-103');assert(i>=0);
 result.fresh=await client.call('app.request_change',{outcome:'reserve_ops.adjust_claim_reserve',subject_refs:{selected_claim:currentRows.subjects.find(s=>s.row_index===i).ref},inputs:{desired_cents:25000}});
 assert(result.fresh.ok);assert.equal(result.fresh.proposal.status,'pending_review');
 const beforeWorker=ledgerSnapshot('edit-before-worker');
 result.worker=await operator(['worker','run','--supervised','--once','--yes','--config','synapsor.actions.runner.json','--worker-id','semantic_action_worker']);
 const after=ledgerSnapshot('edit-after-worker');assert.deepEqual(after.approvals,unstarted.approvals);assert.deepEqual(after.writeback_receipts,baseline.writeback_receipts);
 assert.deepEqual(await sourceSnapshot('edit-final'),source);assert.equal(after.worker_queue.find(q=>q.proposal_id===result.unstarted_proposal_id).lease_id,null);
 result.status='pass_installed_replacement_first';result.history_retained=2;result.clock_assumptions='unchanged; no backward step or unsynchronized clocks claim';
} catch(e) {result.status='failed_or_incomplete';result.error=e.stack;process.exitCode=1;log('edit_failure',{message:e.message});}
finally{if(relay.held)relay.release();await client.close();if(relay.server)await relay.close();await fs.writeFile(path.join(runtime,'edit-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));}
