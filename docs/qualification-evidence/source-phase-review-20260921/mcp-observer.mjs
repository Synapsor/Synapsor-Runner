// Qualification-only transparent stdio observer. Executes only generated installed
// command; records exact transport and refuses before exceeding declared budgets.
import fs from 'node:fs';import {spawn} from 'node:child_process';import readline from 'node:readline';
import assert from 'node:assert/strict';import {captureBody} from './capture-redaction.mjs';
process.umask(0o077);
const p=JSON.parse(fs.readFileSync(process.argv[2]));const secrets=Object.entries(process.env).filter(([k])=>/URL|KEY|TOKEN|PASSWORD|SECRET/.test(k)).map(([,v])=>v);
assert(p.command==='/usr/bin/node'&&p.args[0]===p.installed_mcp_entrypoint&&p.args.includes('--local-test-runtime'));
let child;const append=(kind,line)=>fs.appendFileSync(p.capture_file,JSON.stringify({at:new Date().toISOString(),kind,body:JSON.parse(captureBody(line,secrets))})+'\n',{mode:0o600});
function count(m){if(m.method!=='tools/call')return;assert(['app.describe_data','app.explore_data','app.describe_actions','app.request_change'].includes(m.params?.name));
 const lock=p.ledger+'.lock';const fd=fs.openSync(lock,'wx',0o600);try{const j=JSON.parse(fs.readFileSync(p.ledger));const c=j.case_allocations.find(x=>x.case_id===p.case_id);assert(c?.status==='LIVE'&&Date.now()<Date.parse(c.deadline));if(c.phase_kind==='development')assert.notEqual(m.params.name,'app.request_change','Development is read-only');const ops=c.mcp_calls??=[];if(p.role==='deterministic')assert(ops.filter(x=>x.role==='deterministic').length<c.operation_limits.deterministic,'Deterministic MCP ceiling');if(m.params.name==='app.request_change'){assert(c.business_authorized===true,'Independent final native/read checkpoint not yet passed');assert(ops.filter(x=>x.name==='app.request_change').length<c.operation_limits.request_change,'Shared request_change ceiling');}ops.push({at:new Date().toISOString(),role:p.role,name:m.params.name,transport_id:m.id});const tmp=p.ledger+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(j,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,p.ledger);}finally{fs.closeSync(fd);fs.unlinkSync(lock);}}
child=spawn(p.command,p.args,{env:process.env,stdio:['pipe','pipe','pipe']});
readline.createInterface({input:process.stdin,terminal:false}).on('line',line=>{try{const m=JSON.parse(line);count(m);append('request',line);child.stdin.write(line+'\n');}catch(e){append('observer_refusal',JSON.stringify({error:e.name,message:e.message}));child.kill('SIGTERM');process.exitCode=2;}}).on('close',()=>child.stdin.end());
child.stdout.on('data',d=>process.stdout.write(d));let buffer='';child.stdout.on('data',d=>{buffer+=d;let n;while((n=buffer.indexOf('\n'))>=0){append('response',buffer.slice(0,n));buffer=buffer.slice(n+1);}});
child.stderr.on('data',d=>append('stderr',JSON.stringify({text:String(d)})));
child.on('error',e=>{append('child_error',JSON.stringify({error:e.name}));process.exit(2)});child.on('exit',(code,signal)=>{append('exit',JSON.stringify({code,signal}));process.exit(code??1)});
process.on('SIGTERM',()=>child.kill('SIGTERM'));process.on('SIGINT',()=>child.kill('SIGINT'));
