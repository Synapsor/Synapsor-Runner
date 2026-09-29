// DERIVED zero-provider controls. Exclusive root; never reads a live ledger/key.
import {randomUUID} from 'node:crypto';import fs from 'node:fs';import http from 'node:http';import assert from 'node:assert/strict';
import * as B from './continuation-budget-v1.mjs';import {createFreshTransport,safeException} from './fresh-transport-v1.mjs';
import {createProxy} from './continuation-proxy-v2.mjs';
const root=process.argv[2];fs.mkdirSync(root,{mode:0o700});const results=[];let seq=0;
const H='a'.repeat(64),J='input_agenda_retest',put=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n',{mode:0o600}),read=p=>JSON.parse(fs.readFileSync(p));
const payload={model:'DERIVED-local',store:false,reasoning:{effort:'low'},max_output_tokens:5000,input:'DERIVED no Source',};
const reply=JSON.stringify({id:'resp_local',model:'DERIVED-local',status:'completed',usage:{input_tokens:10,output_tokens:1},output:[]});
async function fixture(mode){
 const dir=`${root}/case-${++seq}`;fs.mkdirSync(dir);let sends=0,callbacks=0;const bodies=[];
 const upstream=http.createServer(async(req,res)=>{let b=[];for await(const x of req)b.push(x);bodies.push(Buffer.concat(b));sends++;
  if(mode==='drop-once'&&sends===1||mode==='drop-always'){req.socket.destroy();return;}
  if(mode==='partial'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"type":"response.output_item.done"}\n\n');setTimeout(()=>res.destroy(),10);return;}
  if(mode==='slow'){setTimeout(()=>{if(!res.destroyed)res.end(reply);},100);return;}
  if(mode==='error421'){res.writeHead(421);res.end('{"error":"misdirected"}');return;}
  if(mode==='secret'){res.end(reply.replace('resp_local','DUMMY_SECRET'));return;}
  res.setHeader('content-type','application/json');res.end(reply);
 });await new Promise(r=>upstream.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${upstream.address().port}/v1/responses`;
 const plan={retry_owner:'runner',candidate:'b7f01aaccf334de56ec2cbef4ce10062d93f13f5',installed_tree_sha256:'b71055cd82742bd91c66b2863f6c7624a7ad48f8b56a11735ae5c5eadaed89da',provider:'openai',model:payload.model,stream:true,nonstream_profile:'openai-tool-free-final-answer-omitted-stream',product_output_caps:[5000],tool_free_output_caps:[5000],reasoning_effort:'low',request_bytes:1048576,stream_bytes:8388608,timeout_ms:1000,local_path:'/responses',upstream_url:url,max_input_tokens:1000000,context_tokens:1000000,eligible_tariffs:[{prompt:'0.000001',completion:'0.000001'}]};
 const ph=B.hash(JSON.stringify(plan)),ledger=dir+'/ledger.json';
 const policy={campaign_usd:'80',combined_usd:'60',deadline:'2026-09-30T18:47:55Z',serial_chargeable_egress:true,journeys:{[J]:{usd:'20',transports:800,token_count_calls:100,historical_token_count_calls:0,transient_retries:2,plan_sha256:ph}}};
 put(ledger,{synthetic:true,larger_programs_lane_c:{policy,policy_sha256:B.hash(JSON.stringify(policy)),baseline:{settled:'0',campaign_hold:'0',external_hold:'0'},entries:[],invocations:[],stopped:false,stopped_journeys:{},transport_continuation:{journey:J,max_recoveries:6,max_B:3,max_attempts:3}}});
 const approvals={};for(const role of ['Main','Tester']){const p=dir+'/'+role+'.json';put(p,{role,accepted:true,plan_sha256:ph,synthetic:true});approvals[role]={path:p,sha256:B.hash(fs.readFileSync(p))};}
 let context=H;const forward=createFreshTransport({allowedURLs:[url],localTest:true,env:{}});
 const proxy=await createProxy({ledger,journey:J,invocation:'derived-'+seq,plan,approvals,root:dir+'/proxy',key:'DUMMY_SECRET',currentness:async()=>context,
  resourceCheck:async()=>({fits:true,evidence_sha256:H}),tokenCounter:async x=>({request_sha256:x.request_sha256,validated:true,method:'DERIVED',input_estimate_tokens:10,accounting_method:'native-count',context_input_tokens:10,context_method:'native-count',context_evidence_sha256:H,output_bound_validated:true,output_bound_method:'DERIVED',billing_output_upper_tokens:5000,count_rpc_accounting:'none'}),forward});
 return{dir,ledger,proxy,upstream,bodies,get sends(){return sends;},get callbacks(){return callbacks;},changeContext(){context='b'.repeat(64);},async call(attempt=1,logical=randomUUID(),extra={}){const result=await new Promise((resolve,reject)=>{const q=http.request(proxy.url+plan.local_path,{method:'POST',headers:{'x-synapsor-generation-id':logical,'x-synapsor-generation-attempt':String(attempt)},...extra},r=>{const chunks=[];r.on('data',c=>chunks.push(c));r.on('error',reject);r.on('end',()=>resolve({status:r.statusCode,body:Buffer.concat(chunks).toString()}));});q.on('error',reject);q.end(JSON.stringify(payload));});if(result.status===200)callbacks++;return result;},async close(){await proxy.close();await new Promise(r=>upstream.close(r));}};
}

for(const mode of ['normal','drop-once','partial','secret']){
 const f=await fixture(mode),logical=randomUUID();try{
   let first;try{first=await f.call(1,logical);}catch(e){first={error:e.code};}
   let entries=read(f.ledger).larger_programs_lane_c.entries;
   if(mode==='drop-once'){
     assert.equal(first.error,'ECONNRESET');assert.equal(f.sends,1,'PROXY_MUST_NOT_REISSUE');
     assert.equal(entries[0].transport_failure.classification,'B');assert(entries[0].reserved_usd);
     const second=await f.call(2,logical);assert.equal(second.status,200);assert.equal(f.sends,2);assert.equal(f.callbacks,1);
     entries=read(f.ledger).larger_programs_lane_c.entries;assert.equal(entries[1].recovery_of,entries[0].id);
     assert.equal(entries[1].logical_operation_id,entries[0].id);assert.equal(B.hash(f.bodies[0]),B.hash(f.bodies[1]));
   }else if(mode==='partial'){
     assert.equal(first.status,503);assert.equal(entries[0].transport_failure.classification,'C');
     assert.equal((await f.call(2,logical)).status,503);assert.equal(f.sends,1,'UPSTREAM_C_MUST_FENCE_PRODUCT_RETRY');
   }else if(mode==='secret'){
     assert.equal(first.status,503);assert.equal((await f.call(2,logical)).status,503);assert.equal(f.sends,1);
   }else{assert.equal(first.status,200);assert.equal(f.sends,1);}
   results.push({mode,result:'PASS',upstream:f.sends,callbacks:f.callbacks});
 }finally{await f.close();}
}
{
 const f=await fixture('normal');try{
   assert.equal((await f.call(2,randomUUID())).status,503);assert.equal(f.sends,0);
   results.push({mode:'foreign-retry-lineage-before-egress',result:'PASS'});
 }finally{await f.close();}
}
put(root+'/RESULT.json',{classification:'DERIVED actual guard-only HTTP; no independent proxy reissue; zero provider calls',results});console.log(JSON.stringify({root,checks:results.length,result:'PASS'}));
