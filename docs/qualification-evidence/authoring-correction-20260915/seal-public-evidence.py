"""Seal quiescent final run evidence without touching original fixtures."""
from pathlib import Path
import json,hashlib,os,datetime
os.umask(0o077)
E=Path(__file__).resolve().parent;plan=json.loads((E/'assignment-plan.json').read_text());O=Path(plan['owned_root']);assert not (O/'one-public-run.lock').exists()
records=[]
for run in plan['case_sources']:
 R=O/'runs'/run;events=[json.loads(s) for s in (R/'public-invocations.jsonl').read_text().splitlines()]
 assert sum(x['event']=='start' for x in events)==sum(x['event']=='exit' for x in events)
 selected=[R/'checkpoints',R/'meter',R/'logs',R/'public-invocations.jsonl',R/'phase-budget-events.jsonl']
 for root in selected:
  files=list(root.rglob('*')) if root.is_dir() else [root]
  for p in files:
   assert not p.is_symlink()
   if p.is_file():
    p.chmod(0o400)
    records.append({'run':run,'path':str(p.relative_to(O)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size,'mode':p.stat().st_mode&0o777})
  if root.is_dir():
   for p in sorted(root.rglob('*'),reverse=True):
    if p.is_dir():p.chmod(0o500)
   root.chmod(0o500)
manifest=O/'public-evidence-manifest.json';assert not manifest.exists();manifest.write_text(json.dumps(records,indent=2)+'\n');manifest.chmod(0o400)
(E/'public-evidence-index.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'manifest':str(manifest),'manifest_sha256':hashlib.sha256(manifest.read_bytes()).hexdigest(),'files':len(records)},indent=2)+'\n');print(json.dumps({'files':len(records),'manifest':str(manifest)}))
