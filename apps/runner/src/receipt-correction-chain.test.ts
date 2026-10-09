import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {describe,it,expect,vi} from 'vitest';
import {canonicalJsonDigest} from '@synapsor-runner/protocol';
import {collectCoverageFeedback,parsePolicyCoverage,reviewPolicyCoverage} from './authoring-policy-coverage.js';
import {createModelAuthoringConversation} from './model-authoring-conversation.js';
import {secureAskJsonRequest} from './model-ask.js';
import {ensurePreparedPolicyCoverage} from './authoring-prepared-policy-review.js';
import {savePolicySources,loadPolicySources,authoringDestination,policyTextSnapshot} from './authoring-policy-source.js';
import {policyReadinessItems,policyReviewReadiness} from './authoring-review-readiness.js';
import {CoverageReceiptConfigurationError,CoverageReceiptDutyError,coverageFinding} from './authoring-coverage-feedback.js';
import * as receiptConfiguration from './authoring-receipt-configuration.js';
import {receiptCouplingInterpretation,receiptCouplingPaths,repairableReceiptCouplingRepresentation} from './authoring-obligation-review.js';
import {receiptComponentMeanings,validateScopedReceiptComponents} from './authoring-scoped-receipt-components.js';
import {createCoverageRepairScope,assembleScopedCoverageReplacement} from './authoring-scoped-correction.js';
import {makeSourceTransactionReview,sourceTransactionMappings,sourceTransactionPreparedContext} from './authoring-source-transaction-review.js';
import {makeSourceTransactionScopeReview,sourceTransactionScopeQuestions} from './authoring-source-transaction-scope.js';
const capture=JSON.parse(await fs.readFile(new URL('./test-fixtures/receipt-correction-chain.json',import.meta.url),'utf8'));
const READ='/runner_evidence/runtime_contract/receipt_read_exclusion';
const CONFIG='/runner_evidence/runtime_contract/receipt_configuration';
const RECEIPTS='/runner_evidence/runtime_contract/receipts';
// DERIVED current operator interpretation for component/transport regressions.
// The authentic captured fixture remains unchanged and has no such record.
const fixture=()=>{
 const f=structuredClone(capture),store=canonicalJsonDigest('DERIVED test project binding');
 const mapping=sourceTransactionMappings(f.draft)[0]!;
 const record=makeSourceTransactionReview({source:f.source,session:f.sources.id,store,start:18,end:18,
  mapping,actor:'derived-test-operator',decision:'confirmed'});
 f.sources.source_transaction_reviews=[record];
 f.draft.runner_evidence.source_transaction_requirement=sourceTransactionPreparedContext(f.sources,store,f.source.digest);
 return f;
};
const EFFECT='/runner_evidence/actions/energy_ops.finalize_settlement_cycle/effect';
const parse=(f:any,args=f.arguments)=>parsePolicyCoverage(args,f.source,f.draft,f.operator_messages,f.sources);
function separated(f:any){
 // DERIVED complete candidate, not a historical model reply. Same policy/draft.
 // The former effect + selection positive did not prove their transaction
 // conjunction. This local regression now supplies its explicit typed proof.
 const args=structuredClone(f.arguments);
 for(const p of args.passages)for(const c of p.counter_requirements??[])delete c.operator_message_id;
 const i=args.passages.findIndex((p:any)=>p.draft_paths.includes(CONFIG)&&p.draft_paths.includes(RECEIPTS)),p=args.passages[i];
 const meanings=receiptComponentMeanings(f.draft),outcome=f.draft.actions[0].outcome;
 args.passages.splice(i,1,
  {start:p.start,end:p.end,disposition:'implemented',responsibility:'runner',issue_kind:'coverage_link',receipt_component:'source_transaction_coupling',interpretation:receiptCouplingInterpretation(outcome),draft_paths:receiptCouplingPaths(outcome)},
  {start:p.start,end:p.end,disposition:'implemented',responsibility:'runner',issue_kind:'coverage_link',receipt_component:'receipt_configuration',interpretation:meanings.receipt_configuration![0],draft_paths:[CONFIG]},
  {start:p.start,end:p.end,topic:'Receipt setup and production',disposition:'needs_decision',responsibility:'deployment',issue_kind:'missing_configuration',interpretation:'Keep the required source-atomic receipt guarantee. Applicable writer/provisioning review, execution permission and a performed receipt require their own evidence; no new receipt is observed here.',draft_paths:[CONFIG]});
 return args;
}
function omittedCouplingShape(f:any, valid=separated(f)){
 const args=structuredClone(valid), p=args.passages.find((p:any)=>p.receipt_component==='source_transaction_coupling');
 delete p.responsibility;delete p.issue_kind;
 p.interpretation=p.interpretation.replace(`The compiled ${f.draft.actions[0].outcome} direct-SQL`,'The compiled direct-SQL');
 return args;
}
function engineQualifiedCouplingShape(f:any, valid=separated(f)){
 const args=omittedCouplingShape(f,valid),p=args.passages.find((entry:any)=>entry.receipt_component==='source_transaction_coupling');
 p.interpretation='The compiled direct-SQL capability couples both listed business effects and the required source_db receipt in one PostgreSQL source transaction: they commit together or roll back. This is capability, not provisioning, execution, a performed receipt, or readback.';
 return args;
}
function scopeFromWire(body:any){
 const marker='Host repair scope (identities and exact references, not authority): ';
 const line=(body.messages??body.input).flatMap((m:any)=>typeof m.content==='string'?m.content.split('\n'):[]).find((line:string)=>line.startsWith(marker));
 return line?JSON.parse(line.slice(marker.length)):undefined;
}
// DERIVED local producer: construct only the groups nominated by the actual
// serialized host request. Immutable historical replies remain unchanged.
function derivedScopedResponse(body:any,candidate:any,f:any){
 const scope=scopeFromWire(body);if(!scope)return candidate;
 const category=(passage:any,target:any)=>!target.receipt_region?'ordinary':passage.receipt_component==='source_transaction_coupling'
  ||(passage.receipt_component===undefined&&passage.draft_paths.length===receiptCouplingPaths(f.draft.actions[0].outcome).length
   &&receiptCouplingPaths(f.draft.actions[0].outcome).every(path=>passage.draft_paths.includes(path)))?'source_transaction_coupling'
  :passage.disposition==='needs_decision'&&passage.responsibility==='deployment'?'setup'
  :passage.draft_paths.includes(READ)?'receipt_read_exclusion':passage.draft_paths.includes(CONFIG)?'receipt_configuration'
  :passage.draft_paths.includes(RECEIPTS)?'receipt_observation':'compiled_effect';
 return {representation:'replacement_only_v2',scope_digest:scope.scope_digest,parent_digest:scope.parent_digest,context:scope.context,
  groups:scope.targets.map((target:any)=>({target_id:target.target_id,
   passage_replacements:target.members.filter((member:any)=>target.findings.some((f:any)=>f.component===member.path
    || f.component.startsWith(member.path+'/draft_paths/') || f.component.startsWith(member.path+'/evidence_checks/'))).map((member:any)=>({
    member_path:member.path,fragments:candidate.passages
     .filter((p:any)=>p.start>=member.start&&p.end<=member.end
      &&!target.required_retained.some((r:any)=>r.raw_digest===`sha256:${createHash('sha256').update(JSON.stringify(p)).digest('hex')}`))
     .map((passage:any)=>{
      const component=category(passage,target);
      // Only newly generated nominated fragments get their declared ID. Never
      // tag byte-identical protected history; coupling omission controls retain
      // the existing exact typed-category host-field completion path.
      return {category:component,passage:['compiled_effect','receipt_configuration','receipt_read_exclusion'].includes(component)
       ?{...passage,receipt_component:component}:passage};
     }),
   })),
   counter_replacements:target.findings.filter((f:any)=>/\/counter_requirements\/\d+$/u.test(f.component)).map((f:any)=>{
    const parentIndex=Number(/^\/passages\/(\d+)/u.exec(f.component)![1]);
    const original=scope.targets.flatMap((t:any)=>t.members).find((m:any)=>m.parent_index===parentIndex);
    const path=(candidate.passages[parentIndex]?.counter_requirements??[])[0]?.path;
    const passage=candidate.passages.find((p:any)=>p.start===original.start&&p.end===original.end
      &&p.counter_requirements?.some((check:any)=>check.path===path));
    return {component_path:f.component,counter_requirement:passage?.counter_requirements?.[Number(f.component.split('/').at(-1))]};
   }),
  }))};
}
function transport(f:any,replies:any[],provider:'openai'|'openrouter'='openrouter'){
 const conversation=createModelAuthoringConversation();conversation.policySources=f.sources;
 const requests:any[]=[];
 const session={provider,model:provider==='openai'?'gpt-5.6-terra':'openai/gpt-5.6-terra',apiKey:'local-only',conversation,
 dependencies:{requestJson:vi.fn(async(r:any)=>{requests.push(structuredClone(r.body));let args=replies[requests.length-1];if(args instanceof Error)throw args;if(!args)throw new Error('No response permitted');
 if(requests.length>1&&canonicalJsonDigest(args)!==canonicalJsonDigest(f.arguments))args=derivedScopedResponse(r.body,args,f);
 return {status:200,body:provider==='openai'?{output:[{type:'function_call',call_id:'test',name:'runner__review_policy_coverage',arguments:JSON.stringify(args)}]}:{choices:[{finish_reason:'tool_calls',message:{role:'assistant',tool_calls:[{id:'test',type:'function',function:{name:'runner__review_policy_coverage',arguments:JSON.stringify(args)}}]}}]}};})}};
 f.sources.approvals.push({digest:f.source.digest,destination:authoringDestination(session)});
 return {session,requests,run:()=>reviewPolicyCoverage({session,source:f.source,draft:f.draft,sourceSession:f.sources})};
}
function correction(body:any){
 const all=(body.messages??body.input).map((m:any)=>m.content).filter((x:any)=>typeof x==='string').join('\n');
 const marker='Correct this structural coverage problem: ';
 return JSON.parse(all.split('\n').find((s:string)=>s.startsWith(marker))!.slice(marker.length));
}
describe('complete captured configuration correction chain',()=>{
 it.each(['openai','openrouter'] as const)('%s corrects only a negatively reviewed second-outcome association under the real replacement producer',async provider=>{
  const f=fixture(),first=f.draft.actions[0],second=structuredClone(first);
  second.name='energy_ops.separate_follow_up';second.outcome=second.name;
  f.draft.actions.push(second);
  const host=structuredClone(f.draft.runner_evidence.actions[first.outcome]);host.outcome=second.outcome;
  f.draft.runner_evidence.actions[second.outcome]=host;
  const setup=f.draft.runner_evidence.runtime_contract.deployment_prerequisites.runner_execution_setup;
  setup.outcomes.push({...setup.outcomes[0],outcome:second.outcome});
  const valid=separated(f),replacement={start:18,end:18,disposition:'implemented',responsibility:'runner',
    issue_kind:'coverage_link',interpretation:receiptComponentMeanings(f.draft).compiled_effect![0],
    draft_paths:[receiptCouplingPaths(second.outcome)[0]]};
  valid.passages.push(replacement);
  const invalid=structuredClone(valid);
  invalid.passages[invalid.passages.length-1]={...replacement,receipt_component:'source_transaction_coupling',
    interpretation:receiptCouplingInterpretation(second.outcome),draft_paths:receiptCouplingPaths(second.outcome)};
  f.sources.coverage_episodes=[{id:'11111111-1111-4111-8111-111111111111',context:canonicalJsonDigest('derived prior'),
    started_at:new Date().toISOString(),submissions:[{number:1,reserved_at:new Date().toISOString(),
      completed_at:new Date().toISOString(),validated:false,tentative:{status:'unaccepted_generation',
        context:canonicalJsonDigest('derived prior'),raw_response:invalid}}]}];
  const question=sourceTransactionScopeQuestions(f.source,f.draft,f.sources)[0]!;
  expect(question.action.outcome).toBe(second.outcome);
  const decision=makeSourceTransactionScopeReview({source:f.source,session:f.sources.id,store:question.store_digest,
    requirement:question.requirement,action:question.action,action_binding_digest:question.action_binding_digest,
    actor:'derived-test-operator',decision:'does_not_apply'});
  f.sources.source_transaction_scope_reviews=[decision];
  expect(()=>parse(f,invalid)).toThrow('SOURCE_TRANSACTION_ASSOCIATION_INVALID');
  expect(()=>parse(f,valid)).not.toThrow();
  let originalError:unknown;
  try{parse(f,invalid);}catch(error){originalError=error;}
  const finding=collectCoverageFeedback(invalid,f.source,f.draft,f.operator_messages,originalError,f.sources).findings;
  expect(finding).toContainEqual(expect.objectContaining({code:'SOURCE_TRANSACTION_ASSOCIATION_INVALID',
    component:`/passages/${invalid.passages.length-1}`,structural:true}));
  f.arguments=invalid;
  const t=transport(f,[invalid,valid],provider);await t.run();
  expect(t.requests).toHaveLength(2);
  const sent=correction(t.requests[1]);
  expect(sent.findings).toContainEqual(expect.objectContaining({code:'SOURCE_TRANSACTION_ASSOCIATION_INVALID',structural:true}));
  const scope=scopeFromWire(t.requests[1]);
  expect(scope.targets).toHaveLength(1);
  expect(scope.targets[0].receipt_region).toBe(true);
  expect(scope.targets[0].required_retained.length).toBeGreaterThan(0);
  expect(f.arguments).toEqual(invalid);
 });
 it.each(['openai','openrouter'] as const)('%s nominates only a host-proven omitted coupling shape and validates the whole scoped replacement',async provider=>{
  const f=fixture(),valid=separated(f),invalid=omittedCouplingShape(f,valid);f.arguments=invalid;
  expect(()=>parse(f)).toThrow('OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED');
  const feedback=collectCoverageFeedback(invalid,f.source,f.draft,f.operator_messages,undefined,f.sources);
  expect(feedback.findings.map(x=>[x.code,x.component,x.structural])).toEqual([
   ['OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED',`/passages/${invalid.passages.findIndex((p:any)=>p.receipt_component==='source_transaction_coupling')}`,true]]);
  const t=transport(f,[invalid,valid],provider);await t.run();expect(t.requests).toHaveLength(2);
  const sent=correction(t.requests[1]);expect(sent.findings).toHaveLength(1);
  expect(sent.findings[0].repair).toContain('outcome-specific canonical capability');
  const scope=scopeFromWire(t.requests[1]);expect(scope.targets).toHaveLength(1);
  expect(scope.targets[0].receipt_region).toBe(true);
  expect(scope.targets[0].allowed_references.source_transaction_coupling).toEqual(expect.arrayContaining(receiptCouplingPaths(f.draft.actions[0].outcome)));
  expect(parse(f,valid).passages.find(p=>p.receipt_coupling)).toMatchObject({receipt_coupling:{origin:'HOST-RESOLVED',effect_count:2,observed:false}});
  expect(f.arguments).toEqual(invalid);
 });
 it.each(['mode','source','revision','transaction','companion','receipt_path','mixed_fields'] as const)(
  'does not nominate %s as a structural coupling repair without the exact current proof',kind=>{
   const f=fixture(),args=omittedCouplingShape(f),p=args.passages.find((p:any)=>p.receipt_component==='source_transaction_coupling');
   const contract=f.draft.runner_evidence.runtime_contract,host=f.draft.runner_evidence.actions[f.draft.actions[0].outcome];
   if(kind==='mode')contract.receipt_configuration.modes[0].authority='runner_ledger';
   if(kind==='source')f.source.digest=canonicalJsonDigest('other source');
   if(kind==='revision')contract.review_evidence_phases.candidate_action_digest=canonicalJsonDigest('other Action');
   if(kind==='transaction')host.effect.transaction='Independent updates, not one transaction';
   if(kind==='companion')host.effect.atomic_updates=[];
   if(kind==='receipt_path')p.draft_paths.pop();
   if(kind==='mixed_fields')p.field_checks=[{resource:'private',field:'unavailable',expectation:'private'}];
   expect(repairableReceiptCouplingRepresentation(p,f.source,f.draft,f.sources)).toBe(false);
   const coupling=collectCoverageFeedback(args,f.source,f.draft,f.operator_messages,undefined,f.sources).findings.find(x=>x.code==='OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED');
   if(kind==='mixed_fields')expect(coupling).toBeUndefined(); // The earlier private-field prerequisite refuses first.
   else expect(coupling).toMatchObject({structural:false});
   expect(()=>parse(f,args)).toThrow();
  });
 it.each(['harmless_punctuation','effect_already_done','writer_ready','denied_transaction'] as const)(
  'nominates the whole unaccepted typed component for %s without accepting its narration',kind=>{
   const f=fixture(),args=engineQualifiedCouplingShape(f),p=args.passages.find((entry:any)=>entry.receipt_component==='source_transaction_coupling');
   if(kind==='harmless_punctuation')p.interpretation=p.interpretation.replace('transaction: they','transaction; they');
   if(kind==='effect_already_done')p.interpretation='The effects and receipt are already committed in the source database.';
   if(kind==='writer_ready')p.interpretation='The writer is already provisioned and ready to execute.';
   if(kind==='denied_transaction')p.interpretation='The business effects and receipt do not commit in one source transaction.';
   expect(()=>parse(f,args)).toThrow('OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED');
   expect(repairableReceiptCouplingRepresentation(p,f.source,f.draft,f.sources)).toBe(true);
   expect(collectCoverageFeedback(args,f.source,f.draft,f.operator_messages,undefined,f.sources).findings)
    .toContainEqual(expect.objectContaining({code:'OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED',structural:true}));
   const accepted=parse(f,separated(f));
   expect(accepted.passages.find(entry=>entry.receipt_component==='source_transaction_coupling')?.interpretation)
    .toBe(receiptCouplingInterpretation(f.draft.actions[0].outcome));
  });
 it('a replacement that repeats a false performed-receipt claim stops after one scoped correction',async()=>{
  const f=fixture(),valid=separated(f),invalid=engineQualifiedCouplingShape(f,valid),repeated=structuredClone(valid);
  repeated.passages.find((p:any)=>p.receipt_component==='source_transaction_coupling').interpretation=
   'The source_db receipt was performed and independently read back.';
  { const p=repeated.passages.find((p:any)=>p.receipt_component==='source_transaction_coupling'); p.draft_paths=p.draft_paths.filter((path:string)=>!path.endsWith('/execution')); }
  f.arguments=invalid;
  const t=transport(f,[invalid,repeated,valid]);
  await expect(t.run()).rejects.toThrow('POLICY_COVERAGE_INVALID');
  expect(t.requests).toHaveLength(2);
  expect(correction(t.requests[1]).findings).toContainEqual(expect.objectContaining({
   code:'OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED',structural:true}));
  expect(()=>parse(f,repeated)).toThrow('OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED');
 });
 it('nominates the authentic B capability-only paraphrase by typed scope and current proof, without accepting its prose',()=>{
  const f=fixture(),args=omittedCouplingShape(f),p=args.passages.find((p:any)=>p.receipt_component==='source_transaction_coupling');
  p.interpretation='The compiled direct-SQL capability couples both listed business effects and the required source_db receipt in one source transaction: all commit together or roll back. This is capability only, not provisioning, execution, a performed receipt, or independent readback.';
  expect(repairableReceiptCouplingRepresentation(p,f.source,f.draft,f.sources)).toBe(true);
  expect(()=>parse(f,args)).toThrow('OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED');
  expect(collectCoverageFeedback(args,f.source,f.draft,f.operator_messages,undefined,f.sources).findings)
    .toContainEqual(expect.objectContaining({code:'OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED',structural:true}));
 });
 it.each(['openai','openrouter'] as const)('%s sends a bounded correction for the latest engine-qualified capability-only serialization',async provider=>{
  const f=fixture(),valid=separated(f),invalid=engineQualifiedCouplingShape(f,valid);
  f.arguments=invalid;
  expect(()=>parse(f)).toThrow('OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED');
  const feedback=collectCoverageFeedback(invalid,f.source,f.draft,f.operator_messages,undefined,f.sources);
  expect(feedback.findings).toContainEqual(expect.objectContaining({
    code:'OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED',structural:true}));
  const t=transport(f,[invalid,valid],provider);
  await t.run();
  expect(t.requests).toHaveLength(2);
  const sent=correction(t.requests[1]);
  expect(sent.findings).toContainEqual(expect.objectContaining({
    code:'OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED',structural:true}));
  const scope=scopeFromWire(t.requests[1]);
  expect(scope.targets).toHaveLength(1);
  expect(scope.targets[0].required_retained.length).toBeGreaterThan(0);
  expect(scope.targets[0].required_retained).toHaveLength(scope.targets[0].members.length-1);
  expect(scope.targets[0].required_retained.every((member:any)=>
    `sha256:${createHash('sha256').update(JSON.stringify(invalid.passages[member.parent_index])).digest('hex')}`===member.raw_digest)).toBe(true);
  expect(scope.targets[0].source_ranges).toEqual([{start:18,end:18}]);
  expect(parse(f,valid).passages.some(p=>p.receipt_coupling?.origin==='HOST-RESOLVED')).toBe(true);
  expect(f.arguments).toEqual(invalid);
 });
 it('does not nominate a changed three-effect requirement without matching compiled capability',()=>{
  const f=fixture(),args=omittedCouplingShape(f),p=args.passages.find((entry:any)=>entry.receipt_component==='source_transaction_coupling');
  const third=structuredClone(f.draft.actions[0].effect.atomic_updates[0]);
  third.target_resource='energy_ops.adjustment_registers';third.target_binding='adjustment';
  f.draft.actions[0].effect.atomic_updates.push(third);
  const store=f.sources.source_transaction_reviews[0].store_digest;
  f.sources.source_transaction_reviews=[makeSourceTransactionReview({source:f.source,session:f.sources.id,store,
    start:18,end:18,mapping:sourceTransactionMappings(f.draft)[0]!,actor:'derived-test-operator',decision:'confirmed'})];
  f.draft.runner_evidence.source_transaction_requirement=sourceTransactionPreparedContext(f.sources,store,f.source.digest);
  p.interpretation='The compiled direct-SQL capability couples both listed business effects and the required source_db receipt in one source transaction: all commit together or roll back. This is capability only, not provisioning, execution, a performed receipt, or independent readback.';
  expect(repairableReceiptCouplingRepresentation(p,f.source,f.draft,f.sources)).toBe(false);
 });
 it('uses the current source and renamed Action binding, not a fixture outcome or passage index',()=>{
  const original=fixture();
  const f=JSON.parse(JSON.stringify(original).replaceAll('energy_ops.finalize_settlement_cycle','tenant.complete_cycle'));
  f.source=policyTextSnapshot(Buffer.from(f.source.text+'\nA later unrelated clause remains pending.','utf8'),
   f.source.name,f.source.version);
  f.draft.runner_evidence.runtime_contract.authoring_lifecycle.current_policy_snapshot.digest=f.source.digest;
  const phase=f.draft.runner_evidence.runtime_contract.review_evidence_phases;
  phase.candidate_action_digest=canonicalJsonDigest(f.draft.actions);
  f.draft.runner_evidence.runtime_contract.saved_execution_review.action_digest=phase.candidate_action_digest;
  if(phase.candidate_action_binding_digest)phase.candidate_action_binding_digest=canonicalJsonDigest({
   candidate_action_digest:phase.candidate_action_digest,actions:f.draft.actions});
  const store=f.sources.source_transaction_reviews[0].store_digest;
  f.sources.source_transaction_reviews=[makeSourceTransactionReview({source:f.source,session:f.sources.id,store,
   start:18,end:18,mapping:sourceTransactionMappings(f.draft)[0]!,actor:'derived-test-operator',decision:'confirmed'})];
  f.draft.runner_evidence.source_transaction_requirement=sourceTransactionPreparedContext(f.sources,store,f.source.digest);
  const args=engineQualifiedCouplingShape(f);
  const coupling=args.passages.find((p:any)=>p.receipt_component==='source_transaction_coupling');
  args.passages.unshift({start:1,end:1,disposition:'needs_decision',interpretation:'Unrelated pending clause.',draft_paths:[]});
  expect(coupling.draft_paths).toEqual(expect.arrayContaining(receiptCouplingPaths('tenant.complete_cycle')));
  expect(repairableReceiptCouplingRepresentation(coupling,f.source,f.draft,f.sources)).toBe(true);
  expect(collectCoverageFeedback(args,f.source,f.draft,f.operator_messages,undefined,f.sources).findings)
   .toContainEqual(expect.objectContaining({code:'OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED',
    component:`/passages/${args.passages.indexOf(coupling)}`,structural:true}));
 });
 it('the actual producer refuses a scoped replacement that drops the challenged transaction conjunction',async()=>{
  const f=fixture(),valid=separated(f),invalid=omittedCouplingShape(f,valid);
  const deleted=structuredClone(valid);
  deleted.passages=deleted.passages.filter((p:any)=>p.receipt_component!=='source_transaction_coupling');
  f.arguments=invalid;
  const t=transport(f,[invalid,deleted]);
  let refusal='';try{await t.run();}catch(error){refusal=(error as Error).message;}
  expect(refusal).toContain('POLICY_COVERAGE_INVALID');
  expect(refusal).toContain('OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED');
  expect(t.requests).toHaveLength(2);
  const scope=scopeFromWire(t.requests[1]);expect(scope.targets[0].receipt_region).toBe(true);
  // The scoped producer nominates this required span even though other
  // configuration, privacy and setup components still cover its source line.
  expect(scope.targets[0].source_ranges).toEqual([{start:18,end:18}]);
  expect(()=>parse(f,deleted)).toThrow('OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED'); // The registered requirement survives omission even outside repair scope.
 });
 it('retains full original invalidity and batches the exact two counter problems plus eligible configuration grouping',()=>{
  const f=fixture(),before=structuredClone(f.arguments);expect(f.arguments.passages).toHaveLength(35);
  expect(()=>parse(f)).toThrow('COUNTING_SUPPORT_MISMATCH');
  const report=collectCoverageFeedback(f.arguments,f.source,f.draft,f.operator_messages,undefined,f.sources);
  expect(report.findings.map(x=>[x.code,x.component,x.structural])).toEqual([
   ['COUNTING_SUPPORT_MISMATCH','/passages/21/counter_requirements/0',true],
   ['COUNTING_SUPPORT_MISMATCH','/passages/22/counter_requirements/0',true],
   ['OBLIGATION_CONFIGURATION_COMPONENT_MIXED','/passages/25',true]]);
  expect(report.complete_validation).toBe(false);expect(f.arguments).toEqual(before);
 });
 it('validates ALL separated passages and preserves receipt and readback duties',()=>{
  const f=fixture(),report=parse(f,separated(f));
  expect(report.passages.filter(p=>p.obligation_assessment).every(p=>p.obligation_assessment!.verified===false)).toBe(true);
  expect(report.passages.some(p=>p.application_obligations?.includes('independent_source_readback'))).toBe(true);
  expect(report.counting_inventory?.paths).toHaveLength(2);
  const blockers=policyReadinessItems(report,f.sources).filter(x=>x.blocksReview);
  expect(blockers.length).toBeGreaterThan(0);expect(blockers.every(x=>Boolean(x.clientDuty))).toBe(true); // exact renewed ownership is performed by prepared-review tests below
 });
 it.each(['openai','openrouter'] as const)('%s serializes the scoped correction for the exact historical tentative parent',async provider=>{
  const f=fixture(),t=transport(f,[f.arguments,separated(f)],provider);
  const context={source:f.source,draft:f.draft,messages:f.operator_messages};
  const nominated=createCoverageRepairScope(f.arguments,collectCoverageFeedback(f.arguments,f.source,f.draft,f.operator_messages,undefined,f.sources),context);
  const derived=derivedScopedResponse({messages:[{content:'Host repair scope (identities and exact references, not authority): '+JSON.stringify(nominated)}]},separated(f),f);
  expect(derived.representation).toBe('replacement_only_v2');
  expect(derived.groups[0].passage_replacements).toEqual([]);
  expect(derived.groups[0].counter_replacements).toHaveLength(2);
  expect(derived.groups[1].counter_replacements).toEqual([]);
  expect(derived.groups[1].passage_replacements).toHaveLength(1);
  const assembled=assembleScopedCoverageReplacement(nominated,f.arguments,derived,context);
  for(const target of nominated.targets)for(const protectedMember of target.required_retained){
   const located=assembled.retained.find(r=>r.parent_index===protectedMember.parent_index)!;
   expect(JSON.stringify(assembled.assembled.passages[located.assembled_index])).toBe(JSON.stringify(f.arguments.passages[protectedMember.parent_index]));
  }
  validateScopedReceiptComponents(assembled.assembled,assembled.categories,nominated,f.source,f.draft,f.sources);
  await t.run();expect(t.requests).toHaveLength(2);
  const fb=correction(t.requests[1]);expect(fb.findings).toHaveLength(3);
  expect(fb.findings.every((x:any)=>x.structural)).toBe(true);
  expect(fb.findings[0].repair).toContain('omit the OPTIONAL counter operator_message_id');
  expect(fb.findings[2].repair).toContain(CONFIG);
  const scope=scopeFromWire(t.requests[1]);expect(scope.disposition).toBe('unaccepted_tentative');expect(scope.targets).toHaveLength(2);
  expect(scope.targets.map((target:any)=>target.receipt_region)).toEqual([false,true]);
  expect(scope.targets.map((target:any)=>target.allowed_references)).toEqual(nominated.targets.map(target=>target.allowed_references));
 });
 it.each(['effect','overview','triple','reordered','duplicate_only','duplicate_companion','unknown_child','foreign_effect','observation','missing','stale','mode','source','destination','read','action','requirement','field','counter','unsupported_setup','setup_outcome','setup_missing','setup_duplicate','setup_mode'])('classifies %s with an explicit evidence-grounded disposition',kind=>{
  const f=fixture(),c=f.draft.runner_evidence.runtime_contract,p=f.arguments.passages[25];
  if(kind==='effect')p.draft_paths=[CONFIG,EFFECT];
  if(kind==='overview')p.draft_paths=[CONFIG,RECEIPTS];
  if(kind==='reordered')p.draft_paths.reverse();
  if(kind==='duplicate_only')p.draft_paths=[CONFIG,CONFIG];
  if(kind==='duplicate_companion')p.draft_paths.push(CONFIG);
  if(kind==='unknown_child')p.draft_paths.push(CONFIG+'/status');
  if(kind==='foreign_effect')p.draft_paths.push('/read');
  if(kind==='observation')p.draft_paths.push('/runner_evidence/runtime_contract/application_obligations/independent_source_readback');
  if(kind==='missing')delete c.receipt_configuration;
  if(kind==='stale')c.receipt_configuration.status='unavailable';
  if(kind==='mode')c.receipt_configuration.modes[0].authority='runner_ledger';
  if(kind==='source')c.receipt_configuration.modes[0].source='other';
  if(kind==='destination')c.receipt_configuration.source_receipt_destinations[0].relation_digest=canonicalJsonDigest('other');
  if(kind==='read')f.draft.read.name='other';
  if(kind==='action')f.draft.actions[0].effect.target_binding='other';
  if(kind==='requirement')f.source.text=f.source.text.replace('source_db receipt','different receipt');
  if(kind==='field')p.field_checks=[{resource:'private-unknown',field:'private-sensitive',expectation:'private'}];
  if(kind==='counter'){p.counter_requirements=structuredClone(f.arguments.passages[21].counter_requirements);delete p.counter_requirements[0].operator_message_id;p.draft_paths.push(p.counter_requirements[0].path.slice(0,-'/capability'.length));}
  if(kind==='unsupported_setup')c.deployment_prerequisites.runner_execution_setup.supported=false;
  if(kind==='setup_outcome')c.deployment_prerequisites.runner_execution_setup.outcomes[0].outcome='other.outcome';
  if(kind==='setup_missing')c.deployment_prerequisites.runner_execution_setup.outcomes=[];
  if(kind==='setup_duplicate')c.deployment_prerequisites.runner_execution_setup.outcomes.push(structuredClone(c.deployment_prerequisites.runner_execution_setup.outcomes[0]));
  if(kind==='setup_mode')c.deployment_prerequisites.runner_execution_setup.outcomes[0].configured_mode='proposal_only';
  const report=collectCoverageFeedback({passages:[p]},f.source,f.draft,f.operator_messages,undefined,f.sources);
  const relevant=report.findings.filter(x=>x.component==='/passages/0');
  if(kind==='overview')expect(relevant).toHaveLength(0); // existing accepted narrow selection + overview; pending duty remains separate
  else if(['effect','triple','reordered'].includes(kind))expect(relevant).toEqual([expect.objectContaining({code:'OBLIGATION_CONFIGURATION_COMPONENT_MIXED',structural:true})]);
  else expect(relevant.some(x=>x.structural)).toBe(false);
  expect(JSON.stringify(report)).not.toContain('private-sensitive');
 });
 it('separate nonrepairable observation prevents retry and no partial report is accepted',async()=>{
  const f=fixture();f.arguments.passages.push({start:18,end:18,disposition:'implemented',responsibility:'runner',interpretation:'An actual source receipt proves independent readback.',draft_paths:[RECEIPTS]});
  const t=transport(f,[f.arguments,separated(f)]);await expect(t.run()).rejects.toThrow('POLICY_COVERAGE_INVALID');expect(t.requests).toHaveLength(1);
 });
 it('a separate false observation stays terminal beside an eligible coupling component',async()=>{
  const f=fixture(),valid=separated(f),invalid=engineQualifiedCouplingShape(f,valid);
  invalid.passages.push({start:18,end:18,disposition:'implemented',responsibility:'runner',
   interpretation:'An actual source receipt proves independent readback.',draft_paths:[RECEIPTS]});
  f.arguments=invalid;
  const feedback=collectCoverageFeedback(invalid,f.source,f.draft,f.operator_messages,undefined,f.sources);
  expect(feedback.findings.some(finding=>finding.code==='OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED'
   && finding.structural)).toBe(true);
  expect(feedback.findings.some(finding=>!finding.structural)).toBe(true);
  const t=transport(f,[invalid,valid]);
  await expect(t.run()).rejects.toThrow('POLICY_COVERAGE_INVALID');
  expect(t.requests).toHaveLength(1);
 });
 it.each(['no_support','wrong_support','heading','condition','duty','false_scalar','false_observation'])('full replacement retains %s blocking',kind=>{
  const f=fixture(),args=separated(f);
  if(kind==='no_support')f.draft.runner_evidence.counting_decisions=[];
  if(kind==='wrong_support')args.passages.find((p:any)=>p.counter_requirements).counter_requirements[0].operator_message_id=2;
  if(kind==='heading'||kind==='condition'){const line=kind==='heading'?1:9;args.passages=args.passages.filter((p:any)=>!(p.start<=line&&p.end>=line));}
  if(kind==='duty')args.passages=args.passages.filter((p:any)=>!p.application_obligations);
  if(kind==='false_scalar')args.passages[25].evidence_checks=[{path:EFFECT+'/target_resource',equals:'different'}];
  if(kind==='false_observation')args.passages.push({start:18,end:18,disposition:'implemented',responsibility:'runner',interpretation:'Invented observation',draft_paths:[RECEIPTS]});
  if(kind==='duty')expect(policyReviewReadiness(f.source,parse(f,args),{...f.sources,application_assignments:[]} as any).ready).toBe(false);
  else expect(()=>parse(f,args)).toThrow();
 });
 it('equivalent passage/pointer order and renamed identifiers preserve receipt disposition',()=>{
  const f=fixture();f.arguments.passages.reverse();for(const p of f.arguments.passages)p.draft_paths.reverse();
  expect(collectCoverageFeedback(f.arguments,f.source,f.draft,f.operator_messages,undefined,f.sources).findings.map(x=>x.code).sort()).toEqual(['COUNTING_SUPPORT_MISMATCH','COUNTING_SUPPORT_MISMATCH','OBLIGATION_CONFIGURATION_COMPONENT_MIXED'].sort());
  const g=JSON.parse(JSON.stringify(f).split('energy_ops.finalize_settlement_cycle').join('tenant.complete_cycle'));
  const p=g.arguments.passages.find((x:any)=>x.draft_paths.includes(CONFIG)&&x.draft_paths.includes(RECEIPTS));
  expect(collectCoverageFeedback({passages:[p]},g.source,g.draft,g.operator_messages,undefined,g.sources).findings.find(x=>x.code==='OBLIGATION_CONFIGURATION_COMPONENT_MIXED')).toMatchObject({structural:true});
 });
 it.each(['source_requirement_unestablished','selection_unavailable','mode_mismatch','component_not_isolatable','responsibility_mismatch','reference_overbroad','current_selection_mixed_component'] as const)('maps typed configuration reason %s exhaustively; identical plain text stays conservative',reason=>{
  const e=new CoverageReceiptConfigurationError(reason),finding=coverageFinding(e,'/passages/0',{});
  expect(finding.code).not.toBe('COVERAGE_VALIDATION_INCOMPLETE');expect(finding.structural).toBe(reason==='current_selection_mixed_component');
  expect(coverageFinding(new Error(e.message),'/passages/0',{}).structural).toBe(false);
 });
 it.each(['deployment','application',undefined] as const)('implemented configuration cannot bypass assessment through responsibility %s',responsibility=>{
  for(const roots of [[CONFIG],[CONFIG,EFFECT],[CONFIG,EFFECT,RECEIPTS]]){
   const f=fixture(),args=structuredClone(f.arguments);for(const p of args.passages)for(const c of p.counter_requirements??[])delete c.operator_message_id;
   args.passages[25].draft_paths=roots;args.passages[25].responsibility=responsibility;
   if(responsibility===undefined)delete args.passages[25].responsibility;
   const report=collectCoverageFeedback(args,f.source,f.draft,f.operator_messages,undefined,f.sources);
   expect(report.findings.find(x=>x.component==='/passages/25')).toMatchObject({code:'OBLIGATION_CONFIGURATION_COMPONENT_MIXED',structural:false});
   expect(()=>parse(f,args)).toThrow('OBLIGATION_CONFIGURATION_COMPONENT_MIXED');
  }
 });
 it.each([CONFIG+'/status','/runner_evidence/runtime_contract','/runner_evidence'])('scalar/broad %s cannot bypass receipt assessment',reference=>{
  for(const roots of [[reference],[reference,EFFECT]]){
   const f=fixture(),args=structuredClone(f.arguments);for(const p of args.passages)for(const c of p.counter_requirements??[])delete c.operator_message_id;
   args.passages[25].draft_paths=roots;
   const report=collectCoverageFeedback(args,f.source,f.draft,f.operator_messages,undefined,f.sources);
   expect(report.findings.find(x=>x.component==='/passages/25')).toMatchObject({code:'OBLIGATION_CONFIGURATION_REFERENCE_OVERBROAD',structural:false});
   expect(()=>parse(f,args)).toThrow('OBLIGATION_CONFIGURATION_REFERENCE_OVERBROAD');
  }
 });
 it.each(['readback_unestablished','setup_unestablished','evidence_stale'] as const)('maps early typed %s without a generic retry',reason=>{
  const finding=coverageFinding(new CoverageReceiptDutyError(reason),'/passages/0',{});
  expect(finding.structural).toBe(false);expect(finding.code).not.toBe('COVERAGE_VALIDATION_INCOMPLETE');
 });
 it.each(['readback','setup','stale'])('real %s validator exposes explicit nonstructural receipt evidence failure',kind=>{
  const f=fixture(),args=separated(f);
  if(kind==='readback')f.draft.runner_evidence.runtime_contract.application_obligations.independent_source_readback.phase='before_execution';
  if(kind==='setup')f.draft.runner_evidence.runtime_contract.deployment_prerequisites.runner_execution_setup.supported=false;
  if(kind==='stale'){
   const saved=parse(f,args);args.passages=saved.passages;const p=args.passages.find((p:any)=>p.obligation_assessment);p.obligation_assessment.dependencies_digest=canonicalJsonDigest('stale');
  }
  const report=collectCoverageFeedback(args,f.source,f.draft,f.operator_messages,undefined,f.sources);
  const code=kind==='readback'?'OBLIGATION_READBACK_UNESTABLISHED':kind==='setup'?'OBLIGATION_SETUP_UNESTABLISHED':'OBLIGATION_EVIDENCE_STALE';
  expect(report.findings.find(x=>x.code===code)).toMatchObject({structural:false});expect(()=>parse(f,args)).toThrow();
 });
 it('repeated invalid response stops without replenishing its correction budget',async()=>{const f=fixture(),t=transport(f,[f.arguments,f.arguments,separated(f)]);await expect(t.run()).rejects.toThrow('POLICY_COVERAGE_INVALID');expect(t.requests).toHaveLength(2);});
 it('a valid first response requires no extra opinion',async()=>{const f=fixture(),t=transport(f,[separated(f)]);await t.run();expect(t.requests).toHaveLength(1);});
});

