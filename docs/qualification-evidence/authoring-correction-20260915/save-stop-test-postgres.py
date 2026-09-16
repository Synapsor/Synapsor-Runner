"""Dump completed owned gate state before stopping its exact container."""
from pathlib import Path
import json, os, subprocess, datetime, hashlib
os.umask(0o077)
E=Path(__file__).resolve().parent
O=Path(json.loads((E/'assignment-plan.json').read_text())['owned_root'])
fixture=json.loads((O/'private/live-postgres.json').read_text())
for name in ['postgres-domain','postgres-assignment']:
    result=json.loads((E/(name+'-exit.json')).read_text())
    assert 'exit_code' in result, 'Do not stop a database still used by a gate'
# Every started local gate must have an actual completed result before cleanup.
for record in E.glob('postgres-*-exit.json'):
    assert 'exit_code' in json.loads(record.read_text()), 'Unfinished PostgreSQL gate: '+record.name
info=json.loads(subprocess.check_output(['docker','inspect',fixture['name']]))[0]
assert info['Id']==fixture['id'] and info['State']['Running']
assert info['Config']['Labels']['synapsor.qualification']==fixture['label']=='authoring-correction-20260915'
assert info['HostConfig']['NetworkMode']=='none'
destination=O/'closure/test-postgres';destination.mkdir(parents=True)
(destination/'container-before.json').write_text(json.dumps(info,indent=2)+'\n')
with (destination/'source.dump').open('xb') as out:
    subprocess.run(['docker','exec',fixture['name'],'pg_dump','-U','postgres','-Fc',fixture['database']],stdout=out,check=True,timeout=60)
with (destination/'postgres.log').open('xb') as out:
    subprocess.run(['docker','logs',fixture['name']],stdout=out,stderr=subprocess.STDOUT,check=True,timeout=30)
hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in destination.iterdir()}
stop=subprocess.run(['docker','stop','--time','10',fixture['name']],capture_output=True,text=True,timeout=30)
after=json.loads(subprocess.check_output(['docker','inspect',fixture['name']]))[0]
assert stop.returncode==0 and after['Id']==fixture['id'] and not after['State']['Running']
(destination/'container-after.json').write_text(json.dumps(after,indent=2)+'\n')
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'container':fixture['name'],'id':fixture['id'],
        'saved_before_stop':hashes,'directory':str(destination),'exit_code':stop.returncode,'running_after':False,'removed':False}
(E/'test-postgres-cleanup.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
