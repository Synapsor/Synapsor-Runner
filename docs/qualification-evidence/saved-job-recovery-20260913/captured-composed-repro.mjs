import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createModelAuthoringConversation, rememberModelAuthoringTurn } from '../../../apps/runner/src/model-authoring-conversation.ts';
import * as current from '../../../apps/runner/src/boundary-authoring-resume.ts';
const E=path.dirname(new URL(import.meta.url).pathname), P=JSON.parse(await fs.readFile(path.join(E,'assignment-plan.json'),'utf8')), O=P.owned_root;
const captured=JSON.parse(await fs.readFile(path.join(O,'captured-resume-input.json'),'utf8'));
const source=path.resolve('apps/runner/src'), B=path.join(O,'baseline-resume-source'); await fs.mkdir(B,{recursive:true});
for (const name of await fs.readdir(source)) if (name !== 'boundary-authoring-resume.ts') await fs.symlink(path.join(source,name),path.join(B,name)).catch(e=>{if(e.code!=='EEXIST')throw e;});
await fs.unlink(path.join(B,'node_modules')).catch(e=>{if(e.code!=='ENOENT')throw e;});
await fs.symlink(path.resolve('node_modules'),path.join(B,'node_modules'));
await fs.writeFile(path.join(B,'package.json'),JSON.stringify({type:'module'}));
await fs.writeFile(path.join(B,'boundary-authoring-resume.ts'),execFileSync('git',['show',`${P.baseline}:apps/runner/src/boundary-authoring-resume.ts`]));
const baseline=await import(pathToFileURL(path.join(B,'boundary-authoring-resume.ts')).href);
const original=await import(pathToFileURL(path.join(O,'original-literal-guard.mjs')).href);
const c=captured.checkpoint, conversation=createModelAuthoringConversation(c.conversation);
rememberModelAuthoringTurn(conversation,c.pending_action_revision.instruction,captured.answer);
const input={binding:c.binding,stage:c.stage,jobIntent:c.job_intent,provider:c.model.provider,model:c.model.name,
 conversation:conversation.turns,previous:c,now:c.updated_at,
 ...Object.fromEntries(Object.entries({policySourceSession:'policy_source_session',readIntent:'read_intent',read:'read',action:'action',pendingActionRevision:'pending_action_revision',
 pendingActionAddition:'pending_action_addition',pendingActionRemoval:'pending_action_removal',pendingJobRevision:'pending_job_revision',pendingReadRevision:'pending_read_revision',
 reviewedVersionFields:'reviewed_version_fields',readPrerequisiteDecisions:'read_prerequisite_decisions',privateReadMetadataDigest:'private_read_metadata_digest',
 metadataDestinationDigest:'metadata_destination_digest',intendedClient:'intended_client',clientHandoff:'client_handoff'}).filter(([,key])=>c[key]!==undefined).map(([key,old])=>[key,c[old]]))};
const results={baseline_revision:P.baseline,candidate_input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),historical:[],baseline:null,current:null};
const variants=[c.conversation.find(t=>t.answer.includes('Each tenant is exactly one league'))?.answer,
 'Before fixing the validation error, answer one question exactly. In the reviewed scope right now, which column is bound as the tenant - carrier_id or account_id? And is that 10-per-24-hours cap counted per carrier organisation or per customer account? If the tenant is bound to account_id then the cap is per account, which is not what I required.',captured.answer];
for(const text of variants){if(!text)throw Error('missing historical phrase'); try{original.assertBoundaryAuthoringResumeMaterial({conversation:[{answer:text}]});results.historical.push({text,accepted:true});}catch(e){results.historical.push({text,accepted:false,error:e.message});}}
try{baseline.buildBoundaryAuthoringResumeState(input);results.baseline={accepted:true};}catch(e){results.baseline={accepted:false,error:e.message};}
const next=current.buildBoundaryAuthoringResumeState(input), root=path.join(O,'captured-composed-checkpoint');await fs.mkdir(root,{recursive:true});
await current.writeBoundaryAuthoringResumeState(root,next);
const reopened=await current.readBoundaryAuthoringResumeState(root,c.binding);
if(reopened.status!=='ready'||JSON.stringify(reopened.value)!==JSON.stringify(next))throw Error('whole checkpoint changed on restart');
results.current={accepted:true,revision_digest:next.revision_digest,full_checkpoint_path:path.join(root,'.synapsor/boundary-authoring/resume.json'),all_carried_fields_retained:true};
if(results.baseline.accepted || results.historical.some(x=>x.accepted))throw Error('expected before failures absent');
await fs.writeFile(path.join(E,'captured-composed-result.json'),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify({baseline:results.baseline,current:results.current,historical_failures:results.historical.length}));
