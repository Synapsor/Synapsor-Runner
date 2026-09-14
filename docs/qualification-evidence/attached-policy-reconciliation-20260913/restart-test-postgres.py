from pathlib import Path
import json,subprocess,datetime,time
E=Path(__file__).resolve().parent;f=json.loads((E/'postgres-test-fixture.json').read_text());i=json.loads(subprocess.check_output(['docker','inspect',f['name']]))[0]
assert i['Id']==f['id'] and not i['State']['Running'] and i['HostConfig']['NetworkMode']=='none'
assert i['Config']['Labels']['synapsor.qualification']==f['label']=='attached-policy-reconciliation-20260913'
assert json.loads((E/'backend-owned-cleanup.json').read_text())['stop_exit']==0
r=subprocess.run(['docker','start',f['name']],capture_output=True,text=True,timeout=30);assert r.returncode==0
for attempt in range(30):
 ready=subprocess.run(['docker','exec',f['name'],'pg_isready','-U','postgres','-d',f['database']],capture_output=True,timeout=5)
 if ready.returncode==0:break
 time.sleep(.25)
assert ready.returncode==0
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'name':f['name'],'id':f['id'],'restart_exit':r.returncode,'readiness_exit':ready.returncode,'reason':'Current-source gates after the reproduced client-duty routing correction; previous stopped database dump/logs remain retained. Same owned test database, no original fixture or preserved failure store touched.'}
(E/'backend-owned-restart.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
