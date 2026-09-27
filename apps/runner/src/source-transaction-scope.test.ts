import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe,it,expect,vi} from 'vitest';
import {canonicalJsonDigest} from '@synapsor-runner/protocol';
import {savePolicySources,loadPolicySources,authoringDestination} from './authoring-policy-source.js';
import {withProjectAuthorityMutation} from './project-authority-mutation.js';
import {ensurePreparedPolicyCoverage} from './authoring-prepared-policy-review.js';
import {localSourceTransactionScopeReview} from './authoring-source-transaction-operation.js';
import {makeSourceTransactionReview,sourceTransactionMappings,sourceTransactionPreparedContext} from './authoring-source-transaction-review.js';
import {makeSourceTransactionScopeReview,sourceTransactionScopeQuestions,currentSourceTransactionScopeReview} from './authoring-source-transaction-scope.js';
import {assertRequiredReceiptCoupling,receiptCouplingInterpretation,receiptCouplingPaths} from './authoring-obligation-review.js';

const captured=JSON.parse(await fs.readFile(new URL('./test-fixtures/receipt-correction-chain.json',import.meta.url),'utf8'));
const store=canonicalJsonDigest('derived fixture project binding');
function fixture(){
  const f=structuredClone(captured);
  const first=f.draft.actions[0];
  const second=structuredClone(first);
  second.name='energy_ops.separately_reviewed_outcome';second.outcome=second.name;
  f.draft.actions.push(second);
  const host=structuredClone(f.draft.runner_evidence.actions[first.outcome]);host.outcome=second.outcome;
  f.draft.runner_evidence.actions[second.outcome]=host;
  const setup=f.draft.runner_evidence.runtime_contract.deployment_prerequisites.runner_execution_setup;
  setup.outcomes.push({...setup.outcomes[0],outcome:second.outcome});
  const mapping=sourceTransactionMappings(f.draft)[0]!;
  const record=makeSourceTransactionReview({source:f.source,session:f.sources.id,store,start:18,end:18,
    mapping,actor:'derived-test-operator',decision:'confirmed'});
  f.sources.source_transaction_reviews=[record];
  f.draft.runner_evidence.source_transaction_requirement=sourceTransactionPreparedContext(f.sources,store,f.source.digest);
  const passage=(outcome:string)=>({start:18,end:18,disposition:'implemented' as const,responsibility:'runner' as const,
    issue_kind:'coverage_link' as const,receipt_component:'source_transaction_coupling' as const,
    interpretation:receiptCouplingInterpretation(outcome),draft_paths:receiptCouplingPaths(outcome)});
  f.sources.coverage_episodes=[{id:'11111111-1111-4111-8111-111111111111',context:canonicalJsonDigest('prior invalid'),
    started_at:new Date().toISOString(),submissions:[{number:1,reserved_at:new Date().toISOString(),
      completed_at:new Date().toISOString(),validated:false,tentative:{status:'unaccepted_generation',
        context:canonicalJsonDigest('prior invalid'),raw_response:{passages:[passage(first.outcome),passage(second.outcome)]}}}]}];
  return {f,record,first:passage(first.outcome),second:passage(second.outcome)};
}

