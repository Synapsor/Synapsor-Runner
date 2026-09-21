// Qualification-only native client diagnostic. It never forwards any HTTP request.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {captureBody} from './capture-redaction.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

process.umask(0o077);
const plan=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const root=path.join(plan.owned_root,process.argv[3]??'native-ingestion');
const expected=Number(process.argv[4]??4);assert([2,4].includes(expected));
await fs.mkdir(root);
const generated=JSON.parse(await fs.readFile(plan.generated_mcp_config,'utf8'));
assert.deepEqual(Object.keys(generated.mcpServers),[plan.selected_mcp_server]);
const entry=generated.mcpServers[plan.selected_mcp_server];
assert.equal(entry.command,'/usr/bin/node');
assert.equal(entry.args[0],plan.installed_mcp_entrypoint);
assert(entry.args.includes('--local-test-runtime'));
const auth=JSON.parse(await fs.readFile('/home/sandesh-tiwari/.claude/.credentials.json','utf8'));
const token=auth.claudeAiOauth?.accessToken; assert(token);
const connection=JSON.parse(await fs.readFile(plan.private_runtime_environment,'utf8'));
assert.deepEqual(Object.keys(connection),['DATABASE_URL']);
const secretValues=[token,...Object.values(connection)];
const redact=s=>captureBody(s,secretValues);
const wire=['app.describe_data','app.explore_data','app.describe_actions','app.request_change']
  .flatMap(x=>['mcp__'+plan.selected_mcp_server+'__'+x,'mcp__'+plan.selected_mcp_server+'__'+x.replaceAll('.','_')]);
let child;const stopOwned=()=>{if(child?.pid)try{process.kill(-child.pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}};let postCount=0; let offered=[];
const events=path.join(root,'events.jsonl');
const log=o=>fs.appendFile(events,JSON.stringify({at:new Date().toISOString(),...o})+'\n',{mode:0o600});
const server=http.createServer(async(req,res)=>{
  if(req.method==='POST'){
    const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;assert(bytes<=1024*1024);chunks.push(chunk);}
    const body=Buffer.concat(chunks).toString();
    const parsed=JSON.parse(body);postCount+=1;await fs.writeFile(path.join(root,'attempted-envelope-'+postCount+'.json'),redact(body),{flag:'wx',mode:0o600});
    offered=(parsed.tools??[]).map(x=>x.name);
    await log({kind:'native_request_intercepted_no_forward',post_count:postCount,model:parsed.model,max_tokens:parsed.max_tokens,effort:parsed.output_config?.effort,offered_tool_count:offered.length,offered_tool_names:offered,request_bytes:Buffer.byteLength(body)});
    res.statusCode=503; res.end('{}');
    setTimeout(stopOwned,50);
    return;
  }
  await log({kind:'startup_request_no_forward',method:req.method,path:(req.url??'').split('?')[0]});
  res.statusCode=503; res.end('{}');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const observed=path.join(root,'generated-mcp-config.json');
await fs.writeFile(observed,JSON.stringify(generated)+'\n');
const args=['-p','--model','claude-opus-5','--effort','high','--input-format','stream-json','--output-format','stream-json','--verbose','--tools','','--allowedTools',...wire,'--strict-mcp-config','--mcp-config',observed,'--setting-sources','','--disable-slash-commands','--permission-mode','dontAsk','--no-chrome','--max-budget-usd','4.90'];
const env={PATH:process.env.PATH,HOME:plan.home,TMPDIR:'/var/tmp',NO_COLOR:'1',TERM:'xterm-256color',...connection,CLAUDE_CODE_OAUTH_TOKEN:token,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_MAX_OUTPUT_TOKENS:'4096',ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`};
await fs.writeFile(path.join(root,'launch.json'),JSON.stringify({args,environment_names:Object.keys(env),no_forward:true},null,2)+'\n');
// Direct SDK catalog is a separate boundary, using the exact generated entry.
const sdk=new Client({name:'native-ingestion-catalog-gate',version:'1'});
const stdio=new StdioClientTransport({command:'bwrap',args:[...plan.sandbox_args,entry.command,...entry.args],env:{PATH:process.env.PATH,HOME:plan.home,NO_COLOR:'1',...connection},stderr:'pipe'});
await sdk.connect(stdio);const catalog=await sdk.listTools();await fs.writeFile(path.join(root,'DIRECT-MCP-CATALOG.json'),JSON.stringify(catalog,null,2)+'\n');await sdk.close();
assert.deepEqual(catalog.tools.map(t=>t.name).sort(),['app.describe_actions','app.describe_data','app.explore_data','app.request_change']);
child=spawn('bwrap',[...plan.sandbox_args,'claude',...args],{env,stdio:['pipe','pipe','pipe'],detached:true});
const writes=[];let outputBuffer='';
child.stdout.on('data',d=>{outputBuffer+=d;let n;while((n=outputBuffer.indexOf('\n'))>=0){const line=outputBuffer.slice(0,n);outputBuffer=outputBuffer.slice(n+1);writes.push(fs.appendFile(path.join(root,'client-output.jsonl'),redact(line)+'\n',{mode:0o600}));}});
child.stderr.on('data',d=>void fs.appendFile(path.join(root,'stderr.txt'),redact(String(d)),{mode:0o600}));
child.stdin.write(JSON.stringify({type:'user',message:{role:'user',content:'Local no-forward tool-catalog diagnostic. Do not perform a business request.'}})+'\n');
const timer=setTimeout(()=>stopOwned(),30000);
const exit=await new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));
clearTimeout(timer);stopOwned();server.closeAllConnections(); server.close();await Promise.all(writes);
const init=[];
try{for(const line of (await fs.readFile(path.join(root,'client-output.jsonl'),'utf8')).split('\n')){if(!line.trim())continue;const x=JSON.parse(line);if(x.type==='system'&&x.subtype==='init')init.push({tools:x.tools,mcp_servers:x.mcp_servers,model:x.model,permissionMode:x.permissionMode,claude_code_version:x.claude_code_version});}}catch{}
const result={at:new Date().toISOString(),exit,provider_forwards:0,ledger_reservations:0,native_posts_intercepted:postCount,native_init:init,offered_tool_count:offered.length,offered_tool_names:offered,generated_server:plan.selected_mcp_server,generated_config_unchanged:true};
await fs.writeFile(path.join(root,'RESULT.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
assert.equal(offered.length,expected);assert.equal(init.at(-1)?.tools.filter(t=>t.startsWith('mcp__')).length,expected);
await fs.writeFile(path.join(root,'GATE-VERDICT.json'),JSON.stringify({status:expected===4?'NATIVE_INGESTION_PASS':'BASELINE_FILTER_REPRODUCED',provider_acceptance:'NOT_TESTED',expected,actual:offered.length})+'\n');
