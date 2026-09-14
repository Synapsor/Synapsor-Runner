import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { parsePolicyCoverage, reviewPolicyCoverage } from '../../../apps/runner/src/authoring-policy-coverage.js';
import { bindPolicyCoverage, savePolicySources, loadPolicySources } from '../../../apps/runner/src/authoring-policy-source.js';
import { createModelAuthoringConversation } from '../../../apps/runner/src/model-authoring-conversation.js';
import { policyReviewReadiness } from '../../../apps/runner/src/authoring-review-readiness.js';
const fixture=JSON.parse(await fs.readFile(new URL('../../../apps/runner/src/fixtures/counting-recheck-review.json',import.meta.url),'utf8'));
for (const [index, reply] of fixture.replies.entries()) {
const root=await fs.mkdtemp(path.join(os.tmpdir(),'counting-addition-replay-'));
try {
 const conversation=createModelAuthoringConversation(); conversation.policySources=structuredClone(fixture.policy_sources);let calls=0;
 let result:any;
 try {
  const report=await reviewPolicyCoverage({source:fixture.source,draft:fixture.draft,env:{OPENAI_API_KEY:'captured-test-only'},session:{provider:'openai',model:'gpt-5.6-terra',conversation,dependencies:{requestJson:async()=>{calls++;return {status:200,body:{output:[{type:'function_call',name:'runner__review_policy_coverage',call_id:'exact16',arguments:JSON.stringify(reply)}]}};}}}});
  const state=structuredClone(fixture.policy_sources);bindPolicyCoverage(state,report,state.coverage_authority_digest);await savePolicySources(root,state,{expectedDigest:null});const saved=await loadPolicySources(root,state.id);const rechecked=parsePolicyCoverage({passages:saved.coverage!.passages},fixture.source,fixture.draft,state.operator_messages);assert.deepEqual(rechecked.passages.map(p=>p.counter_requirements),report.passages.map(p=>p.counter_requirements));assert.deepEqual(saved.coverage,report);
  result={accepted:true,persisted:true,counter_passage:report.passages.find(p=>p.counter_requirements?.length),readiness:policyReviewReadiness(fixture.source,report,state)};
 } catch(e){result={accepted:false,error:String(e)};}
 console.log(JSON.stringify({exact_reply:13+index,provider_transports:0,captured_producer_calls:calls,classification:'composed exact-response replay in disposable source-session store; no publication',...result},null,2));
} finally {await fs.rm(root,{recursive:true,force:true});}

}
