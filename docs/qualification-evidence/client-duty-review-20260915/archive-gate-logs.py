"""Retain complete gate logs outside Git; no partial log is archived as complete."""
from pathlib import Path
import json,hashlib,shutil,os,datetime
os.umask(0o077)
E=Path(__file__).resolve().parent;plan=json.loads((E/'assignment-plan.json').read_text());O=Path(plan['owned_root']);D=O/'verification-logs';D.mkdir()
assert json.loads((E/'finish-stable-full03-gates.json').read_text()).get('completed_at')
records=[]
for f in sorted(E.glob('*.log')):
    target=D/f.name;shutil.copy2(f,target);target.chmod(0o400)
    records.append({'name':f.name,'bytes':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'saved_path':str(target)})
for f in sorted(Path('/var/tmp').glob('client-duty-*-driver.log')):
    assert f.is_file() and not f.is_symlink() and f.stat().st_uid==os.getuid()
    target=D/f.name;shutil.copy2(f,target);target.chmod(0o400)
    records.append({'name':f.name,'bytes':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'saved_path':str(target),'kind':'task wrapper output'})
(D/'MANIFEST.json').write_text(json.dumps(records,indent=2)+'\n');(D/'MANIFEST.json').chmod(0o400);D.chmod(0o500)
(E/'gate-log-index.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'root':str(D),'manifest_sha256':hashlib.sha256((D/'MANIFEST.json').read_bytes()).hexdigest(),'records':records},indent=2)+'\n')
print(json.dumps({'logs':len(records),'root':str(D)}))
