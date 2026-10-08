#!/usr/bin/env python3
"""Finite isolated native connector witness; never uses an inherited DB URL."""
import json,os,pathlib,subprocess,sys,time,uuid
W=pathlib.Path(__file__).resolve().parents[3]
E=pathlib.Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/authoring-reliability-20260930/authoring-dead-end-lab-20261002/operator-conversation-470/b61-shared-commit-recovery-20261007-v1')
name=sys.argv[1]
if not name.replace('-','').isalnum():raise SystemExit('Owned checkpoint name required')
case=sys.argv[2] if len(sys.argv)>2 else 'luna_atomic:source_db'
if case not in ['all','remaining','luna_atomic:runner_ledger','anchored_insert:source_db','ordinary_update:source_db','anchored_insert:runner_ledger','ordinary_update:runner_ledger','luna_atomic:source_db']:raise SystemExit('Known bounded case required')
variant=sys.argv[3] if len(sys.argv)>3 else 'standard'
if variant not in ['standard','crash_adoption','cleanup','legacy_absent','legacy_unwritable','rollback','process_concurrency']:raise SystemExit('Known native variant required')
record=E/name;record.mkdir(mode=0o700,parents=True,exist_ok=False)
owned=pathlib.Path('/var/tmp/synapsor-b61-recovery-owned-'+name+'-'+uuid.uuid4().hex[:8]);owned.mkdir(mode=0o700)
for p in [owned/'home',owned/'tmp']:p.mkdir(mode=0o700)
env={'PATH':os.environ['PATH'],'HOME':str(owned/'home'),'TMPDIR':str(owned/'tmp'),'CI':'1','COREPACK_ENABLE_NETWORK':'0','TSX_DISABLE_CACHE':'1','SYNAPSOR_B61_RECOVERY_LEASE':'1'}
cmd=['bwrap','--unshare-net','--bind','/','/','--dev','/dev','--proc','/proc','--chdir',str(W), 'node','--import',str(W/'node_modules/tsx/dist/loader.mjs'),str(W/'docs/development/b61-shared-commit-recovery/recovery-bench.mjs'),str(owned)]
cmd.extend([case,variant])
(record/'COMMAND.json').write_text(json.dumps({'command':cmd,'env':env,'product_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=W,text=True).strip(),'owned':str(owned),'lease':'Main finite max1live/serial process witness; no provider/outgoing network','case':case},indent=2)+'\n')
start=time.time()
with (record/'stdout.log').open('w') as out,(record/'stderr.log').open('w') as err:
 p=subprocess.Popen(cmd,cwd=W,env=env,stdin=subprocess.DEVNULL,stdout=out,stderr=err,start_new_session=True,umask=0o077)
 (record/'START.json').write_text(json.dumps({'pid':p.pid,'pgid':p.pid,'started_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())},indent=2)+'\n')
 print(json.dumps({'state':'BENCH_LAUNCHED','pid':p.pid,'record':str(record),'owned':str(owned),'case':case}),flush=True)
 code=p.wait()
result={'exit':code,'seconds':time.time()-start,'pgid':p.pid,'owned':str(owned),'state':'NATIVE_CLOSED','physical_fixture':'stop+preserve; no removal/reset/old history replay'}
(record/'RESULT.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result),flush=True)
raise SystemExit(code)
