import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { onboard } from './guided-start.js';
import { structuredBoundaryAuthoringCommand } from './boundary-structured-authoring.js';
import { boundaryAuthoringResumeBinding, boundaryReviewCommand, loadBoundaryReviewContext } from './boundary-commands.js';
import { readActionRuleAuthorityDraft, readActionRuleAuthorityActivation, writeActionRuleAuthorityDraftIfCurrent } from './action-rule-authority.js';
import { activateSemanticActionRuntime } from './semantic-action-deployment.js';
import { prepareSavedActionRuleRemoval } from './action-rule-removal.js';
import { buildBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState } from './boundary-authoring-resume.js';
import { createBoundaryAuthoringChat } from './boundary-authoring-chat.js';
import { newPolicySourceSession, policyTextSnapshot, savePolicySources, loadPolicySources } from './authoring-policy-source.js';
import { ownedProgramDraft, ownedProgramInspection } from './test-fixtures/owned-authoring-program.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, {recursive:true, force:true})));
});

// DERIVED public Resume regression. Native reviewed fixture creation prepares
// a two-Action authority and exact removal; the real conversation controller
// creates the waiting question. No accepted handoff, answer, report or generation
// state is injected. Only structural inspection, operator IO and replies are local.
it.each(['removal_eof','blank','unknown','root_unknown','action_drift'] as const)('reopens the real saved Input decision without planning or renewal: %s', async mode => {
  const repeatedKeep = mode !== 'removal_eof', rootUnknown = mode === 'root_unknown', answeredUnknown = mode === 'unknown' || mode === 'action_drift', actionDrift = mode === 'action_drift';
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'input-removal-resume-')); roots.push(root);
  const inspection = ownedProgramInspection(), inspect = async () => structuredClone(inspection);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Provider traffic forbidden'); });
  expect(await onboard(['db','--project-root',root,'--from-env','OWNED_INPUT_RESUME_URL','--schema','studio','--json'],
    {interactive:false,schemaInspector:inspect})).toBe(0);
  const command = (args:string[]) => structuredBoundaryAuthoringCommand(['--project-root',root,...args], inspect);
  expect(await command(['--export-draft','input.json','--json'])).toBe(0);
  const request = JSON.parse(await fs.readFile(path.join(root,'input.json'),'utf8'));
  request.read.resources = [{resource_id:'studio.parcels',include:true,tenant_key:'tenant_id',principal_key:'principal_id',
    row_identity:'parcel_id',selectable_fields:['label','units','available','version'],keep_out_fields:['internal_note'],
    withhold_from_model_fields:['available','version'],private_model_fields:['available','version']}];
  request.actions = [ownedProgramDraft(1),ownedProgramDraft(2)];
  await fs.writeFile(path.join(root,'input.json'),JSON.stringify(request));
  expect(await command(['--draft','input.json','--json'])).toBe(0);
  let visit = 0;
  expect(await boundaryReviewCommand(['--project-root',root,'--access'],inspect,{
    chooseResource:async()=>visit++===0?{action:'confirm'}:undefined,
    editFieldTiers:async()=>undefined,promptText:async()=> 'DERIVED fixture operator',
    confirm:async()=>true,confirmActivation:async()=>true,
  })).toBe(0);
  const context = await loadBoundaryReviewContext(root);
  const draft = (await readActionRuleAuthorityDraft(root,`${context.candidate.pack.name}_rules`))!;
  if (!repeatedKeep) await activateSemanticActionRuntime({projectRoot:root,draft,actor:'DERIVED component operator'});
  const removal = await prepareSavedActionRuleRemoval(root,'studio.pack_parcel_2');
  if(removal.mode==='deactivate')throw new Error('Expected retained peer Action');
  if (!repeatedKeep) await writeActionRuleAuthorityDraftIfCurrent(root,removal.draft,removal.baseline);
  const sources = newPolicySourceSession();
  sources.snapshots = [policyTextSnapshot(Buffer.from('Each retained parcel proposal needs a caller note.\nAgree the note length before completing this setup.'),'parcel-policy.txt')]; sources.active=1;
  await savePolicySources(root,sources,{expectedDigest:null});
  const saved = buildBoundaryAuthoringResumeState({binding:boundaryAuthoringResumeBinding((await loadBoundaryReviewContext(root)).bundle),
    stage:'authority_review',jobIntent:'Prepare the parcel program and retain the separate requested removal.',provider:'openai',model:'owned-input-resume-local',
    actionWorkflow:'program',policySourceSession:sources.id,
    action:{intent:'Retain the first parcel proposal.',intents:['Retain the first parcel proposal.'],strategy:'rule_derived',
      outcome:'studio.pack_parcel_1',intended_outcomes:['studio.pack_parcel_1'],completed_outcomes:['studio.pack_parcel_1']},
    ...(!repeatedKeep ? {pendingActionRemoval:{outcome:'studio.pack_parcel_2',authority_name:removal.draft.authority.name,draft_digest:removal.draft.digest}} : {})});
  await writeBoundaryAuthoringResumeState(root,saved,{expectedRevisionDigest:null});
  const resumeFile = path.join(root,'.synapsor/boundary-authoring/resume.json');
  const readResume = async () => JSON.parse(await fs.readFile(resumeFile,'utf8'));
  const actualQuestion = 'How short or long may the caller note be?';
  let stage:'review'|'keep'|'resume'='review', transcript='', reads=0, responses=0, savedChoices=0;
  let interrupt:(()=>void)|undefined;
  const write=(text:string)=>{transcript+=text;};
  const io:any={write,writeChunk:write,columns:()=>110,isTerminal:()=>false,setStatus:()=>{},clearStatus:()=>{},close:()=>{},
    onInterrupt:(handler:()=>void)=>{interrupt=handler;return()=>{interrupt=undefined;};},
    review:async(title:string,lines:string[])=>write(`\n${title}\n${lines.join('\n')}\n`),
    read:async()=>{reads++;expect((await readResume()).owner_handoffs.at(-1)).toMatchObject({consumer:'input_policy',state:'waiting',question:actualQuestion});if(repeatedKeep&&reads===1)return answeredUnknown?'I do not know the maximum. Keep this decision pending.':'  ';interrupt?.();return undefined;},
    readConversation:async()=>io.read(),
    choose:async(choice:any)=>{
      write(`\nCHOICE ${choice.title}: ${choice.options.map((o:any)=>o.value).join(',')}\n`);
      const values=choice.options.map((o:any)=>o.value);
      if(choice.title==='START BOUNDARY DRAFTING')return stage==='review'?'review_rules':'resume';
      if(choice.title==='USE THE SAVED ATTACHMENT')return 'continue';
      if(choice.title==='SEND ATTACHED RULES'){expect(choice.initialValue).toBe('cancel');return 'send';}
      if(choice.title==='SAVED INPUT-POLICY DECISION'){savedChoices++;expect(choice.initialValue).toBe('keep');return stage==='keep'?'keep':'answer';}
      if(values.includes('yes')&&/Send this Boundary-authoring conversation|Allow the assistant to send|reviewed structural context/.test(choice.message)){
        expect(choice.initialValue).toBe('no');return 'yes';
      }
      interrupt?.();return undefined;
    }};
  const requestJson=async(request:any)=>{
    responses++;
    const body=request.body,names=(body.tools??[]).map((t:any)=>t.name??t.function?.name);
    if(!names.length)return {status:200,body:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'The parcel setup remains pending.'}]}]}};
    expect(names).toEqual(['runner__propose_operator_decision']);
    const text=JSON.stringify(body);
    const lines=(body.input??[]).flatMap((item:any)=>typeof item.content==='string'?item.content.split('\n'):[]);
    const line=lines.find((line:string)=>line.startsWith('Current question: '));
    expect(line,text).toBeDefined();const q=JSON.parse(line.slice('Current question: '.length));
    if(rootUnknown||q.raw_answer)return {status:200,body:{status:'completed',output:[{type:'function_call',call_id:'owned-unknown-input',name:names[0],arguments:JSON.stringify({
      question_id:q.question_id,revision:q.revision,...(q.raw_answer?{answer_id:q.answer_id}:{source_reference:q.source_reference}),status:'proposal',disposition:'pending'})}]}};
    return {status:200,body:{status:'completed',output:[{type:'function_call',call_id:'owned-input-resume',name:names[0],arguments:JSON.stringify({
      question_id:q.question_id,revision:q.revision,source_reference:q.source_reference,status:'needs_information',question:actualQuestion})}]}};
  };
  const outer:any={chooseResource:async()=>undefined,editFieldTiers:async()=>undefined,promptText:async()=>undefined,confirm:async()=>false,
    chooseOption:async(title:string,choices:any[])=> {write(`\nOUTER ${title}: ${choices.map(o=>o.value).join(',')}\n`);return 'pause';},rememberDetails:(title:string,lines:string[])=>write(`\n${title}\n${lines.join('\n')}\n`)};
  const options:any={startWithAgentJob:true,exitAfterAgentJob:true,
    modelAuthoringSession:{provider:'openai',model:'owned-input-resume-local',apiKey:'inert-fixture-only',dependencies:{requestJson}},
    actionProjectInspector:inspect,boundaryAuthoringChatFactory:(selection:any)=>createBoundaryAuthoringChat({...selection,io,color:false,streamLineDelayMs:0})};
  expect(await boundaryReviewCommand(['--project-root',root,'--access','--job-first','--review-rules'],inspect,outer,undefined,options)).toBe(0);
  const pending=await readResume();expect(reads,transcript).toBe(rootUnknown?0:1);
  if(rootUnknown)expect(pending.owner_handoffs??[]).toEqual([]);
  else expect(pending.owner_handoffs.at(-1)).toMatchObject({consumer:'input_policy',state:answeredUnknown?'answered':'waiting',question:actualQuestion});
  expect(pending.pending_policy_review).toBeUndefined();
  const beforeSources=await loadPolicySources(root,sources.id), beforeActive=await readActionRuleAuthorityActivation(root);
  const beforeResponses=responses;
  if (repeatedKeep) {
    stage='keep';
    expect(await boundaryReviewCommand(['--project-root',root,'--access','--job-first'],inspect,outer,undefined,options)).toBe(0);
    expect(savedChoices,transcript).toBe(rootUnknown?0:1);
    expect(reads).toBe(rootUnknown?0:1); expect(responses).toBe(beforeResponses);
    const kept=await readResume();
    expect(kept.owner_handoffs).toEqual(pending.owner_handoffs);
    expect(kept.operator_questions).toEqual(pending.operator_questions);
    expect(kept.generation_recovery).toEqual(pending.generation_recovery);
  }
  if(answeredUnknown||rootUnknown){
    const choicesBefore=savedChoices;
    if(actionDrift){
      await writeActionRuleAuthorityDraftIfCurrent(root,removal.draft,removal.baseline);
      expect((await readActionRuleAuthorityDraft(root,removal.draft.authority.name))?.digest).toBe(removal.draft.digest);
      expect(removal.draft.authority.rules.map(entry=>entry.rule.outcome)).toEqual(['studio.pack_parcel_1']);
    }
    const transcriptBefore=transcript.length;
    stage='keep';
    expect(await boundaryReviewCommand(['--project-root',root,'--access','--job-first'],inspect,outer,undefined,options)).toBe(0);
    expect(savedChoices,transcript).toBe(choicesBefore+(rootUnknown||actionDrift?0:1));
    if(actionDrift)expect(transcript.slice(transcriptBefore)).toContain('POLICY_SOURCE_CHANGED');
    expect(responses,transcript).toBe(beforeResponses);
    const after=await readResume();
    expect(after.owner_handoffs).toEqual(pending.owner_handoffs);
    expect(after.operator_questions).toEqual(pending.operator_questions);
    expect(after.generation_recovery).toEqual(pending.generation_recovery);
    expect(canonicalJsonDigest(await loadPolicySources(root,sources.id))).toBe(canonicalJsonDigest(beforeSources));
    expect(await readActionRuleAuthorityActivation(root)).toEqual(beforeActive);
    return;
  }
  stage='resume';
  expect(await boundaryReviewCommand(['--project-root',root,'--access','--job-first'],inspect,outer,undefined,options)).toBe(0);
  expect(reads,transcript).toBe(2);
  const after=await readResume();expect(after.owner_handoffs).toEqual(pending.owner_handoffs);
  if(repeatedKeep){
    expect(after.operator_questions.slice(0,pending.operator_questions.length)).toEqual(pending.operator_questions);
    expect(after.operator_questions.at(-1)).toMatchObject({kind:'input_bounds',presentation:{text:actualQuestion},budget_owner_id:pending.operator_questions[0].id});
    expect(after.operator_questions.at(-1).raw_answer).toBeUndefined();
    expect(after.operator_questions.at(-1).confirmation).toBeUndefined();
  }else expect(after.operator_questions).toEqual(pending.operator_questions);
  expect(after.pending_action_removal).toEqual(pending.pending_action_removal);
  expect(after.generation_recovery).toEqual(pending.generation_recovery);
  expect(responses).toBe(beforeResponses);
  expect(canonicalJsonDigest(await loadPolicySources(root,sources.id))).toBe(canonicalJsonDigest(beforeSources));
  expect(await readActionRuleAuthorityActivation(root)).toEqual(beforeActive);
},30_000);
