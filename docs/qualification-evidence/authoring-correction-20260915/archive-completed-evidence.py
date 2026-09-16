"""Archive only completed task evidence, with exact hashes; preserve every failed attempt."""
from pathlib import Path
import os, json, hashlib, shutil, datetime, sys, re
os.umask(0o077)
E=Path(__file__).resolve().parent
O=Path(json.loads((E/'assignment-plan.json').read_text())['owned_root'])
phase=sys.argv[1];assert phase in ['development','stable','closure']
D=O/'verification-archive';D.mkdir(exist_ok=True)
indexfile=E/'verification-evidence-index.json'
records=json.loads(indexfile.read_text())['records'] if indexfile.exists() else []
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
exits=[]
for p in sorted(E.glob('*-exit.json')):
 r=json.loads(p.read_text());assert 'exit_code' in r,'Still running: '+p.name
 log=E/(p.name.removesuffix('-exit.json')+'.log')
 r['summary_lines']=[line.strip() for line in log.read_text(errors='replace').splitlines() if re.match(r'\s*(Test Files|Tests|Duration)\s',line)] if log.exists() else next((x['summary_lines'] for x in json.loads((E/'verification-attempts.json').read_text()) if x['name']==r['name']),[]) if (E/'verification-attempts.json').exists() else []
 exits.append(r)
files=[*E.glob('*.log'),*E.glob('*-source.json'),*E.glob('*-source-after.json')]
for p in E.iterdir():
 if p.is_dir() and (E/(p.name+'-exit.json')).exists():files+=list(p.rglob('*'))
for p in sorted(files):
 if not p.is_file():continue
 rel=p.relative_to(E);target=D/rel;assert not target.exists();target.parent.mkdir(parents=True,exist_ok=True)
 shutil.copy2(p,target);assert sha(target)==sha(p);target.chmod(0o400)
 records.append({'relative_path':str(rel),'saved_path':str(target),'sha256':sha(target),'bytes':target.stat().st_size,'phase':phase})
 p.unlink()
for p in E.iterdir():
 if p.is_dir() and (E/(p.name+'-exit.json')).exists():
  for sub in sorted(p.rglob('*'),reverse=True):
   if sub.is_dir():sub.rmdir()
  p.rmdir()
manifest=D/('MANIFEST-'+phase+'.json');assert not manifest.exists();manifest.write_text(json.dumps(records,indent=2)+'\n');manifest.chmod(0o400)
indexfile.write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'archive_root':str(D),'manifest':str(manifest),'manifest_sha256':sha(manifest),'records':records},indent=2)+'\n')
(E/'verification-attempts.json').write_text(json.dumps(exits,indent=2)+'\n')
print(json.dumps({'attempts':len(exits),'retained_files':len(records),'archive':str(D)}))
