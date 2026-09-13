"""Save the new fixture-only database state and stop only its owned container."""
from pathlib import Path
import os, json, subprocess, hashlib, datetime
os.umask(0o077)
E=Path(__file__).resolve().parent; plan=json.loads((E/'assignment-plan.json').read_text()); O=Path(plan['owned_root']); H=O/'fixture-validation'
metadata=json.loads((H/'postgres-fixture.json').read_text()); out=H/'saved-state';out.mkdir()
env={'PATH':os.environ['PATH'],'HOME':str(O/'verification-home'),'LANG':'C.UTF-8','NO_COLOR':'1'}
def run(args,**kw):return subprocess.run(args,check=True,env=env,**kw)
def inspect():
    x=json.loads(run(['docker','inspect',metadata['name']],capture_output=True,text=True).stdout)[0]
    assert x['Id']==metadata['id'] and x['Config']['Labels']['synapsor.qualification']=='stage-b-fixture-preparation-20260913'
    assert x['HostConfig']['NetworkMode']=='none'
    return x
before=inspect();assert before['State']['Running'];(out/'container-before.json').write_text(json.dumps(before,indent=2)+'\n')
processes=[]
for p in (O/'preflight').glob('*/result.json'):
    d=json.loads(p.read_text());pid=d.get('child_pid');assert d['status']=='passed' and d['exit_code']==0
    if pid:
        live=(Path('/proc')/str(pid)/'cmdline').exists();processes.append({'pid':pid,'result':str(p),'running':live});assert not live,'Inspect a surviving recorded process before cleanup; never kill by PID alone'
selection=json.loads((E/'case-selection.json').read_text());dumps=[]
for item in selection['cases']:
    case=Path(item['root']);manifest=json.loads((case/'frozen-input-manifest.json').read_text())
    for r in manifest['records']: assert hashlib.sha256((case/r['path']).read_bytes()).hexdigest()==r['sha256']
    assert not list((case/'project').iterdir()),'Authoring must not have started before external acceptance'
    db='stageb_'+item['id'].replace('-','_')
    active=run(['docker','exec',metadata['name'],'psql','-X','-At','-U','postgres','-d',db,'-c',"SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()"],capture_output=True,text=True)
    assert active.stdout.strip()=='0','Existing test still uses a fixture database; preserve it running'
    p=out/(db+'.dump')
    with p.open('xb') as f:run(['docker','exec',metadata['name'],'pg_dump','-U','postgres','-d',db,'--format=custom'],stdout=f,stderr=subprocess.PIPE)
    listing=run(['docker','exec','-i',metadata['name'],'pg_restore','--list'],input=p.read_bytes(),capture_output=True)
    (out/(db+'-contents.txt')).write_bytes(listing.stdout)
    dumps.append({'case':item['id'],'database':db,'path':str(p),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'pg_restore_list_exit':0,'fixture_inputs_unchanged':True,'project_empty':True})
roles=run(['docker','exec',metadata['name'],'pg_dumpall','-U','postgres','--globals-only','--no-role-passwords'],capture_output=True);(out/'roles-no-passwords.sql').write_bytes(roles.stdout)
logs=run(['docker','logs','--timestamps',metadata['name']],capture_output=True);(out/'postgres.stdout.log').write_bytes(logs.stdout);(out/'postgres.stderr.log').write_bytes(logs.stderr)
inspect();run(['docker','stop','--time','10',metadata['name']],capture_output=True)
after=inspect();assert not after['State']['Running'];(out/'container-stopped.json').write_text(json.dumps(after,indent=2)+'\n')
result={'saved_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'container':metadata['name'],'container_id':metadata['id'],'postgres_version':metadata['query']['version'],'image':metadata['image'],'network':'none','stop_exit_code':0,'removed':False,'running_after':False,'provider_children':processes,'dumps':dumps,'logs_saved_before_stop':True,'external_reviewer_smoke_executed':False,'stage_b_authoring_runs':0,'original_resources_touched':False}
for p in [out/'result.json',E/'fixture-pause.json']:p.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'stop_exit':0,'dumps':len(dumps),'stage_b_authoring_runs':0,'candidate_inputs_unchanged':True}))
