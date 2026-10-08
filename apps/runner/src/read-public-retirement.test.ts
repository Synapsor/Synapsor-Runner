import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {buildBoundaryAuthoringResumeState,writeBoundaryAuthoringResumeState} from './boundary-authoring-resume.js';
import {onboard,start} from './guided-start.js';
import {boundaryReviewCommand,loadBoundaryReviewContext} from './boundary-commands.js';
import {prepareBoundaryResourceReviewMutation,commitBoundaryResourceReviewMutation} from './boundary-review-mutation.js';
import {createBoundaryAuthoringChat} from './boundary-authoring-chat.js';
import {ownedProgramInspection} from './test-fixtures/owned-authoring-program.js';
import {modelVisibleJsonLine,modelVisibleUserText} from './test-fixtures/model-visible-frame.js';
import {READ_SCOPE_PROTOCOL,type ReadScopeReference} from './read-structured-scope.js';
// Reuses R1's accepted public fixture at 2d906e04 without changing its business
// answers, provider counts, history, currentness, or default-No assertions.
const retiredCalls = vi.hoisted(() => [] as string[]);
vi.mock("./read-meaning-evidence.js", async original => ({ ...await original<typeof import("./read-meaning-evidence.js")>(),
  ...Object.fromEntries(["readMeaningReferences", "isExplicitReadMeaningStatement", "readResourceDefinitionPhrases", "readDefinitionPhrases", "isUnknownReadMeaning", "findReadMeaningEvidence", "explicitReadTaskTargets"]
    .map(name => [name, () => { retiredCalls.push(name); throw Error(`RETIRED_ENGLISH_CALLED:${name}`); }])) }));
vi.mock("./read-current-evidence.js", async original => ({ ...await original<typeof import("./read-current-evidence.js")>(),
  ...Object.fromEntries(["createCurrentReadEvidence", "currentReadEvidenceStatements"].map(name => [name, () => {
    retiredCalls.push(name); throw Error(`RETIRED_ENGLISH_CALLED:${name}`); }])) }));
afterEach(() => { expect(retiredCalls).toEqual([]); retiredCalls.splice(0); });

