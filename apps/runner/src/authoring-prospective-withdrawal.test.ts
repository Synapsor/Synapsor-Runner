import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {canonicalJsonDigest} from '@synapsor-runner/protocol';
import {onboard} from './guided-start.js';
import {structuredBoundaryAuthoringCommand} from './boundary-structured-authoring.js';
import {boundaryReviewCommand,loadBoundaryReviewContext} from './boundary-commands.js';
import {explorationBoundaryCandidateDigest} from './auto-boundary.js';
import {readActionRuleAuthorityDraft,readActionRuleAuthorityActivation,readActionRuleProspectiveWithdrawal,
  readActionRuleCoverageLineage,writeActionRuleAuthorityDraftIfCurrent,readActionRuleAuthorityRevisionBaseline,
  buildActionRuleAuthorityDraft,readActionRuleReviewSubjects} from './action-rule-authority.js';
import {prepareSavedActionRuleRemoval} from './action-rule-removal.js';
import {activateSemanticActionRuntime} from './semantic-action-deployment.js';
import {ownedProgramDraft,ownedProgramInspection} from './test-fixtures/owned-authoring-program.js';
import {prepareActionVersionField} from './action-rule-version-review.js';
import {buildActionRuleAuthoringCatalog} from './action-rule-authoring.js';
import {policyCoverageDraft} from './authoring-policy-evidence.js';
import {parsePolicyCoverage} from './authoring-policy-coverage.js';
import {policyTextSnapshot,newPolicySourceSession,savePolicySources,loadPolicySources,bindPolicyCoverage} from './authoring-policy-source.js';
import {prepareRetainedDutyReview,assembleRetainedDutyReview,preflightRetainedDutyEvidence,assertPendingWithdrawalDutyProofs} from './authoring-retained-duties.js';
import {assessActionWithdrawal} from './action-rule-withdrawal.js';
import {buildBoundaryAuthoringResumeState,writeBoundaryAuthoringResumeState} from './boundary-authoring-resume.js';
import {policyReviewReadiness} from './authoring-review-readiness.js';
import {createBoundaryAuthoringChat} from './boundary-authoring-chat.js';
import {authoringDestination} from './authoring-policy-source.js';

const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
/** DERIVED existing parcel grammar; real public preparation/store publication.
 * No database, model, BUSINESS Source or runtime operation is connected. */
