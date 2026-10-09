import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {canonicalJsonDigest} from '@synapsor-runner/protocol';
import {activePolicySource,savePolicySources,loadPolicySources,policySourceSavedDigest,newPolicySourceSession,policyTextSnapshot} from './authoring-policy-source.js';
import {parsePolicyCoverage} from './authoring-policy-coverage.js';
import {policyReviewReadiness} from './authoring-review-readiness.js';
import {localScopedDisclosureReview} from './authoring-scoped-disclosure-operation.js';
import {scopedDisclosureInventory,disclosureFields} from './authoring-scoped-disclosure.js';
import {withProjectAuthorityMutation,withHeldProjectAuthorityAccess,type ProjectAuthorityMutationPermit} from './project-authority-mutation.js';
import {ensurePreparedPolicyCoverage} from './authoring-prepared-policy-review.js';
const captures=JSON.parse(await fs.readFile(new URL('./test-fixtures/scoped-disclosure-captures.json',import.meta.url),'utf8'));
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
const STORE='sha256:614276979e3dd6ce73ca9c49e84f56010139ace3bebaa2b607e99a78f5011a7e';
const READ='sha256:42947f9d8d549e3a34de616b505c188d69765967712485748ba196ccf57a61f3';
async function setup(lane:'main'|'tester'='main',knownSynthetic=false){
 const f=structuredClone(captures[lane]);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'disclosure-review-'));roots.push(root);
 if(knownSynthetic){
   f.source=policyTextSnapshot(Buffer.from('Related descriptions require explicit source-owner non-sensitive classification for scoped discovery.'),'synthetic-known-classification.txt');
   f.sources=newPolicySourceSession();f.sources.snapshots=[f.source];f.sources.active=f.source.version;f.sources.operator_messages=[];
   f.sources.coverage_authority_digest=canonicalJsonDigest('synthetic read-only authority');
   f.draft.read.source='synthetic';
   f.draft.read.pack.resources=f.draft.read.pack.resources.slice(0,2).map((r:any,i:number)=>({...r,id:i===0?'sample.labels':'sample.places',schema:'sample',table:i===0?'labels':'places',selectable_fields:i===0?['alpha','beta']:['gamma']}));
   f.draft={read:f.draft.read,actions:[],runner_evidence:{runtime_contract:{client_contract:{mode:'interactive_four_tool',client:'synthetic'}}}};
   f.arguments={passages:[{start:1,end:1,disposition:'implemented',interpretation:'The exact scoped descriptions are returned. The host separately validates the source-required classification.',draft_paths:['/read/pack/resources']}]};
 }
 const original=JSON.stringify(f.arguments);
 // Reproduce both unchanged replies before adding the newly registered mapping.
 f.sources.coverage=parsePolicyCoverage(f.arguments,f.source,f.draft,f.sources.operator_messages);
 await savePolicySources(root,f.sources);
 const prompts:string[]=[];let mapping=true,choice='deferred',subset='1,2,3',cancelSave=false;
 const session={promptText:async(question:string)=>{
   prompts.push(question);return question.startsWith('Source line')?(knownSynthetic?'1':'24'):question.startsWith('Exact applicable')?'1,2,3':subset;
 },chooseOption:async(question:string,options:any[])=>{
   prompts.push(question);return question==='SOURCE-REQUIRED DISCLOSURE MEANING'?options[1]?.value:choice;
 },confirm:async(question:string)=>{prompts.push(question);return !(cancelSave&&question==='Save this exact classification decision?');}} as any;
 const currentDraft=()=>({...f.draft,runner_evidence:{...f.draft.runner_evidence,scoped_disclosure:{
   source_session:f.sources.id,metadata_digest:canonicalJsonDigest("synthetic current reader metadata"),read_digest:READ,store_digest:STORE,reviews:f.sources.scoped_disclosure_reviews??[]}}});
 const input={projectRoot:root,sources:f.sources,session,actor:'synthetic source owner',register:true,location:'active' as const,
   currentDraft,authorityDigest:f.sources.coverage_authority_digest,clarifications:[],assertCurrent:async()=>{},
   assertCurrentHeld:async(permit:ProjectAuthorityMutationPermit)=>withHeldProjectAuthorityAccess(root,permit,async()=>{}),
   coordinated:async(op:any)=>{await withProjectAuthorityMutation(root,op);}};
 return {f,root,input,prompts,currentDraft,original,
   set:(values:{choice?:string;subset?:string;cancelSave?:boolean})=>{if(values.choice)choice=values.choice;if(values.subset)subset=values.subset;if(values.cancelSave!==undefined)cancelSave=values.cancelSave;},
   run:()=>localScopedDisclosureReview({...input,register:mapping}),restart:async()=>{f.sources=await loadPolicySources(root,f.sources.id);input.sources=f.sources;mapping=false;}};
}
describe('source-established disclosure requirement through local review, strict coverage, canonical save and reuse',()=>{
 it.each(['main','tester'] as const)('retains exact %s response while registering a real pending choice and rechecking after restart',async lane=>{
   const x=await setup(lane);expect(policyReviewReadiness(x.f.source,x.f.sources.coverage,x.f.sources).ready).toBe(lane==='main');
   const result=await x.run();expect(result.ready).toBe(false);expect(result.inventory?.items.map(f=>f.state)).toEqual(['deferred','deferred','deferred']);
   expect(result.summary.join('\n')).not.toMatch(/Before activation|saved draft/);
   expect(JSON.stringify(x.f.arguments)).toBe(x.original);expect(x.f.sources.coverage.passages).toEqual(parsePolicyCoverage(x.f.arguments,x.f.source,x.currentDraft(),x.f.sources.operator_messages).passages);
   const history=structuredClone(x.f.sources.scoped_disclosure_reviews);
   await x.restart();x.input.session={...x.input.session,chooseOption:async()=> 'keep'};
   const again=await x.run();expect(again.ready).toBe(false);expect(x.f.sources.scoped_disclosure_reviews).toEqual(history);
   const report=parsePolicyCoverage(x.f.arguments,x.f.source,x.currentDraft(),x.f.sources.operator_messages);
   expect(policyReviewReadiness(x.f.source,report,x.f.sources).ready).toBe(false);
   expect(again.inventory).toEqual(result.inventory);
 });
 it('has a separate known synthetic affirmative control, partial 2/3, full resolution and provider-free restart',async()=>{
   const x=await setup('main',true);x.set({choice:'confirmed_non_sensitive',subset:'1,2'});
   let result=await x.run();expect(result.ready).toBe(false);expect(result.inventory!.items.map(i=>i.state)).toEqual(['confirmed_non_sensitive','confirmed_non_sensitive','unanswered']);
   await x.restart();x.set({subset:'3'});result=await x.run();expect(result.ready,JSON.stringify(result)).toBe(true);
   expect(result.inventory!.items.every(i=>i.verified===false&&i.assurance==='operator_assertion_only')).toBe(true);
   await x.restart();x.input.session={...x.input.session,chooseOption:async()=> 'keep'};
   expect((await x.run()).ready).toBe(true);
   // An unrelated Action wrapper does not replace the meaning identity.
   x.f.draft.unrelated_action_wrapper={numeric_edit:5};
   expect(scopedDisclosureInventory(x.f.source,x.currentDraft()).items.every(i=>i.state==='confirmed_non_sensitive')).toBe(true);
 });
 it.each(['source','session','metadata','read','store','field','binding','audience','purpose'] as const)('does not reuse an affirmative decision under changed %s',async change=>{
   const x=await setup('main',true);x.set({choice:'confirmed_non_sensitive'});expect((await x.run()).ready).toBe(true);
   let draft=x.currentDraft(),source=x.f.source;
   if(change==='source')source={...source,digest:canonicalJsonDigest('other source')};
   if(change==='session')draft.runner_evidence.scoped_disclosure.source_session='00000000-0000-0000-0000-000000000000';
   if(change==='metadata')draft.runner_evidence.scoped_disclosure.metadata_digest=canonicalJsonDigest('changed reader metadata');
   if(change==='read')draft.runner_evidence.scoped_disclosure.read_digest=canonicalJsonDigest('other Read');
   if(change==='store')draft.runner_evidence.scoped_disclosure.store_digest=canonicalJsonDigest('other store');
   if(change==='field')draft.read.pack.resources[0].selectable_fields=['other_name'];
   if(change==='binding')draft.read.pack.resources[0].table='same_names_other_table';
   if(change==='audience'||change==='purpose'){
     const record=draft.runner_evidence.scoped_disclosure.reviews.at(-1);record[change]='unrelated';
     expect(()=>scopedDisclosureInventory(source,draft)).toThrow('SCOPED_DISCLOSURE_EVIDENCE_INVALID');return;
   }
   expect(scopedDisclosureInventory(source,draft).items.some(i=>i.state==='stale')).toBe(true);
 });
 it.each(['background','grouped','reordered','implemented'] as const)('the full %s response cannot discharge the independent unknown',async shape=>{
   const x=await setup();await x.run();const args=structuredClone(x.f.arguments);
   if(shape==='background')args.passages[2].disposition='background';
   if(shape==='grouped')args.passages[2].interpretation+=' Related descriptions are included in this broader passage.';
   if(shape==='reordered')args.passages.reverse();
   if(shape==='implemented')args.passages[2].interpretation+=' No additional classification evidence is supplied.';
   const report=parsePolicyCoverage(args,x.f.source,x.currentDraft(),x.f.sources.operator_messages);
   expect(policyReviewReadiness(x.f.source,report,x.f.sources).ready).toBe(false);
 });
 it.each(['cancel','eof','declined','competing'] as const)('retains the registered requirement without partial acceptance on %s',async mode=>{
   const x=await setup();await x.run();await x.restart();const before=structuredClone(x.f.sources.scoped_disclosure_reviews);
   if(mode==='declined')x.set({choice:'not_confirmed'});
   else if(mode==='cancel')x.set({choice:'confirmed_non_sensitive',cancelSave:true});
   else if(mode==='eof')x.input.session={...x.input.session,chooseOption:async()=>undefined};
   else {
     const old=x.input.session.confirm;x.input.session={...x.input.session,confirm:async(q:string)=>{
       if(q==='Save this exact classification decision?'){
         const competing=structuredClone(x.f.sources);competing.operator_messages.push('Separate current owner record');await savePolicySources(x.root,competing);
       }return old(q);
     }};x.set({choice:'confirmed_non_sensitive'});
   }
   if(mode==='competing')await expect(x.run()).rejects.toThrow('POLICY_SOURCE_CHANGED');
   else expect((await x.run()).ready).toBe(false);
   const saved=await loadPolicySources(x.root,x.f.sources.id);
   expect(saved.scoped_disclosure_reviews?.slice(0,before.length)).toEqual(before);
   if(mode!=='declined')expect(saved.scoped_disclosure_reviews).toEqual(before);
   else expect(saved.scoped_disclosure_reviews?.at(-1)?.fields.every(f=>f.decision==='not_confirmed')).toBe(true);
 });
 it('refuses deletion/corruption of registered requirements and missing inventory in an old ready report',async()=>{
   const x=await setup(),old=structuredClone(x.f.sources.coverage);await x.run();
   expect(policyReviewReadiness(x.f.source,old,x.f.sources).ready).toBe(false);
   const missing=structuredClone(x.f.sources);delete missing.scoped_disclosure_reviews;
   await expect(savePolicySources(x.root,missing)).rejects.toThrow('SCOPED_DISCLOSURE_HISTORY_CHANGED');
   const corrupt=structuredClone(x.f.sources);corrupt.scoped_disclosure_reviews[0].fields=[];
   await expect(savePolicySources(x.root,corrupt)).rejects.toThrow('SCOPED_DISCLOSURE_EVIDENCE_INVALID');
   expect((await loadPolicySources(x.root,x.f.sources.id)).scoped_disclosure_reviews).toEqual(x.f.sources.scoped_disclosure_reviews);
 });
 it('leaves a substantive privacy conflict independent of a known classification',async()=>{
   const x=await setup();x.f.sources.coverage.passages[2].disposition='conflict';
   x.f.sources.coverage.passages[2].interpretation='Synthetic source-prohibition conflict remains unresolved; classification cannot waive it.';
   await savePolicySources(x.root,x.f.sources);x.set({choice:'confirmed_non_sensitive'});
   const result=await x.run();expect(result.ready).toBe(false);expect(x.f.sources.coverage.passages[2].disposition).toBe('conflict');
 });
 it('does not require classification with no represented source condition; renamed fields use structure alone',async()=>{
   const x=await setup();expect(policyReviewReadiness(x.f.source,x.f.sources.coverage,x.f.sources).ready).toBe(true);
   x.f.draft.read.pack.resources[0].id='a.widgets';x.f.draft.read.pack.resources[0].selectable_fields=['alpha','beta'];
   const result=await x.run();expect(result.ready).toBe(false);expect(result.inventory!.items.slice(0,2).map(i=>i.resource)).toContain('a.widgets');
 });
 it('re-registers the same mapped meaning without resetting an existing exact decision, and records withdrawal separately',async()=>{
   const x=await setup('main',true);x.set({choice:'confirmed_non_sensitive'});await x.run();await x.restart();
   const before=structuredClone(x.f.sources.scoped_disclosure_reviews);
   const choose=x.input.session.chooseOption;x.input.session={...x.input.session,chooseOption:async()=> 'keep'};
   const reused=await localScopedDisclosureReview({...x.input,register:true});expect(reused.ready).toBe(true);
   expect(x.f.sources.scoped_disclosure_reviews).toEqual(before);
   x.input.session={...x.input.session,chooseOption:choose};x.set({choice:'not_confirmed'});
   const withdrawn=await x.run();expect(withdrawn.ready).toBe(false);
   expect(withdrawn.inventory?.items.every(i=>i.state==='not_confirmed')).toBe(true);
   expect(x.f.sources.scoped_disclosure_reviews.slice(0,before.length)).toEqual(before);
 });
 it('excludes selectable but model-withheld fields from the local returned-field picker',async()=>{
   const x=await setup();x.f.draft.read.pack.resources[0].model_withheld_fields=['public_name'];
   const fields=disclosureFields(x.f.draft);
   expect(fields.some(f=>f.resource==='release_ops.animals'&&f.field==='public_name')).toBe(false);
   expect(fields.some(f=>f.resource==='release_ops.animals'&&f.field==='species_group')).toBe(true);
 });
 it('invalidates an inbound relationship-only change under the current Read digest',async()=>{
   const x=await setup('main',true);x.set({choice:'confirmed_non_sensitive'});await x.run();
   const draft=x.currentDraft();draft.read.pack.resources.at(-1).relationships=[];
   draft.runner_evidence.scoped_disclosure.read_digest=canonicalJsonDigest(draft.read);
   expect(scopedDisclosureInventory(x.f.source,draft).items.every(i=>i.state==='stale')).toBe(true);
 });
 it('keeps the mapping after decision write failure and refuses an in-prompt binding change',async()=>{
   const x=await setup();await x.run();await x.restart();x.set({choice:'confirmed_non_sensitive'});
   const before=await policySourceSavedDigest(x.root,x.f.sources.id);
   vi.spyOn(fs,'rename').mockRejectedValueOnce(new Error('synthetic failed atomic save'));
   await expect(x.run()).rejects.toThrow('synthetic failed atomic save');
   expect(await policySourceSavedDigest(x.root,x.f.sources.id)).toBe(before);vi.restoreAllMocks();
   const confirm=x.input.session.confirm;x.input.session={...x.input.session,confirm:async(q:string)=>{
     const result=await confirm(q);if(q==='Save this exact classification decision?')x.f.draft.read.pack.resources[0].table='changed';return result;
   }};
   await expect(x.run()).rejects.toThrow('SCOPED_DISCLOSURE_CONTEXT_CHANGED');
   expect(await policySourceSavedDigest(x.root,x.f.sources.id)).toBe(before);
 });
 it('stops prepared provider work on the registered unknown instead of obtaining another opinion',async()=>{
   const x=await setup();await x.run();const requestJson=vi.fn(async()=>{throw new Error('Provider must not run');});
   await expect(ensurePreparedPolicyCoverage({projectRoot:x.root,sources:x.f.sources,currentDraft:x.currentDraft as any,
     modelSession:{provider:'openrouter',model:'openai/gpt-5.6-terra',dependencies:{requestJson}},operatorSession:x.input.session,
     authorityDigest:x.input.authorityDigest,clarifications:[],state:{},assertCurrent:async()=>{}})).rejects.toThrow('SCOPED_DISCLOSURE_REVIEW_PENDING');
   expect(requestJson).not.toHaveBeenCalled();
 });
});
