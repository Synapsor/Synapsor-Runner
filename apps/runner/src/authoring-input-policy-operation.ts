import {canonicalJsonDigest} from '@synapsor-runner/protocol';
import {activePolicySource,loadPolicySources,policySourceSavedDigest,savePolicySources,type PolicySourceSession} from './authoring-policy-source.js';
import {makeSourceInputReview,assertSourceInputReviews,type SourceInputRequirement} from './authoring-input-policy.js';
import type {BoundaryReviewInteractiveSession} from './boundary-cli-picker.js';
import {withProjectAuthorityMutation,type ProjectAuthorityMutationPermit} from './project-authority-mutation.js';

/** Local meaning review, stored with the existing source session and CAS. Never
 * derives English meaning, modifies a draft, or treats a model as the operator. */
export async function reviewSourceInputPolicy(input:{projectRoot:string;sources:PolicySourceSession;session:BoundaryReviewInteractiveSession;
  outcomes:string[];store:string;actor:string;assertCurrent:(permit?:ProjectAuthorityMutationPermit)=>Promise<void>}) {
 const source=activePolicySource(input.sources);if(!source)return;
 assertSourceInputReviews(input.sources.input_policy_reviews);
 const expected=await policySourceSavedDigest(input.projectRoot,input.sources.id);
 if(canonicalJsonDigest(await loadPolicySources(input.projectRoot,input.sources.id))!==canonicalJsonDigest(input.sources))throw new Error('POLICY_SOURCE_CHANGED: Reopen the current source before reviewing input requirements.');
 await input.assertCurrent();
 const current=input.sources.input_policy_reviews?.at(-1);
 if(current?.source_digest===source.digest&&current.store_digest===input.store&&current.source_session===input.sources.id
   &&current.decision==='confirmed'&&input.outcomes.every(o=>current.outcomes.includes(o)))return;

 const context=[`Current policy: ${source.name}. Review exact input requirements for this intended inventory; this is operator interpretation only, not whole-policy validation.`,
  ...source.text.split(/\r\n|\r|\n/u).map((line,i)=>`${i+1}: ${line}`),...input.outcomes.map((o,i)=>`${i+1}. ${o}`),
  'Required presence alone does not mean nonempty. Lengths use UTF-16 units; no trim or implicit whitespace ban.'];
 const choice=await input.session.chooseOption?.('REVIEW DECLARED TEXT INPUT BOUNDS',[
  {value:'pending',label:'Keep pending; do not draft under an unknown input contract'},
  {value:'register',label:'Record exact source-required input ranges'},
  {value:'none',label:'Confirm no explicit string range requirement in this source for these Actions'},
 ],{initialValue:'pending',reviewOnly:true,displayContext:true,context});
 if(!choice||choice==='pending')throw new Error('SOURCE_INPUT_REQUIREMENT_PENDING: Review the attached source input requirements locally before continuing this program.');
 const requirements:SourceInputRequirement[]=[];
 // These finite record fields are saved together below, not as free-form policy overrides.
 if(choice==='register'){
  for(let n=0;n<256;n++){
   const names=(await input.session.promptText('Exact Action numbers for this requirement (comma-separated; no wildcard)',{context,recordPolicyAnswer:false}))??'';
   if(!/^\d+(?:\s*,\s*\d+)*$/u.test(names.trim()))throw new Error('SOURCE_INPUT_REQUIREMENT_PENDING: No interpretation saved.');
   const selected=names.split(',').map(x=>input.outcomes[Number(x.trim())-1]);
   if(selected.some(x=>!x)||new Set(selected).size!==selected.length)throw new Error('SOURCE_INPUT_REVIEW_INVALID: Select distinct current Actions.');
   const field=((await input.session.promptText('Exact caller input name stated by the policy',{context,recordPolicyAnswer:false}))??'').trim();
   const bounds=((await input.session.promptText('Explicit minimum and maximum UTF-16 length (for example 1..64)',{context,recordPolicyAnswer:false}))??'').trim();
   const lines=((await input.session.promptText('Exact supporting policy line or range (for example 4-16)',{context,recordPolicyAnswer:false}))??'').trim();
   const b=/^(\d+)\.\.(\d+)$/u.exec(bounds),l=/^(\d+)(?:-(\d+))?$/u.exec(lines);
   if(!b||!l)throw new Error('SOURCE_INPUT_REVIEW_INVALID: Use exact finite bounds and source lines.');
   requirements.push({outcomes:selected as string[],input:field,min_length:Number(b[1]),max_length:Number(b[2]),start:Number(l[1]),end:Number(l[2]??l[1])});
   if(!await input.session.confirm('Register another distinct input requirement?',{defaultValue:false,context:['These choices are not saved yet.']}))break;
  }
 }else if(choice!=='none')throw new Error('SOURCE_INPUT_REVIEW_INVALID: No interpretation saved.');
 const record=makeSourceInputReview({source,session:input.sources,store:input.store,outcomes:input.outcomes,requirements,actor:input.actor});
 const detail=[...context,...requirements.map(q=>`${q.outcomes.join(', ')} / ${q.input}: present string ${q.min_length}..${q.max_length}; source lines ${q.start}-${q.end}`),
  'Unlisted source duties are still subject to complete review. This grants no authority and certifies no implementation.'];
 if(!await input.session.confirm('Save this exact attributed input-policy interpretation?',{defaultValue:false,context:detail}))throw new Error('SOURCE_INPUT_REQUIREMENT_PENDING: Interpretation not saved.');
 const staged=structuredClone(input.sources);staged.input_policy_reviews=[...(staged.input_policy_reviews??[]),record];
 await withProjectAuthorityMutation(input.projectRoot,async permit=>{
  await input.assertCurrent(permit);
  if(activePolicySource(input.sources)?.digest!==source.digest)throw new Error('POLICY_SOURCE_CHANGED: The policy changed while awaiting confirmation.');
  await savePolicySources(input.projectRoot,staged,{expectedDigest:expected,permit});
 });
 Object.assign(input.sources,staged);
}
