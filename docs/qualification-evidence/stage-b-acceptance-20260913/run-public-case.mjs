// Public PTY launcher adapted from the retained isolation-first authoring driver.
// Only qualification environment/recording changes; the installed CLI is intact.
import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import {parseEnv} from 'node:util';import {spawn,spawnSync,execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';import assert from 'node:assert/strict';
import {qualificationSandboxArguments,qualificationEnvironment} from '../../../scripts/qualification-sandbox.mjs';
process.umask(0o077);
const E=path.dirname(fileURLToPath(import.meta.url)),plan=JSON.parse(await fs.readFile(path.join(E,'assignment-plan.json'))),O=plan.owned_root;
const [name,...args]=process.argv.slice(2);assert(['tournament-ratification','software-release-sealing'].includes(name));assert(process.stdin.isTTY&&process.stdout.isTTY,'Normal public terminal required');
assert(!args.some(a=>/postgres(?:ql)?:\/\/|sk-|--api-key/.test(a)));
const accepted=JSON.parse(await fs.readFile(path.join(E,'external-acceptance.json')));assert.equal(accepted.status,'ACCEPTED_NO_MATERIAL_BLOCKER');assert.equal(accepted.candidate_tree,plan.candidate_tree);
const owned=path.join(O,'cases',name),project=path.join(owned,'project'),F=path.join(plan.prior_owned_root,'frozen'),H=path.join(O,'trial-harness');
execFileSync(process.execPath,[path.join(F,'freeze-repair.mjs'),'--verify'],{stdio:'pipe'});
const inputManifest=JSON.parse(await fs.readFile(path.join(owned,'frozen-input-manifest.json')));for(const r of inputManifest.records)assert.equal(createHash('sha256').update(await fs.readFile(path.join(owned,r.path))).digest('hex'),r.sha256);
const privateRecord=JSON.parse(await fs.readFile(path.join(O,'fixture-validation',name+'-private-connection.json')));
const inspected=JSON.parse(execFileSync('docker',['inspect',privateRecord.container],{encoding:'utf8'}))[0];assert.equal(inspected.Id,privateRecord.container_id);assert(inspected.State.Running);assert.equal(inspected.Config.Labels['synapsor.qualification'],'stage-b-fixture-preparation-20260913');assert.equal(inspected.HostConfig.NetworkMode,'none');
const lock=path.join(O,'one-public-case.lock');await fs.mkdir(lock);let child,timer;
const log=x=>fs.appendFile(path.join(owned,'public-invocations.jsonl'),JSON.stringify({at:new Date().toISOString(),...x})+'\n');
try{
 const statePath=path.join(owned,'trial-state.json'),state=JSON.parse(await fs.readFile(statePath));
 if(!state.first_public_start){state.first_public_start=new Date().toISOString();state.phase='initial_onboarding';state.initial_authoring_runs=1;state.initial_setup_deadline=new Date(Date.now()+75*60000).toISOString();state.total_deadline=new Date(Date.now()+180*60000).toISOString();state.status='RUNNING';await fs.writeFile(statePath,JSON.stringify(state,null,2)+'\n');}
 assert(Date.now()<Date.parse(state.total_deadline),'Existing total case budget exhausted; never reset');
 const meter=path.join(owned,'meter');await fs.mkdir(meter,{recursive:true});const planPath=path.join(meter,'plan.json');
 try{await fs.writeFile(planPath,JSON.stringify({started_at:state.first_public_start,maximum_attempts:50,maximum_case_attempts:80,reserved_editing_attempts:30,deadline:state.initial_setup_deadline,hosts:['api.openai.com'],capture_sanitized_inputs:true,private_values_file:path.join(owned,'private/forbidden-provider-values.json')},null,2)+'\n',{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
 const meterPlan=JSON.parse(await fs.readFile(planPath));assert(Date.now()<Date.parse(meterPlan.deadline),'Current declared phase ended; preserve its result before proceeding');
 const creds=parseEnv(await fs.readFile('/home/sandesh-tiwari/Desktop/Customer Service With Synapsor Runner/.env','utf8'));assert(creds.OPENAI_API_KEY);
 const env=qualificationEnvironment({...privateRecord.env,OPENAI_API_KEY:creds.OPENAI_API_KEY,NO_COLOR:'1',QUALIFICATION_MOUNT_PLAN:path.join(owned,'mount-plan.json'),QUALIFICATION_PROVIDER_METER:meter,NODE_OPTIONS:`--import=${pathToFileURL(path.join(H,'provider-meter.mjs')).href}`});
 // No runtime identity or operator role values are inherited into authoring.
 // A later public review command can use only the already supported local
 // operator configuration, prepared separately with its actual confirmation.
 const sandbox=await qualificationSandboxArguments({ownedRoot:owned,cwd:project,home:path.join(owned,'home')});
 const tmp=path.join(owned,'var-tmp');await fs.mkdir(tmp,{recursive:true});sandbox.splice(sandbox.length-1,0,'--ro-bind',privateRecord.socket,privateRecord.socket,'--bind',tmp,'/var/tmp','--setenv','NO_COLOR','1');
 for(const rel of ['authoring-input','private','verifier','schema.sql','case.json','frozen-input-manifest.json',...(await fs.stat(path.join(owned,'checkpoints')).catch(()=>null)?['checkpoints']:[])])sandbox.splice(sandbox.length-1,0,'--ro-bind',path.join(owned,rel),path.join(owned,rel));
 assert.equal(spawnSync('stty',['cols','150','rows','46'],{stdio:'inherit'}).status,0);
 const pre=spawnSync('bwrap',[...sandbox,process.execPath,path.join(H,'storage-preflight.mjs'),...args],{env,encoding:'utf8'});
 await log({event:'preflight',args,code:pre.status,stdout:pre.stdout,stderr:pre.stderr});assert.equal(pre.status,0,'Effective-store isolation refused before application writable open');
 await log({event:'start',args,artifact_tree:plan.candidate_tree,accepted_report_sha256:accepted.report_sha256,phase:state.phase,phase_deadline:meterPlan.deadline,maximum_provider_attempts:meterPlan.maximum_attempts,environment_names:Object.keys(env).sort()});
 child=spawn('bwrap',[...sandbox,process.execPath,path.join(F,'installed/node_modules/@synapsor/runner/dist/cli.js'),...args],{env,stdio:'inherit'});await log({event:'owned_process',pid:child.pid,wrapper_pid:process.pid});
 timer=setTimeout(()=>child.kill('SIGTERM'),Date.parse(meterPlan.deadline)-Date.now());for(const sig of ['SIGINT','SIGTERM','SIGHUP'])process.on(sig,()=>child.kill(sig));
 const result=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal}));});await log({event:'exit',...result});process.exitCode=result.code??1;
}finally{clearTimeout(timer);await fs.rmdir(lock);}
