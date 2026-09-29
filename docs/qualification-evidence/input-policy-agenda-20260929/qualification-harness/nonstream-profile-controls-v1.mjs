import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {allocateRetest,ownerSha256,deadline,journey} from './allocate-retest-v1.mjs';
import * as B from '/home/sandesh-tiwari/Desktop/C++/synapsor-runner/docs/qualification-evidence/larger-programs-supported-20260927/lane-c-harness/lane-c-budget-v5.mjs';
const root=process.argv[2];fs.mkdirSync(root,{recursive:false,mode:0o700});const results=[];let seq=0;
const put=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n',{mode:0o600});
const load=p=>JSON.parse(fs.readFileSync(p));
const h=p=>B.hash(fs.readFileSync(p));
const H='a'.repeat(64), when='2026-09-28T23:00:00Z';
function fixture() {
 const dir=path.join(root,`case-${++seq}`);fs.mkdirSync(dir);const parent=path.join(dir,'closed.json'),dest=path.join(dir,'next.json');
 const policy={campaign_usd:'80',combined_usd:'60',serial_chargeable_egress:true,deadline:'2026-10-01T23:59:00Z',journeys:Object.fromEntries(Object.entries({direct:'30',or:'20',mini:'10'}).map(([k,usd])=>[k,{usd,transports:800,token_count_calls:100,historical_token_count_calls:k==='direct'?1:0,transient_retries:2,plan_sha256:H}]))};
 const entries=[];for(const [j,n,c]of[['direct',51,24],['or',14,0],['mini',21,2]])for(const[kind,count]of[['inference',n],['token-count',c]])for(let i=0;i<count;i++)entries.push({id:`${j}-${kind}-${i}`,journey:j,kind,status:'REQUEST_COST_SETTLED',started_at:when,completed_at:when,settled_usd:'0',reserved_usd:'1'});
 const last=entries.find(x=>x.id==='direct-inference-50');delete last.settled_usd;last.status='UNKNOWN_COST_RESERVED';last.reserved_usd='2.77855';
 const state={synthetic:true,active_operation:null,unrelated_history:{keep:true},larger_programs_lane_c:{policy,policy_sha256:B.hash(JSON.stringify(policy)),entries,invocations:[],baseline:{settled:'16.90079760',campaign_hold:'0',external_hold:'0'},stopped:false,stopped_journeys:{direct:{reason:'UNRESOLVED_FINANCIAL_TRANSPORT',id:last.id,at:when}}}};
 put(parent,state);const a={id:'input-agenda-fidelity-20260929-allocation1',owner_sha256:ownerSha256,parent_path:parent,destination_path:dest,expected_parent_sha256:h(parent),expected_policy_sha256:state.larger_programs_lane_c.policy_sha256,plan_sha256:H,installed_acceptance_sha256:'b'.repeat(64),deadline};
 return{dir,parent,dest,state,a};
}
function sign(f){let refs={};for(const role of['Main','Tester']){const p=path.join(f.dir,`sign-${role}-${Date.now()}-${Math.random()}.json`);put(p,{role,accepted:true,amendment_sha256:B.hash(JSON.stringify(f.a))});refs[role]={path:p,sha256:h(p)};}return refs;}
function fresh(){const f=fixture();f.signoffs=sign(f);allocateRetest(f.parent,f.dest,f.a,f.signoffs);return f;}
function test(name,fn){fn();results.push({name,result:'PASS'});}
function refusesUnchanged(file,fn,reason){const before=h(file);assert.throws(fn,reason);assert.equal(h(file),before);}
function invoke(f){B.registerInvocation(f.dest,journey,'test-invocation',H);}

