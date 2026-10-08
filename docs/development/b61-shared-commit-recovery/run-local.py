#!/usr/bin/env python3
"""Owned finite build/focus only; no inherited Source/provider environment."""
import json,os,pathlib,subprocess,sys,time,uuid
W=pathlib.Path(__file__).resolve().parents[3]
E=pathlib.Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/authoring-reliability-20260930/authoring-dead-end-lab-20261002/operator-conversation-470/b61-shared-commit-recovery-20261007-v1')
name,mode=sys.argv[1:3]
if not name.replace('-','').isalnum() or mode not in ['build','intents','adapter','binding']:raise SystemExit('Known finite local checkpoint required')
record=E/name;record.mkdir(mode=0o700,parents=True,exist_ok=False)
owned=pathlib.Path('/var/tmp/synapsor-b61-recovery-local-'+uuid.uuid4().hex[:8]);owned.mkdir(mode=0o700)
for n in ['home','tmp','.git']:(owned/n).mkdir(mode=0o700)
env={'PATH':os.environ['PATH'],'HOME':str(owned/'home'),'TMPDIR':str(owned/'tmp'),'CI':'1','COREPACK_ENABLE_NETWORK':'0'}
if mode=='build':args=['node',str(W/'node_modules/typescript/bin/tsc'),'-b','packages/postgres','packages/proposal-store','--force','--pretty','false']
else:
 config=owned/'vitest.config.mjs';config.write_text('export default '+json.dumps({'root':str(W),'cacheDir':str(owned/'vite-cache'),'test':{'pool':'forks','isolate':True,'minWorkers':1,'maxWorkers':1,'fileParallelism':False,'testTimeout':30000}})+';\n')
 args=['node',str(W/'node_modules/vitest/vitest.mjs'),'run','--config',str(config),'--reporter=json','--outputFile',str(record/'vitest.json')]
 if mode=='binding':args+=['packages/postgres/src/source-completion-binding.test.ts']
 elif mode=='adapter':args+=['packages/postgres/src/connection-lifetime.test.ts','packages/postgres/src/index.test.ts','packages/postgres/src/atomic-updates.test.ts']
 else:args+=['packages/proposal-store/src/index.test.ts','-t','retains an original Source binding|persists fleet writeback intents|round-trips protocol-v3 writeback intents|requires reconciliation after an incomplete|records a signed reconciliation']
cmd=['bwrap','--unshare-net','--bind','/','/','--dev','/dev','--proc','/proc','--chdir',str(W),*args]
(record/'COMMAND.json').write_text(json.dumps({'command':cmd,'env':env,'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=W,text=True).strip(),'scope':'one bounded local worker/no PG/provider'},indent=2)+'\n')
s=time.time()
with (record/'stdout.log').open('w') as o,(record/'stderr.log').open('w') as e:
 p=subprocess.Popen(cmd,env=env,cwd=W,stdin=subprocess.DEVNULL,stdout=o,stderr=e,start_new_session=True,umask=0o077);rc=p.wait()
r={'exit':rc,'seconds':time.time()-s,'pgid':p.pid,'owned':str(owned)}
(record/'RESULT.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r));raise SystemExit(rc)
