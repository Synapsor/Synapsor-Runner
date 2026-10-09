import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalJsonDigest as digest } from '@synapsor-runner/protocol';
import { createSourceInputHost, type SourceInputHostAccess } from './authoring-input-host.js';
import { newPolicySourceSession, policyTextSnapshot, savePolicySources, policySourceSavedDigestHeld } from './authoring-policy-source.js';
import { buildBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState, assertBoundaryAuthoringResumeCurrent,
  assertBoundaryAuthoringResumeCurrentHeld, readBoundaryAuthoringResumeState } from './boundary-authoring-resume.js';
import { leaveOperatorQuestionPending } from './authoring-operator-question.js';
import { withProjectAuthorityMutation, withHeldProjectAuthorityAccess } from './project-authority-mutation.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, {recursive:true,force:true}); });
it('saves the exact Input pending question through actual held Source and Resume checks without using entry ports', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(),'input-held-access-')); roots.push(projectRoot);
  const sources = newPolicySourceSession(); sources.snapshots.push(policyTextSnapshot(Buffer.from('Review the note length.'),'rules.txt')); sources.active=1;
  await savePolicySources(projectRoot,sources,{expectedDigest:null});
  const binding = {boundary_name:'input_access',generation_lock_fingerprint:digest('lock'),schema_fingerprint:digest('schema'),role_posture_fingerprint:digest('role')};
  const base = {binding,stage:'authority_review' as const,jobIntent:'Review the note length.',provider:'openai' as const,model:'offline',policySourceSession:sources.id};
  let state = buildBoundaryAuthoringResumeState(base);
  await writeBoundaryAuthoringResumeState(projectRoot,state,{expectedRevisionDigest:null});
  const store=digest('exact current store'), context=digest(sources), scope=digest('exact Input scope');
  const heldContext = vi.fn(async (permit: Parameters<typeof withHeldProjectAuthorityAccess>[1]) =>
    withHeldProjectAuthorityAccess(projectRoot,permit,async()=>({store,inspectReader:async()=>{}})));
  const entryContext=vi.fn(async()=>withProjectAuthorityMutation(projectRoot,async()=>({store,inspectReader:async()=>{}})));
  const access: SourceInputHostAccess = {
    readQuestions:()=>state.operator_questions??[],readHandoffs:()=>state.owner_handoffs??[],readRecovery:()=>state.generation_recovery,
    readConversationTurns:()=>undefined,readOutcomes:()=>['work.note'],scopeDigest:()=>scope,
    contextDigest:async()=>context,
    contextDigestHeld:async permit=>{expect(await policySourceSavedDigestHeld(projectRoot,sources.id,permit)).toBe(context);return context;},
    assertResumeCurrent:()=>assertBoundaryAuthoringResumeCurrent(projectRoot,state),
    assertResumeCurrentHeld:permit=>assertBoundaryAuthoringResumeCurrentHeld(projectRoot,state,permit),
    loadContext:entryContext,loadContextHeld:heldContext,
    mutate:(operation,parentPermit)=>parentPermit?withHeldProjectAuthorityAccess(projectRoot,parentPermit,operation):withProjectAuthorityMutation(projectRoot,operation),
    commit:async(update,{permit})=>{
      const next=buildBoundaryAuthoringResumeState({...base,previous:state,operatorQuestions:update.questions??state.operator_questions});
      await writeBoundaryAuthoringResumeState(projectRoot,next,{expectedRevisionDigest:state.revision_digest,permit});state=next;
    },checkpointFailure:subject=>new Error(subject),
  };
  const interact=vi.fn(async()=>{throw new Error('No UI during the protected transition.');});
  const host=await createSourceInputHost({projectRoot,sources,store,outcomes:['work.note'],actor:'declared operator',access,interact});
  if(host.state!=='ready') throw new Error('Expected actual pending Input root.');
  const original=host.ports.readQuestions().root;
  await host.ports.saveQuestion(leaveOperatorQuestionPending(original,'cancelled'),original.digest,{});
  expect(entryContext).not.toHaveBeenCalled();expect(heldContext).toHaveBeenCalledTimes(1);expect(interact).not.toHaveBeenCalled();
  const loaded=await readBoundaryAuthoringResumeState(projectRoot,binding);
  expect(loaded.status).toBe('ready');
  if(loaded.status==='ready') expect(loaded.value.operator_questions).toEqual([expect.objectContaining({id:original.id,disposition:'cancelled'})]);
  expect(state.operator_questions![0]!.raw_answer).toBeUndefined();expect(state.operator_questions![0]!.confirmation).toBeUndefined();
});

it('rechecks a current Read-only review subject through explicit held access without acquiring Action authority', async () => {
  const { resolveAuthoringReviewSubject } = await import('./authoring-review-subject.js');
  const projectRoot=await fs.mkdtemp(path.join(os.tmpdir(),'review-subject-held-'));roots.push(projectRoot);
  const binding={boundary_name:'read_only',generation_lock_fingerprint:digest('lock'),schema_fingerprint:digest('schema'),role_posture_fingerprint:digest('role')};
  const resume=buildBoundaryAuthoringResumeState({binding,stage:'authority_review',jobIntent:'Read existing records',provider:'openai',model:'offline'});
  await writeBoundaryAuthoringResumeState(projectRoot,resume,{expectedRevisionDigest:null});
  const chooseOption=vi.fn(async()=>undefined);
  const resolved=await resolveAuthoringReviewSubject({projectRoot,resume,context:{source_session:'unselected',source_digest:digest('Source'),read_name:binding.boundary_name,read_digest:digest('Read')},session:{chooseOption}});
  expect(resolved.subject).toBeUndefined();expect(chooseOption).not.toHaveBeenCalled();
  await withProjectAuthorityMutation(projectRoot,async permit=>{
    await expect(resolved.assertCurrent()).rejects.toMatchObject({code:'POLICY_MUTATION_PERMIT_REQUIRED'});
    await resolved.assertCurrentHeld(permit);
  });
  expect(await readBoundaryAuthoringResumeState(projectRoot,binding)).toEqual({status:'ready',value:resume});
});
