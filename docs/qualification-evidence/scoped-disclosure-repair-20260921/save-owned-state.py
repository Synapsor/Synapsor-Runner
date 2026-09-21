"""Preserve labelled task state before stopping only its recorded container."""
from pathlib import Path
import json, os, sys, subprocess, hashlib, datetime
os.umask(0o077)
root=Path(sys.argv[1]).resolve(); assert root.name in ['main-A-reproduction','main-A-development','main-A-final']
fixture=json.loads((root/'fixture.json').read_text()); name=fixture['container']
info=json.loads(subprocess.check_output(['docker','inspect',name]))[0]
owned=json.loads((root/'private/container.json').read_text())
assert info['Id']==owned['id'] and info['Config']['Labels']['synapsor.task']=='scoped-disclosure-repair-20260921'
out=root.parent/'owned-final-states'/root.name;out.mkdir(mode=0o700,parents=True)
with (out/'source.dump').open('wb') as f: subprocess.run(['docker','exec',name,'pg_dump','-Fc','-U','postgres','-d',fixture['database_destination']['database']],stdout=f,check=True)
with (out/'roles-without-passwords.sql').open('wb') as f: subprocess.run(['docker','exec',name,'pg_dumpall','--roles-only','--no-role-passwords','-U','postgres'],stdout=f,check=True)
with (out/'database.log').open('wb') as f: subprocess.run(['docker','logs',name],stdout=f,stderr=subprocess.STDOUT,check=True)
subprocess.run(['tar','-czf',str(out/'whole-project-home.tgz'),'-C',str(root),'project','home'],check=True)
subprocess.run(['tar','-czf',str(out/'evidence.tgz'),'-C',str(root),'operator-captures','state-readbacks','authoring-meter','harness','fixture.json','LAUNCH-PLAN.json','preflight-before-open.json'],check=True)
files=[{'file':p.name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size} for p in sorted(out.iterdir()) if p.is_file()]
(out/'manifest.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'container_id':info['Id'],'final_state_not_clean_start':True,'files':files},indent=2)+'\n')
assert '--stop' in sys.argv or '--save-only' in sys.argv, 'Declare save-only or owned-resource stop'
if '--save-only' in sys.argv:
 print(json.dumps({'root':str(out),'files':len(files),'stopped':False,'next':'verify archive restoration before owned stop'}));sys.exit(0)
subprocess.run(['docker','stop',name],capture_output=True,check=True)
assert not json.loads(subprocess.check_output(['docker','inspect',name]))[0]['State']['Running']
(out/'cleanup.json').write_text(json.dumps({'stopped_container':owned,'saved_before_stop':True,'removed':False},indent=2)+'\n')
print(json.dumps({'root':str(out),'files':len(files),'stopped':name}))
