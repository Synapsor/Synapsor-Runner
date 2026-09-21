// Evidence export of the existing local-transport regression. No external provider.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { secureAskJsonRequest } from '../../../apps/runner/src/model-ask.ts';
import { reviewPolicyCoverage } from '../../../apps/runner/src/authoring-policy-coverage.ts';
import { authoringDestination } from '../../../apps/runner/src/authoring-policy-source.ts';
import { createModelAuthoringConversation } from '../../../apps/runner/src/model-authoring-conversation.ts';
import { RECEIPT_PATH } from '../../../apps/runner/src/authoring-obligation-review.ts';
const input=JSON.parse(await fs.readFile(new URL('../../../apps/runner/src/test-fixtures/receipt-review-association.json',import.meta.url),'utf8'));
const root='/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-review-5d92ca5-20260920/local-wire';
await fs.mkdir(root);
for(const provider of ['openai','openrouter'] as const){
 const f=structuredClone(input.A),conversation=createModelAuthoringConversation();conversation.policySources=f.sources;
 const corrected=structuredClone(f.arguments),p=corrected.passages[14];
 p.draft_paths=p.draft_paths.filter((v:string)=>v!==RECEIPT_PATH);
 corrected.passages.push({start:p.start,end:p.end,disposition:'needs_decision',responsibility:'deployment',issue_kind:'missing_configuration',draft_paths:[RECEIPT_PATH],interpretation:'The required Runner-ledger guarantee is supported. Receipt setup remains pending and no receipt or source readback is established.',topic:'Receipt setup',next_step:'Perform separate reviewed setup after authority review.'});
 const wire:any[]=[],events:any[]=[];
 const server=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));wire.push(JSON.parse(Buffer.concat(chunks).toString()));
  const args=wire.length===1?f.arguments:corrected;res.setHeader('content-type','text/event-stream');
  if(provider==='openai'){
   res.write(`data: ${JSON.stringify({type:'response.output_item.added',item:{type:'function_call',name:'runner__review_policy_coverage'}})}\n\n`);
   res.end(`data: ${JSON.stringify({type:'response.completed',response:{status:'completed',output:[{type:'function_call',name:'runner__review_policy_coverage',call_id:'wire',arguments:JSON.stringify(args)}]}})}\n\n`);
  }else{
   res.write(`data: ${JSON.stringify({choices:[{delta:{reasoning_details:[{type:'reasoning.encrypted',data:'opaque-test-continuation',index:0}],tool_calls:[{index:0,id:'wire',type:'function',function:{name:'runner__review_policy_coverage',arguments:JSON.stringify(args)}}]}}]})}\n\n`);
   res.end(`data: ${JSON.stringify({choices:[{delta:{},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`);
  }
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();assert(address&&typeof address!=='string');
  const session={provider,model:provider==='openrouter'?'openai/gpt-5.6-terra':'gpt-5.6-terra',apiKey:'synthetic-local-only',conversation,dependencies:{requestJson:(r:any)=>secureAskJsonRequest({...r,headers:{},endpoint:new URL(`http://127.0.0.1:${address.port}/test`),scope:'custom_loopback'}),onStream:(e:any)=>events.push(e)}};
  f.sources.approvals.push({digest:f.source.digest,destination:authoringDestination(session)});
  const report=await reviewPolicyCoverage({session,source:f.source,draft:f.draft});
  assert.equal(wire.length,2);const correction=JSON.stringify(wire[1]);
  assert(correction.includes('OBLIGATION_OBSERVATION_UNESTABLISHED')&&correction.includes('Separate the compiled capability claim'));
  assert(!correction.includes('opaque-test-continuation')&&!JSON.stringify(events).includes('opaque-test-continuation'));
  const pending=report.passages.find(p=>p.obligation_assessment?.family==='receipt_setup');assert(pending&&pending.obligation_assessment?.verified===false);
  for(let i=0;i<wire.length;i++)await fs.writeFile(`${root}/${provider}-request-${i+1}.json`,JSON.stringify(wire[i],null,2)+'\n',{flag:'wx'});
  await fs.writeFile(`${root}/${provider}-result.json`,JSON.stringify({classification:'Zero-provider loopback export of existing regression; original A reply then explicitly DERIVED controlled replacement; no saved-job/store mutation',requests:wire.length,correction_delivered:true,private_continuation_disclosed:false,receipt_component:pending},null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({provider,local_requests:wire.length,external_provider_calls:0,correction_delivered:true,pending_unverified:true}));
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