async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'prospective-withdrawal-'));roots.push(root);
 vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
 const inspection=ownedProgramInspection(),inspect=async()=>inspection;
 expect(await onboard(['db','--project-root',root,'--from-env','OWNED_STUDIO_READ_URL','--schema','studio','--json'],{interactive:false,schemaInspector:inspect})).toBe(0);
 const command=(args:string[])=>structuredBoundaryAuthoringCommand(['--project-root',root,...args],inspect);
 expect(await command(['--export-draft','input.json','--json'])).toBe(0);
 const request=JSON.parse(await fs.readFile(path.join(root,'input.json'),'utf8'));
 request.read.resources=[{resource_id:'studio.parcels',include:true,tenant_key:'tenant_id',principal_key:'principal_id',row_identity:'parcel_id',
  selectable_fields:['label','units','available','version'],keep_out_fields:['internal_note'],withhold_from_model_fields:['available','version'],private_model_fields:['available','version']}];
 request.actions=[ownedProgramDraft(1),ownedProgramDraft(2)];
 await fs.writeFile(path.join(root,'input.json'),JSON.stringify(request));
 expect(await command(['--draft','input.json','--json'])).toBe(0);
 const context=await loadBoundaryReviewContext(root),readDigest=explorationBoundaryCandidateDigest(context.candidate);
 let visits=0;
 expect(await boundaryReviewCommand(['--project-root',root,'--access'],inspect,{chooseResource:async()=>visits++===0?{action:'confirm'}:undefined,
  editFieldTiers:async()=>undefined,promptText:async()=> 'DERIVED component operator',confirm:async()=>true,confirmActivation:async()=>true})).toBe(0);
 const initial=(await readActionRuleAuthorityDraft(root,`${context.candidate.pack.name}_rules`))!;
 const active=(await activateSemanticActionRuntime({projectRoot:root,draft:initial,actor:'DERIVED component operator'})).activation;
 const removal=await prepareSavedActionRuleRemoval(root,request.actions[1].outcome);
 if(removal.mode==='deactivate')throw new Error('Expected retained Action');
 await writeActionRuleAuthorityDraftIfCurrent(root,removal.draft,removal.baseline);
 const candidate=removal.draft;
 const proof=(await readActionRuleProspectiveWithdrawal(root,candidate,readDigest))!;
 expect(proof).toBeDefined();expect(await readActionRuleCoverageLineage(root,candidate,readDigest)).toBeUndefined();
 const reviewed=prepareActionVersionField({context:{readBoundary:context.candidate,readBoundaryDigest:readDigest,
  builtCatalog:buildActionRuleAuthoringCatalog({boundary:context.candidate,inspection})},inspection,generationLock:context.lock,resource:'studio.parcels',field:'version'}).review;
 const source=policyTextSnapshot(Buffer.from('Maintain each version counter on every write, including outside Runner.'),'derived-counter-source.txt');
 const session=newPolicySourceSession();session.snapshots=[source];session.active=source.version;
 const prepared=(authority:typeof active|typeof candidate)=>policyCoverageDraft({read:context.candidate,decisions:context.bundle.decisions,
  actions:[],authority,source:{inspection,generationLock:context.lock},reviewedVersionFields:[reviewed],policySources:session});
 const old=prepared(active),current=prepared(candidate);
 const passage=(outcome:string)=>({start:1,end:1,disposition:'needs_decision' as const,responsibility:'deployment' as const,
  issue_kind:'missing_configuration' as const,interpretation:'Maintain every writer; external assurance remains unverified.',
  draft_paths:[`/runner_evidence/actions/${outcome}/effect/source_counter_maintenance`],
  source_counter_obligation:{path:`/runner_evidence/actions/${outcome}/effect/source_counter_maintenance`,requirement:'owner_maintenance' as const}});
 const previous=parsePolicyCoverage({passages:old.actions.map(a=>passage(a.outcome))},source,old,[]);
 const parse=(passages:ReturnType<typeof passage>[])=>parsePolicyCoverage({passages},source,current,[]);
 const submitted=current.actions.map(a=>passage(a.outcome));
 const coverageAuthority=canonicalJsonDigest({read:readDigest,action:active.digest});
 const plan=()=>prepareRetainedDutyReview(previous,source,current,undefined,coverageAuthority,proof);
 const report=()=>assembleRetainedDutyReview(parse(submitted),plan(),source,current,p=>parsePolicyCoverage({passages:p},source,current,[]));
 return{root,active,candidate,proof,readDigest,source,session,old,current,previous,submitted,parse,coverageAuthority,plan,report,prepared,context,reviewed,inspect};
}

