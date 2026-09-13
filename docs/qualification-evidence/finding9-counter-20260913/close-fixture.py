from pathlib import Path
import subprocess,json,datetime,sys
root=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/finding9-counter-454a0d2-20260913')
launcher=Path(__file__).with_name('launch-installed.py')
for name,args in [('worker-final',['worker','status','--config','./synapsor.actions.runner.json']),('receipts-final',['receipts','list','--details','--config','./synapsor.actions.runner.json']),('conflict-lifecycle',['lifecycle','show','wrp_rule_8cbba2a704ca24b285ab6d55548e2d34','--json','--config','./synapsor.actions.runner.json'])]:
 r=subprocess.run([sys.executable,str(launcher),*args],capture_output=True)
 (root/'logs'/f'{name}.stdout').write_bytes(r.stdout);(root/'logs'/f'{name}.stderr').write_bytes(r.stderr)
 (root/'logs'/f'{name}.exit.json').write_text(json.dumps({'args':args,'exit_code':r.returncode},indent=2)+'\n');r.check_returncode()
r=subprocess.run([sys.executable,str(Path(__file__).with_name('snapshot.py')),'final-before-stop'],capture_output=True);print(r.stdout.decode());r.check_returncode()
c=json.loads((root/'fixture/container.json').read_text());i=json.loads(subprocess.check_output(['docker','inspect',c['id']]))[0]
assert i['Id']==c['id'] and i['Config']['Labels']['synapsor.qualification']==c['label'] and i['HostConfig']['NetworkMode']=='none'
(root/'logs/container-final.log').write_bytes(subprocess.check_output(['docker','logs',c['id']],stderr=subprocess.STDOUT))
subprocess.run(['docker','stop',c['id']],check=True,capture_output=True)
after=json.loads(subprocess.check_output(['docker','inspect',c['id']]))[0];assert not after['State']['Running']
result={'closed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'container_id':c['id'],'network':'none','running':after['State']['Running'],'exit_code':after['State']['ExitCode'],'worker_runs':'three finite --supervised --once invocations, all exited','source_and_store_snapshot':str(root/'checkpoints/final-before-stop'),'retained_blocked_proposal':'wrp_rule_8cbba2a704ca24b285ab6d55548e2d34','fixture_attempts':1,'provider_calls':0}
(root/'cleanup.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
