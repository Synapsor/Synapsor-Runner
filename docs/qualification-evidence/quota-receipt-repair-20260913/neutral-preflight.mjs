// Reuses the prior Responses ping and isolated Claude MCP prerequisite.
// No case policy, schema, source rows, database configuration or identity input.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseEnv} from 'node:util';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import assert from 'node:assert/strict';
import {qualificationSandboxArguments,qualificationEnvironment} from '../../../scripts/qualification-sandbox.mjs';
process.umask(0o077);
const E=path.dirname(fileURLToPath(import.meta.url)),plan=JSON.parse(await fs.readFile(path.join(E,'assignment-plan.json')));
const O=plan.owned_root,F=path.join(O,'development-frozen/installed');
const role=process.argv[2];assert(['authoring','runtime'].includes(role));
const base=path.join(O,'preflight');await fs.mkdir(base,{recursive:true});
const attempt=(await fs.readdir(base)).filter(x=>x.startsWith(role+'-')).length+1;assert(attempt<=plan.budgets.provider_neutral_attempts_per_role);
const owned=path.join(base,role+'-'+attempt);await fs.mkdir(owned);await fs.mkdir(path.join(owned,'home'));await fs.mkdir(path.join(owned,'var-tmp'));
const result={role,attempt,started_at:new Date().toISOString(),classification:'neutral configured-provider prerequisite, not Runner or Stage B qualification; ping dependencies from explicitly labeled development installation',source_metadata_sent:false,identity_values_sent:false,status:'running'};
const resultPath=path.join(owned,'result.json');await fs.writeFile(resultPath,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
const sandbox=await qualificationSandboxArguments({ownedRoot:owned,cwd:owned,home:path.join(owned,'home')});sandbox.splice(sandbox.length-1,0,'--bind',path.join(owned,'var-tmp'),'/var/tmp','--setenv','NO_COLOR','1');
let child,proxy,timer;const env=qualificationEnvironment({NO_COLOR:'1'});let code=1;
try{
 if(role==='authoring'){
  const key=parseEnv(await fs.readFile('/home/sandesh-tiwari/Desktop/Customer Service With Synapsor Runner/.env','utf8')).OPENAI_API_KEY;assert(key,'Existing configured OpenAI credential unavailable');
  const previous='/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/gate2-b955c83/provider-preflight.mjs';
  let source=await fs.readFile(previous,'utf8');
  source=source.replace("const configured = parseEnv(await readFile('/home/sandesh-tiwari/Desktop/Customer Service With Synapsor Runner/.env', 'utf8'));","const configured = {};");
  await fs.writeFile(path.join(owned,'provider-ping.mjs'),source,{flag:'wx'});env.OPENAI_API_KEY=key;
  result.requested_model='gpt-5.6-terra';result.provider='openai';result.endpoint='https://api.openai.com/v1/responses';result.settings={store:false,max_output_tokens:1024,tool_choice:'qualification_ping',parallel_tool_calls:false};
  child=spawn('bwrap',[...sandbox,process.execPath,path.join(owned,'provider-ping.mjs'),'neutral'],{env,stdio:['ignore','pipe','pipe']});
 }else{
  const auth=JSON.parse(await fs.readFile('/home/sandesh-tiwari/.claude/.credentials.json'));assert(auth.claudeAiOauth?.accessToken,'Existing subscribed Claude credential unavailable');
  env.CLAUDE_CODE_OAUTH_TOKEN=auth.claudeAiOauth.accessToken;env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1';
  result.provider='anthropic';result.requested_model='opus';result.client_version=execFileSync('claude',['--version'],{encoding:'utf8',env:qualificationEnvironment()}).trim();
  const source=await fs.readFile('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/gate2-b955c83/client-ping-server.mjs','utf8');
  await fs.writeFile(path.join(owned,'client-ping-server.mjs'),source.replaceAll("'./installed/node_modules/", "'"+pathToFileURL(F+'/node_modules/').href),{flag:'wx'});
  const config={mcpServers:{gate2_preflight:{command:process.execPath,args:[path.join(owned,'client-ping-server.mjs')]}}};await fs.writeFile(path.join(owned,'mcp.json'),JSON.stringify(config),{flag:'wx'});
  let transports=0;
  proxy=createServer(async(req,res)=>{
   try{
    assert(req.url?.startsWith('/v1/'),'Only configured Anthropic API traffic is permitted');const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);
    if(req.method==='POST'&&req.url.startsWith('/v1/messages')){assert(++transports<=6,'Neutral transport ceiling reached');const parsed=JSON.parse(body.toString());await fs.appendFile(path.join(owned,'provider-attempts.jsonl'),JSON.stringify({index:transports,at:new Date().toISOString(),endpoint:'https://api.anthropic.com'+req.url,model:parsed.model,max_tokens:parsed.max_tokens,request_bytes:body.length})+'\n');}
    const headers={...req.headers};for(const h of ['host','connection','content-length'])delete headers[h];
    const upstream=await fetch('https://api.anthropic.com'+req.url,{method:req.method,headers,body:body.length?body:undefined,redirect:'error',signal:AbortSignal.timeout(90000)});
    await fs.appendFile(path.join(owned,'transport-results.jsonl'),JSON.stringify({at:new Date().toISOString(),path:req.url,status:upstream.status,request_id:upstream.headers.get('request-id')})+'\n');res.statusCode=upstream.status;
    for(const [n,v] of upstream.headers)if(!['content-encoding','content-length','transfer-encoding','connection'].includes(n))res.setHeader(n,v);
    if(upstream.body)Readable.fromWeb(upstream.body).pipe(res);else res.end();
   }catch(error){res.statusCode=503;res.end(JSON.stringify({type:'error',error:{type:'qualification_transport_error',message:'Neutral prerequisite transport refused or failed'}}));}
  });await new Promise(r=>proxy.listen(0,'127.0.0.1',r));env.ANTHROPIC_BASE_URL=`http://127.0.0.1:${proxy.address().port}`;
  const args=['-p','--model','opus','--output-format','json','--tools','','--allowedTools','mcp__gate2_preflight__qualification_ping','--strict-mcp-config','--mcp-config',path.join(owned,'mcp.json'),'--setting-sources','','--disable-slash-commands','--permission-mode','dontAsk','--no-chrome','--max-budget-usd','1'];
  result.settings={cli_args:args,nonessential_traffic_disabled:true,tools:'neutral ping only; no Runner, database, shell, file or web tools',provider_transport_limit:6};
  child=spawn('bwrap',[...sandbox,'claude',...args],{env,stdio:['pipe','pipe','pipe']});child.stdin.end('This is a neutral connection prerequisite. Call the qualification_ping MCP tool once and report the exact returned marker. No database, policy or authoring task is involved.');
 }
 result.child_pid=child.pid;await fs.writeFile(resultPath,JSON.stringify(result,null,2)+'\n');
 let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
 timer=setTimeout(()=>{result.timeout=true;child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),5000).unref();},120000);
 code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(c,s)=>{result.signal=s;resolve(c??1);});});
 await fs.writeFile(path.join(owned,'stdout.json'),stdout,{flag:'wx'});await fs.writeFile(path.join(owned,'stderr.log'),stderr,{flag:'wx'});
 if(role==='authoring'){
  const response=JSON.parse(await fs.readFile(path.join(owned,'provider-preflight-neutral.json')));result.response=response;result.actual_provider_attempts=1;assert.equal(code,0);assert.equal(response.http_status,200);
 }else{
  const output=JSON.parse(stdout);result.response={is_error:output.is_error,subtype:output.subtype,result:output.result,modelUsage:output.modelUsage,num_turns:output.num_turns,total_cost_usd:output.total_cost_usd,duration_ms:output.duration_ms};
  const calls=(await fs.readFile(path.join(owned,'client-tool-calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);const attempts=(await fs.readFile(path.join(owned,'provider-attempts.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  result.neutral_tool_calls=calls.length;result.actual_provider_attempts=attempts.length;result.actual_requested_models=attempts.map(x=>x.model);assert.equal(code,0);assert.equal(output.is_error,false);assert.equal(calls.length,1);assert(output.result.includes('GATE2_MCP_TOOL_CONFIRMED'));
 }
 result.status='passed';
}catch(error){result.status='prerequisite_blocked';result.failure={type:error.name,message:error.message};code=1;}
finally{clearTimeout(timer);if(child&&child.exitCode===null)child.kill('SIGTERM');proxy?.closeAllConnections();proxy?.close();result.exit_code=code;result.completed_at=new Date().toISOString();await fs.writeFile(resultPath,JSON.stringify(result,null,2)+'\n');await fs.writeFile(path.join(E,`${role}-preflight-${attempt}.json`),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));}
process.exitCode=code;
