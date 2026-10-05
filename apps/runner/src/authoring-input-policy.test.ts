import {describe,it,expect} from 'vitest';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {canonicalJsonDigest} from '@synapsor-runner/protocol';
import {newPolicySourceSession,policyTextSnapshot,savePolicySources,loadPolicySources} from './authoring-policy-source.js';
import {makeSourceInputReview,sourceInputFidelity,assertSourceInputReviews,SourceInputFidelityError,assertInputFidelityRepair} from './authoring-input-policy.js';
import {actionRuleDraftDiagnostics} from './action-rule-draft.js';
import {reviewSourceInputPolicy} from './authoring-input-policy-operation.js';
import {randomUUID} from 'node:crypto';
import {createOperatorQuestion,proposeOperatorAnswer,confirmOperatorAnswer} from './authoring-operator-question.js';
const store=canonicalJsonDigest('owned fixture store');
const setup=()=>{
 const source=policyTextSnapshot(Buffer.from('The caller note must contain 1 through 64 UTF-16 units.\nNo normalization.'),'policy.txt');
 const session=newPolicySourceSession();session.snapshots=[source];session.active=1;
 const requirements=[{outcomes:['warehouse.release'],input:'operator_note',start:1,end:1,min_length:1,max_length:64}];
 const r=makeSourceInputReview({source,session,store,outcomes:['warehouse.release'],requirements,actor:'fixture local operator'});session.input_policy_reviews=[r];
 const action:any={outcome:'warehouse.release',inputs:[{name:'operator_note',description:'Caller note',type:{kind:'string',max_length:64,comparison:'exact'}}],require:{kind:'all',expressions:[]}};
 return {source,session,r,action,run:()=>sourceInputFidelity(source,session,store,[action])};
};
describe('current attributed input policy fidelity',()=>{
 it('binds assisted Source interpretation to exact adopted question without changing manual history',()=>{
  const f=setup();
  const source_binding={source_session:f.session.id,source_digest:f.source.digest as `sha256:${string}`,store_digest:store,
   agenda_digest:canonicalJsonDigest({source_session:f.session.id,source_digest:f.source.digest,store_digest:store,outcomes:f.r.outcomes}),lines:f.source.lines};
  const root=createOperatorQuestion({id:randomUUID(),revision:1,kind:'input_bounds',scope_digest:canonicalJsonDigest('fixture job'),
   context_digest:canonicalJsonDigest('fixture current context'),target:{phase:'input-policy',outcomes:f.r.outcomes},source_binding,
   material:['Required presence and string length are distinct.'],evidence:[{id:f.session.id,digest:f.source.digest as `sha256:${string}`}],
   continuation:'input_policy_review',assistedLocalConsumer:true});
  const proposed=proposeOperatorAnswer(root,{question_id:root.id,revision:root.revision,source_reference:canonicalJsonDigest(source_binding),
   disposition:'proposed',value:{kind:'input_bounds',requirements:f.r.requirements}});
  const confirmed=confirmOperatorAnswer(proposed);
  const record=makeSourceInputReview({source:f.source,session:f.session,store,outcomes:f.r.outcomes,requirements:f.r.requirements,
   actor:'fixture local operator',operatorQuestion:confirmed,questionRoot:confirmed} as any);
  expect((record as any).question_reference).toMatchObject({id:confirmed.id,revision:1,digest:confirmed.digest,
   proposal_digest:canonicalJsonDigest(confirmed.proposal),root_id:confirmed.id,root_digest:confirmed.digest,basis:'policy_source'});
  expect(record.verified).toBe(false);expect(record.previous).toBe(f.r.digest);
  expect(f.session.input_policy_reviews).toEqual([f.r]);expect(f.r).not.toHaveProperty('question_reference');
  assertSourceInputReviews([f.r,record]);
  for(const changed of [{operatorQuestion:proposed},{store:canonicalJsonDigest('other store')},
    {requirements:[{...f.r.requirements[0]!,max_length:65}]},{outcomes:['warehouse.other']}])
   expect(()=>makeSourceInputReview({source:f.source,session:f.session,store,outcomes:f.r.outcomes,requirements:f.r.requirements,
    actor:'fixture local operator',operatorQuestion:confirmed,questionRoot:confirmed,...changed} as any)).toThrow();
 });
 it('provides precise delivered model diagnostic; only equivalent compiled constraint clears it',()=>{
  const f=setup();const bad=f.run();expect(bad.findings[0]).toMatchObject({required:{min_length:1,max_length:64},established:{min_length:0,max_length:64},requirement_digest:f.r.digest});
  expect(actionRuleDraftDiagnostics(new SourceInputFidelityError(bad.findings))[0]).toMatchObject({code:'SOURCE_INPUT_CONSTRAINT_WEAKER',repair:'model',path:'draft.inputs.operator_note'});
  f.action.inputs[0].type.min_length=1;expect(f.run().findings).toEqual([]);expect(f.run().digest).not.toEqual(bad.digest);
 });
 it.each(['missing','wrong_input','wrong_type','weaker_max','empty_enum'])('refuses missing/weaker representation %s',change=>{
  const f=setup();if(change==='missing')delete f.action.inputs;if(change==='wrong_input')f.action.inputs[0].name='another_note';
  if(change==='wrong_type')f.action.inputs[0].type={kind:'integer'};
  if(change==='weaker_max')f.action.inputs[0].type={kind:'string',comparison:'exact',min_length:1,max_length:65};
  if(change==='empty_enum')f.action.inputs[0].type.enum=['','x'];expect(f.run().findings).toHaveLength(1);
 });
 it('accepts finite enum and exact existing neq-empty, rejects an OR escape',()=>{
  const f=setup();f.action.inputs[0].type.enum=['x','😀'];expect(f.run().findings).toEqual([]);delete f.action.inputs[0].type.enum;
  const comparison={kind:'compare',operator:'neq',left:{kind:'input',name:'operator_note'},right:{kind:'literal',value:'',value_type:{kind:'string',max_length:64,comparison:'exact'}}};
  f.action.require={kind:'all',expressions:[comparison]};expect(f.run().findings).toEqual([]);
  f.action.require={kind:'any',expressions:[comparison,{kind:'all',expressions:[]}]};expect(f.run().findings).toHaveLength(1);
 });
 it('does not transfer meaning across complete Source/store/session changes',()=>{
  const f=setup();f.action.inputs[0].type.min_length=1;
  const changed=policyTextSnapshot(Buffer.from(f.source.text+'\nException for a new workflow.'),'policy.txt',2);
  expect(sourceInputFidelity(changed,f.session,store,[f.action]).findings[0]?.code).toBe('SOURCE_INPUT_REQUIREMENT_PENDING');
  expect(sourceInputFidelity(f.source,f.session,canonicalJsonDigest('other store'),[f.action]).findings[0]?.code).toBe('SOURCE_INPUT_REQUIREMENT_PENDING');
  expect(sourceInputFidelity(f.source,{...f.session,id:'12345678-1234-1234-1234-123456789012'},store,[f.action]).findings[0]?.code).toBe('SOURCE_INPUT_REQUIREMENT_PENDING');
 });
 it('does not give another Action a registered fidelity pass',()=>{
  const f=setup();f.action.outcome='warehouse.other';f.action.inputs[0].type.min_length=1;
  expect(f.run().findings[0]?.code).toBe('SOURCE_INPUT_REQUIREMENT_PENDING');
 });
 it('does not use an impossible interval as a vacuous proof',()=>{
  const f=setup();f.action.inputs[0].type.min_length=1;
  f.action.require={kind:'compare',operator:'eq',left:{kind:'input',name:'operator_note'},right:{kind:'literal',value:'x'.repeat(65),value_type:{kind:'string',max_length:100,comparison:'exact'}}};
  expect(f.run().findings).toHaveLength(1);
 });
 it('retains the old source decision while assessing only the new current interpretation',()=>{
  const f=setup();f.action.inputs[0].type.min_length=1;
  const source=policyTextSnapshot(Buffer.from(f.source.text+'\nCurrent source amendment.'),'policy.txt',2);
  const current=makeSourceInputReview({source,session:f.session,store,outcomes:f.r.outcomes,requirements:f.r.requirements,actor:'fixture operator'});
  f.session.input_policy_reviews!.push(current);
  const result=sourceInputFidelity(source,f.session,store,[f.action]);
  expect(result.findings).toEqual([]);expect(result.review_digests).toEqual([current.digest]);expect(f.session.input_policy_reviews![0]).toEqual(f.r);
 });
 it('retains the correction parent and refuses unrelated or predicate deletion changes',()=>{
  const f=setup();const parent=structuredClone(f.action),next=structuredClone(parent);next.inputs[0].type.min_length=1;
  expect(()=>assertInputFidelityRepair(parent,next,f.run().findings)).not.toThrow();
  expect(()=>assertInputFidelityRepair(parent,{...next,outcome:'warehouse.other'},f.run().findings)).toThrow('OUTSIDE_SCOPE');
  parent.require={kind:'compare',operator:'eq',left:{kind:'literal',value:true,value_type:{kind:'boolean'}},right:{kind:'literal',value:true,value_type:{kind:'boolean'}}};
  expect(()=>assertInputFidelityRepair(parent,next,f.run().findings)).toThrow('Preserve every existing predicate');
 });
 it('cannot fabricate or erase lineage through coordinated save',async()=>{
  const f=setup(),root=await fs.mkdtemp(path.join(os.tmpdir(),'input-policy-cas-'));
  try{await savePolicySources(root,f.session);const loaded=await loadPolicySources(root,f.session.id);expect(loaded).toEqual(f.session);
   await expect(savePolicySources(root,{...loaded,input_policy_reviews:[]})).rejects.toThrow('SOURCE_INPUT_HISTORY_CHANGED');
   const forged=structuredClone(f.r);forged.requirements[0]!.min_length=0;expect(()=>assertSourceInputReviews([forged])).toThrow();
   const next=makeSourceInputReview({...f,session:f.session,store,outcomes:f.r.outcomes,requirements:f.r.requirements,actor:'fixture operator',decision:'deferred'});
   const stale=canonicalJsonDigest(f.session);await savePolicySources(root,{...f.session,input_policy_reviews:[f.r,next]},{expectedDigest:stale});
   await expect(savePolicySources(root,f.session,{expectedDigest:stale})).rejects.toThrow();
  }finally{await fs.rm(root,{recursive:true,force:true});}
 });
 it('default-No public local review keeps exact state unchanged',async()=>{
  const f=setup();delete f.session.input_policy_reviews;const root=await fs.mkdtemp(path.join(os.tmpdir(),'input-policy-no-'));
  try{await savePolicySources(root,f.session);const before=await fs.readFile(path.join(root,'.synapsor/boundary-authoring/policy-sources',f.session.id+'.json'));
   await expect(reviewSourceInputPolicy({projectRoot:root,sources:f.session,store,outcomes:['warehouse.release'],actor:'fixture operator',assertCurrent:async()=>{},session:{chooseOption:async(_t:any,_o:any,opt:any)=>{expect(opt.initialValue).toBe('pending');return 'pending';}} as any})).rejects.toThrow('SOURCE_INPUT_REQUIREMENT_PENDING');
   expect(await fs.readFile(path.join(root,'.synapsor/boundary-authoring/policy-sources',f.session.id+'.json'))).toEqual(before);
  }finally{await fs.rm(root,{recursive:true,force:true});}
 });
});
