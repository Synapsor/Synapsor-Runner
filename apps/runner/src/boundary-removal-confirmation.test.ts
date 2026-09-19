import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { boundaryCommand } from './guided-start.js';
import { boundaryReviewCommand, boundaryAuthoringResumeBinding } from './boundary-commands.js';
import { loadBoundaryReviewContext } from './boundary-commands.js';
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState } from './boundary-authoring-resume.js';
import { prepareBoundaryResourceReviewMutation, commitBoundaryResourceReviewMutation, prepareBoundaryReviewMutationBatch } from './boundary-review-mutation.js';
import type { BoundaryReviewInteractiveSession } from './boundary-cli-picker.js';

const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const r of roots.splice(0))await fs.rm(r,{recursive:true,force:true});});
async function fixture(pending=true){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'resource-removal-confirm-'));roots.push(root);
  const inspection=JSON.parse(await fs.readFile(new URL('./__fixtures__/scoped-read-recovery/refunds.json',import.meta.url),'utf8'));
  let output='';vi.spyOn(process.stdout,'write').mockImplementation(chunk=>{output+=String(chunk);return true;});
  await boundaryCommand(['draft','--project-root',root,'--schema','refunds','--from-env','DATABASE_URL','--json'],async()=>inspection);
  await commitBoundaryResourceReviewMutation(root,await prepareBoundaryResourceReviewMutation(root,{resource_id:'refunds.customers',include:true,actor:'owner',reason:'Retain required catalog resource.'},async()=>inspection));
  const before=await loadBoundaryReviewContext(root);const binding=boundaryAuthoringResumeBinding(before.bundle);
  if(pending)await writeBoundaryAuthoringResumeState(root,buildBoundaryAuthoringResumeState({binding,stage:'read_mapping',jobIntent:'Keep the original policy and unresolved relationship.',provider:'openai',model:'synthetic',pendingReadRelationship:{resource:'refunds.refund_requests'}}));
  return {root,inspection,before,binding,output:()=>output};
}
it.each([false,undefined,true])('requires explicit disabled removal confirmation and preserves pending work: %s',async answer=>{
  const f=await fixture();const state=await readBoundaryAuthoringResumeState(f.root,f.binding);let step=0;
  const confirm=vi.fn<BoundaryReviewInteractiveSession["confirm"]>(async(_prompt,options)=>{
    expect(options?.defaultValue).toBe(false);
    expect(options?.context?.join('\n')).toContain('Dependency impact: unknown');
    expect(options?.context?.join('\n')).toContain('private verification');
    expect(options?.context?.join('\n')).toContain('pending');
    expect(options?.context?.join('\n')).toContain('refunds.customers');
    expect((await loadBoundaryReviewContext(f.root)).candidate).toEqual(f.before.candidate);
    return answer;
  });
  const session:BoundaryReviewInteractiveSession={chooseResource:async()=>step++===0?{resource_id:'refunds.customers',action:'remove'}:undefined,
    editFieldTiers:async()=>undefined,promptText:async()=>undefined,confirm};
  expect(await boundaryReviewCommand(['--project-root',f.root,'--access'],async()=>f.inspection,session)).toBe(0);
  expect(confirm).toHaveBeenCalledOnce();
  expect((await loadBoundaryReviewContext(f.root)).candidate.pack.resources.some(r=>r.id==='refunds.customers')).toBe(answer!==true);
  expect(await readBoundaryAuthoringResumeState(f.root,f.binding)).toEqual(state);
  if(answer===true){expect(f.output()).toContain('incomplete');expect(f.output()).not.toContain('Next: review and activate the complete boundary');}
  // Restarting the editor alone does not repeat the acknowledged removal.
  await boundaryReviewCommand(['--project-root',f.root,'--access'],async()=>f.inspection,{...session,chooseResource:async()=>undefined});
  expect(confirm).toHaveBeenCalledOnce();
},20000);
it('refuses a removal if the exact candidate changes during confirmation',async()=>{
  const f=await fixture();let step=0;
  const session:BoundaryReviewInteractiveSession={chooseResource:async()=>step++===0?{resource_id:'refunds.customers',action:'remove'}:undefined,
    editFieldTiers:async()=>undefined,promptText:async()=>undefined,confirm:async()=>{
      await commitBoundaryResourceReviewMutation(f.root,await prepareBoundaryResourceReviewMutation(f.root,{resource_id:'refunds.customers',minimum_cohort_size:4,actor:'other',reason:'Separate concurrent review.'},async()=>f.inspection));return true;
    }};
  await boundaryReviewCommand(['--project-root',f.root,'--access'],async()=>f.inspection,session).catch(()=>undefined);
  const after=await loadBoundaryReviewContext(f.root);expect(after.candidate.pack.resources.find(r=>r.id==='refunds.customers')?.minimum_cohort_size).toBe(4);
},20000);
it('discloses unknown policy dependency impact in single and batch structured previews without claiming none',async()=>{
  const f=await fixture(false);const request={resource_id:'refunds.customers',exclude:true,actor:'owner',reason:'Remove an optional catalog selection.'};
  const single=await prepareBoundaryResourceReviewMutation(f.root,request,async()=>f.inspection);
  const batch=await prepareBoundaryReviewMutationBatch(f.root,[request],async()=>f.inspection);
  expect(single.resource_removal_impact).toMatchObject({requirement_impact:'unknown',job_status:'unknown',availability_removed:['public_read','private_verification']});
  expect(batch).toMatchObject({resource_removal_impacts:[single.resource_removal_impact]});
  expect((await loadBoundaryReviewContext(f.root)).candidate).toEqual(f.before.candidate);
},20000);