describe('prospective exact withdrawal retains current Source duties',()=>{
 it.each(['resume_no','resume_yes','explicit_review','review_without_removal'] as const)(
  'ordinary public %s preserves the distinction between pending policy review and exact withdrawal',async mode=>{
   const f=await fixture(),report=f.report(),model='DERIVED component';
   bindPolicyCoverage(f.session,report,canonicalJsonDigest({read:f.readDigest,action:f.candidate.digest}));
   f.session.approvals=[{digest:f.source.digest,destination:authoringDestination({provider:'openai',model})}];
   await savePolicySources(f.root,f.session,{expectedDigest:null});
   const binding={boundary_name:f.context.candidate.pack.name,generation_lock_fingerprint:f.context.candidate.generation_lock_fingerprint,
    schema_fingerprint:f.context.lock.schema_fingerprint,role_posture_fingerprint:f.context.lock.role_posture_fingerprint};
   const original=buildBoundaryAuthoringResumeState({binding,stage:'action_drafting',jobIntent:'DERIVED original two parcel duties stay pending.',actionWorkflow:'program',provider:'openai',model,
    action:{intent:'Parcel one',intents:['Parcel one','Parcel two'],intended_outcomes:f.active.authority.rules.map(r=>r.rule.outcome)}});
   const resume=buildBoundaryAuthoringResumeState({binding,previous:original,stage:'authority_review',jobIntent:original.job_intent,provider:'openai',model,
    policySourceSession:f.session.id,reviewedVersionFields:[f.reviewed],action:{intent:'Parcel one',intents:['Parcel one'],intended_outcomes:f.candidate.authority.rules.map(r=>r.rule.outcome),completed_outcomes:f.candidate.authority.rules.map(r=>r.rule.outcome)},
    ...(mode==='review_without_removal'?{}:{pendingActionRemoval:{outcome:f.proof.basis.removed_outcomes[0]!,authority_name:f.candidate.authority.name,draft_digest:f.candidate.digest}}),
    pendingPolicyReview:{operation:'review_rules',request:'Review attached rules and unresolved decisions',source_session:f.session.id,source_digest:f.source.digest as `sha256:${string}`,
     read_digest:f.readDigest,action_name:f.candidate.authority.name,action_digest:f.candidate.digest,
     action_subject:(await readActionRuleReviewSubjects(f.root)).find(s=>s.identity.location==='disabled'&&s.authority.digest===f.candidate.digest)!.identity}});
   await writeBoundaryAuthoringResumeState(f.root,resume,{expectedRevisionDigest:null});
   const menus:any[]=[],notices:any[]=[],unexpectedRequests:any[]=[];
   let interrupt:(()=>void)|undefined;
   const io:any={write:()=>{},writeChunk:()=>{},columns:()=>110,isTerminal:()=>false,setStatus:()=>{},clearStatus:()=>{},close:()=>{},
    onInterrupt:(handler:()=>void)=>{interrupt=handler;return()=>{interrupt=undefined;};},review:async()=>{},
    read:async()=>{interrupt?.();return undefined;},readConversation:async()=>{interrupt?.();return undefined;},
    choose:async(choice:any)=>{
     const values=choice.options.map((o:any)=>o.value);let selected:string|undefined;
     if(choice.title==='START BOUNDARY DRAFTING')selected=mode==='explicit_review'?'review_rules':'resume';
     else if(choice.title==='CLIENT FOR THIS JOB')selected='later';
     else if(choice.title==='USE THE SAVED ATTACHMENT')selected='continue';
     else if(choice.title==='SEND ATTACHED RULES')selected='send';
     else if(values.includes('withdraw'))selected=menus.some(m=>m.message==='Publish this exact Action withdrawal?')?'back':'withdraw';
     else if(choice.message==='Publish this exact Action withdrawal?'){
      expect(choice.initialValue).toBe('no');selected=mode==='resume_yes'?'yes':'no';
     }else if(choice.message==='Run a new bounded model review?')selected='no';
     else if(choice.title==='FINISH ATTACHED RULES REVIEW'||choice.title==='SETUP NEEDS ATTENTION')selected='pause';
     else if(values.includes('back'))selected='back';
     menus.push({...choice,selected});if(!selected||!values.includes(selected)){interrupt?.();return undefined;}return selected;
    }};
   const outer:any={chooseResource:async()=>undefined,editFieldTiers:async()=>undefined,promptText:async()=>undefined,confirm:async()=>false,
    chooseOption:async()=> 'pause'};
   await boundaryReviewCommand(['--project-root',f.root,'--access','--job-first'],f.inspect,outer,undefined,{
    startWithAgentJob:true,exitAfterAgentJob:true,onAuthoringResult:notice=>notices.push(notice),actionProjectInspector:f.inspect,
    modelAuthoringSession:{provider:'openai',model,apiKey:'local-test-only',dependencies:{requestJson:async request=>{unexpectedRequests.push(request);throw new Error('NO_PROVIDER_REQUEST_EXPECTED');}}},
    boundaryAuthoringChatFactory:selection=>createBoundaryAuthoringChat({...selection,io,color:false,streamLineDelayMs:0})});
   expect(unexpectedRequests).toEqual([]);
   const withdrawalVisited=menus.some(m=>m.message==='Publish this exact Action withdrawal?');
   expect(withdrawalVisited,JSON.stringify({menus,notices})).toBe(mode==='resume_no'||mode==='resume_yes');
   const active=(await readActionRuleAuthorityActivation(f.root))!;
   expect(active).toEqual(mode==='resume_yes'?expect.objectContaining({digest:f.candidate.digest,
    publication:expect.objectContaining({kind:'withdrawal',business_review_completed:false,removed_outcomes:f.proof.basis.removed_outcomes})}):f.active);
   const saved=await loadPolicySources(f.root,f.session.id);expect(saved.snapshots).toEqual(f.session.snapshots);
   expect(saved.coverage).toEqual(f.session.coverage);expect(policyReviewReadiness(f.source,saved.coverage,saved).ready).toBe(false);
   const after=JSON.parse(await fs.readFile(path.join(f.root,'.synapsor/boundary-authoring/resume.json'),'utf8'));
   expect(after.pending_policy_review).toEqual(resume.pending_policy_review);
   if(mode==='resume_yes')expect(after.pending_action_removal).toBeUndefined();
   else expect(after.pending_action_removal).toEqual(resume.pending_action_removal);
  },20000);
 it('permits canonical review, preserves full original report, and never invents a removal event or BUSINESS readiness',async()=>{
  const f=await fixture();expect(()=>preflightRetainedDutyEvidence(f.plan(),f.source,f.current)).not.toThrow();
  const report=f.report();expect(report.retained_duty_history).toMatchObject([{disposition:'pending_exact_withdrawal',verified:false,original_report:f.previous}]);
  const record=report.retained_duty_history![0]!;expect(record).not.toHaveProperty('removal_basis');expect(record).not.toHaveProperty('lineage_digest');
  expect(record.continuing_paths).toHaveLength(1);expect(policyReviewReadiness(f.source,report).ready).toBe(false);
  expect(()=>assertPendingWithdrawalDutyProofs(report,f.proof)).not.toThrow();
  expect(await readActionRuleAuthorityActivation(f.root)).toEqual(f.active);
  bindPolicyCoverage(f.session,report,canonicalJsonDigest({read:f.readDigest,action:f.candidate.digest}));
  await savePolicySources(f.root,f.session,{expectedDigest:null});expect(await loadPolicySources(f.root,f.session.id)).toEqual(f.session);
  expect(policyReviewReadiness(f.source,report,f.session).ready).toBe(false);
  const mismatched={...f.session,coverage_authority_digest:canonicalJsonDigest({read:f.readDigest,action:f.active.digest})};
  expect(policyReviewReadiness(f.source,report,mismatched).items?.some(i=>i.title.includes('Original Source duties remain pending after') && i.blocksReview)).toBe(true);
  const malformed=structuredClone(f.session);malformed.id=newPolicySourceSession().id;Object.assign(malformed.coverage!.retained_duty_history![0]!,{removal_basis:{}});
  await expect(savePolicySources(f.root,malformed)).rejects.toThrow('POLICY_RETAINED_DUTY');
  const oversize=structuredClone(f.session);oversize.id=newPolicySourceSession().id;oversize.coverage!.retained_duty_history![0]!.continuing_paths=Array.from({length:257},(_,i)=>`/runner_evidence/actions/derived_${i}/effect/source_counter_maintenance`);
  await expect(savePolicySources(f.root,oversize)).rejects.toThrow('POLICY_RETAINED_DUTY');
  const again=prepareRetainedDutyReview(report,f.source,f.current,undefined,f.session.coverage_authority_digest,f.proof);
  expect(assembleRetainedDutyReview(f.parse(f.submitted),again,f.source,f.current,p=>parsePolicyCoverage({passages:p},f.source,f.current,[]))).toEqual(report);
  const changed=structuredClone(f.session);delete changed.coverage!.retained_duty_history;
  await expect(savePolicySources(f.root,changed)).rejects.toThrow('POLICY_RETAINED_DUTY');
  await expect(savePolicySources(f.root,{...f.session,operator_messages:['later owner statement']},{expectedDigest:canonicalJsonDigest(f.session)})).resolves.toBeUndefined();
  await expect(savePolicySources(f.root,f.session,{expectedDigest:canonicalJsonDigest(f.session)})).rejects.toThrow('POLICY_SOURCE_CHANGED');
 },20000);
 it('publishes only through real current withdrawal checks and keeps the prospective audit pending after the actual event',async()=>{
  const f=await fixture(),report=f.report();bindPolicyCoverage(f.session,report,canonicalJsonDigest({read:f.readDigest,action:f.candidate.digest}));
  await savePolicySources(f.root,f.session,{expectedDigest:null});
  const binding={boundary_name:f.context.candidate.pack.name,generation_lock_fingerprint:f.context.candidate.generation_lock_fingerprint,
    schema_fingerprint:f.context.lock.schema_fingerprint,role_posture_fingerprint:f.context.lock.role_posture_fingerprint};
  const old=buildBoundaryAuthoringResumeState({binding,stage:'action_drafting',jobIntent:'DERIVED original two parcel duties stay pending.',actionWorkflow:'program',provider:'openai',model:'DERIVED component',
    action:{intent:'Parcel one',intents:['Parcel one','Parcel two'],intended_outcomes:f.active.authority.rules.map(r=>r.rule.outcome)}});
  const resume=buildBoundaryAuthoringResumeState({binding,previous:old,stage:'authority_review',jobIntent:old.job_intent,provider:'openai',model:'DERIVED component',
    policySourceSession:f.session.id,reviewedVersionFields:[f.reviewed],action:{intent:'Parcel one',intents:['Parcel one'],intended_outcomes:f.candidate.authority.rules.map(r=>r.rule.outcome),completed_outcomes:f.candidate.authority.rules.map(r=>r.rule.outcome)},
    pendingActionRemoval:{outcome:f.proof.basis.removed_outcomes[0]!,authority_name:f.candidate.authority.name,draft_digest:f.candidate.digest},
    pendingPolicyReview:{operation:'review_rules',request:'Review attached rules and unresolved decisions',source_session:f.session.id,source_digest:f.source.digest as `sha256:${string}`,
      read_digest:f.readDigest,action_name:f.candidate.authority.name,action_digest:f.candidate.digest,
      action_subject:(await readActionRuleReviewSubjects(f.root)).find(s=>s.identity.location==='disabled' && s.authority.digest===f.candidate.digest)!.identity}});
  await writeBoundaryAuthoringResumeState(f.root,resume,{expectedRevisionDigest:null});
  const consent=await assessActionWithdrawal({projectRoot:f.root,draft:f.candidate});expect(consent.business_review_completed).toBe(false);
  const published=(await activateSemanticActionRuntime({projectRoot:f.root,draft:f.candidate,actor:'DERIVED component operator',withdrawalContext:consent.review_context_digest})).activation;
  expect(published.publication).toEqual(consent);expect(await loadPolicySources(f.root,f.session.id)).toEqual(f.session);
  const lineage=await readActionRuleCoverageLineage(f.root,published,f.readDigest);expect(lineage).toBeDefined();
  const current=f.prepared(published),plan=prepareRetainedDutyReview(report,f.source,current,lineage,f.session.coverage_authority_digest);
  expect(()=>preflightRetainedDutyEvidence(plan,f.source,current)).not.toThrow();
  const parse=(passages:typeof report.passages)=>parsePolicyCoverage({passages},f.source,current,[]);
  const next=assembleRetainedDutyReview(parse(f.submitted),plan,f.source,current,parse);
  expect(next.retained_duty_history).toEqual(report.retained_duty_history);
  expect(next.retained_duty_history![0]!.disposition).toBe('pending_exact_withdrawal');expect(policyReviewReadiness(f.source,next,f.session).ready).toBe(false);
 },20000);
 it('reselecting the actual active authority or restoring a removed outcome leaves the old proposal inert and requires normal current duty validation',async()=>{
  const f=await fixture(),report=f.report();
  const plan=prepareRetainedDutyReview(report,f.source,f.old,undefined,canonicalJsonDigest({read:f.readDigest,action:f.active.digest}));
  expect(()=>preflightRetainedDutyEvidence(plan,f.source,f.old)).not.toThrow();
  const parsed=parsePolicyCoverage({passages:f.previous.passages},f.source,f.old,[]);
  const restored=assembleRetainedDutyReview(parsed,plan,f.source,f.old,p=>parsePolicyCoverage({passages:p},f.source,f.old,[]));
  expect(restored.retained_duty_history).toEqual(report.retained_duty_history);expect(restored.current_pending_retained_duties).toEqual([]);
  const session=structuredClone(f.session);bindPolicyCoverage(session,restored,canonicalJsonDigest({read:f.readDigest,action:f.active.digest}));
  expect(policyReviewReadiness(f.source,restored,session).items?.some(i=>i.title.includes('Original Source duties remain pending after'))).toBe(false);
  expect(policyReviewReadiness(f.source,restored).ready).toBe(policyReviewReadiness(f.source,f.previous).ready);
  expect(policyReviewReadiness(f.source,restored).items?.some(i=>i.title.includes('Original Source duties remain pending after'))).toBe(false);
  const renewed=prepareRetainedDutyReview(restored,f.source,f.current,undefined,f.coverageAuthority,f.proof);
  expect(assembleRetainedDutyReview(f.parse(f.submitted),renewed,f.source,f.current,p=>parsePolicyCoverage({passages:p},f.source,f.current,[]))).toEqual(report);
 },20000);
 it.each(['retained_input','retained_rule','approval','limit','added','read'] as const)('does not turn a changed %s into prospective removal evidence',async fault=>{
  const f=await fixture(),altered=structuredClone(f.proof);
  if(fault==='read')altered.basis.read_digest=canonicalJsonDigest('foreign Read');
  else if(fault==='added')altered.candidate.authority.rules.push(structuredClone(f.active.authority.rules.at(-1)!));
  else if(fault==='retained_input')altered.candidate.authority.rules[0]!.rule.inputs![0]!.maximum=9;
  else if(fault==='retained_rule')altered.candidate.authority.rules[0]!.rule.ttl_seconds=900;
  else if(fault==='approval')altered.candidate.authority.approval_classes[0]!.required_approvals=2;
  else altered.basis.candidate_digest=canonicalJsonDigest('changed limit');
  expect(()=>prepareRetainedDutyReview(f.previous,f.source,f.current,undefined,f.coverageAuthority,altered)).toThrow();
 },20000);
 it('refuses changed Source/current evidence, missing proof, forged audit and model-supplied host history',async()=>{
  const f=await fixture(),changed=policyTextSnapshot(Buffer.from(f.source.text+'\nAn exception applies.'),f.source.name);
  expect(()=>prepareRetainedDutyReview(f.previous,changed,f.current,undefined,f.coverageAuthority,f.proof)).toThrow('POLICY_RETAINED_DUTY_PENDING');
  expect(()=>prepareRetainedDutyReview(f.previous,f.source,f.current,undefined,f.coverageAuthority)).toThrow('POLICY_RETAINED_DUTY_PENDING');
  f.current.runner_evidence.actions[f.current.actions[0]!.outcome]!.effect.source_counter_maintenance!.proof_digest=canonicalJsonDigest('different owner proof');
  expect(()=>preflightRetainedDutyEvidence(f.plan(),f.source,f.current)).toThrow('POLICY_RETAINED_DUTY_PENDING');
  expect(()=>parsePolicyCoverage({passages:f.submitted,retained_duty_history:[]},f.source,f.current,[])).toThrow();
 },20000);
 it('does not reuse a saved prospective proof after the actual disabled pointer changes',async()=>{
  const f=await fixture(),report=f.report();
  const changed=buildActionRuleAuthorityDraft({name:f.active.authority.name,catalog:f.active.authority.catalog,
    rules:f.active.authority.rules,approval_classes:f.active.authority.approval_classes,reviews:f.active.reviews,
    action_boundary_name:f.active.authority.action_boundary.name,now:'2026-10-01T01:00:00.000Z'});
  // A new disabled pointer with a different creation binding cannot replace
  // the selected exact candidate, even when the business text is unchanged.
  await writeActionRuleAuthorityDraftIfCurrent(f.root,changed,await readActionRuleAuthorityRevisionBaseline(f.root));
  expect(await readActionRuleProspectiveWithdrawal(f.root,f.candidate,f.readDigest)).toBeUndefined();
  expect(()=>assertPendingWithdrawalDutyProofs(report,undefined)).toThrow('POLICY_RETAINED_DUTY_PENDING');
 },20000);
});