const {validateRequest,createProxy}=await import('./input-agenda-proxy-v2.mjs');
const oldProxy=await import('./input-agenda-proxy-v1.mjs');
const captureRoot='/home/sandesh-tiwari/Desktop/Synapsor Tutorials/test-1.8.0/independent-input-agenda-20260929/private/installed-full50-084/captures';
const oldPlan=load('/home/sandesh-tiwari/Desktop/Synapsor Tutorials/test-1.8.0/independent-supported-50-20260927/private/lane-c-live-735/plans/DIRECT-PLAN-816.json');
const plan={...oldPlan,candidate:'b7f01aaccf334de56ec2cbef4ce10062d93f13f5',installed_tree_sha256:'b71055cd82742bd91c66b2863f6c7624a7ad48f8b56a11735ae5c5eadaed89da',deadline,nonstream_profile:'openai-tool-free-final-answer-omitted-stream',upstream_url:'http://127.0.0.1:1/NEVER',timeout_ms:1000};
const actual=fs.readFileSync(path.join(captureRoot,'installed-request-0320.json'));
test('preserved actual320 fails old streaming-only profile; no egress',()=>assert.throws(()=>oldProxy.validateRequest(actual,plan),/STREAM_CHANGED/));
test('actual320 admitted with exact output/model/body and explicit opt-in',()=>{const checked=validateRequest(actual,plan);assert.equal(checked.request_sha256,B.hash(actual));assert.equal(checked.output_tokens,5000);assert.deepEqual(checked.tool_names,[]);const unapproved={...plan};delete unapproved.nonstream_profile;assert.throws(()=>validateRequest(actual,unapproved),/STREAM_CHANGED/);});
const captured=fs.readdirSync(captureRoot).filter(n=>/^installed-request-\d+\.json$/.test(n));
test('all actual installed finite request envelopes remain admitted',()=>{for(const n of captured)validateRequest(fs.readFileSync(path.join(captureRoot,n)),plan);});
test('nonstream tools, changed explicit stream, route, output, storage or reasoning still refuse',()=>{
 const base=JSON.parse(actual);for(const [patch,expected] of [[{stream:false},/STREAM_CHANGED/],[{stream:null},/STREAM_CHANGED/],[{tools:[]},/STREAM_CHANGED/],[{tool_choice:'none'},/STREAM_CHANGED/],[{parallel_tool_calls:false},/STREAM_CHANGED/],[{max_output_tokens:12001},/OUTPUT_CHANGED/],[{store:true},/STORE_CHANGED/],[{reasoning:{effort:'high'}},/REASONING_CHANGED/]])assert.throws(()=>validateRequest(Buffer.from(JSON.stringify({...base,...patch})),plan),expected);
 assert.throws(()=>validateRequest(actual,{...plan,provider:'openrouter'}),/STREAM_CHANGED/);
});
for(const mode of ['normal-json','incomplete-json','missing-usage','http-error','malformed-json','oversized-json','secret-json','invalid-stream']){
 const q=fixture(),planHash=B.hash(JSON.stringify(plan));q.a.plan_sha256=planHash;allocateRetest(q.parent,q.dest,q.a,sign(q));
 const approvals={};for(const role of ['Main','Tester']){const p=path.join(q.dir,role+'-proxy.json');put(p,{role,accepted:true,plan_sha256:planHash,label:'DERIVED zero-provider boundary test'});approvals[role]={path:p,sha256:h(p)};}
 let forwards=0;const itemBody={id:'resp_derived',model:plan.model,status:mode==='incomplete-json'?'incomplete':'completed',service_tier:'default',usage:{input_tokens:1000,input_tokens_details:{cached_tokens:0,cache_write_tokens:0},output_tokens:50,output_tokens_details:{reasoning_tokens:40}},output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'DERIVED final answer, no tool callback'}]}]};
 if(mode==='missing-usage')delete itemBody.usage;
 if(mode==='secret-json')itemBody.output[0].content[0].text='DUMMY_ONLY';
 const reply=mode==='oversized-json'?'x'.repeat(1048577):mode==='malformed-json'?'not json':mode==='http-error'?JSON.stringify({error:{code:'derived400'}}):JSON.stringify(itemBody);
 const proxy=await createProxy({ledger:q.dest,journey,invocation:'derived-'+mode,plan,approvals,root:path.join(q.dir,'proxy'),key:'DUMMY_ONLY',resourceCheck:async()=>({fits:true,evidence_sha256:H}),tokenCounter:async x=>({request_sha256:x.request_sha256,validated:true,method:'DERIVED synthetic fixed count; no real count endpoint',input_estimate_tokens:1000,accounting_method:'native-count',context_input_tokens:1000,context_method:'native-count',context_evidence_sha256:H,output_bound_validated:true,output_bound_method:'DERIVED unchanged captured5000 cap',billing_output_upper_tokens:5000,count_rpc_accounting:'none'}),forward:async(url,options)=>{forwards++;assert.equal(url,plan.upstream_url);assert.equal(B.hash(options.body),B.hash(actual));return new Response(reply,{status:mode==='http-error'?400:200,headers:{'content-type':'application/json'}});}});
 try{
  const bytes=mode==='invalid-stream'?Buffer.from(JSON.stringify({...JSON.parse(actual),stream:false})):actual;
  const res=await fetch(proxy.url+plan.local_path,{method:'POST',body:bytes});const body=await res.text();const state=load(q.dest),entry=state.larger_programs_lane_c.entries.at(-1);
  assert.equal(h(q.parent),q.a.expected_parent_sha256);
  if(mode==='invalid-stream'){assert.equal(forwards,0);assert.equal(res.status,503);assert.equal(state.larger_programs_lane_c.entries.length,q.state.larger_programs_lane_c.entries.length);}
  else{
   assert.equal(forwards,1);assert.equal(entry.journey,journey);assert.equal(entry.request_sha256,B.hash(actual));assert(entry.completed_at);
   if(['normal-json','incomplete-json','secret-json'].includes(mode)){
    assert(entry.settled_usd);assert.equal(entry.result.generation_incomplete,mode==='incomplete-json');
    if(mode==='secret-json'){assert.equal(res.status,503);assert(!body.includes('DUMMY_ONLY'));assert(state.larger_programs_lane_c.stopped);}
    else{assert.equal(res.status,200);assert.equal(body,reply);assert(!state.larger_programs_lane_c.stopped_journeys[journey]);}
   }else{assert.equal(entry.status,'UNKNOWN_COST_RESERVED');assert(state.larger_programs_lane_c.stopped_journeys[journey]);assert(entry.reserved_usd);}
  }
 }finally{await proxy.close();}
 results.push({name:'actual local proxy native320 path '+mode,result:'PASS'});
}
put(path.join(root,'RESULT.json'),{classification:'DERIVED local exact-encoding/profile and disposable ledger controls; zero provider calls, no live ledger/fixture/product mutation',at:new Date().toISOString(),actual320_sha256:B.hash(actual),captured_envelopes:captured.length,checks:results.length,results});console.log(JSON.stringify({root,captured_envelopes:captured.length,checks:results.length,all:'PASS'}));
