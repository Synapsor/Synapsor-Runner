"""Save and stop the completed explicit backend gate's owned database only."""
from pathlib import Path
import json,os,subprocess,hashlib,datetime,sys
os.umask(0o077)
e=Path(__file__).resolve().parent;o=Path(json.loads((e/'assignment-plan.json').read_text())['owned_root'])
f=json.loads((e/'postgres-test-fixture.json').read_text()); final=sys.argv[1:]==['final']
for n in (['final-postgres03','final-pg-four02'] if final else ['final-postgres','final-postgres02','final-pg-four']):
 r=json.loads((e/(n+'-exit.json')).read_text());assert r['exit_code']==0 and r['source_unchanged']
s=json.loads((e/'stable-full-exit.json').read_text());assert not s['owned_postgres_database_url_enabled']
i=json.loads(subprocess.check_output(['docker','inspect',f['name']]))[0]
assert i['Id']==f['id'] and i['State']['Running'] and i['HostConfig']['NetworkMode']=='none'
assert i['Config']['Labels']['synapsor.qualification']==f['label']=='attached-policy-reconciliation-20260913'
d=o/'closure'/('backend-tests-final' if final else 'backend-tests');d.mkdir(parents=True)
(d/'container-before.json').write_text(json.dumps(i,indent=2)+'\n')
with (d/'source.dump').open('xb') as out:subprocess.run(['docker','exec',f['name'],'pg_dump','-U','postgres','-Fc',f['database']],stdout=out,check=True,timeout=60)
with (d/'postgres.log').open('xb') as out:subprocess.run(['docker','logs',f['name']],stdout=out,stderr=subprocess.STDOUT,check=True,timeout=30)
hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in d.iterdir()}
s=subprocess.run(['docker','stop','--time','10',f['name']],capture_output=True,text=True,timeout=30)
after=json.loads(subprocess.check_output(['docker','inspect',f['name']]))[0];assert s.returncode==0 and after['Id']==f['id'] and not after['State']['Running']
(d/'container-after.json').write_text(json.dumps(after,indent=2)+'\n')
r={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'container':f['name'],'id':f['id'],'saved_before_stop':hashes,'stop_exit':s.returncode,'running_after':False,'saved':str(d),'removed':False,'original_containers_touched':False}
(e/('backend-owned-cleanup-final.json' if final else 'backend-owned-cleanup.json')).write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r))
