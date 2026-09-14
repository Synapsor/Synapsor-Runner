from pathlib import Path
import json,subprocess,hashlib,datetime,os,sys
os.umask(0o077)
E=Path(__file__).resolve().parent;O=Path(json.loads((E/'assignment-plan.json').read_text())['owned_root'])
suffix='02' if sys.argv[1:]==['02'] else ''
for n in ['final-postgres'+suffix,'final-review-postgres'+suffix]:
 result=json.loads((E/(n+'-exit.json')).read_text());assert result['exit_code']==0 and result['source_unchanged']
f=json.loads((E/'postgres-test-fixture.json').read_text());i=json.loads(subprocess.check_output(['docker','inspect',f['name']]))[0]
assert i['Id']==f['id'] and i['State']['Running'] and i['HostConfig']['NetworkMode']=='none'
assert i['Config']['Labels']['synapsor.qualification']==f['label']=='counting-contract-review-20260914'
D=O/('closure/backend'+suffix);D.mkdir(parents=True)
(D/'container-before.json').write_text(json.dumps(i,indent=2)+'\n')
with (D/'source.dump').open('xb') as out:subprocess.run(['docker','exec',f['name'],'pg_dump','-U','postgres','-Fc',f['database']],stdout=out,check=True,timeout=60)
with (D/'postgres.log').open('xb') as out:subprocess.run(['docker','logs',f['name']],stdout=out,stderr=subprocess.STDOUT,check=True,timeout=30)
hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in D.iterdir()}
r=subprocess.run(['docker','stop','--time','10',f['name']],capture_output=True,text=True,timeout=30);assert r.returncode==0
a=json.loads(subprocess.check_output(['docker','inspect',f['name']]))[0];assert a['Id']==f['id'] and not a['State']['Running']
(D/'container-after.json').write_text(json.dumps(a,indent=2)+'\n')
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'container':f['name'],'id':f['id'],'saved':str(D),'saved_before_stop':hashes,'stop_exit':r.returncode,'running_after':False,'removed':False,'original_containers_touched':False}
(E/('backend-cleanup'+suffix+'.json')).write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
