// Normal packaged CLI in a PTY. The only injection is the existing nonmutating
// provider observer; all policy edits/reviews still use the public operator UI.
import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseEnv} from 'node:util';import {spawn,spawnSync,execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';import assert from 'node:assert/strict';
import {qualificationSandboxArguments,qualificationEnvironment} from '../../../scripts/qualification-sandbox.mjs';
import {budget} from './phase-budget.mjs';
process.umask(0o077);
const E=path.dirname(fileURLToPath(import.meta.url)),plan=JSON.parse(await fs.readFile(path.join(E,'assignment-plan.json'))),O=plan.owned_root;
const [runId,...args]=process.argv.slice(2);assert(/^(counting-wording-control|recovery-tournament-(original|assisted)|recovery-software|edit-tournament|fresh-(tournament|software))$/.test(runId));
assert(process.stdin.isTTY&&process.stdout.isTTY);assert(!args.some(a=>/postgres(?:ql)?:\/\/|sk-|--api-key/.test(a)));
const owned=path.join(O,'runs',runId),statePath=path.join(owned,'run-state.json'),state=JSON.parse(await fs.readFile(statePath));
const F=plan.frozen_root,manifest=JSON.parse(await fs.readFile(path.join(F,'installed-artifact-manifest.json'))),H=plan.trial_harness_root;
assert.equal(state.artifact_tree,manifest.installed_tree_sha256);execFileSync(process.execPath,[path.join(F,'freeze-repair.mjs'),'--verify'],{stdio:'pipe'});
const inputManifest=JSON.parse(await fs.readFile(path.join(owned,'frozen-input-manifest.json')));
for(const r of inputManifest.records)assert.equal(createHash('sha256').update(await fs.readFile(path.join(owned,r.path))).digest('hex'),r.sha256);
const connection=JSON.parse(await fs.readFile(path.join(owned,'private/connection.json'))),ci=JSON.parse(execFileSync('docker',['inspect',connection.container],{encoding:'utf8'}))[0];
assert.equal(ci.Id,connection.container_id);assert.equal(ci.Config.Labels['synapsor.qualification'],connection.label);assert.equal(ci.HostConfig.NetworkMode,'none');assert(ci.State.Running);
const lock=path.join(O,'one-public-run.lock');await fs.mkdir(lock);let child,timer;
const log=x=>fs.appendFile(path.join(owned,'public-invocations.jsonl'),JSON.stringify({at:new Date().toISOString(),...x})+'\n');
try {
 const meter=path.join(owned,'meter'),meterPath=path.join(meter,'plan.json');
 const secrets=parseEnv(await fs.readFile('/home/sandesh-tiwari/Desktop/Customer Service With Synapsor Runner/.env','utf8'));assert(secrets.OPENAI_API_KEY);
 const env=qualificationEnvironment({...connection.env,OPENAI_API_KEY:secrets.OPENAI_API_KEY,NO_COLOR:'1',QUALIFICATION_MOUNT_PLAN:path.join(owned,'mount-plan.json'),QUALIFICATION_PROVIDER_METER:meter,NODE_OPTIONS:`--import=${pathToFileURL(path.join(H,'provider-meter.mjs')).href}`});
 const mounts=state.checkpoint?[{logical:state.logicalCase,physical:owned}]:[];
 const sandbox=await qualificationSandboxArguments({ownedRoot:owned,mounts,cwd:state.logicalProject,home:path.join(owned,'home')});
 sandbox.splice(sandbox.length-1,0,'--ro-bind',connection.socket,connection.logicalSocket,'--bind',path.join(owned,'var-tmp'),'/var/tmp','--setenv','NO_COLOR','1');
 for(const rel of ['authoring-input','private','verifier','schema.sql','case.json','frozen-input-manifest.json'])for(const base of new Set([owned,state.logicalCase]))sandbox.splice(sandbox.length-1,0,'--ro-bind',path.join(owned,rel),path.join(base,rel));
 assert.equal(spawnSync('stty',['cols','150','rows','46'],{stdio:'inherit'}).status,0);
 const preEnv={...env}; for(const key of ['OPENAI_API_KEY','NODE_OPTIONS','QUALIFICATION_PROVIDER_METER'])delete preEnv[key];
 const pre=spawnSync('bwrap',[...sandbox,process.execPath,path.join(H,'storage-preflight.mjs'),...args],{env:preEnv,encoding:'utf8'});
 await log({event:'preflight',args,code:pre.status,stdout:pre.stdout,stderr:pre.stderr});assert.equal(pre.status,0,'Effective-store preflight refused before writable application open');
 const phaseState=await budget(runId);Object.assign(state,phaseState.state);
 const meterPlan=JSON.parse(await fs.readFile(meterPath));assert(Date.now()<Date.parse(meterPlan.deadline),'Existing phase budget exhausted; preserve it, never reset');
 const invocationDeadline=new Date(Math.min(Date.parse(meterPlan.deadline),Date.now()+600000)).toISOString();
 await log({event:'start',authoring:true,args,artifact_tree:manifest.installed_tree_sha256,phase:state.phase,deadline:meterPlan.deadline,invocation_deadline:invocationDeadline,maximum_provider_attempts:meterPlan.maximum_attempts,environment_names:Object.keys(env).sort()});
 child=spawn('bwrap',[...sandbox,process.execPath,path.join(F,'installed/node_modules/@synapsor/runner/dist/cli.js'),...args],{env,stdio:'inherit'});
 await log({event:'owned_process',pid:child.pid,wrapper_pid:process.pid});timer=setTimeout(()=>child.kill('SIGTERM'),Date.parse(invocationDeadline)-Date.now());
 for(const sig of ['SIGINT','SIGTERM','SIGHUP'])process.on(sig,()=>child.kill(sig));
 const result=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal}));});await log({event:'exit',...result});process.exitCode=result.code??1;
}finally{clearTimeout(timer);await fs.rmdir(lock);}