describe('current-proof complete save and restart',()=>{
 async function prepared(replies:(f:any)=>any[]){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'evidence-correction-')),f=fixture(),t=transport(f,replies(f));
  vi.spyOn(receiptConfiguration,'authoringReceiptConfiguration').mockResolvedValue(f.draft.runner_evidence.runtime_contract.receipt_configuration);
  await savePolicySources(root,f.sources);
  const input={projectRoot:root,sources:f.sources,modelSession:t.session,operatorSession:{chooseOption:vi.fn(async()=> 'assign'),confirm:vi.fn(async()=>true)} as any,
   currentDraft:()=>f.draft,authorityDigest:f.sources.coverage_authority_digest,clarifications:[],assertCurrent:async()=>{},state:{},onValidated:vi.fn()};
  return {root,f,t,input};
 }
 it('engine-qualified invalid parent receives one scoped correction, saves complete BUSINESS review, and reuses it',async()=>{
  const x=await prepared(f=>[engineQualifiedCouplingShape(f),separated(f)]);
  try{
   const result=await ensurePreparedPolicyCoverage(x.input);
   expect(result.activity).toBe('provider');
   expect(x.t.requests).toHaveLength(2);
   const sent=correction(x.t.requests[1]);
   expect(sent.findings.map((finding:any)=>[finding.code,finding.component,finding.structural])).toEqual([
    ['OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED',
      `/passages/${engineQualifiedCouplingShape(x.f).passages.findIndex((p:any)=>p.receipt_component==='source_transaction_coupling')}`,true]]);
   const saved=await loadPolicySources(x.root,x.f.sources.id);
   expect(saved.coverage_episodes?.at(-1)?.submissions.map(s=>s.validated)).toEqual([false,true]);
   expect(saved.coverage_episodes?.at(-1)?.submissions[0]?.tentative?.raw_response)
    .toEqual(engineQualifiedCouplingShape(x.f));
   expect(saved.coverage_episodes?.at(-1)?.submissions[1]?.tentative?.raw_parent)
    .toEqual(engineQualifiedCouplingShape(x.f));
   expect(policyReviewReadiness(x.f.source,saved.coverage!,saved).ready).toBe(true);
   expect(saved.coverage?.source_transaction_association?.decision).toBe('operator_confirmed_unverified');
   expect(saved.coverage?.passages.some(p=>p.receipt_coupling?.observed===false)).toBe(true);
   expect(saved.coverage?.passages.filter(p=>p.obligation_assessment).every(p=>p.obligation_assessment?.verified===false)).toBe(true);
   x.t.session.conversation.policySources=saved;
   const recheck=await ensurePreparedPolicyCoverage({...x.input,sources:saved,state:{}});
   expect(recheck.activity).toBe('validated_reuse');
   expect(x.t.requests).toHaveLength(2);
  }finally{vi.restoreAllMocks();await fs.rm(x.root,{recursive:true,force:true});}
 });
 it.each(['both','all','responsibility','issue_kind','receipt_component'] as const)('host supplies %s omitted typed fields only for the nominated run60 coupling representation',async omitted=>{
  const x=await prepared(f=>{
   const corrected=separated(f),coupling=corrected.passages.find((p:any)=>p.receipt_component==='source_transaction_coupling');
   // DERIVED only: the paid run60 correction used this exact canonical meaning
   // and exact references but omitted these two host-determined fields.
   if(omitted==='both'||omitted==='all'||omitted==='responsibility')delete coupling.responsibility;
   if(omitted==='both'||omitted==='all'||omitted==='issue_kind')delete coupling.issue_kind;
   if(omitted==='all'||omitted==='receipt_component')delete coupling.receipt_component;
   return [engineQualifiedCouplingShape(f),corrected];
  });
  try{
   const result=await ensurePreparedPolicyCoverage(x.input);
   expect(result.activity).toBe('provider');
   expect(x.t.requests).toHaveLength(2);
   const outgoing=x.t.requests[1].tools[0].function.parameters;
   expect(outgoing.properties.groups.items.properties.target_id.description)
    .toContain('Runner supplies responsibility=runner, issue_kind=coverage_link and receipt_component=source_transaction_coupling');
   const saved=await loadPolicySources(x.root,x.f.sources.id);
   expect(saved.coverage_episodes?.at(-1)?.submissions.map(s=>s.validated)).toEqual([false,true]);
   const correction=saved.coverage_episodes?.at(-1)?.submissions[1]?.tentative;
   const raw=(correction?.raw_response as any).groups[0].passage_replacements[0].fragments[0].passage;
   if(omitted==='both'||omitted==='all'||omitted==='responsibility')expect(raw).not.toHaveProperty('responsibility');
   if(omitted==='both'||omitted==='all'||omitted==='issue_kind')expect(raw).not.toHaveProperty('issue_kind');
   if(omitted==='all'||omitted==='receipt_component')expect(raw).not.toHaveProperty('receipt_component');
   expect(correction?.host_supplied_fields).toEqual([{member_path:`/passages/${engineQualifiedCouplingShape(x.f).passages.findIndex((p:any)=>p.receipt_component==='source_transaction_coupling')}`,
    fields:omitted==='both'?['responsibility','issue_kind']:omitted==='all'
     ?['responsibility','issue_kind','receipt_component']:[omitted]}]);
   expect((correction?.assembled as any)?.passages.find((p:any)=>p.receipt_component==='source_transaction_coupling'))
    .toMatchObject({responsibility:'runner',issue_kind:'coverage_link',receipt_component:'source_transaction_coupling'});
   expect(saved.coverage?.passages.find(p=>p.receipt_component==='source_transaction_coupling'))
    .toMatchObject({responsibility:'runner',issue_kind:'coverage_link',receipt_component:'source_transaction_coupling'});
   expect(policyReviewReadiness(x.f.source,saved.coverage!,saved).ready).toBe(true);
  }finally{vi.restoreAllMocks();await fs.rm(x.root,{recursive:true,force:true});}
 });
 it.each([['responsibility','operator'],['issue_kind','business_choice'],
  ['receipt_component','other'],['receipt_component',null]] as const)('refuses explicitly wrong %s on the nominated coupling fragment',async(key,value)=>{
  const x=await prepared(f=>{
   const corrected=separated(f),coupling=corrected.passages.find((p:any)=>p.receipt_component==='source_transaction_coupling');
   coupling[key]=value;
   return [engineQualifiedCouplingShape(f),corrected];
  });
  const original=structuredClone(x.f.sources.coverage);
  try{
   await expect(ensurePreparedPolicyCoverage(x.input)).rejects.toThrow('COVERAGE_SCOPED_CORRECTION_REFUSED');
   const saved=await loadPolicySources(x.root,x.f.sources.id);
   expect(saved.coverage_episodes?.at(-1)?.submissions.map(s=>s.validated)).toEqual([false,false]);
   expect(saved.coverage).toEqual(original);
  }finally{vi.restoreAllMocks();await fs.rm(x.root,{recursive:true,force:true});}
 });
 it('does not supply fields for a separate receipt setup fragment',async()=>{
  const x=await prepared(f=>{
   const corrected=separated(f),setup=corrected.passages.find((p:any)=>p.receipt_component===undefined
    &&p.disposition==='needs_decision'&&p.draft_paths.includes(CONFIG));
   delete setup.responsibility;delete setup.issue_kind;
   return [engineQualifiedCouplingShape(f),corrected];
  });
  const original=structuredClone(x.f.sources.coverage);
  try{
   await expect(ensurePreparedPolicyCoverage(x.input)).rejects.toThrow('POLICY_COVERAGE_INVALID');
   const saved=await loadPolicySources(x.root,x.f.sources.id);
   expect(saved.coverage_episodes?.at(-1)?.submissions.map(s=>s.validated)).toEqual([false,false]);
   expect(saved.coverage).toEqual(original);
   expect(saved.coverage_episodes?.at(-1)?.submissions[1]?.tentative?.host_supplied_fields).toBeUndefined();
  }finally{vi.restoreAllMocks();await fs.rm(x.root,{recursive:true,force:true});}
 });
 it('a repeated false receipt assertion remains in invalid history and cannot spend a second correction',async()=>{
  const x=await prepared(f=>{
   const valid=separated(f),initial=engineQualifiedCouplingShape(f,valid),repeated=structuredClone(valid);
   initial.passages.find((p:any)=>p.receipt_component==='source_transaction_coupling').interpretation=
    'A source receipt has already been written and independently read back.';
   repeated.passages.find((p:any)=>p.receipt_component==='source_transaction_coupling').interpretation=
    'The source_db receipt was performed and independently read back.';
   { const p=repeated.passages.find((p:any)=>p.receipt_component==='source_transaction_coupling'); p.draft_paths=p.draft_paths.filter((path:string)=>!path.endsWith('/execution')); }
   return [initial,repeated,valid];
  });
  const original=structuredClone(x.f.sources.coverage),ownership=structuredClone(x.f.sources.application_assignments);
  try{
   await expect(ensurePreparedPolicyCoverage(x.input)).rejects.toThrow('POLICY_COVERAGE_INVALID');
   expect(x.t.requests).toHaveLength(2);
   const saved=await loadPolicySources(x.root,x.f.sources.id);
   expect(saved.coverage).toEqual(original);
   expect(saved.application_assignments).toEqual(ownership);
   const attempts=saved.coverage_episodes?.at(-1)?.submissions;
   expect(attempts?.map(s=>s.validated)).toEqual([false,false]);
   expect(JSON.stringify(attempts?.[0]?.tentative?.raw_response)).toContain('already been written and independently read back');
   expect(JSON.stringify(attempts?.[1]?.tentative?.raw_response)).toContain('performed and independently read back');
  }finally{vi.restoreAllMocks();await fs.rm(x.root,{recursive:true,force:true});}
 });
 it.each(['openai','openrouter'] as const)('%s loopback SSE drives preparation, scoped correction, full persistence and unchanged reuse',async provider=>{
  const x=await prepared(f=>[f.arguments,separated(f)]),wire:any[]=[],stream:any[]=[],previous=structuredClone(x.f.sources.coverage_episodes);
  const server=createServer(async(req,res)=>{
   const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));wire.push(JSON.parse(Buffer.concat(chunks).toString()));
   const args=wire.length===1?x.f.arguments:derivedScopedResponse(wire.at(-1),separated(x.f),x.f);res.setHeader('content-type','text/event-stream');
   if(provider==='openai'){
    res.write(`data: ${JSON.stringify({type:'response.output_item.added',item:{type:'function_call',name:'runner__review_policy_coverage'}})}\n\n`);
    res.end(`data: ${JSON.stringify({type:'response.completed',response:{status:'completed',output:[{type:'function_call',call_id:'local',name:'runner__review_policy_coverage',arguments:JSON.stringify(args)}]}})}\n\n`);
   }else{
    const text=JSON.stringify(args),mid=Math.floor(text.length/2);
    res.write(`data: ${JSON.stringify({choices:[{delta:{reasoning_details:[{type:'reasoning.encrypted',data:'opaque-local-private-continuation',index:0}],tool_calls:[{index:0,id:'local',type:'function',function:{name:'runner__review_policy_coverage',arguments:text.slice(0,mid)}}]}}]})}\n\n`);
    res.write(`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,function:{arguments:text.slice(mid)}}]}}]})}\n\n`);
    res.end(`data: ${JSON.stringify({choices:[{delta:{},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`);
   }
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
   const address=server.address();if(!address||typeof address==='string')throw new Error('local address missing');
   const session={...x.t.session,provider,model:provider==='openai'?'gpt-5.6-terra':'openai/gpt-5.6-terra',dependencies:{
    requestJson:(r:any)=>secureAskJsonRequest({...r,headers:{},endpoint:new URL(`http://127.0.0.1:${address.port}/test`),scope:'custom_loopback'}),onStream:(e:any)=>stream.push(e)}};
   x.f.sources.approvals.push({digest:x.f.source.digest,destination:authoringDestination(session)});await savePolicySources(x.root,x.f.sources);
   const input={...x.input,modelSession:session};const result=await ensurePreparedPolicyCoverage(input);
   expect(result.activity).toBe('provider');expect(wire).toHaveLength(2);
   expect(correction(wire[1]).findings.map((x:any)=>x.code)).toEqual(['COUNTING_SUPPORT_MISMATCH','COUNTING_SUPPORT_MISMATCH','OBLIGATION_CONFIGURATION_COMPONENT_MIXED']);
   expect(correction(wire[1]).findings.every((x:any)=>x.structural)).toBe(true);
   expect(scopeFromWire(wire[1]).targets).toHaveLength(2);
   expect(JSON.stringify(wire[1])).not.toContain('opaque-local-private-continuation');expect(JSON.stringify(stream)).not.toContain('opaque-local-private-continuation');
   const saved=await loadPolicySources(x.root,x.f.sources.id);
   expect(saved.coverage_episodes?.slice(0,previous.length)).toEqual(previous);expect(saved.coverage_episodes?.at(-1)?.submissions).toHaveLength(2);
   expect(saved.coverage_episodes?.at(-1)?.submissions.map(s=>s.validated)).toEqual([false,true]);
   const tentative=saved.coverage_episodes!.at(-1)!.submissions[1]!.tentative!;
   expect(tentative.raw_parent).toEqual(x.f.arguments);expect(tentative.raw_response).toHaveProperty('groups');
   expect(tentative.assembled).toHaveProperty('passages');
   expect(policyReviewReadiness(x.f.source,saved.coverage,saved).ready).toBe(true);
   expect(saved.application_assignments?.every(a=>a.verified===false)).toBe(true);
   const duties=saved.coverage!.passages.filter(p=>p.obligation_assessment);expect(duties.length).toBeGreaterThan(0);expect(duties.every(p=>p.obligation_assessment!.verified===false)).toBe(true);
   session.conversation.policySources=saved;
   const recheck=await ensurePreparedPolicyCoverage({...input,sources:saved,state:{}});expect(recheck.activity).toBe('validated_reuse');expect(wire).toHaveLength(2);
   expect(x.input.onValidated).toHaveBeenCalledTimes(2);
  }finally{await new Promise<void>(r=>server.close(()=>r()));vi.restoreAllMocks();await fs.rm(x.root,{recursive:true,force:true});}
 });
 it.each(['repeated','transport','residual','cancel','failed_save','concurrent_source','drift_read','drift_action','drift_selection','drift_decision'])('%s preserves prior coverage and no partial ownership',async mode=>{
  const x=await prepared(f=>mode==='repeated'?[f.arguments,f.arguments]:mode==='transport'?[f.arguments,new Error('local transport refused')]:mode==='residual'?[f.arguments,{passages:[...separated(f).passages,{start:18,end:18,disposition:'implemented',responsibility:'runner',interpretation:'Invented observation',draft_paths:[RECEIPTS]}]}]:[f.arguments,separated(f)]);
  const priorCoverage=structuredClone(x.f.sources.coverage),priorOwners=structuredClone(x.f.sources.application_assignments);
  try{
   if(mode==='cancel') {x.input.operatorSession.confirm.mockResolvedValue(false);Object.assign(x.input,{savedReviewEpisode:{job:'saved review',subject:'current Action'}});}
   if(mode==='failed_save')vi.spyOn(fs,'rename').mockRejectedValue(new Error('controlled save failed'));
   if(mode==='concurrent_source')x.input.assertCurrent=async()=>{await savePolicySources(x.root,{...x.f.sources,operator_messages:[...x.f.sources.operator_messages,'separate changed decision']});};
   if(mode.startsWith('drift_')){
    const original=x.t.session.dependencies.requestJson;x.t.session.dependencies.requestJson=vi.fn(async(r:any)=>{
     const response=await original(r);
     if(x.t.requests.length===2){
      if(mode==='drift_read')x.f.draft.read.name='changed Read';
      if(mode==='drift_action')x.f.draft.actions[0].effect.operation='changed';
      if(mode==='drift_selection')x.f.draft.runner_evidence.runtime_contract.receipt_configuration.digest=canonicalJsonDigest('changed');
      if(mode==='drift_decision')await savePolicySources(x.root,{...x.f.sources,operator_messages:[...x.f.sources.operator_messages,'changed decision']});
     }return response;
    });
   }
   await expect(ensurePreparedPolicyCoverage(x.input)).rejects.toThrow();
   vi.restoreAllMocks();const saved=await loadPolicySources(x.root,x.f.sources.id);
   expect(saved.coverage).toEqual(priorCoverage);expect(saved.application_assignments).toEqual(priorOwners);expect(x.input.onValidated).not.toHaveBeenCalled();
   if(['cancel','failed_save','concurrent_source'].includes(mode))expect(x.t.requests).toHaveLength(0);
   else expect(x.t.requests).toHaveLength(2);
  }finally{vi.restoreAllMocks();await fs.rm(x.root,{recursive:true,force:true});}
 });
});
