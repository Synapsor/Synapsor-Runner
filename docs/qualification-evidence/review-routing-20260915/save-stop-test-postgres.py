"""Save and stop the owned review/domain test database by exact owned identity."""
from pathlib import Path
import os,json,subprocess,hashlib,datetime
os.umask(0o077)
E=Path(__file__).resolve().parent;O=Path(json.loads((E/'assignment-plan.json').read_text())['owned_root']);d=json.loads((O/'private/live-postgres.json').read_text());info=json.loads(subprocess.check_output(['docker','inspect',d['name']]))[0]
assert info['Id']==d['id'] and info['Config']['Labels']['synapsor.qualification']==d['label']=='review-routing-20260915' and info['HostConfig']['NetworkMode']=='none' and info['State']['Running']
D=O/'closure/test-postgres';D.mkdir(parents=True)
with (D/'source.dump').open('xb') as f:subprocess.run(['docker','exec',d['name'],'pg_dump','-U','postgres','-Fc',d['database']],stdout=f,check=True,timeout=60)
with (D/'postgres.log').open('xb') as f:subprocess.run(['docker','logs',d['name']],stdout=f,stderr=subprocess.STDOUT,check=True,timeout=30)
r={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'name':d['name'],'id':d['id'],'saved':str(D),'before_stop_hashes':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in D.iterdir()},'removed':False}
subprocess.run(['docker','stop','--time','10',d['name']],capture_output=True,check=True,timeout=30);after=json.loads(subprocess.check_output(['docker','inspect',d['name']]))[0];assert after['Id']==d['id'] and not after['State']['Running'];r['running_after']=False
(E/'test-postgres-cleanup.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r))
