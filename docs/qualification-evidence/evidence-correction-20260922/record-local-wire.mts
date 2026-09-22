// Evidence export of the existing local-transport regression. No external provider.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { secureAskJsonRequest } from '../../../apps/runner/src/model-ask.ts';
import { reviewPolicyCoverage } from '../../../apps/runner/src/authoring-policy-coverage.ts';
import { authoringDestination } from '../../../apps/runner/src/authoring-policy-source.ts';
import { createModelAuthoringConversation } from '../../../apps/runner/src/model-authoring-conversation.ts';
const input=JSON.parse(await fs.readFile(new URL('../../../apps/runner/src/test-fixtures/evidence-aware-correction.json',import.meta.url),'utf8'));
const root='/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/evidence-correction-f0a6fd1-20260922/'+(process.argv.includes('--final')?'local-wire-final':'local-wire');
await fs.mkdir(root);
for(const provider of ['openai','openrouter'] as const){
 const f=structuredClone(input),conversation=createModelAuthoringConversation();conversation.policySources=f.sources;
 const corrected=structuredClone(f.arguments),READ='/runner_evidence/runtime_contract/receipt_read_exclusion',CONFIG='/runner_evidence/runtime_contract/receipt_configuration';
 for(const p of corrected.passages)for(const c of p.counter_requirements??[])delete c.operator_message_id;
 const i=corrected.passages.findIndex((p:any)=>p.draft_paths.includes(READ)),p=corrected.passages[i];
 corrected.passages.splice(i,1,
  {...p,topic:'Compiled effect',interpretation:'The compiled effect has the listed atomic transaction capability, not an observed execution.',draft_paths:p.draft_paths.filter((x:string)=>x!==READ&&x!==CONFIG)},
  {...p,topic:'Configured receipt mode',interpretation:'Current configuration selects the required mode. Provisioning, an actual receipt and independent readback are not established by this claim.',draft_paths:[CONFIG]},
  {...p,topic:'Receipt Read exclusion',interpretation:'The configured receipt destination is excluded from the exact selected Read graph according to current host evidence.',draft_paths:[READ]});
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
  assert(correction.includes('RECEIPT_READ_EXCLUSION_UNESTABLISHED')&&correction.includes('separately supported claims')&&correction.includes('omit the OPTIONAL counter operator_message_id'));
  assert(!correction.includes('opaque-test-continuation')&&!JSON.stringify(events).includes('opaque-test-continuation'));
  const pending=report.passages.filter(p=>p.obligation_assessment);assert(pending.length&&pending.every(p=>p.obligation_assessment!.verified===false));
  const exclusion=report.passages.find(p=>p.draft_paths.length===1&&p.draft_paths[0]===READ);assert(exclusion?.disposition==='implemented');
  for(let i=0;i<wire.length;i++)await fs.writeFile(`${root}/${provider}-request-${i+1}.json`,JSON.stringify(wire[i],null,2)+'\n',{flag:'wx'});
  await fs.writeFile(`${root}/${provider}-DERIVED-replacement.json`,JSON.stringify(corrected,null,2)+'\n',{flag:'wx'});
  await fs.writeFile(`${root}/${provider}-validated-report.json`,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  await fs.writeFile(`${root}/${provider}-result.json`,JSON.stringify({classification:'Zero-provider loopback export; exact original rejected then explicitly DERIVED complete replacement; no original store opened',requests:wire.length,correction_delivered:true,private_continuation_disclosed:false,unverified_duties:pending,exclusion},null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({provider,local_requests:wire.length,external_provider_calls:0,correction_delivered:true,pending_unverified:true}));
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
