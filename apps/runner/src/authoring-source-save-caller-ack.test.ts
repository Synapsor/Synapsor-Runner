import { execFileSync } from 'node:child_process';
import { createSourceInputHost, type SourceInputHostAccess } from './authoring-input-host.js';
import { buildBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState, assertBoundaryAuthoringResumeCurrent, assertBoundaryAuthoringResumeCurrentHeld, readBoundaryAuthoringResumeState } from './boundary-authoring-resume.js';
import { proposeOperatorAnswer, confirmOperatorAnswer } from './authoring-operator-question.js';
import { makeSourceInputReview } from './authoring-input-policy.js';
import { withProjectAuthorityMutation, withHeldProjectAuthorityAccess } from './project-authority-mutation.js';
import type { BoundaryReviewInteractiveSession } from './boundary-cli-picker.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import * as sourceOwner from './authoring-policy-source.js';
import { reviewSourceInputPolicy } from './authoring-input-policy-operation.js';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, {recursive:true,force:true}))); });
async function fixture() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'source-caller-ack-')); roots.push(root);
  const sources=sourceOwner.newPolicySourceSession(); sources.snapshots=[sourceOwner.policyTextSnapshot(Buffer.from('No explicit caller text length range is required.'),'rules.txt')]; sources.active=1;
  await sourceOwner.savePolicySources(root,sources,{expectedDigest:null});
  const file=path.join(root,'.synapsor/boundary-authoring/policy-sources',`${sources.id}.json`);
  const session:BoundaryReviewInteractiveSession={chooseResource:async()=>{throw new Error("Resource picker is outside this Source save control");},editFieldTiers:async()=>{throw new Error("Field editor is outside this Source save control");},promptText:async()=>'',chooseOption:async(_title,options)=>options.find(option=>option.value==='none')?.value,confirm:async()=>true};
  return {root,sources,file,input:{projectRoot:root,sources,store:canonicalJsonDigest('current local store'),outcomes:['work.change'],actor:'local operator',assertCurrent:async()=>{},session}};
}
it.each(['captured','absent','outcome'] as const)('local Input adopts corresponding Source ACK: %s', async scenario => {
  const f=await fixture(), nativeSave=sourceOwner.savePolicySources, nativeRename=fs.rename.bind(fs);
  if(scenario==='captured') vi.spyOn(sourceOwner,'savePolicySources').mockImplementation((root,next,options)=>{
    const pending=nativeSave(root,next,options);
    next.operator_messages=['Later mutable staging content was never submitted.'];
    return pending;
  });
  if(scenario==='absent') vi.spyOn(fs,'rename').mockImplementation(async(from,to)=>{
    await nativeRename(from,to); if(to===f.file) f.sources.coverage_context_digest=canonicalJsonDigest('Later optional memory field was never submitted.');
  });
  const result=await reviewSourceInputPolicy(f.input), persisted=await sourceOwner.loadPolicySources(f.root,f.sources.id);
  expect(f.sources).toEqual(persisted);
  expect(f.sources.operator_messages).toBeUndefined(); expect(f.sources.coverage_context_digest).toBeUndefined();
  expect(result).toMatchObject({sourceSave:{savedSession:persisted,outcome:{state:'acknowledged',reference:{path:f.file,session_id:f.sources.id,revision_digest:canonicalJsonDigest(persisted)}}}});
});
it.each(['cas','uncertain'] as const)('local Input does not adopt refused or unacknowledged Source: %s', async failure => {
  const f=await fixture(), original=structuredClone(f.sources), nativeRead=fs.readFile.bind(fs), nativeRename=fs.rename.bind(fs); let replaced=false;
  if(failure==='cas') f.input.session.confirm=async()=>{
    await sourceOwner.savePolicySources(f.root,{...f.sources,operator_messages:['A competing accepted statement.']},{expectedDigest:canonicalJsonDigest(f.sources)}); return true;
  };
  else {
    vi.spyOn(fs,'rename').mockImplementation(async(from,to)=>{await nativeRename(from,to);if(to===f.file)replaced=true;});
    vi.spyOn(fs,'readFile').mockImplementation(async(target,options)=>{if(replaced&&target===f.file)throw Object.assign(new Error('actual native readback unavailable'),{code:'EIO'});return nativeRead(target,options);});
  }
  await expect(reviewSourceInputPolicy(f.input)).rejects.toMatchObject({code:failure==='cas'?'POLICY_SOURCE_CHANGED':'POLICY_SOURCE_SAVE_UNCERTAIN'});
  vi.restoreAllMocks(); expect(f.sources).toEqual(original);
  const actual=await sourceOwner.loadPolicySources(f.root,f.sources.id);
  if(failure==='uncertain')expect(actual.input_policy_reviews).toHaveLength(1);
  else expect(actual.operator_messages).toEqual(['A competing accepted statement.']);
});

