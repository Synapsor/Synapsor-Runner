// Deterministic integration evidence. The first captured reply is unchanged;
// the second payload is explicitly derived, never a new provider observation.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parsePolicyCoverage, reviewPolicyCoverage } from '../../../apps/runner/src/authoring-policy-coverage.ts';
import { policyReviewReadiness } from '../../../apps/runner/src/authoring-review-readiness.ts';
import { authoringDestination, bindPolicyCoverage, loadPolicySources, savePolicySources } from '../../../apps/runner/src/authoring-policy-source.ts';
import { createModelAuthoringConversation } from '../../../apps/runner/src/model-authoring-conversation.ts';
import { SOURCE_COUNTER_CLASSIFICATION_GUIDANCE } from '../../../apps/runner/src/authoring-counter-maintenance-review.ts';
process.umask(0o077);
const E=path.dirname(new URL(import.meta.url).pathname),plan=JSON.parse(await fs.readFile(path.join(E,'assignment-plan.json'),'utf8'));
const fixture=path.join(plan.owned_root,'private/primary-maintenance-capture.json');
const bytes=await fs.readFile(fixture),captured=JSON.parse(String(bytes)),hash=b=>createHash('sha256').update(b).digest('hex');
const root=path.join(plan.owned_root,'deterministic/maintenance-after');await fs.mkdir(root,{recursive:true});
let originalRefusal='';try{parsePolicyCoverage(captured.arguments,captured.source,captured.draft,captured.operator_messages);}catch(e){originalRefusal=e.message;}
assert(originalRefusal.startsWith('SOURCE_COUNTER_CLASSIFICATION_REQUIRED'));
const args=structuredClone(captured.arguments),index=args.passages.findIndex(p=>p.topic==='Conflict-counter maintenance'),original=args.passages[index];assert(index>=0);
const pointer='/runner_evidence/actions/league.result_ratification/effect/source_counter_maintenance';
args.passages.splice(index,1,{start:original.start,end:original.end,disposition:'implemented',responsibility:'runner',
 interpretation:'Runner retains the compiled exact result update and maintained integer version advance.',
 draft_paths:['/runner_evidence/actions/league.result_ratification/effect'],
 evidence_checks:[{path:'/runner_evidence/actions/league.result_ratification/effect/operation',equals:'update'}]},
 {...original,interpretation:'The source-owner maintenance obligation is current; independent external assurance is unverified.',
 draft_paths:[pointer],source_counter_obligation:{path:pointer,requirement:'owner_maintenance'}});
await fs.writeFile(path.join(root,'derived-structural-correction.json'),JSON.stringify(args,null,2)+'\n',{flag:'wx'});
const conversation=createModelAuthoringConversation();conversation.policySources=structuredClone(captured.session);
const requests=[];const session={provider:'openai' as const,model:'gpt-test',apiKey:'test-only',conversation,
 dependencies:{requestJson:async request=>{requests.push(request.body);return{status:200,body:{output:[{type:'function_call',call_id:String(requests.length),
 name:'runner__review_policy_coverage',arguments:JSON.stringify(requests.length===1?captured.arguments:args)}]}};}}};
conversation.policySources.approvals.push({digest:captured.source.digest,destination:authoringDestination(session)});
await savePolicySources(root,conversation.policySources);
const report=await reviewPolicyCoverage({session,source:captured.source,draft:captured.draft});assert.equal(requests.length,2);
bindPolicyCoverage(conversation.policySources,report,captured.session.coverage_authority_digest);
await savePolicySources(root,conversation.policySources);
const restored=await loadPolicySources(root,conversation.policySources.id);
const rechecked=parsePolicyCoverage({passages:restored.coverage.passages},captured.source,captured.draft,captured.operator_messages);
assert.deepEqual(rechecked,report);const readiness=policyReviewReadiness(captured.source,rechecked,restored);assert(readiness.ready);
const tool=requests[0].tools.find(t=>t.name==='runner__review_policy_coverage');
assert(tool.parameters.properties.passages.items.properties.draft_paths.items.enum.includes(pointer));
await fs.writeFile(path.join(root,'transport-envelopes.json'),JSON.stringify(requests,null,2)+'\n',{flag:'wx'});
await fs.writeFile(path.join(E,'maintenance-prompt-change.json'),JSON.stringify({basis:['maintenance-before-result.json','maintenance-wire-before.json'],
 before:{classification_guidance:null,typed_source_counter_obligation:null,exact_maintenance_pointer_in_enum:false},
 after:{classification_guidance:SOURCE_COUNTER_CLASSIFICATION_GUIDANCE,typed_source_counter_obligation:tool.parameters.properties.passages.items.properties.source_counter_obligation,exact_maintenance_pointer_in_enum:true},
 other_prompt_text:'unchanged; exact historical input retained, new deterministic transport envelopes private',
 fixture_specific_product_prompt_terms_added:false},null,2)+'\n',{flag:'wx'});
assert.equal(hash(await fs.readFile(fixture)),hash(bytes));
const result={at:new Date().toISOString(),classification:'DETERMINISTIC captured first reply plus labelled derived structural correction; NOT public/model completion',
 original_refusal:originalRefusal,original_capture_sha256:hash(bytes),actual_provider_calls:0,mocked_transport_requests:requests.length,
 coverage_saved_reloaded_revalidated:true,business_ready:readiness.ready,components:report.passages.filter(p=>p.source_counter_obligation),
 pending_responsibilities:readiness.items.filter(i=>!i.blocksReview),summary:readiness.summary,original_unchanged:true,
 source_effects:false,authority_mutations:false,independent_external_assurance:'unverified',
 derived_payload_path:path.join(root,'derived-structural-correction.json'),envelopes:path.join(root,'transport-envelopes.json')};
await fs.writeFile(path.join(E,'maintenance-after-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({business_ready:readiness.ready,actual_provider_calls:0,classification:result.classification}));
