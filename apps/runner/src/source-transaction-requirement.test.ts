import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe,it,expect,vi} from 'vitest';
import {canonicalJsonDigest} from '@synapsor-runner/protocol';
import {activePolicySource,loadPolicySources,policyTextSnapshot,savePolicySources} from './authoring-policy-source.js';
import {withProjectAuthorityMutation} from './project-authority-mutation.js';
import {localSourceTransactionReview} from './authoring-source-transaction-operation.js';
import {currentSourceTransactionReview,sourceTransactionMappings,sourceTransactionPreparedContext,
  sourceTransactionReviewNeeded,makeSourceTransactionReview} from './authoring-source-transaction-review.js';
import {assessReceiptCouplingCapability,assertRequiredReceiptCoupling,receiptCouplingInterpretation,receiptCouplingPaths} from './authoring-obligation-review.js';
import {ensurePreparedPolicyCoverage} from './authoring-prepared-policy-review.js';
import {authoringDestination} from './authoring-policy-source.js';
import {policyReadinessItems} from './authoring-review-readiness.js';

const captured=JSON.parse(await fs.readFile(new URL('./test-fixtures/receipt-correction-chain.json',import.meta.url),'utf8'));
const fresh=()=>structuredClone(captured);
const store=canonicalJsonDigest('derived fixture project binding');
const prepared=(f:any)=>{
  f.draft.runner_evidence.source_transaction_requirement=sourceTransactionPreparedContext(f.sources,store,f.source.digest);
  return f.draft;
};
const passage=(f:any)=>({start:18,end:18,disposition:'implemented' as const,responsibility:'runner' as const,
  issue_kind:'coverage_link' as const,receipt_component:'source_transaction_coupling' as const,
  interpretation:receiptCouplingInterpretation(f.draft.actions[0].outcome),draft_paths:receiptCouplingPaths(f.draft.actions[0].outcome)});
const confirmed=(f:any)=>{
  const mapping=sourceTransactionMappings(prepared(f))[0]!;
  const record=makeSourceTransactionReview({source:f.source,session:f.sources.id,store,start:18,end:18,
    mapping,actor:'local-fixture-operator',decision:'confirmed'});
  f.sources.source_transaction_reviews=[record];prepared(f);
  return record;
};

