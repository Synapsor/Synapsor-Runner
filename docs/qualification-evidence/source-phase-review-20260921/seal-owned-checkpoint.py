"""Read-only checkpoint of a verified owned project and matching source. No cleanup."""
from pathlib import Path
import os,sys,json,subprocess,hashlib,datetime
os.umask(0o077)
root=Path(sys.argv[1]).resolve();label=sys.argv[2]
assert root.name=='main-A-final' and label in ['untouched','review-complete-before-publication','final']
fixture=json.loads((root/'fixture.json').read_text());owned=json.loads((root/'private/container.json').read_text())
info=json.loads(subprocess.check_output(['docker','inspect',owned['name']]))[0]
assert info['Id']==owned['id'] and info['Config']['Labels']['synapsor.task']=='source-phase-review-20260921' and info['State']['Running']
plan=json.loads((root/'LAUNCH-PLAN.json').read_text())
pre=subprocess.run(['bwrap']+plan['sandbox_args']+['node',plan['preflight'],plan['logical_project']],capture_output=True)
assert pre.returncode==0,'Effective-store preflight failed; no checkpoint opened'
out=root.parent/'sealed-checkpoints'/root.name/label;out.mkdir(parents=True)
(out/'effective-store-preflight.json').write_bytes(pre.stdout)
db=fixture['database_destination']['database']
for name,args in [('source.dump',['pg_dump','-Fc','-U','postgres','-d',db]),('source-schema-acl.sql',['pg_dump','--schema-only','-U','postgres','-d',db]),('roles-without-passwords.sql',['pg_dumpall','--roles-only','--no-role-passwords','-U','postgres'])]:
 with (out/name).open('xb') as f:subprocess.run(['docker','exec',owned['name']]+args,stdout=f,check=True)
subprocess.run(['tar','-czf',str(out/'whole-project-home.tgz'),'-C',str(root),'project','home'],check=True)
for name in ['fixture.json','RESTORE-VERDICT.json','all-table-before.json']:
 if (root/name).is_file():(out/name).write_bytes((root/name).read_bytes())
files=[{'path':p.name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size} for p in sorted(out.iterdir()) if p.is_file()]
manifest={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'label':label,'case':fixture['case'],'logical_project':plan['logical_project'],'container_id':owned['id'],'files':files,'authority_operations':0,'secret_handling':'Private archive; fresh credentials kept separately; role SQL excludes password hashes'}
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
for p in out.iterdir():os.chmod(p,0o400)
os.chmod(out,0o500)
print(json.dumps({'root':str(out),'manifest_sha256':hashlib.sha256((out/'manifest.json').read_bytes()).hexdigest(),'label':label,'read_only':True}))
