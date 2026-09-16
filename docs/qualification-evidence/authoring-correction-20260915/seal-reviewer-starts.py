"""Seal untouched matched checkpoints; never copy development decisions into final starts."""
from pathlib import Path
import json, shutil, hashlib, os, datetime
os.umask(0o077)
E=Path(__file__).resolve().parent;plan=json.loads((E/'assignment-plan.json').read_text());O=Path(plan['owned_root']);D=O/'clean-starts';D.mkdir()
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
records=[]
for name,selected in plan['case_sources'].items():
 src=Path(selected['checkpoint_root']);dest=D/name;dest.mkdir()
 for item in ['project','project-manifest.json','source.dump','source-readback.json']:
  p=src/item;q=dest/item
  if p.is_dir():shutil.copytree(p,q)
  else:shutil.copy2(p,q)
 expected=json.loads((dest/'project-manifest.json').read_text())
 assert sorted(r['path'] for r in expected)==sorted(str(p.relative_to(dest/'project')) for p in (dest/'project').rglob('*') if p.is_file())
 for r in expected:assert sha(dest/'project'/r['path'])==r['sha256']
 source=json.loads((dest/'source-readback.json').read_text());assert sum(map(len,source.values()))==104
 for p in sorted(dest.rglob('*'),reverse=True):
  assert not p.is_symlink()
  if p.is_file():p.chmod((p.stat().st_mode&0o555)|0o400);records.append({'path':str(p.relative_to(D)),'sha256':sha(p),'mode':p.stat().st_mode&0o777})
  elif p.is_dir():p.chmod(0o500)
 dest.chmod(0o500)
manifest=D/'MANIFEST.json';manifest.write_text(json.dumps(records,indent=2)+'\n');manifest.chmod(0o400);D.chmod(0o500)
(E/'reviewer-starts.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'root':str(D),'manifest_sha256':sha(manifest),'files':len(records),'source_rows_each':104,'baseline':'A current ownership, B untouched v2; same prior checkpoints, no development decisions'},indent=2)+'\n')
print(json.dumps({'root':str(D),'files':len(records),'rows':104}))