describe('source-bound transaction interpretation',()=>{
  it('keeps exact B pending without an operator record even with source_db mode and a complete compiled capability',()=>{
    const f=fresh(),draft=prepared(f),p=passage(f);
    expect(sourceTransactionReviewNeeded(draft)).toBe(true);
    expect(assessReceiptCouplingCapability(p,f.source,draft)).toMatchObject({origin:'HOST-RESOLVED',effect_count:2});
    expect(currentSourceTransactionReview(f.source,draft,f.sources)).toBeUndefined();
    expect(()=>assertRequiredReceiptCoupling([p],f.source,draft,[],f.sources)).toThrow('explicit applicable operator review');
  });

  it('never turns a model-supplied coupling claim into source meaning, even outside the multi-effect prompt family',()=>{
    const f=fresh(),draft=prepared(f);
    draft.actions[0].effect.atomic_updates=[];
    expect(sourceTransactionReviewNeeded(draft)).toBe(false);
    expect(()=>assertRequiredReceiptCoupling([passage(f)],f.source,draft,[],f.sources)).toThrow('explicit applicable operator review');
  });

  it('confines every accepted coupling component to the reviewed Action and exact source range',()=>{
    const f=fresh();confirmed(f);
    const unrelated={...passage(f),start:17,end:17};
    expect(assessReceiptCouplingCapability(unrelated,f.source,f.draft)).toMatchObject({origin:'HOST-RESOLVED'});
    expect(()=>assertRequiredReceiptCoupling([passage(f),unrelated],f.source,f.draft,[],f.sources))
      .toThrow('different Action or source range');
  });

  it('saves a new explicit local interpretation with full-policy display, then reuses only its exact current source and mapping',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'source-transaction-local-')),f=fresh();
    try {
      await savePolicySources(root,f.sources);
      const prompts:any[]=[], session={promptText:vi.fn(async(_label:string,options:any)=>{prompts.push(options);return '18';}),
        chooseOption:vi.fn(async()=> 'confirmed'),confirm:vi.fn(async()=>true),rememberDetails:vi.fn()};
      const result=await localSourceTransactionReview({projectRoot:root,sources:f.sources,session:session as any,
        actor:'local-fixture-operator',currentDraft:()=>prepared(f),assertCurrent:async()=>{},assertCurrentHeld:async()=>{},
        coordinated:async operation=>withProjectAuthorityMutation(root,operation)});
      expect(result).toMatchObject({state:'confirmed',changed:true});
      expect(prompts[0].context).toContain(`18: ${f.source.text.split('\n')[17]}`);
      expect((session.chooseOption as any).mock.calls[0]![2].context).toEqual(expect.arrayContaining([
        expect.stringContaining('energy_ops.metering_cycles'),expect.stringContaining('energy_ops.settlement_registers'),
        expect.stringContaining('source_db')]));
      const saved=await loadPolicySources(root,f.sources.id),record=saved.source_transaction_reviews?.[0];
      expect(record).toMatchObject({origin:'OPERATOR-SOURCE-TRANSACTION-REVIEW',decision:'confirmed',actor:'local-fixture-operator',
        required_effects:[{role:'primary'},{role:'companion'}],required_receipt:{mode:'source_db'},verified:false});
      f.sources=saved;prepared(f);
      expect(currentSourceTransactionReview(f.source,f.draft,f.sources)?.digest).toBe(record!.digest);
      expect(()=>assertRequiredReceiptCoupling([passage(f)],f.source,f.draft,[],f.sources)).not.toThrow();
      const again=await localSourceTransactionReview({projectRoot:root,sources:f.sources,session:session as any,
        actor:'local-fixture-operator',currentDraft:()=>prepared(f),assertCurrent:async()=>{},assertCurrentHeld:async()=>{},
        coordinated:async operation=>withProjectAuthorityMutation(root,operation)});
      expect(again).toMatchObject({state:'confirmed',changed:false});
      expect((await loadPolicySources(root,f.sources.id)).source_transaction_reviews).toHaveLength(1);
      const changed=policyTextSnapshot(Buffer.from(f.source.text+'\nA later exception permits separate commits.','utf8'),f.source.name,f.source.version);
      f.source=changed;f.draft.runner_evidence.runtime_contract.authoring_lifecycle.current_policy_snapshot.digest=changed.digest;
      expect(currentSourceTransactionReview(changed,prepared(f),f.sources)).toBeUndefined();
      expect(()=>assertRequiredReceiptCoupling([passage(f)],changed,f.draft,[],f.sources)).toThrow('explicit applicable operator review');
    } finally {await fs.rm(root,{recursive:true,force:true});}
  });

  it('default pending, cancellation and a forged model-facing item create no operator meaning',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'source-transaction-pending-')),f=fresh();
    try {
      await savePolicySources(root,f.sources);
      const before=await loadPolicySources(root,f.sources.id);
      const session={promptText:vi.fn(async()=>undefined),chooseOption:vi.fn(),confirm:vi.fn()};
      const result=await localSourceTransactionReview({projectRoot:root,sources:f.sources,session:session as any,
        actor:'local-fixture-operator',currentDraft:()=>prepared(f),assertCurrent:async()=>{},assertCurrentHeld:async()=>{},
        coordinated:async operation=>withProjectAuthorityMutation(root,operation)});
      expect(result).toMatchObject({state:'pending',changed:false});
      expect(await loadPolicySources(root,f.sources.id)).toEqual(before);
      const forged=confirmed(f);delete f.sources.source_transaction_reviews;prepared(f);
      f.draft.runner_evidence.source_transaction_requirement.items=[{...sourceTransactionPreparedContext({...f.sources,source_transaction_reviews:[forged]},store,f.source.digest).items[0],decision:'confirmed'}];
      expect(currentSourceTransactionReview(f.source,f.draft,f.sources)).toBeUndefined();
    } finally {await fs.rm(root,{recursive:true,force:true});}
  });

  it('lets an explicit local revisit withdraw a current confirmation append-only without re-prompting ordinary Review',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'source-transaction-revisit-')),f=fresh();
    try {
      confirmed(f);await savePolicySources(root,f.sources);
      const session={promptText:vi.fn(async()=> '18'),chooseOption:vi.fn(async()=> 'deferred'),
        confirm:vi.fn(async()=>true),rememberDetails:vi.fn()};
      const input:Parameters<typeof localSourceTransactionReview>[0]={projectRoot:root,sources:f.sources,session:session as any,actor:'local-fixture-operator',
        currentDraft:()=>prepared(f),assertCurrent:async()=>{},assertCurrentHeld:async()=>{},
        coordinated:async operation=>{await withProjectAuthorityMutation(root,operation);}};
      expect(await localSourceTransactionReview(input)).toMatchObject({state:'confirmed',changed:false});
      expect(session.chooseOption).not.toHaveBeenCalled();
      expect(await localSourceTransactionReview({...input,revisitCurrent:true})).toMatchObject({state:'deferred',changed:true});
      const saved=await loadPolicySources(root,f.sources.id);
      expect(saved.source_transaction_reviews).toHaveLength(2);
      expect(saved.source_transaction_reviews?.[1]?.previous).toBe(saved.source_transaction_reviews?.[0]?.digest);
      expect(currentSourceTransactionReview(f.source,prepared(f),f.sources)).toBeUndefined();
      expect(()=>assertRequiredReceiptCoupling([passage(f)],f.source,f.draft,[],f.sources))
        .toThrow('explicit applicable operator review');
    } finally {await fs.rm(root,{recursive:true,force:true});}
  });

  it('distinguishes cancelling a public revisit from withdrawing the confirmed interpretation',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'source-transaction-withdraw-')),f=fresh();
    try {
      const first=confirmed(f);await savePolicySources(root,f.sources);
      let selected='cancel';
      const session={promptText:vi.fn(async()=> '18'),chooseOption:vi.fn(async()=>selected),
        confirm:vi.fn(async()=>true),rememberDetails:vi.fn()};
      const input:Parameters<typeof localSourceTransactionReview>[0]={projectRoot:root,sources:f.sources,session:session as any,
        actor:'local-fixture-operator',revisitCurrent:true,currentDraft:()=>prepared(f),assertCurrent:async()=>{},assertCurrentHeld:async()=>{},
        coordinated:async operation=>{await withProjectAuthorityMutation(root,operation);}};
      expect(await localSourceTransactionReview(input)).toMatchObject({state:'confirmed',changed:false});
      expect((session.chooseOption as any).mock.calls[0]?.[2]).toMatchObject({initialValue:'cancel'});
      expect(session.confirm).not.toHaveBeenCalled();
      expect((await loadPolicySources(root,f.sources.id)).source_transaction_reviews).toEqual([first]);
      selected='withdraw';
      expect(await localSourceTransactionReview(input)).toMatchObject({state:'pending',changed:true});
      const saved=await loadPolicySources(root,f.sources.id);
      expect(saved.source_transaction_reviews).toHaveLength(2);
      expect(saved.source_transaction_reviews?.[1]).toMatchObject({decision:'pending',previous:first.digest});
      expect(currentSourceTransactionReview(f.source,prepared(f),f.sources)).toBeUndefined();
      expect(()=>assertRequiredReceiptCoupling([passage(f)],f.source,f.draft,[],f.sources))
        .toThrow('explicit applicable operator review');
    } finally {await fs.rm(root,{recursive:true,force:true});}
  });

  it('keeps a recorded conflict blocking for the unchanged source and Action, even after an attempted later confirmation',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'source-transaction-conflict-')),f=fresh();
    try {
      const mapping=sourceTransactionMappings(prepared(f))[0]!;
      const conflict=makeSourceTransactionReview({source:f.source,session:f.sources.id,store,start:18,end:18,
        mapping,actor:'local-fixture-operator',decision:'conflicting'});
      f.sources.source_transaction_reviews=[conflict];
      await savePolicySources(root,f.sources);
      const session={promptText:vi.fn(async()=> '18'),chooseOption:vi.fn(async()=> 'confirmed'),
        confirm:vi.fn(async()=>true),rememberDetails:vi.fn()};
      const input:Parameters<typeof localSourceTransactionReview>[0]={projectRoot:root,sources:f.sources,session:session as any,
        actor:'local-fixture-operator',currentDraft:()=>prepared(f),assertCurrent:async()=>{},assertCurrentHeld:async()=>{},
        coordinated:async operation=>{await withProjectAuthorityMutation(root,operation);}};
      await expect(localSourceTransactionReview(input)).rejects.toThrow('SOURCE_TRANSACTION_REVIEW_CONFLICT');
      expect((await loadPolicySources(root,f.sources.id)).source_transaction_reviews).toEqual([conflict]);
      expect((session.chooseOption as any).mock.calls.at(-1)?.[1]).not.toEqual(expect.arrayContaining([
        expect.objectContaining({value:'confirmed'})]));
      const forgedLater=makeSourceTransactionReview({source:f.source,session:f.sources.id,store,start:18,end:18,
        mapping,actor:'local-fixture-operator',decision:'confirmed',previous:conflict});
      f.sources.source_transaction_reviews.push(forgedLater);prepared(f);
      expect(currentSourceTransactionReview(f.source,f.draft,f.sources)).toBeUndefined();
      expect(()=>assertRequiredReceiptCoupling([passage(f)],f.source,f.draft,[],f.sources))
        .toThrow('explicit applicable operator review');
    } finally {await fs.rm(root,{recursive:true,force:true});}
  });

  it('reports an incomplete candidate as unavailable without asking an owner to confirm its missing mapping',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'source-transaction-incomplete-')),f=fresh();
    try {
      f.draft.actions[0].effect.atomic_updates[0].allowed_fields=[];
      await savePolicySources(root,f.sources);
      const session={promptText:vi.fn(),chooseOption:vi.fn(),confirm:vi.fn()};
      const result=await localSourceTransactionReview({projectRoot:root,sources:f.sources,session:session as any,
        actor:'local-fixture-operator',currentDraft:()=>prepared(f),assertCurrent:async()=>{},assertCurrentHeld:async()=>{},
        coordinated:async operation=>withProjectAuthorityMutation(root,operation)});
      expect(result).toMatchObject({state:'capability_unavailable',changed:false});
      expect(session.promptText).not.toHaveBeenCalled();
      expect((await loadPolicySources(root,f.sources.id)).source_transaction_reviews).toBeUndefined();
    } finally {await fs.rm(root,{recursive:true,force:true});}
  });

  it('refuses a concurrent saved-source decision before persisting the local confirmation',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'source-transaction-race-')),f=fresh();
    try {
      await savePolicySources(root,f.sources);
      const session={promptText:vi.fn(async()=> '18'),chooseOption:vi.fn(async()=> 'confirmed'),
        confirm:vi.fn(async()=>{await savePolicySources(root,{...f.sources,
          operator_messages:[...(f.sources.operator_messages??[]),'competing decision']});return true;})};
      await expect(localSourceTransactionReview({projectRoot:root,sources:f.sources,session:session as any,
        actor:'local-fixture-operator',currentDraft:()=>prepared(f),assertCurrent:async()=>{},assertCurrentHeld:async()=>{},
        coordinated:async operation=>withProjectAuthorityMutation(root,operation)})).rejects.toThrow('POLICY_SOURCE_CHANGED');
      expect((await loadPolicySources(root,f.sources.id)).source_transaction_reviews).toBeUndefined();
    } finally {await fs.rm(root,{recursive:true,force:true});}
  });

  it('retains append-only decision history and rejects a writer that drops it',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'source-transaction-history-')),f=fresh();
    try {
      confirmed(f);await savePolicySources(root,f.sources);
      const truncated={...f.sources,source_transaction_reviews:[]};
      await expect(savePolicySources(root,truncated)).rejects.toThrow('SOURCE_TRANSACTION_HISTORY_CHANGED');
      expect((await loadPolicySources(root,f.sources.id)).source_transaction_reviews).toHaveLength(1);
    } finally {await fs.rm(root,{recursive:true,force:true});}
  });

  it('refuses a cross-session or changed-store record and a later deferred decision without recycling confirmation',()=>{
    const f=fresh(),original=confirmed(f);
    const otherSession=structuredClone(f.sources);
    otherSession.id='00000000-0000-4000-8000-000000000001';
    otherSession.source_transaction_reviews=[original];
    f.draft.runner_evidence.source_transaction_requirement=sourceTransactionPreparedContext(otherSession,store,f.source.digest);
    expect(currentSourceTransactionReview(f.source,f.draft,otherSession)).toBeUndefined();
    f.draft.runner_evidence.source_transaction_requirement=sourceTransactionPreparedContext(f.sources,canonicalJsonDigest('different store'),f.source.digest);
    expect(currentSourceTransactionReview(f.source,f.draft,f.sources)).toBeUndefined();
    const deferred=makeSourceTransactionReview({source:f.source,session:f.sources.id,store,start:18,end:18,
      mapping:sourceTransactionMappings(f.draft)[0]!,actor:'local-fixture-operator',decision:'deferred',previous:original});
    f.sources.source_transaction_reviews.push(deferred);prepared(f);
    expect(currentSourceTransactionReview(f.source,f.draft,f.sources)).toBeUndefined();
    expect(()=>assertRequiredReceiptCoupling([passage(f)],f.source,f.draft,[],f.sources)).toThrow('explicit applicable operator review');
  });

  it('revises one source/Action decision append-only while retaining its earlier range as history',()=>{
    const f=fresh(),first=confirmed(f);
    const other=makeSourceTransactionReview({source:f.source,session:f.sources.id,store,start:17,end:18,
      mapping:sourceTransactionMappings(f.draft)[0]!,actor:'local-fixture-operator',decision:'confirmed',previous:first});
    f.sources.source_transaction_reviews.push(other);prepared(f);
    expect(other.id).toBe(first.id);
    expect(other.previous).toBe(first.digest);
    expect(currentSourceTransactionReview(f.source,f.draft,f.sources)?.digest).toBe(other.digest);
    expect(f.sources.source_transaction_reviews[0]).toEqual(first);
  });

  it('does not report old associated coverage as ready after a newer deferred source decision',()=>{
    const f=fresh(),first=confirmed(f);
    const report={...f.sources.coverage,source_transaction_association:{origin:'HOST-REVIEW-ASSOCIATION',
      requirement_digest:first.digest,capability_dependencies_digest:canonicalJsonDigest('derived capability'),
      outcome:first.action.outcome,source_digest:f.source.digest,decision:'operator_confirmed_unverified',
      phase:'business_review'}} as any;
    const blocked=()=>policyReadinessItems(report,f.sources).some(item=>item.title==='Source transaction requirement needs current review');
    expect(blocked()).toBe(false);
    f.sources.source_transaction_reviews!.push(makeSourceTransactionReview({source:f.source,session:f.sources.id,store,
      start:first.start,end:first.end,mapping:sourceTransactionMappings(f.draft)[0]!,actor:'local-fixture-operator',
      decision:'deferred',previous:first}));
    expect(blocked()).toBe(true);
  });

  it('retains source meaning across changed implementation but refuses wrong or missing effects as capability mismatches',()=>{
    const f=fresh();confirmed(f);
    const wrong=structuredClone(f.draft);
    wrong.actions[0].effect.atomic_updates[0].target_resource='energy_ops.other_registers';
    expect(currentSourceTransactionReview(f.source,wrong,f.sources)?.digest).toBe(f.sources.source_transaction_reviews[0].digest);
    expect(()=>assertRequiredReceiptCoupling([passage(f)],f.source,wrong,[],f.sources)).toThrow('complete Action effect and receipt mapping');
    const missing=structuredClone(f.draft);
    missing.actions[0].effect.atomic_updates=[];
    expect(sourceTransactionReviewNeeded(missing)).toBe(false); // The saved requirement, not the shortened implementation, keeps the obligation live.
    expect(sourceTransactionMappings(missing)).toHaveLength(0);
    expect(currentSourceTransactionReview(f.source,missing,f.sources)?.digest).toBe(f.sources.source_transaction_reviews[0].digest);
    expect(()=>assertRequiredReceiptCoupling([passage(f)],f.source,missing,[],f.sources)).toThrow('complete Action effect and receipt mapping');
    const changedAssignment=structuredClone(f.draft);
    changedAssignment.actions[0].effect.atomic_updates[0].set.credited_total={kind:'literal',value:999};
    expect(currentSourceTransactionReview(f.source,changedAssignment,f.sources)?.digest).toBe(f.sources.source_transaction_reviews[0].digest);
    expect(()=>assertRequiredReceiptCoupling([passage(f)],f.source,changedAssignment,[],f.sources))
      .toThrow('complete Action effect and receipt mapping');
  });

  it.each([
    'The business changes and receipt may commit in separate PostgreSQL transactions.',
    'The same-source-transaction receipt rule is optional for this Action.',
    'Only when the customer opts in must the business changes and receipt share a source transaction.',
    'A later exception permits the receipt to commit separately.',
    'This requirement applies to a different Action, not the selected Action.',
    'The required business effect is now a different register update.',
  ])('changed full-source text cannot silently reuse an old decision: %s',async addition=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'source-transaction-changed-')),f=fresh();
    try {
      confirmed(f);
      const source=policyTextSnapshot(Buffer.from(`${f.source.text}\n${addition}\n`,'utf8'),f.source.name,2);
      f.source=source;f.sources.snapshots=[f.sources.snapshots[0],source];f.sources.active=2;
      f.draft.runner_evidence.runtime_contract.authoring_lifecycle.current_policy_snapshot.digest=source.digest;
      prepared(f);
      const session={provider:'openrouter',model:'openai/gpt-5.6-terra'} as any;
      f.sources.approvals.push({digest:source.digest,destination:authoringDestination(session)});
      await savePolicySources(root,f.sources);
      expect(currentSourceTransactionReview(source,f.draft,f.sources)).toBeUndefined();
      await expect(ensurePreparedPolicyCoverage({projectRoot:root,sources:f.sources,modelSession:session,
        operatorSession:{} as any,currentDraft:()=>f.draft,authorityDigest:canonicalJsonDigest('derived authority'),
        clarifications:[],assertCurrent:async()=>{},assertCurrentHeld:async()=>{},state:{}})).rejects.toThrow('SOURCE_TRANSACTION_REVIEW_PENDING');
    } finally {await fs.rm(root,{recursive:true,force:true});}
  });

  it('retains unchanged source meaning while refusing stale compiled capability',()=>{
    const f=fresh(),record=confirmed(f),p=passage(f);
    f.draft.runner_evidence.runtime_contract.review_evidence_phases.candidate_action_digest=canonicalJsonDigest('different current Action revision');
    expect(currentSourceTransactionReview(f.source,f.draft,f.sources)?.digest).toBe(record.digest);
    expect(()=>assessReceiptCouplingCapability(p,f.source,f.draft)).toThrow('OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED');
    expect(()=>assertRequiredReceiptCoupling([p],f.source,f.draft,[],f.sources)).toThrow('OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED');
  });

  it('stops a stale implementation before a new saved Review episode or provider submission',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'source-transaction-capability-')),f=fresh();
    try {
      confirmed(f);
      f.draft.actions[0].effect.atomic_updates=[];
      const session={provider:'openrouter',model:'openai/gpt-5.6-terra',conversation:{policySources:f.sources},
        dependencies:{requestJson:vi.fn()}} as any;
      f.sources.approvals.push({digest:f.source.digest,destination:authoringDestination(session)});
      await savePolicySources(root,f.sources);
      await expect(ensurePreparedPolicyCoverage({projectRoot:root,sources:f.sources,modelSession:session,
        operatorSession:{} as any,currentDraft:()=>f.draft,authorityDigest:canonicalJsonDigest('derived authority'),
        clarifications:[],assertCurrent:async()=>{},assertCurrentHeld:async()=>{},state:{}})).rejects.toThrow('complete Action effect and receipt mapping');
      expect(session.dependencies.requestJson).not.toHaveBeenCalled();
      expect((await loadPolicySources(root,f.sources.id)).coverage_episodes).toEqual(f.sources.coverage_episodes);
    } finally {await fs.rm(root,{recursive:true,force:true});}
  });
});
