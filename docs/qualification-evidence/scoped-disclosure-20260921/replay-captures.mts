// Read-only capture replay plus disposable canonical coverage persistence.
// No provider, source connection, authority injection or historical queue execution.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parsePolicyCoverage} from '../../../apps/runner/src/authoring-policy-coverage.js';
import {policyReviewReadiness} from '../../../apps/runner/src/authoring-review-readiness.js';
import {activePolicySource,bindPolicyCoverage,savePolicySources,loadPolicySources} from '../../../apps/runner/src/authoring-policy-source.js';
process.umask(0o077);
const [output, mainRoot, testerRoot]=process.argv.slice(2);
if(!output||!mainRoot||!testerRoot) throw Error('Usage: replay-captures.mts NEW_OUTPUT_DIRECTORY MAIN_ROOT TESTER_ROOT');
await fs.mkdir(output,{mode:0o700}); // EEXIST is intentional; never overwrite evidence.
const hash=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex');
const session='e631e9a6-e7d6-4428-a423-be36465405f7';
const results=[];
for(const [lane,root,prefix] of [['main',mainRoot,'MAIN-A-REVIEW-1'],['tester',testerRoot,'TESTER-A-REVIEW-1']]) {
 const requestFile=path.join(root,'authoring-meter',prefix+'-request.json');
 const responseFile=path.join(root,'authoring-meter',prefix+'-response.txt');
 const requestBytes=await fs.readFile(requestFile),responseBytes=await fs.readFile(responseFile);
 const request=JSON.parse(requestBytes.toString());
 const line=request.messages.at(-1).content.split('\n').find((l:string)=>l.startsWith('Current draft (JSON pointer root): '));
 const draft=JSON.parse(line.slice('Current draft (JSON pointer root): '.length));
 const calls=new Map<number,{name:string;arguments:string}>();
 // Deliberately read only tool-call deltas; do not expose reasoning continuation.
 for(const line of responseBytes.toString().split('\n')) {
  if(!line.startsWith('data: ')||line.slice(6).trim()==='[DONE]')continue;
  const event=JSON.parse(line.slice(6));
  for(const choice of event.choices??[])for(const call of choice.delta?.tool_calls??[]) {
   const value=calls.get(call.index)??{name:'',arguments:''};
   value.name+=call.function?.name??'';value.arguments+=call.function?.arguments??'';calls.set(call.index,value);
  }
 }
 if(calls.size!==1||calls.get(0)?.name!=='runner__review_policy_coverage')throw Error('Unexpected captured complete review call');
 const args=JSON.parse(calls.get(0)!.arguments);
 const sourceFile=path.join(root,'project/.synapsor/boundary-authoring/policy-sources',session+'.json');
 const sourceBytes=await fs.readFile(sourceFile),sources=JSON.parse(sourceBytes.toString());
 const source=activePolicySource(sources)!;
 const report=parsePolicyCoverage(args,source,draft,sources.operator_messages??[]);
 const before=policyReviewReadiness(source,report,sources);
 const owned=path.join(output,lane);await fs.mkdir(owned,{mode:0o700});
 bindPolicyCoverage(sources,report,sources.coverage_authority_digest);
 await savePolicySources(owned,sources);
 const reopened=await loadPolicySources(owned,session);
 const parsedAgain=parsePolicyCoverage({passages:reopened.coverage!.passages},source,draft,reopened.operator_messages??[]);
 const after=policyReviewReadiness(source,parsedAgain,reopened);
 results.push({lane,request:{path:requestFile,sha256:hash(requestBytes)},response:{path:responseFile,sha256:hash(responseBytes)},
  source_record:{path:sourceFile,sha256:hash(sourceBytes)},
  raw_response_unchanged:true,provider_calls:0,readiness_before_save:before.ready,readiness_after_reload:after.ready,
  blockers:after.items?.filter(x=>x.blocksReview).map(x=>({title:x.title,next_step:x.nextStep})),
  historical_input_unchanged:hash(await fs.readFile(sourceFile))===hash(sourceBytes),
  scope:'Exact complete captured arguments through current parser, canonical coverage bind/save/load and readiness; synthetic disposable review-record storage only. Not a new installed/operator/model episode; no live source/store/authority path.'});
}
if(results[0].request.sha256!==results[1].request.sha256)throw Error('Prepared contexts diverged');
if(results[0].readiness_after_reload!==true||results[1].readiness_after_reload!==false)throw Error('Historical divergence not reproduced');
await fs.writeFile(path.join(output,'RESULT.json'),JSON.stringify({at:new Date().toISOString(),status:'KNOWN OMISSION DISCREPANCY REPRODUCED, NOT REPAIRED',results},null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(results.map(({lane,readiness_after_reload,blockers})=>({lane,readiness_after_reload,blockers}))));
