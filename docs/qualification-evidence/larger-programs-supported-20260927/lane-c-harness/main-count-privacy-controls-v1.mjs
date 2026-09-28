// DERIVED offline/loopback controls of owner136's finite amendment.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {hash,initialize,registerInvocation,reserveRequest,markStarted,finishRequest,summary,transportSummary} from './lane-c-budget-v3.mjs';
import {pricedUpper,pricedCost,validateTokenObservation,validateRequest} from './lane-c-proxy-v5.mjs';
const {performTokenCount}=await import(new URL(process.argv[3],import.meta.url));
const root=process.argv[2];assert(root&&!fs.existsSync(root));fs.mkdirSync(root,{recursive:true,mode:0o700});
const h='a'.repeat(64),rows=[];let n=0,forwards=0;
const plan={candidate:'f20e8633b352528fe216adfca6ca45a47a351e27',provider:'openai',model:'gpt-5.6-terra',stream:true,product_output_caps:[800,5000,12000],tool_free_output_caps:[800],reasoning_effort:'low',request_bytes:1048576,stream_bytes:8388608,max_input_tokens:922000,context_tokens:1050000,local_path:'/v1/responses',upstream_url:'https://api.openai.com/v1/responses',count_endpoint:'https://api.openai.com/v1/responses/input_tokens',count_profile_sha256:h,timeout_ms:1000,eligible_tariffs:[{prompt:'0.000002',completion:'0.000012',overrides:[{min_prompt_tokens:272001,prompt:'0.000010',completion:'0.000040'}]}]};
const request={model:plan.model,stream:true,store:false,reasoning:{effort:'low'},instructions:'DERIVED complete Source and instructions',input:[{role:'user',content:'DERIVED full50 owner task'},{type:'function_call_output',call_id:'prior',output:'DERIVED retained prior tool result'}],parallel_tool_calls:false,tools:[{type:'function',name:'runner__test',parameters:{type:'object',properties:{a:{type:'string'}},required:['a'],additionalProperties:false}}],tool_choice:{type:'function',name:'runner__test'},max_output_tokens:5000};
const bytes=Buffer.from(JSON.stringify(request)),ph=hash(JSON.stringify(plan));
const seed=path.join(root,'seed.json');fs.writeFileSync(seed,JSON.stringify({active_operation:null,settled_spend_usd:'4.18686165',uncertain_hold_usd:'0.26298000',older_hold_already_reflected_usd:'0.71608250',new_provider_transports:[]}),{mode:0o600});
const approvals=Object.fromEntries(['Main','Tester'].map(role=>{const p=path.join(root,role+'.json');fs.writeFileSync(p,JSON.stringify({role,plan_sha256:ph,accepted:true,label:'DERIVED not live consent'}),{mode:0o600});return [role,{path:p,sha256:hash(fs.readFileSync(p))}];}));
function setup(){const ledger=path.join(root,'ledger-'+(++n)+'.json');initialize(ledger,seed,hash(fs.readFileSync(seed)),{campaign_usd:'60',combined_usd:'40',serial_chargeable_egress:true,carried_liabilities:[{id:'602',journey:'openai',usd:'0.0017',evidence_sha256:h}],deadline:'2026-09-30T23:59:00Z',journeys:Object.fromEntries(['openai','openrouter'].map(k=>[k,{usd:'20',transports:400,transient_retries:2,token_count_calls:100,historical_token_count_calls:k==='openai'?1:0,plan_sha256:ph}]))});registerInvocation(ledger,'openai','test',ph);registerInvocation(ledger,'openrouter','other',ph);return ledger;}
const read=p=>JSON.parse(fs.readFileSync(p));
const test=async(name,fn)=>{await fn();rows.push({name,verdict:'PASS',layer:'DERIVED local count/ledger/proxy contract; no external transport'});};
const resourceCheck=async()=>({fits:true,evidence_sha256:h});
function args(ledger,forward){return {ledger,journey:'openai',invocation:'test',id:'count-new',plan,approvals,inferenceBytes:bytes,root:path.join(root,'capture-'+n),key:'DUMMY_COUNT_KEY',resourceCheck,forward};}


for(const location of ['body-key','header-key','body-private','header-private'])await test(location,async()=>{
 const l=setup(),value=location.includes('private')?'PRIVATE_OWNER_VALUE_144':'DUMMY_COUNT_KEY';
 const a=args(l,async()=>new Response(JSON.stringify({object:'response.input_tokens',input_tokens:170,...(location.startsWith('body')?{extra:value}:{})}),{headers:location.startsWith('header')?{'x-request-id':value}:{}}));a.privateValues=['PRIVATE_OWNER_VALUE_144'];
 let error=null;try{await performTokenCount(a);}catch(e){error=e.message;}
 const state=read(l);const bytes=fs.readdirSync(a.root).map(n=>fs.readFileSync(path.join(a.root,n),'utf8')).join('')+JSON.stringify(state);
 const outcome={location,error,private_value_in_evidence:bytes.includes(value),shared_stop:state.larger_programs_lane_c.stopped};
 fs.writeFileSync(path.join(root,location+'.json'),JSON.stringify(outcome,null,2));
 if(process.argv[4]==='expect-refusal'){assert(!outcome.private_value_in_evidence);assert(outcome.shared_stop);assert.equal(error,'SECRET_IN_RESPONSE');}
});
const result={utc:new Date().toISOString(),label:'DERIVED known-value count response probe, no actual credentials or external requests',module:process.argv[3],module_sha256:hash(fs.readFileSync(new URL(process.argv[3],import.meta.url))),rows,observations:rows.map(x=>read(path.join(root,x.name+'.json')))};
fs.writeFileSync(path.join(root,'RESULT.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
