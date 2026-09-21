import {reserve,settleRuntimeTurn} from './provider-budget.mjs';
// Two neutral prerequisite transports maximum, no case data, no source access.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';
import assert from 'node:assert/strict';
import {captureBody,sha} from './capture-redaction.mjs';
process.umask(0o077);
const root='/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/known-case-deployment-7be82c7-20260920';
const role=process.argv[2];assert(role==='runtime');
const dir=path.join(root,'prerequisites','neutral-'+role+(process.env.QUALIFICATION_NEUTRAL_NO_FORWARD?'-local-capture':process.env.QUALIFICATION_NEUTRAL_RETRY?'2':''));await fs.mkdir(dir);
const put=(name,value)=>fs.writeFile(path.join(dir,name),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const start=new Date().toISOString();
if(role==='authoring'){
 const env=await fs.readFile('/home/sandesh-tiwari/Desktop/Customer Service With Synapsor Runner/.env','utf8');
 const line=env.split('\n').find(s=>s.split('=')[0].trim()==='OPENROUTER_API_KEY');assert(line);
 const key=line.slice(line.indexOf('=')+1).trim().replace(/^['"]|['"]$/g,'');
 const request={model:'openai/gpt-5.6-terra',messages:[{role:'user',content:'Neutral transport prerequisite only. Call report_ready with ready=true. There is no database, policy, owner identity or business operation.'}],tools:[{type:'function',function:{name:'report_ready',description:'Report neutral transport readiness only.',parameters:{type:'object',properties:{ready:{type:'boolean'}},required:['ready'],additionalProperties:false}}}],tool_choice:{type:'function',function:{name:'report_ready'}},max_tokens:5000,provider:{require_parameters:true,data_collection:'deny',allow_fallbacks:false},stream:false};
 await put('attempt.json',{start,provider_attempt:1,role,maximum:1,spend_ceiling_usd:0.10});await put('request.json',captureBody(JSON.stringify(request),[key]));
 try{
  const res=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(120000)});
  const body=await res.text();await put('response.json',captureBody(body,[key]));const data=JSON.parse(body);
  const call=data.choices?.[0]?.message?.tool_calls?.[0];const okay=res.ok&&call?.function?.name==='report_ready'&&JSON.parse(call.function.arguments).ready===true;
  await put('result.json',{start,end:new Date().toISOString(),http_status:res.status,status:okay?'PASS':'BLOCKED',provider_attempts:1,model:data.model??request.model,finish_reason:data.choices?.[0]?.finish_reason,usage:data.usage,upstream:data.provider??null,body_sha256:sha(body)});
  console.log(JSON.stringify({role,status:okay?'PASS':'BLOCKED',http_status:res.status,model:data.model,usage:data.usage}));
 }catch(e){await put('result.json',{start,end:new Date().toISOString(),status:'BLOCKED',provider_attempts:1,error:e.name});console.log(JSON.stringify({role,status:'BLOCKED',error:e.name}));}
}else{
 const auth=JSON.parse(await fs.readFile('/home/sandesh-tiwari/.claude/.credentials.json','utf8'));const token=auth.claudeAiOauth?.accessToken;assert(token);
 let calls=0;const pending=[];let child;let reservation;let actualTransports=0;
 const proxy=createServer(async(req,res)=>{try{
  if(req.method!=='POST'||!req.url?.startsWith('/v1/messages')){res.statusCode=503;res.end('{}');return;}
  const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks).toString();
  if(++calls>1){res.statusCode=429;res.end('{}');child?.kill('SIGTERM');return;}
  await put('received-envelope.json',captureBody(body,[token]));
  if(process.env.QUALIFICATION_NEUTRAL_NO_FORWARD) throw new Error('LOCAL_CAPTURE_ONLY_NO_FORWARD');
  reservation=reserve(path.join(root,'shared/provider-budget-ledger.json'),'NEUTRAL','runtime','runtime',JSON.parse(body));
  await put('attempt.json',{start,provider_attempt:1,role,maximum:1,reservation});await put('request.json',captureBody(body,[token]));
  const headers={...req.headers};for(const h of ['host','connection','content-length'])delete headers[h];
  if(process.env.QUALIFICATION_NEUTRAL_NO_FORWARD) throw new Error('LOCAL_CAPTURE_ONLY_NO_FORWARD');
  actualTransports++;
  const up=await fetch('https://api.anthropic.com'+req.url,{method:'POST',headers,body,redirect:'error',signal:AbortSignal.timeout(120000)});
  const copy=up.clone().text().then(t=>put('response.txt',captureBody(t,[token])));pending.push(copy);
  res.statusCode=up.status;for(const[k,v]of up.headers)if(!['content-encoding','content-length','transfer-encoding','connection'].includes(k))res.setHeader(k,v);
  await put('http-result.json',{status:up.status,end:new Date().toISOString()});if(up.body)Readable.fromWeb(up.body).pipe(res);else res.end();
 }catch(e){res.statusCode=503;res.end('{}');await put('transport-error.json',{error:e.name,message:e.message});}});
 await new Promise(r=>proxy.listen(0,'127.0.0.1',r));const home=path.join(dir,'home');await fs.mkdir(home);
 const env={PATH:process.env.PATH,HOME:home,TMPDIR:'/var/tmp',NO_COLOR:'1',CLAUDE_CODE_OAUTH_TOKEN:token,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_MAX_OUTPUT_TOKENS:'4096',ANTHROPIC_BASE_URL:'http://127.0.0.1:'+proxy.address().port};
 const args=['-p','Reply with the single word READY. This is a neutral connectivity test; no files, tools, source data or business task.','--model','claude-opus-5','--effort','high','--output-format','json','--tools','','--setting-sources','','--disable-slash-commands','--permission-mode','dontAsk','--no-chrome','--max-turns','1','--max-budget-usd','0.10'];
 await put('launch.json',{start,args,environment_names:Object.keys(env)});
 child=spawn('claude',args,{cwd:home,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
 const timer=setTimeout(()=>child.kill('SIGTERM'),150000);const exit=await new Promise(r=>{child.on('error',e=>r({error:e.name}));child.on('exit',(code,signal)=>r({code,signal}));});clearTimeout(timer);
 await Promise.allSettled(pending);proxy.closeAllConnections();proxy.close();await put('stdout.json',captureBody(stdout,[token]));await put('stderr.json',captureBody(stderr,[token]));let data;try{data=JSON.parse(stdout);}catch{}
 if(reservation&&Number.isFinite(data?.total_cost_usd))settleRuntimeTurn(path.join(root,'shared/provider-budget-ledger.json'),'NEUTRAL',[reservation.id],data.total_cost_usd);
 const okay=exit.code===0&&!data?.is_error&&data?.result?.trim()==='READY';
 await put('result.json',{start,end:new Date().toISOString(),status:okay?'PASS':'BLOCKED',actual_transports:actualTransports,extra_attempts_refused:Math.max(0,calls-1),exit,model_usage:data?.modelUsage,cost_usd:data?.total_cost_usd,result:data?.result});console.log(JSON.stringify({role,status:okay?'PASS':'BLOCKED',calls,exit,cost_usd:data?.total_cost_usd,model_usage:data?.modelUsage}));
}