const job="Show the signed-in customer's parcel labels under the attached policy. No Actions.";
const source="Customers may read only their own parcel label. studio.parcels is the parcel register; label is the customer-visible parcel name. All other fields remain private. No Actions are requested.";
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
type Mode='revision'|'no_read_yes'|'read_no'|'replace'|'replace_cancel'|'replace_stale'|'no_read_no'|'stale'|'review';
async function runVariant(mode:Mode, continueAfterCancel=false, firstBlank=false){
 let revisionStarted=false, revisionGiven=false, revisionCalls=0; const revisionInstruction="Name the parcel register Customer parcels. Keep every existing Read field, scope and restriction unchanged.";
 let rawPrompts=0;const correction="Show at most one parcel label at a time; keep the same signed-in customer's scope and all other restrictions.";
 let winningAmendment:any;const amendment='Also keep parcel availability private; review this change before continuing.';
 const noRead=mode.startsWith('no_read');
 const selectedJob=noRead?'Prepare no Read access and no Actions; keep every authority disabled.':job;
 const selectedSource=noRead?'No Read access and no Actions are requested. Keep every authority disabled.':source;
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'b64-public-read-owned-')),sourceFile=path.join(root,'parcel-policy.txt');await fs.writeFile(sourceFile,selectedSource,{mode:0o600,flag:'wx'});await fs.chmod(root,0o700);await fs.mkdir(path.join(root,'.git'),{mode:0o700});
 const inspect=async()=>structuredClone(ownedProgramInspection()),resumeFile=path.join(root,'.synapsor/boundary-authoring/resume.json');
 const resume=async()=>fs.readFile(resumeFile,'utf8').then(t=>JSON.parse(t)).catch(()=>undefined);
 const menus:any[]=[],requests:any[]=[],failures:any[]=[],reads:string[]=[],decisions:any[]=[];let transcript='',attached=false,jobGiven=false,cold=false,sourceConsent=0,planning=0,mapping=0,planningDetails=false;
 const write=(text:string)=>{transcript+=text;};
 const read=async()=>{if(revisionStarted&&!revisionGiven){revisionGiven=true;return revisionInstruction;}if(cold){
    const current=await resume(),rawQuestion=current?.operator_questions?.at(-1);
    if(rawQuestion?.read_scope?.mode==='replacement_answer'&&!rawQuestion.raw_answer){
      rawPrompts++;expect(rawPrompts).toBe(continueAfterCancel&&rawPrompts>1?2:1);
      if(mode==='replace_cancel'&&(!continueAfterCancel||rawPrompts===1))return firstBlank?'':undefined;
      if(mode==='replace_stale'){
        winningAmendment=buildBoundaryAuthoringResumeState({binding:current.binding,stage:current.stage,jobIntent:current.job_intent,provider:current.model.provider,model:current.model.name,previous:current,conversation:current.conversation,policySourceSession:current.policy_source_session,read:current.read,readIntent:current.read_intent,intendedClient:current.intended_client,pendingJobRevision:amendment,privateReadMetadataDigest:current.private_read_metadata_digest,metadataDestinationDigest:current.metadata_destination_digest});
        await writeBoundaryAuthoringResumeState(root,winningAmendment,{expectedRevisionDigest:current.revision_digest});
      }
      return correction;
    }
    return undefined;
  }if(!attached){attached=true;reads.push('attach');return `/attach ${sourceFile}`;}if(!jobGiven){jobGiven=true;reads.push('job');return selectedJob;}throw Error('PUBLIC_B64_UNDECLARED_OPERATOR_QUESTION');};
 const io:any={write,writeChunk:write,columns:()=>110,isTerminal:()=>false,setStatus:()=>{},clearStatus:()=>{},close:()=>{},onInterrupt:()=>()=>{},read,readConversation:read,
  choose:async(choice:any)=>{
   const values=choice.options.map((entry:any)=>entry.value),saved=await resume();let selected:string|undefined;
   if(choice.title==='START BOUNDARY DRAFTING')selected=cold?'resume':'model';
   else if(choice.title==='BOUNDARY JOB PLANNING DID NOT COMPLETE'){selected=planningDetails?'back':'details';planningDetails=true;}
   else if(choice.title==='SEND ATTACHED RULES'){expect(choice.initialValue).toBe('cancel');sourceConsent++;selected='send';}
   else if(choice.title==='READ SCOPE IS STILL PENDING'&&cold&&(mode.startsWith('replace')||mode==='review'))selected=mode.startsWith('replace')?'replace':mode;
   else if(choice.title==='CLIENT FOR THIS JOB')selected='later';
   else if(choice.title==='CLIENT INTEGRATION RESPONSIBILITIES')selected='assign';
   else if(choice.title==='REVIEW DECLARED TEXT INPUT BOUNDS')selected='none';
   else if(choice.message==='Save this exact attributed input-policy interpretation?'){expect(choice.initialValue).toBe('no');selected='yes';}
   else if(values.includes('yes') && /Send this Boundary-authoring conversation|Allow the assistant to send|reviewed structural context/.test(choice.message??'')){expect(choice.initialValue).toBe('no');selected='yes';}
   else if(choice.message==='Run a new bounded model review?'){expect(choice.initialValue).toBe('no');selected='no';}
   else if(choice.message==='Confirm this complete Read scope and analyzed plan?' && values.includes('yes') && saved?.operator_questions?.at(-1)?.kind==='read_scope'){
    const q=saved.operator_questions.at(-1);expect(choice.initialValue).toBe('no');expect(q.confirmation).toBeUndefined();expect(q.read_scope.mode).toBe('review');
    decisions.push({question:q,menu:choice});selected=mode==='revision'||mode==='no_read_yes'||mode==='stale'||((mode==='review'||mode==='replace'||continueAfterCancel)&&cold)?'yes':'no';
    if(mode==='stale'){
     winningAmendment=buildBoundaryAuthoringResumeState({binding:saved.binding,stage:saved.stage,jobIntent:saved.job_intent,provider:saved.model.provider,model:saved.model.name,previous:saved,conversation:saved.conversation,policySourceSession:saved.policy_source_session,read:saved.read,readIntent:saved.read_intent,intendedClient:saved.intended_client,pendingJobRevision:amendment,privateReadMetadataDigest:saved.private_read_metadata_digest,metadataDestinationDigest:saved.metadata_destination_digest});
     await writeBoundaryAuthoringResumeState(root,winningAmendment,{expectedRevisionDigest:saved.revision_digest});
    }
   }
   else if(mode==='revision'&&values.includes('revise_model')&&!revisionStarted){revisionStarted=true;selected='revise_model';}
   else if(values.includes('finish'))selected='finish';
   else if(choice.title==='SETUP NEEDS ATTENTION'||values.includes('pause'))selected='pause';
   menus.push({...choice,selected,native_stage:saved?.stage});return selected&&values.includes(selected)?selected:undefined;
  }};
 function typedProposal(refs:ReadScopeReference[],catalog:any){
  const original=refs.find(r=>r.kind==='request')!,policy=refs.find(r=>r.kind==='source')!;if(noRead){expect(original.text).toBe(selectedJob);expect(policy.text).toBe(selectedSource);return {protocol:READ_SCOPE_PROTOCOL,applicability:'no_read_requested',original_request:original.id,requirements:[]};}expect(original.text).toContain('parcel labels');expect(policy.text).toContain('All other fields remain private');
  const resource=catalog.resources.find((r:any)=>(r.id??r.name)==='studio.parcels');expect(resource).toBeDefined();const id=resource.id??resource.name;const fieldIds=resource.fields.map((f:any)=>f.id??f.name);expect(fieldIds).toContain('label');
  const answer=refs.filter(r=>r.kind==='answer').at(-1);if(answer)expect(answer.text).toBe(correction);
  const rootTarget={root_resource:id,resource:id,operation:'resource'},shown={...rootTarget,operation:'return',field:'label'};
  return{protocol:READ_SCOPE_PROTOCOL,applicability:'read_requested',original_request:original.id,requirements:[{id:'own-parcel-label',intended_use:'Show only the signed-in customer parcel labels',references:[original.id,policy.id,...(answer?[answer.id]:[])],disposition:'include',subjects:[{root_resource:id,mode:'trusted_principal'}],targets:[rootTarget,shown]},...fieldIds.filter((id:string)=>id!=='label').map((field:string)=>({id:`private-${field}`,intended_use:`Keep ${field} private under the attached only-label policy`,references:[policy.id],disposition:'exclude',subjects:[],targets:[{...rootTarget,operation:'return',field}]}))]};
 }
 const requestJson=async(request:any)=>{
  if(requests.length>=12)throw Error('PUBLIC_B64_FINITE_RESPONDER_LIMIT');const body=request.body,text=modelVisibleUserText(body),names=(body.tools??[]).map((t:any)=>t.name??t.function?.name);let name:string|undefined,args:any,narration:string|undefined;
  if(names.includes('runner__plan_boundary_job')){planning++;name='runner__plan_boundary_job';const visible=modelVisibleJsonLine<any>(body,'Host Read context');args={status:'planned',read_mode:noRead?'none':'create',...(noRead?{}:{read_intent:job}),action_mode:'none',summary:noRead?'No Read or Action authority is requested.':'Prepare own parcel labels only; no Action.',read_scope:typedProposal(visible.references,visible.catalog)};}
  else if(names.includes('runner__submit_read_workloads')){expect(noRead,'No-Read planning must not enter mapping').toBe(false);mapping++;name='runner__submit_read_workloads';const refs=modelVisibleJsonLine<ReadScopeReference[]>(body,'Host scope reference inventory'),catalog=modelVisibleJsonLine<any>(body,'Structural catalog');args={allowed:[{id:'own_parcel_labels',description:'Show signed-in customer parcel labels.',plan:{kind:'rows',resource:'studio.parcels',select:['label'],...(refs.some(r=>r.kind==='answer')?{limit:1}:{})}}],forbidden:[],read_scope:typedProposal(refs,catalog)};}
  else if(names.includes('runner__submit_read_boundary_revision')){
    revisionCalls++; expect(mode).toBe('revision'); expect(text).toContain(revisionInstruction);
    const visible=modelVisibleJsonLine<any>(body,'Host scope inventory');
    expect(visible.catalog.resources.some((r:any)=>r.id==='studio.parcels')).toBe(true);
    name='runner__submit_read_boundary_revision';args={read_scope:typedProposal(visible.references,visible.catalog),
      resource_changes:[{resource:'studio.parcels',settings:{metadata:{label:'Customer parcels'}}}]};
  }
  else if(names.includes('runner__propose_operator_decision')){name='runner__propose_operator_decision';const q=modelVisibleJsonLine<any>(body,'Current question');expect(q.kind).toBe('input_bounds');expect(modelVisibleJsonLine<string>(body,'Complete saved Source text (no truncation)')).toBe(source);args={question_id:q.question_id,revision:q.revision,source_reference:q.source_reference,status:'proposal',disposition:'proposed',value:{kind:'input_bounds',requirements:[]}};}
  else if(names.includes('runner__review_policy_coverage')){name='runner__review_policy_coverage';expect(text).toContain(source);const refs=modelVisibleJsonLine<string[]>(body,'Exact coverage references (select, do not invent paths)');expect(refs).toContain('/read');const current=modelVisibleJsonLine<any>(body,'Current draft (JSON pointer root)'),access=current.runner_evidence.read_access['studio.parcels'];expect(access.customer_scoped_access).toBe(true);expect(access.trusted_principal_field).toBe('principal_id');args={passages:[{start:1,end:1,disposition:'implemented',interpretation:'The current emitted Read access evidence establishes person scope and only parcel labels are selected; all other fields remain private and no Actions exist.',draft_paths:['/runner_evidence/read_access/studio.parcels','/read','/actions']}]};}
  else if(!names.length){const question=text.split('\n').find(line=>line.startsWith('Exact next question: '));narration=question?JSON.parse(question.slice('Exact next question: '.length)):'The proposed Read remains disabled until the operator reviews it.';}
  else throw Error(`PUBLIC_B64_UNDECLARED_MODEL_TOOL:${names.join(',')}`);
  requests.push({names,args,text});return{status:200,body:{output:name?[{type:'function_call',call_id:`public-b64-${requests.length}`,name,arguments:JSON.stringify(args)}]:[{type:'message',content:[{type:'output_text',text:narration}]}]}};
 };
 const outer:any={chooseResource:async()=>{throw Error('NO_MANUAL_BYPASS');},editFieldTiers:async()=>{throw Error('NO_MANUAL_BYPASS');},chooseOption:async(title:string,choices:any[],options:any)=>{failures.push({title,choices,options});return choices.some(c=>c.value==='pause')?'pause':undefined;},rememberDetails:(title:string,details:string[])=>failures.push({title,details}),promptText:async()=>undefined,confirm:async()=>{throw Error('NO_OUTER_CONFIRMATION');}};
 const options:any={startWithAgentJob:true,exitAfterAgentJob:true,modelAuthoringSession:{provider:'openai',model:'independent-public-read',apiKey:'inert-local-only',dependencies:{requestJson}},actionProjectInspector:inspect,boundaryAuthoringChatFactory:(selection:any)=>createBoundaryAuthoringChat({...selection,io,color:false,streamLineDelayMs:0})};
 vi.stubEnv('B64_PUBLIC_READ_URL','postgresql://fictional.invalid/never-opened');const stdout=vi.spyOn(process.stdout,'write').mockReturnValue(true);vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('NO_EXTERNAL_TRANSPORT');});
 let beforeCold:any,afterCold:any;
 try{
  await onboard(['db','--project-root',root,'--from-env','B64_PUBLIC_READ_URL','--schema','studio','--json'],{interactive:false,schemaInspector:inspect});
  // Declared structural fixture origin; no typed proposal or completion is seeded.
  await commitBoundaryResourceReviewMutation(root,await prepareBoundaryResourceReviewMutation(root,{resource_id:'studio.parcels',include:true,tenant_key:'tenant_id',principal_key:'principal_id',selectable_fields:['label'],actor:'declared parcel operator',reason:'Signed-in customers may see only their own parcel labels.'},inspect));
  await boundaryReviewCommand(['--project-root',root,'--confirm','--actor','declared parcel operator','--output',path.join(root,'reviewed-structural-context.json')],inspect,{presentationMode:'conversation',promptText:async()=>undefined,confirm:async(_message,options)=>{expect(options?.context?.length).toBeGreaterThan(0);return true;},chooseResource:async()=>undefined,editFieldTiers:async()=>undefined});
  expect((await loadBoundaryReviewContext(root)).candidate.activation).not.toBe('active');
  await start(['--project-root',root,'--from-env','B64_PUBLIC_READ_URL','--schema','studio','--cli'],{interactive:true,schemaInspector:inspect,runBoundaryReview:(args,inspection)=>boundaryReviewCommand(args,inspection,outer,undefined,options)});
  beforeCold=await resume();expect(sourceConsent).toBe(1);expect(planning).toBe(1);expect(mapping).toBe(noRead?0:1);if(mode!=='revision')expect(decisions).toHaveLength(1);
  const scope=beforeCold.operator_questions.find((q:any)=>q.kind==='read_scope');expect(scope).toBeDefined();
  expect(scope.read_scope.record.proposal.applicability).toBe(noRead?'no_read_requested':'read_requested');
  expect(beforeCold.authority_granted).toBe(false);expect(beforeCold.source_database_changed).toBe(false);
  if(mode==='revision'){
    expect(revisionStarted,JSON.stringify({menus,failures,transcript})).toBe(true);expect(revisionGiven).toBe(true);expect(revisionCalls).toBe(1);
    const saved=await loadBoundaryReviewContext(root),resource=saved.candidate.pack.resources.find((r:any)=>r.id==='studio.parcels');
    expect(resource?.label).toBe('Customer parcels');expect(resource?.selectable_fields).toEqual(['label']);
    expect(resource?.principal_key).toBe('principal_id');expect(resource?.tenant_key).toBe('tenant_id');
    expect(beforeCold.authority_granted).toBe(false);expect(beforeCold.source_database_changed).toBe(false);
    cold=true;const count=requests.length;await boundaryReviewCommand(['--project-root',root,'--access','--job-first'],inspect,outer,undefined,options);
    expect(requests).toHaveLength(count);expect((await loadBoundaryReviewContext(root)).candidate.pack.resources.find((r:any)=>r.id==='studio.parcels')?.label).toBe('Customer parcels');
  }
  else if(mode==='no_read_yes'){expect(scope.confirmation).toBeDefined();expect(scope.read_scope.record.analysis_digest).toBeUndefined();expect(beforeCold.read).toBeUndefined();}
  else if(mode==='stale'){
   expect(scope.confirmation).toBeUndefined();expect(winningAmendment).toBeDefined();expect(beforeCold.revision_digest).toBe(winningAmendment.revision_digest);expect(beforeCold.pending_job_revision).toBe(amendment);
   expect(beforeCold.operator_questions).toEqual(winningAmendment.operator_questions);expect(beforeCold.generation_recovery).toEqual(winningAmendment.generation_recovery);
   expect(JSON.stringify(failures)).toMatch(/BOUNDARY_AUTHORING_RESUME_CHANGED|READ_SCOPE_REVIEW_CHANGED/);
  }else {expect(scope.confirmation).toBeUndefined();expect(scope.disposition?.kind??scope.disposition).toBe('declined');}
  if(mode==='review'){
   cold=true;await boundaryReviewCommand(['--project-root',root,'--access','--job-first'],inspect,outer,undefined,options);afterCold=await resume();
   expect(menus.some(m=>m.title==='READ SCOPE IS STILL PENDING'&&m.selected==='review'),'Saved declined scope must offer exact Review').toBe(true);
   expect(planning).toBe(1);expect(mapping).toBe(1);expect(decisions).toHaveLength(2);
   const reviewed=afterCold.operator_questions.find((q:any)=>q.id===scope.id);expect(reviewed.revision).toBe(scope.revision);expect(reviewed.confirmation).toBeDefined();
   expect(reviewed.disposition_history).toEqual(expect.arrayContaining(scope.disposition_history));expect(afterCold.read.scope_question_id).toBe(scope.id);
   const saved=await loadBoundaryReviewContext(root);expect(saved.candidate.pack.resources.find((r:any)=>r.id==='studio.parcels')?.selectable_fields).toEqual(['label']);expect(afterCold.authority_granted).toBe(false);expect(afterCold.source_database_changed).toBe(false);
  }
  if(mode.startsWith('replace')){
   cold=true;await boundaryReviewCommand(['--project-root',root,'--access','--job-first'],inspect,outer,undefined,options);afterCold=await resume();
   expect(menus.some(m=>m.title==='READ SCOPE IS STILL PENDING'&&m.selected==='replace')).toBe(true);
   expect(rawPrompts,'Actual public Replace must ask for the operator correction').toBe(1);expect(planning).toBe(1);
   const retained=afterCold.operator_questions.find((q:any)=>q.id===scope.id);
   expect(retained.read_scope).toEqual(scope.read_scope);expect(retained.confirmation).toBeUndefined();
   expect(retained.disposition_history).toEqual(expect.arrayContaining(scope.disposition_history));
   const raw=afterCold.operator_questions.find((q:any)=>q.read_scope?.mode==='replacement_answer');expect(raw).toBeDefined();expect(raw.confirmation).toBeUndefined();
   if(mode==='replace'){
     expect(raw.raw_answer.text).toBe(correction);expect(mapping).toBe(2);expect(decisions).toHaveLength(2);
     const latest=afterCold.operator_questions.at(-1);expect(latest.read_scope.mode).toBe('review');expect(latest.read_scope.predecessor_id).toBe(scope.id);expect(latest.confirmation).toBeDefined();expect(afterCold.read.scope_question_id).toBe(latest.id);
     expect(latest.read_scope.record.references.some((r:any)=>r.kind==='answer'&&r.question_id===raw.id&&r.text===correction)).toBe(true);
     expect(afterCold.read.assistance_history.state.call_count).toBe(2);
     const count=requests.length;await boundaryReviewCommand(['--project-root',root,'--access','--job-first'],inspect,outer,undefined,options);const reopened=await resume();expect(requests).toHaveLength(count);expect(reopened.operator_questions).toEqual(afterCold.operator_questions);expect(reopened.read.scope_question_id).toBe(latest.id);
   } else {
     expect(mapping).toBe(1);expect(decisions).toHaveLength(1);if(firstBlank)expect(raw.raw_answer.text).toBe('');else expect(raw.raw_answer).toBeUndefined();
     if(mode==='replace_cancel')expect(raw.disposition).toBe(firstBlank?'unknown':'cancelled');
     if(mode==='replace_stale'){expect(afterCold.revision_digest).toBe(winningAmendment.revision_digest);expect(afterCold.pending_job_revision).toBe(amendment);expect(afterCold.operator_questions).toEqual(winningAmendment.operator_questions);expect(afterCold.generation_recovery).toEqual(winningAmendment.generation_recovery);}
   }
   expect(afterCold.authority_granted).toBe(false);expect(afterCold.source_database_changed).toBe(false);
   if(continueAfterCancel){
     expect(mode).toBe('replace_cancel');const cancelled=structuredClone(afterCold);
     await boundaryReviewCommand(['--project-root',root,'--access','--job-first'],inspect,outer,undefined,options);
     const resumed=await resume();expect(rawPrompts,'Cancelled public correction must be answerable on ordinary Resume').toBe(2);
     expect(planning).toBe(1);expect(mapping).toBe(2);expect(decisions).toHaveLength(2);
     const answered=resumed.operator_questions.find((q:any)=>q.read_scope?.mode==='replacement_answer'&&q.raw_answer?.text===correction);expect(answered).toBeDefined();expect(answered.confirmation).toBeUndefined();
     const latest=resumed.operator_questions.at(-1);expect(latest.read_scope.mode).toBe('review');expect(latest.confirmation).toBeDefined();expect(resumed.read.scope_question_id).toBe(latest.id);expect(resumed.read.assistance_history.state.call_count).toBe(2);
     const original=resumed.operator_questions.find((q:any)=>q.id===scope.id);expect(original.read_scope).toEqual(scope.read_scope);expect(original.confirmation).toBeUndefined();
     if(firstBlank){expect(resumed.operator_questions.find((q:any)=>q.id===raw.id)).toEqual(raw);expect(answered.id).not.toBe(raw.id);expect(answered.revision).toBe(raw.revision+1);expect(answered.read_scope.predecessor_id).toBe(raw.id);}
     expect(resumed.operator_questions.find((q:any)=>q.id===raw.id)?.disposition_history).toEqual(expect.arrayContaining(cancelled.operator_questions.find((q:any)=>q.id===raw.id).disposition_history));
     expect(resumed.authority_granted).toBe(false);expect(resumed.source_database_changed).toBe(false);
   }
  }
 }finally{
  const capture=process.env.B51_READ_PROCESS_CAPTURE_DIR;if(capture){await fs.mkdir(capture,{recursive:true});await fs.writeFile(path.join(capture,`PUBLIC-READ-${mode}${continueAfterCancel?"-resumed":""}${firstBlank?"-blank":""}.json`),JSON.stringify({root,job:selectedJob,source:selectedSource,mode,transcript,menus,requests,failures,reads,decisions,sourceConsent,planning,mapping,revisionCalls,revisionStarted,revisionGiven,rawPrompts,correction,beforeCold,afterCold,finalResume:await resume(),stdout:stdout.mock.calls.map(x=>String(x[0])).join(''),limits:'Actual public command+B48 IO; supplied synthetic schema metadata. No DB query, model provider egress, activation or public PASS unless complete assertions pass.'},null,2));}
 }
}
it.each<Mode>(['replace','replace_cancel','replace_stale'])('public B64 %s retains exact scope without retired English calls',mode=>runVariant(mode),30000);

it('independent public cancelled correction resumes to a real answer and separate review',()=>runVariant('replace_cancel',true),30000);

it('independent public blank correction resumes without losing original raw history',()=>runVariant('replace_cancel',true,true),30000);

it('public typed Read revision and cold Resume never call retired English owners',()=>runVariant('revision'),30000);
