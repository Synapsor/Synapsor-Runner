// Packaged public operator path, zero provider credentials/calls. No authority setters.
import fs from 'node:fs/promises';import {createWriteStream} from 'node:fs';import {randomUUID} from 'node:crypto';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {spawn,spawnSync,execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';import assert from 'node:assert/strict';
import {qualificationSandboxArguments,qualificationEnvironment} from '../../../scripts/qualification-sandbox.mjs';
process.umask(0o077);
const E=path.dirname(fileURLToPath(import.meta.url)),plan=JSON.parse(await fs.readFile(path.join(E,'assignment-plan.json'))),O=plan.owned_root;
let [runId,...args]=process.argv.slice(2);assert.equal(runId,'prepared-software');
const administrator=args[0]==='--administrator';if(administrator)args.shift();
const owned=path.join(O,'runs',runId),state=JSON.parse(await fs.readFile(path.join(owned,'run-state.json'))),F=state.artifact_directory;
assert(!args.some(arg=>/postgres(?:ql)?:\/\/|sk-|--api-key/.test(arg)));
execFileSync(process.execPath,[path.join(F,'freeze-repair.mjs'),'--verify'],{stdio:'pipe'});
const connection=JSON.parse(await fs.readFile(path.join(owned,'private/connection.json')));
const inspect=JSON.parse(execFileSync('docker',['inspect',connection.container],{encoding:'utf8'}))[0];
assert.equal(inspect.Id,connection.container_id);assert.equal(inspect.Config.Labels['synapsor.qualification'],connection.label);assert.equal(inspect.HostConfig.NetworkMode,'none');assert(inspect.State.Running);
const H=path.join(plan.previous_root,'trial-harness');
const env=qualificationEnvironment({...connection.env,...(administrator?{SETUP_DATABASE_URL:connection.adminLogicalUrl??connection.adminUrl}:{}),NO_COLOR:'1',QUALIFICATION_MOUNT_PLAN:path.join(owned,'mount-plan.json')});
assert(!Object.keys(env).some(key=>/OPENAI|ANTHROPIC|CLAUDE|API_KEY|TOKEN|NODE_OPTIONS/.test(key)));
const sandbox=await qualificationSandboxArguments({ownedRoot:owned,mounts:[{logical:state.logicalCase,physical:owned}],cwd:state.logicalProject,home:path.join(owned,'home')});
sandbox.splice(sandbox.length-1,0,'--unshare-net','--ro-bind',connection.socket,connection.logicalSocket,'--bind',path.join(owned,'var-tmp'),'/var/tmp','--setenv','NO_COLOR','1');
for(const rel of ['authoring-input','private','verifier','schema.sql','case.json','frozen-input-manifest.json'])for(const base of new Set([owned,state.logicalCase]))sandbox.splice(sandbox.length-1,0,'--ro-bind',path.join(owned,rel),path.join(base,rel));
const log=value=>fs.appendFile(path.join(owned,'public-invocations.jsonl'),JSON.stringify({at:new Date().toISOString(),...value})+'\n');
const pre=spawnSync('bwrap',[...sandbox,process.execPath,path.join(H,'storage-preflight.mjs'),...args],{env,encoding:'utf8'});
await log({event:'preflight',args,code:pre.status,stdout:pre.stdout,stderr:pre.stderr});assert.equal(pre.status,0,'Effective-store preflight refused');
if(!state.first_public_start){state.first_public_start=new Date().toISOString();state.setup_deadline=new Date(Date.now()+60*60000).toISOString();await fs.writeFile(path.join(owned,'run-state.json'),JSON.stringify(state,null,2)+'\n');}
assert(Date.now()<Date.parse(state.setup_deadline),'Prepared setup budget exhausted');
await log({event:'start',args,administrator,artifact_tree:state.artifact_tree,source_build_manifest:path.join(F,'source-build-manifest.json'),environment_names:Object.keys(env).sort()});
const outputPath=path.join(owned,'logs','command-'+Date.now()+'-'+randomUUID().slice(0,6)+'.log');
const capture=process.stdout.isTTY?undefined:createWriteStream(outputPath,{flags:'wx',mode:0o600});
await log({event:'output',path:capture?outputPath:'external script(1) terminal recording'});
const child=spawn('bwrap',[...sandbox,process.execPath,path.join(F,'installed/node_modules/@synapsor/runner/dist/cli.js'),...args],{env,stdio:capture?['inherit','pipe','pipe']:'inherit'});
if(capture){child.stdout.on('data',data=>{process.stdout.write(data);capture.write(data);});child.stderr.on('data',data=>{process.stderr.write(data);capture.write(data);});}
await log({event:'owned_process',pid:child.pid,wrapper_pid:process.pid});
const timer=setTimeout(()=>child.kill('SIGTERM'),Math.min(Date.parse(state.setup_deadline)-Date.now(),180000));
for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,()=>child.kill(signal));
const result=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal}));});
clearTimeout(timer);if(capture)await new Promise(resolve=>capture.end(resolve));await log({event:'exit',...result});process.exitCode=result.code??1;
