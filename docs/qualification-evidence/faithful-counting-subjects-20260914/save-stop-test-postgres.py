from pathlib import Path
import json,subprocess,hashlib,datetime,os
os.umask(0o077)
E=Path(__file__).resolve().parent;O=Path(json.loads((E/'assignment-plan.json').read_text())['owned_root']);c=json.loads((O/'private/live-postgres.json').read_text());i=json.loads(subprocess.check_output(['docker','inspect',c['name']]))[0]
assert i['Id']==c['id'] and i['Config']['Labels']['synapsor.qualification']=='faithful-counting-subjects-20260914' and i['HostConfig']['NetworkMode']=='none' and i['State']['Running']
R=O/'closure/live-postgres-tests';R.mkdir()
active=subprocess.check_output(['docker','exec',c['name'],'psql','-X','-U','postgres','-d',c['database'],'-At','-c',"SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'"]).decode().strip();assert active=='0',active
with (R/'source.dump').open('xb') as f:subprocess.run(['docker','exec',c['name'],'pg_dump','-U','postgres','-Fc',c['database']],stdout=f,check=True,timeout=60)
with (R/'postgres.log').open('xb')as f:subprocess.run(['docker','logs',c['name']],stdout=f,stderr=subprocess.STDOUT,check=True,timeout=30)
(R/'container-before.json').write_text(json.dumps(i,indent=2)+'\n');hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest()for p in R.iterdir()}
x=subprocess.run(['docker','stop','--time','10',c['name']],capture_output=True,text=True,timeout=30);assert x.returncode==0
j=json.loads(subprocess.check_output(['docker','inspect',c['name']]))[0];assert j['Id']==i['Id'] and not j['State']['Running']
v={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'container':c['name'],'id':c['id'],'label':c['label'],'active_clients_before_stop':0,'saved_before_stop':hashes,'directory':str(R),'stop_exit':0,'running_after':False,'removed':False};(E/'test-postgres-cleanup.json').write_text(json.dumps(v,indent=2)+'\n');(R/'stop-result.json').write_text(json.dumps(v,indent=2)+'\n');print(json.dumps(v))