describe('per-outcome source transaction scope',()=>{
  it('retains the registered unknown after the model omits its earlier extra association',()=>{
    const {f,first,second}=fixture();
    const questions=sourceTransactionScopeQuestions(f.source,f.draft,f.sources);
    expect(questions).toHaveLength(1);
    expect(questions[0]!.action.outcome).toBe(second.draft_paths[0]!.split('/')[3]);
    expect(()=>assertRequiredReceiptCoupling([first,second],f.source,f.draft,[],f.sources))
      .toThrow('SOURCE_TRANSACTION_SCOPE_UNESTABLISHED');
    expect(()=>assertRequiredReceiptCoupling([first],f.source,f.draft,[],f.sources))
      .toThrow('SOURCE_TRANSACTION_SCOPE_UNESTABLISHED');
  });

  it('retains every unanswered pairing within the twelve-Action boundary, including the ninth',()=>{
    const {f,first,second}=fixture();
    for(let index=2;index<=9;index++){
      const action=structuredClone(f.draft.actions[1]);
      action.name=`energy_ops.separately_reviewed_${index}`;action.outcome=action.name;
      f.draft.actions.push(action);
      f.draft.runner_evidence.actions[action.outcome]=structuredClone(f.draft.runner_evidence.actions[f.draft.actions[1].outcome]);
      f.draft.runner_evidence.runtime_contract.deployment_prerequisites.runner_execution_setup.outcomes.push({
        ...f.draft.runner_evidence.runtime_contract.deployment_prerequisites.runner_execution_setup.outcomes[1],
        outcome:action.outcome});
      f.sources.coverage_episodes[0].submissions[0].tentative.raw_response.passages.push({
        ...structuredClone(second),draft_paths:receiptCouplingPaths(action.outcome)});
    }
    const questions=sourceTransactionScopeQuestions(f.source,f.draft,f.sources);
    expect(f.draft.actions).toHaveLength(10);
    expect(questions).toHaveLength(9);
    f.sources.source_transaction_scope_reviews=questions.slice(0,8).map(question=>makeSourceTransactionScopeReview({
      source:f.source,session:f.sources.id,store,requirement:question.requirement,action:question.action,
      action_binding_digest:question.action_binding_digest,actor:'derived-test-operator',decision:'does_not_apply'}));
    expect(()=>assertRequiredReceiptCoupling([first],f.source,f.draft,[],f.sources))
      .toThrow('SOURCE_TRANSACTION_SCOPE_UNESTABLISHED');
  });

  it('retains all registered pairings at sixty-four and refuses sixty-five without truncation',()=>{
    const {f,first,second}=fixture();
    const template=structuredClone(f.draft.actions[1]);
    const expected=[template.outcome];
    for(let index=3;index<=64;index++){
      const action=structuredClone(template);
      action.name=`energy_ops.supported_${index}`;action.outcome=action.name;
      f.draft.actions.push(action); expected.push(action.outcome);
      f.draft.runner_evidence.actions[action.outcome]=structuredClone(f.draft.runner_evidence.actions[template.outcome]);
      f.draft.runner_evidence.runtime_contract.deployment_prerequisites.runner_execution_setup.outcomes.push({
        ...f.draft.runner_evidence.runtime_contract.deployment_prerequisites.runner_execution_setup.outcomes[1],
        outcome:action.outcome});
      f.sources.coverage_episodes[0].submissions[0].tentative.raw_response.passages.push({
        ...structuredClone(second),draft_paths:receiptCouplingPaths(action.outcome)});
    }
    expect(f.draft.actions).toHaveLength(64);
    const questions=sourceTransactionScopeQuestions(f.source,f.draft,f.sources);
    expect(questions.map(question=>question.action.outcome).sort()).toEqual(expected.sort());
    expect(questions).toHaveLength(63);
    expect(questions.every(question=>!question.current)).toBe(true);
    expect(()=>assertRequiredReceiptCoupling([first],f.source,f.draft,[],f.sources))
      .toThrow('SOURCE_TRANSACTION_SCOPE_UNESTABLISHED');
    f.draft.actions.push({...structuredClone(template),name:'energy_ops.unsupported_65',outcome:'energy_ops.unsupported_65'});
    expect(f.draft.actions).toHaveLength(65);
    expect(()=>sourceTransactionScopeQuestions(f.source,f.draft,f.sources))
      .toThrow('SOURCE_TRANSACTION_SCOPE_INVENTORY_LIMIT');
  });

  it('uses an explicit negative for only the nominated association, retaining finalization',()=>{
    const {f,first,second}=fixture(),question=sourceTransactionScopeQuestions(f.source,f.draft,f.sources)[0]!;
    const answer=makeSourceTransactionScopeReview({source:f.source,session:f.sources.id,store,
      requirement:question.requirement,action:question.action,action_binding_digest:question.action_binding_digest,
      actor:'derived-test-operator',decision:'does_not_apply'});
    f.sources.source_transaction_scope_reviews=[answer];
    expect(currentSourceTransactionScopeReview(f.source,f.draft,f.sources,question.requirement,question.action)?.digest).toBe(answer.digest);
    expect(()=>assertRequiredReceiptCoupling([first],f.source,f.draft,[],f.sources)).not.toThrow();
    expect(()=>assertRequiredReceiptCoupling([first,second],f.source,f.draft,[],f.sources))
      .toThrow('SOURCE_TRANSACTION_ASSOCIATION_INVALID');
    f.draft.actions[1].effect.set={...f.draft.actions[1].effect.set,posted_credits:5};
    expect(sourceTransactionScopeQuestions(f.source,f.draft,f.sources)[0]?.current).toBeUndefined();
    expect(()=>assertRequiredReceiptCoupling([first],f.source,f.draft,[],f.sources))
      .toThrow('SOURCE_TRANSACTION_SCOPE_UNESTABLISHED');
  });

  it('requires both current meaning and exact two-effect capability for an affirmative second association',()=>{
    const {f,first,second}=fixture(),question=sourceTransactionScopeQuestions(f.source,f.draft,f.sources)[0]!;
    const answer=makeSourceTransactionScopeReview({source:f.source,session:f.sources.id,store,
      requirement:question.requirement,action:question.action,action_binding_digest:question.action_binding_digest,
      actor:'derived-test-operator',decision:'applies'});
    f.sources.source_transaction_scope_reviews=[answer];
    expect(()=>assertRequiredReceiptCoupling([first,second],f.source,f.draft,[],f.sources)).not.toThrow();
    expect(()=>assertRequiredReceiptCoupling([first],f.source,f.draft,[],f.sources))
      .toThrow('SOURCE_TRANSACTION_SCOPE_CAPABILITY_MISMATCH');
    f.draft.actions[1].effect.atomic_updates=[];
    expect(()=>assertRequiredReceiptCoupling([first,second],f.source,f.draft,[],f.sources)).toThrow();
  });

  it('does not transfer an affirmative clause to a same-count Action with different assignments',()=>{
    const {f,first,second}=fixture();
    const original=f.draft.actions[0],follow=f.draft.actions[1];
    follow.effect.allowed_fields=structuredClone(original.effect.allowed_fields);
    follow.effect.atomic_updates=structuredClone(original.effect.atomic_updates);
    const host=f.draft.runner_evidence.actions[follow.outcome];
    host.effect=structuredClone(f.draft.runner_evidence.actions[original.outcome].effect);
    const changed={kind:'input',name:'credits_to_post'};
    follow.effect.atomic_updates[0].set.credited_total=changed;
    host.effect.atomic_updates[0].set.credited_total=changed;
    const question=sourceTransactionScopeQuestions(f.source,f.draft,f.sources)[0]!;
    f.sources.source_transaction_scope_reviews=[makeSourceTransactionScopeReview({source:f.source,
      session:f.sources.id,store,requirement:question.requirement,action:question.action,
      action_binding_digest:question.action_binding_digest,actor:'derived-test-operator',decision:'applies'})];
    expect(sourceTransactionMappings(f.draft)[1]!.required_effects).not.toEqual(question.requirement.required_effects);
    expect(()=>assertRequiredReceiptCoupling([first,second],f.source,f.draft,[],f.sources))
      .toThrow('SOURCE_TRANSACTION_SCOPE_CAPABILITY_MISMATCH');
  });

  it('retains meaning across lifecycle bookkeeping but invalidates changed receipt or Read bindings',()=>{
    const {f}=fixture(),question=sourceTransactionScopeQuestions(f.source,f.draft,f.sources)[0]!;
    const answer=makeSourceTransactionScopeReview({source:f.source,session:f.sources.id,store,
      requirement:question.requirement,action:question.action,action_binding_digest:question.action_binding_digest,
      actor:'derived-test-operator',decision:'does_not_apply'});
    f.sources.source_transaction_scope_reviews=[answer];
    const action=f.draft.actions.find((entry:any)=>entry.outcome===question.action.outcome)!;
    action.review={status:'published',at:'2026-09-24T00:00:00.000Z'};
    f.draft.runner_evidence.runtime_contract.receipt_configuration.reviewed_intent={status:'renewed'};
    expect(sourceTransactionScopeQuestions(f.source,f.draft,f.sources)[0]?.current?.digest).toBe(answer.digest);
    f.draft.runner_evidence.runtime_contract.receipt_configuration.source_receipt_destinations=[];
    expect(sourceTransactionScopeQuestions(f.source,f.draft,f.sources)[0]?.current).toBeUndefined();
    f.draft.runner_evidence.runtime_contract.receipt_configuration.source_receipt_destinations=
      captured.draft.runner_evidence.runtime_contract.receipt_configuration.source_receipt_destinations;
    f.draft.read.resource='changed_resource';
    expect(sourceTransactionScopeQuestions(f.source,f.draft,f.sources)[0]?.current).toBeUndefined();
  });

  it('keeps a removed outcome decision as history without transferring it to another Action',()=>{
    const {f,first}=fixture(),question=sourceTransactionScopeQuestions(f.source,f.draft,f.sources)[0]!;
    const answer=makeSourceTransactionScopeReview({source:f.source,session:f.sources.id,store,
      requirement:question.requirement,action:question.action,action_binding_digest:question.action_binding_digest,
      actor:'derived-test-operator',decision:'does_not_apply'});
    f.sources.source_transaction_scope_reviews=[answer];
    f.draft.actions=f.draft.actions.filter((entry:any)=>entry.outcome!==question.action.outcome);
    delete f.draft.runner_evidence.actions[question.action.outcome];
    f.draft.runner_evidence.runtime_contract.deployment_prerequisites.runner_execution_setup.outcomes=
      f.draft.runner_evidence.runtime_contract.deployment_prerequisites.runner_execution_setup.outcomes
        .filter((entry:any)=>entry.outcome!==question.action.outcome);
    expect(sourceTransactionScopeQuestions(f.source,f.draft,f.sources)).toHaveLength(0);
    expect(f.sources.source_transaction_scope_reviews).toEqual([answer]);
    expect(()=>assertRequiredReceiptCoupling([first],f.source,f.draft,[],f.sources)).not.toThrow();
    const replacement=structuredClone(f.draft.actions[0]);
    replacement.name='energy_ops.new_followup';replacement.outcome=replacement.name;
    f.draft.actions.push(replacement);
    f.draft.runner_evidence.actions[replacement.outcome]=structuredClone(f.draft.runner_evidence.actions[f.draft.actions[0].outcome]);
    f.sources.coverage_episodes[0].submissions[0].tentative.raw_response.passages.push({
      ...structuredClone(first),draft_paths:receiptCouplingPaths(replacement.outcome)});
    expect(sourceTransactionScopeQuestions(f.source,f.draft,f.sources).map(entry=>entry.action.outcome))
      .toEqual([replacement.outcome]);
    expect(sourceTransactionScopeQuestions(f.source,f.draft,f.sources)[0]?.current).toBeUndefined();
  });

  it('asks locally with default pending and saves a confirmed negative append-only after explicit confirmation',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'source-scope-local-'));
    try{
      const {f}=fixture();await savePolicySources(root,f.sources);
      const question=sourceTransactionScopeQuestions(f.source,f.draft,f.sources)[0]!;
      const session={chooseOption:vi.fn(async()=> 'pending'),confirm:vi.fn(async()=>true),rememberDetails:vi.fn()};
      const input={projectRoot:root,sources:f.sources,session:session as any,actor:'derived-test-operator',question,
        currentDraft:()=>f.draft,assertCurrent:async()=>{},
        coordinated:async(operation:any)=>{await withProjectAuthorityMutation(root,operation);}};
      expect(await localSourceTransactionScopeReview(input)).toMatchObject({state:'pending',changed:false});
      expect((await loadPolicySources(root,f.sources.id)).source_transaction_scope_reviews).toBeUndefined();
      expect((session.chooseOption as any).mock.calls[0]?.[2]).toMatchObject({initialValue:'pending'});
      expect((session.rememberDetails as any).mock.calls[0]?.[1]).toEqual(expect.arrayContaining([expect.stringContaining('18: The two business changes')]));
      session.chooseOption.mockResolvedValue('does_not_apply');
      expect(await localSourceTransactionScopeReview(input)).toMatchObject({state:'does_not_apply',changed:true});
      const saved=await loadPolicySources(root,f.sources.id);
      expect(saved.source_transaction_reviews).toEqual(f.sources.source_transaction_reviews);
      expect(saved.source_transaction_scope_reviews).toHaveLength(1);
      expect(saved.source_transaction_scope_reviews?.[0]).toMatchObject({verified:false,decision:'does_not_apply',previous:null});
      expect(await localSourceTransactionScopeReview(input)).toMatchObject({state:'does_not_apply',changed:false});
      expect((await loadPolicySources(root,f.sources.id)).source_transaction_scope_reviews).toHaveLength(1);
    }finally{await fs.rm(root,{recursive:true,force:true});}
  });
  it('blocks a new paid saved Review before episode or submission allocation while the exact pairing is unanswered',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'source-scope-prepared-'));
    try{
      const {f}=fixture();
      const session={provider:'openrouter',model:'openai/gpt-5.6-terra',dependencies:{requestJson:vi.fn()}} as any;
      f.sources.approvals.push({digest:f.source.digest,destination:authoringDestination(session)});
      await savePolicySources(root,f.sources);
      await expect(ensurePreparedPolicyCoverage({projectRoot:root,sources:f.sources,modelSession:session,
        operatorSession:{} as any,currentDraft:()=>f.draft,authorityDigest:canonicalJsonDigest('derived authority'),
        clarifications:[],assertCurrent:async()=>{},state:{},savedReviewEpisode:{job:'derived',subject:'derived'}}))
        .rejects.toThrow('SOURCE_TRANSACTION_SCOPE_REVIEW_PENDING');
      expect(session.dependencies.requestJson).not.toHaveBeenCalled();
      const saved=await loadPolicySources(root,f.sources.id);
      expect(saved.coverage_episodes).toHaveLength(1);
      expect(saved.source_transaction_scope_reviews).toBeUndefined();
    }finally{await fs.rm(root,{recursive:true,force:true});}
  });
});