it.each(['absent','wrong_question','wrong_path','resume_refused','resume_cas'] as const)('native Input host consumes corresponding Source ACK: %s',async scenario=>{
 const f=await fixture(),store=f.input.store,scope=canonicalJsonDigest('native Input scope');
 await fs.mkdir(path.join(f.root,'.git'));
 await fs.writeFile(path.join(f.root,'synapsor.runner.json'),JSON.stringify({version:1,mode:'read_only',sources:{app:{engine:'postgres',read_url_env:'UNUSED_READ_URL'}},capabilities:[],trusted_context:{provider:'static_dev',values:{tenant_id:'fixture-private-tenant',principal:'fixture-private-principal'}}}));
 const binding={boundary_name:'native_input_ack',generation_lock_fingerprint:canonicalJsonDigest('lock'),schema_fingerprint:canonicalJsonDigest('schema'),role_posture_fingerprint:canonicalJsonDigest('role')};
 const base={binding,stage:'authority_review' as const,jobIntent:'Review declared caller input bounds',provider:'openai' as const,model:'offline',policySourceSession:f.sources.id};
 let state=buildBoundaryAuthoringResumeState(base);await writeBoundaryAuthoringResumeState(f.root,state,{expectedRevisionDigest:null});
 let competeResume=false;let winner:typeof state|undefined;let refuseResume=false;const refusal=new Error('Actual enclosing Resume refused');
 const access:SourceInputHostAccess={
  readQuestions:()=>state.operator_questions??[],readHandoffs:()=>state.owner_handoffs??[],readRecovery:()=>state.generation_recovery,readConversationTurns:()=>undefined,readOutcomes:()=>f.input.outcomes,
  scopeDigest:()=>scope,contextDigest:async()=>canonicalJsonDigest(f.sources),contextDigestHeld:async()=>canonicalJsonDigest(f.sources),
  assertResumeCurrent:()=>assertBoundaryAuthoringResumeCurrent(f.root,state),assertResumeCurrentHeld:permit=>assertBoundaryAuthoringResumeCurrentHeld(f.root,state,permit),
  loadContext:()=>withProjectAuthorityMutation(f.root,async()=>({store,inspectReader:async()=>{}})),
  loadContextHeld:permit=>withHeldProjectAuthorityAccess(f.root,permit,async()=>({store,inspectReader:async()=>{}})),
  mutate:(operation,permit)=>permit?withHeldProjectAuthorityAccess(f.root,permit,operation):withProjectAuthorityMutation(f.root,operation),
  commit:async(update,{permit})=>{if(competeResume){competeResume=false;winner=buildBoundaryAuthoringResumeState({...base,previous:state,operatorQuestions:state.operator_questions,pendingJobRevision:'Review retained Input progress'});await writeBoundaryAuthoringResumeState(f.root,winner,{expectedRevisionDigest:state.revision_digest,permit});}if(refuseResume)throw refusal;const next=buildBoundaryAuthoringResumeState({...base,previous:state,operatorQuestions:update.questions??state.operator_questions});await writeBoundaryAuthoringResumeState(f.root,next,{expectedRevisionDigest:state.revision_digest,permit});state=next;},
  checkpointFailure:subject=>new Error(subject),
 };
 const host=await createSourceInputHost({projectRoot:f.root,sources:f.sources,store,outcomes:f.input.outcomes,actor:'local_installation_operator',access,interact:async()=>{throw new Error('No model or UI at protected adoption');}});
 if(host.state!=='ready')throw new Error('Native pending Input owner required');
 const original=host.ports.readQuestions().root;
 const confirmed=confirmOperatorAnswer(proposeOperatorAnswer(original,{question_id:original.id,revision:original.revision,source_reference:canonicalJsonDigest(original.source_binding),disposition:'proposed',value:{kind:'input_bounds',requirements:[]}}));
 await host.ports.saveQuestion(confirmed,original.digest,{});
 const review=makeSourceInputReview({source:sourceOwner.activePolicySource(f.sources)!,session:f.sources,store,outcomes:f.input.outcomes,requirements:[],actor:'local_installation_operator',operatorQuestion:confirmed,questionRoot:confirmed});
 const staged=structuredClone(f.sources);staged.input_policy_reviews=[review];
 const acknowledged=await sourceOwner.savePolicySources(f.root,staged,{expectedDigest:canonicalJsonDigest(f.sources)});
 const projected=structuredClone(staged),before=structuredClone(f.sources),resumeBefore=structuredClone(state);
 let supplied=acknowledged;
 if(scenario==='absent')f.sources.coverage_context_digest=canonicalJsonDigest('Unsubmitted optional memory');
 if(scenario==='wrong_path'){
  const other=await fs.mkdtemp(path.join(os.tmpdir(),'other-source-owner-'));roots.push(other);
  supplied=await sourceOwner.savePolicySources(other,projected,{expectedDigest:null});
 }
 refuseResume=scenario==='resume_refused';competeResume=scenario==='resume_cas';
 const pending=host.ports.acknowledge(scenario==='wrong_question'?original:confirmed,review,projected,undefined,supplied);
 if(scenario==='wrong_question'||scenario==='wrong_path'){await expect(pending).rejects.toBeInstanceOf(sourceOwner.PolicySourceChangedError);expect(f.sources).toEqual(before);}
 else if(scenario==='resume_cas'){
  await expect(pending).rejects.toMatchObject({code:'BOUNDARY_AUTHORING_RESUME_CHANGED'});
  expect(f.sources).toEqual(acknowledged.savedSession);expect(state).toEqual(resumeBefore);
  expect(winner?.revision_digest).not.toBe(resumeBefore.revision_digest);
  expect(await readBoundaryAuthoringResumeState(f.root,binding)).toEqual({status:'ready',value:winner});
  // New OS reader imports the two native owners. It receives only file identity;
  // no live fixture closure, submitted projection, or expected winner bytes.
  const script=`(async()=>{const s=await import('./apps/runner/src/authoring-policy-source.ts');const r=await import('./apps/runner/src/boundary-authoring-resume.ts');const [root,id,binding]=process.argv.slice(1);const source=await s.loadPolicySources(root,id);const resume=await r.readBoundaryAuthoringResumeState(root,JSON.parse(binding));process.stdout.write(JSON.stringify({readerPid:process.pid,sourceDigest:(await import('@synapsor-runner/protocol')).canonicalJsonDigest(source),sourceReviews:source.input_policy_reviews?.length,resumeStatus:resume.status,resumeDigest:('value' in resume)?resume.value.revision_digest:undefined,questionDigest:('value' in resume)?resume.value.operator_questions?.at(-1)?.digest:undefined}));})().catch(()=>{process.exitCode=1});`;
  const cold=JSON.parse(execFileSync(path.resolve('node_modules/.bin/tsx'),['--eval',script,f.root,f.sources.id,JSON.stringify(binding)],{encoding:'utf8',env:{...process.env,TMPDIR:os.tmpdir()}}));
  expect(cold.readerPid).toBeGreaterThan(0);expect(cold.readerPid).not.toBe(process.pid);
  expect(cold).toEqual({readerPid:expect.any(Number),sourceDigest:acknowledged.outcome.reference.revision_digest,sourceReviews:1,resumeStatus:'ready',resumeDigest:winner!.revision_digest,questionDigest:confirmed.digest});
 }
 else if(refuseResume){await expect(pending).rejects.toBe(refusal);expect(f.sources).toEqual(await sourceOwner.loadPolicySources(f.root,f.sources.id));expect(await readBoundaryAuthoringResumeState(f.root,binding)).toEqual({status:'ready',value:resumeBefore});}
 else {await pending;expect(f.sources).toEqual(await sourceOwner.loadPolicySources(f.root,f.sources.id));expect(f.sources.coverage_context_digest).toBeUndefined();}
});
