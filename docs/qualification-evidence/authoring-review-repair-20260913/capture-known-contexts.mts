// Deterministic context replay from saved disabled metadata. No database opens,
// no provider requests, no restored authority, and no invented fresh inspection.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { policyCoverageDraft } from '../../../apps/runner/src/authoring-policy-evidence.js';
import { reviewPolicyCoverage } from '../../../apps/runner/src/authoring-policy-coverage.js';
import { newPolicySourceSession, authoringDestination } from '../../../apps/runner/src/authoring-policy-source.js';
import { createModelAuthoringConversation } from '../../../apps/runner/src/model-authoring-conversation.js';
const E=path.dirname(fileURLToPath(import.meta.url)), plan=JSON.parse(await fs.readFile(path.join(E,'assignment-plan.json'),'utf8'));
const results=[];
for(const [name,checkpoint] of [['tournament-ratification','unaided-clarification-refusal'],['software-release-sealing','budget-stopped']]) {
 const root=path.join(plan.previous_root,'cases',name,'checkpoints',checkpoint,'project');
 const saved=JSON.parse(await fs.readFile(path.join(root,'.synapsor/action-rules/drafts/reviewed_staging_rules/authority.json'),'utf8'));
 const cp=path.join(root,'.synapsor/control-policy'), snapshot=JSON.parse(await fs.readFile(path.join(cp,(await fs.readdir(cp)).find(n=>n.endsWith('.snapshot.json'))!),'utf8'));
 const read=snapshot.revisions.find(r=>r.kind==='read').content.boundary;
 const sources=path.join(root,'.synapsor/boundary-authoring/policy-sources'), originalSources=JSON.parse(await fs.readFile(path.join(sources,(await fs.readdir(sources)).find(n=>n.endsWith('.json'))!),'utf8'));
 const input={read, decisions:[], actions:[], authority:saved}; const before=JSON.stringify(input);
 const draft=policyCoverageDraft(input);
 assert.equal(JSON.stringify(input),before);
 for(const action of saved.authority.rules) for(const binding of action.verification_boundary.resources) for(const field of binding.fields) {
  assert.equal(draft.runner_evidence.actions[action.rule.outcome].scoped_bindings[binding.binding].fields[field.name].nullable,field.nullable);
 }
 assert.equal(draft.runner_evidence.source_constraints,undefined,'No invented fresh inspection evidence');
 const source=originalSources.snapshots.find(s=>s.version===originalSources.active), conversation=createModelAuthoringConversation();
 conversation.policySources=newPolicySourceSession(); conversation.policySources.snapshots=[source];conversation.policySources.active=source.version;
 conversation.policySources.operator_messages=originalSources.operator_messages;
 conversation.policySources.approvals=[{digest:source.digest,destination:authoringDestination({provider:'openai',model:'context-replay'})}];
 let body;
 await reviewPolicyCoverage({source,draft,session:{provider:'openai',model:'context-replay',conversation,dependencies:{requestJson:async(request)=>{
  body=request.body;
  return {status:200,body:{output:[{type:'function_call',name:'runner__review_policy_coverage',call_id:'local_capture',arguments:JSON.stringify({passages:[{
   start:1,end:source.text.split('\n').length,disposition:'needs_decision',interpretation:'Capture-only test: no policy completeness or deployment verdict.',draft_paths:[]}]})}]}};
 }}},env:{OPENAI_API_KEY:'local-test-placeholder'}});
 const raw=JSON.stringify(body,null,2)+'\n', dest=path.join(plan.owned_root,'prompt-after');await fs.mkdir(dest,{recursive:true});
 await fs.writeFile(path.join(dest,name+'-request.json'),raw,{flag:'wx'});
 await fs.writeFile(path.join(dest,name+'-context.json'),JSON.stringify(draft,null,2)+'\n',{flag:'wx'});
 results.push({case:name,result:'compiled field evidence/unchanged inputs checked; review prompt captured with deterministic stub',provider_calls:0,
  inspection_evidence:'NOT_SUPPLIED: prior captured inspection is not recreated',authority_changed:false,source_queried:false,
  request_sha256:createHash('sha256').update(raw).digest('hex'),path:path.join(dest,name+'-request.json')});
}
await fs.writeFile(path.join(E,'known-context-replays.json'),JSON.stringify(results,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(results));
