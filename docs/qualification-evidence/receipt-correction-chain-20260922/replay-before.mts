import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {collectCoverageFeedback,parsePolicyCoverage,reviewPolicyCoverage} from '../../../apps/runner/src/authoring-policy-coverage.ts';
import {assessReviewObligation} from '../../../apps/runner/src/authoring-obligation-review.ts';
import {createModelAuthoringConversation} from '../../../apps/runner/src/model-authoring-conversation.ts';
const root='/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-correction-chain-2f6c952-20260922';
const records=[];
for (const [name,file] of [['prior','../../../apps/runner/src/test-fixtures/evidence-aware-correction.json'],['latest',root+'/private/latest-review-input.json']]) {
 const f=JSON.parse(await fs.readFile(file.startsWith('/')?file:new URL(file,import.meta.url),'utf8'));
 let refusal='';try{parsePolicyCoverage(f.arguments,f.source,f.draft,f.operator_messages);}catch(e){refusal=(e as Error).message;}
 assert(refusal.startsWith('COUNTING_SUPPORT_MISMATCH:'));
 const feedback=collectCoverageFeedback(f.arguments,f.source,f.draft,f.operator_messages);
 const conversation=createModelAuthoringConversation();conversation.policySources=f.sources;
 const requests:any[]=[];const session={provider:'openrouter' as const,model:'openai/gpt-5.6-terra',apiKey:'local-only',conversation,dependencies:{requestJson:async(r:any)=>{
  requests.push(r.body);return {status:200,body:{choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'local',type:'function',function:{name:'runner__review_policy_coverage',arguments:JSON.stringify(f.arguments)}}]}}]}};
 }}};
 let stopped='';try{await reviewPolicyCoverage({session,source:f.source,draft:f.draft});}catch(e){stopped=(e as Error).message;}
 assert(stopped.includes('POLICY_COVERAGE_INVALID'));assert.equal(requests.length,name==='prior'?2:1);
 let early='';if(name==='latest'){try{assessReviewObligation(f.arguments.passages[25],f.source,f.draft);}catch(e){early=(e as Error).message;}
  assert(early.startsWith('OBLIGATION_CONFIGURATION_COMPONENT_MIXED:'));assert.equal(feedback.findings.at(-1)?.code,'COVERAGE_VALIDATION_INCOMPLETE');}
 await fs.writeFile(root+`/private/${name}-before-wire.json`,JSON.stringify(requests,null,2)+'\n',{flag:'wx'});
 records.push({name,refusal,early,feedback,requests:requests.length,external_calls:0,original_store_opened:false});
}
await fs.writeFile(root+'/BASELINE-REPLAY-001.json',JSON.stringify(records,null,2)+'\n',{flag:'wx'});
console.log(records.map(r=>({name:r.name,requests:r.requests,findings:r.feedback.findings.map(f=>[f.code,f.structural]),early:r.early})));
