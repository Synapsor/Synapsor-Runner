"""Hash retained raw verification artifacts without copying private content to Git."""
from pathlib import Path
import hashlib,json,datetime
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/worker-handoff-63aa664-20260920');e=Path(__file__).resolve().parent
entries=[]
# Full installation inventory is its own immutable manifest. Cache/tmp/credential
# and process-private source/configuration trees are not a public evidence index.
for p in sorted(r.rglob('*')):
 rel=p.relative_to(r)
 if not p.is_file() or p.is_symlink():continue
 if any(x in rel.parts for x in ['test-home','test-tmp','test-var-tmp','offline-home','package-tmp','package-var-tmp','installed','project','home','tmp','var-tmp']):continue
 if 'private' in p.name or p.name=='installed-artifact.tar.gz' or p.suffix=='.tgz':continue
 entries.append({'path':str(p),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
(e/'EVIDENCE-INDEX.json').write_text(json.dumps({'generated_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'raw_root':str(r),'note':'Hashes only; private fixture/state captures remain restricted at their owned paths. Installed tree has its separate complete file/mode/symlink manifest. Credentials and temporary trees excluded.','files':entries},indent=2)+'\n')
print(json.dumps({'files':len(entries),'path':str(e/'EVIDENCE-INDEX.json')}))
