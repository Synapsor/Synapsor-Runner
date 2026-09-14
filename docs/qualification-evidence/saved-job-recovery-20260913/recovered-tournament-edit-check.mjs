// Read-only final oracle for this ticket's smaller recovered execution/edit schedule.
// Does not run a worker or inherit the older wider championship/old-queue schedule.
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {D,state,sourceSnapshot,ledgerSnapshot} from './known-runtime.mjs';
assert.equal(state.runId,'recovery-tournament-original');const phase=process.argv[2];assert(['before','after'].includes(phase));
const result={at:new Date().toISOString(),artifact_tree:state.artifact_tree,phase,status:'incomplete'};
function authority(l){const pointers=l.control_policy_active.filter(x=>x.kind==='action');assert.equal(pointers.length,1);const p=pointers[0];const row=l.control_policy_revisions.find(x=>['deployment_id','scope_key','kind','name','revision_id'].every(k=>x[k]===p[k]));assert(row);return {revision:p.revision_id,document:JSON.parse(row.content_json).authority};}
function normalize(doc){const p=structuredClone(doc.authority);delete p.digest;delete p.action_boundary.digest;for(const r of p.rules)delete r.activated_at;for(const r of p.action_boundary.rules)delete r.approval_policy_digest;return p;}
try {
 const l=ledgerSnapshot('recovered-edit-'+phase),s=await sourceSnapshot('recovered-edit-'+phase),a=authority(l);
 await fs.writeFile(path.join(D,'recovered-edit-'+phase+'-authority.json'),JSON.stringify(a,null,2)+'\n',{flag:'wx'});
 if(phase==='before') {assert.equal(l.proposals.length,1);assert.equal(l.approvals.length,1);assert.equal(l.writeback_receipts.length,1);result.status='saved_preedit_authority_history_source';}
 else {
  const prior=JSON.parse(await fs.readFile(path.join(D,'recovered-edit-before-authority.json'))),before=JSON.parse(await fs.readFile(path.join(D,'recovered-edit-before-ledger.json'))),source=JSON.parse(await fs.readFile(path.join(D,'recovered-edit-before-source.json')));
  const expected=normalize(prior.document),actual=normalize(a.document),limits=expected.approval_classes[0].shared_limits;
  const tenant=limits.find(x=>x.scope==='tenant'),overall=limits.find(x=>x.scope==='boundary');assert.equal(limits.length,2);assert.equal(tenant.maximum,2);assert.equal(overall.maximum,6);for(const x of limits){assert.equal(x.window_seconds,86400);assert.equal(x.capability,undefined);}tenant.maximum=1;
  assert.deepEqual(actual,expected);assert.notEqual(a.revision,prior.revision);assert.deepEqual(l.approvals,before.approvals);assert.deepEqual(l.writeback_receipts,before.writeback_receipts);assert.deepEqual(s,source);assert.equal(l.proposals.length,2);
  const target=source.results.find(x=>x.result_ref==='primary-R02');assert(target);const review=l.proposals.find(x=>x.object_id===target.result_id);assert(review);assert.equal(review.state,'pending_review');assert(!l.approvals.some(x=>x.proposal_id===review.proposal_id));assert(!l.worker_queue.some(x=>x.proposal_id===review.proposal_id));
  result.status='passed_exact_limit_edit_retained_history_and_current_human_review';result.before_revision=prior.revision;result.after_revision=a.revision;result.counts={proposals:2,automatic_approvals:1,control_receipts:1,pending_review:1};result.comparison='complete normalized Action authority; only tenant maximum2->1 plus generated digests/timestamps';result.source_unchanged_since_verified_effect=true;result.old_unstarted_work='not exercised in this smaller recovered schedule; historical wider check remains separate';
 }
} catch(error){result.status='failed_or_incomplete';result.error=error.stack;process.exitCode=1;}
await fs.writeFile(path.join(D,'recovered-edit-'+phase+'-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));
