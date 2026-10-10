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
  const session:BoundaryReviewInteractiveSession={promptText:async()=>'',chooseOption:async(_title,options)=>options.find(option=>option.value==='none')?.value,confirm:async()=>true};
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
