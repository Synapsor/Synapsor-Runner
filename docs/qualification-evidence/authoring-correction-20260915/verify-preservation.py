"""Read-only verification of prior and current sealed evidence."""
from pathlib import Path
import json,hashlib,subprocess,datetime,sys
E=Path(__file__).resolve().parent;plan=json.loads((E/'assignment-plan.json').read_text());O=Path(plan['owned_root'])
old=O.parent/'client-duty-review-f60dfa1-20260915';sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
for r in json.loads((E/'capture-index.json').read_text())['records']:assert sha(Path(r['path']))==r['sha256']
prior=json.loads((old/'public-evidence-manifest.json').read_text())
for r in prior:
 p=old/r['path'];assert p.is_file() and sha(p)==r['sha256'] and p.stat().st_mode&0o777==r['mode']
for root in [old/'clean-starts',O/'clean-starts']:
 records=json.loads((root/'MANIFEST.json').read_text())
 for r in records:
  p=root/r['path'];assert not p.is_symlink() and p.stat().st_mode&0o777==r['mode']
  if 'sha256' in r:assert sha(p)==r['sha256']
  else:assert p.is_dir()
oldmanifest=old/'frozen/installed-artifact-manifest.json'
assert sha(oldmanifest)=='faaae6cd232dc4c0db55746e436657ac22480d0e440662132ce4e7082c02ec80'
oldcheck=json.loads(subprocess.check_output(['node',str(old/'frozen/freeze-repair.mjs'),'--verify'],text=True))
current=None
if (O/'frozen/installed-artifact-manifest.json').exists():current=json.loads(subprocess.check_output(['node',str(O/'frozen/freeze-repair.mjs'),'--verify'],text=True))
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'old_captures_verified':4,'old_public_evidence_files_verified':len(prior),'old_sealed_starts_unchanged':True,'new_sealed_starts_unchanged':True,'old_installation':oldcheck,'current_installation':current}
name=sys.argv[1] if len(sys.argv)>1 else 'final';assert name in ['before-public','final']
(E/('preservation-'+name+'.json')).write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
