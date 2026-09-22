// Evidence export of the existing local-transport regression. No external provider.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { secureAskJsonRequest } from '../../../apps/runner/src/model-ask.ts';
import { reviewPolicyCoverage } from '../../../apps/runner/src/authoring-policy-coverage.ts';
import { authoringDestination } from '../../../apps/runner/src/authoring-policy-source.ts';
import { createModelAuthoringConversation } from '../../../apps/runner/src/model-authoring-conversation.ts';
const CONFIG='/runner_evidence/runtime_contract/receipt_configuration',RECEIPTS='/runner_evidence/runtime_contract/receipts';
function separated(f:any){
 // DERIVED complete response, not a historical model reply. Same policy/draft.
 const args=structuredClone(f.arguments);
 for(const p of args.passages)for(const c of p.counter_requirements??[])delete c.operator_message_id;
 const i=args.passages.findIndex((p:any)=>p.draft_paths.includes(CONFIG)&&p.draft_paths.includes(RECEIPTS)),p=args.passages[i];
 args.passages.splice(i,1,
  {...p,topic:'Compiled effect',interpretation:'The compiled effect supports the listed updates in one guarded transaction. This is capability, not an observation of execution.',draft_paths:p.draft_paths.filter((x:string)=>x!==RECEIPTS&&x!==CONFIG)},
  {...p,topic:'Configured receipt mode',interpretation:'Current reviewed configuration selects the source-required source_db mode. This proves neither current provisioning, a performed receipt nor independent readback.',draft_paths:[CONFIG]},
  {start:p.start,end:p.end,topic:'Receipt setup and production',disposition:'needs_decision',responsibility:'deployment',issue_kind:'missing_configuration',interpretation:'Keep the required source-atomic receipt guarantee. Applicable writer/provisioning review, execution permission and a performed receipt require their own evidence; no new receipt is observed here.',draft_paths:[RECEIPTS]});
 return args;
}
const input=JSON.parse(await fs.readFile(new URL('../../../apps/runner/src/test-fixtures/receipt-correction-chain.json',import.meta.url),'utf8'));
const label=process.argv[2]??'attempt';assert(/^[a-z0-9-]+$/u.test(label));
const root='/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-correction-chain-2f6c952-20260922/local-wire-'+label;
await fs.mkdir(root);
for(const provider of ['openai','openrouter'] as const){
 const f=structuredClone(input),conversation=createModelAuthoringConversation();conversation.policySources=f.sources;
 const corrected=separated(f),READ="/runner_evidence/runtime_contract/receipt_read_exclusion";
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
  assert(correction.includes('OBLIGATION_CONFIGURATION_COMPONENT_MIXED')&&correction.includes('separately supported components')&&correction.includes('omit the OPTIONAL counter operator_message_id'));
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
