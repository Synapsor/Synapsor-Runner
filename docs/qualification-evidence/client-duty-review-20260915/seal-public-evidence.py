"""Seal completed owned snapshots/captures and index them without copying secrets into Git."""
from pathlib import Path
import json,hashlib,datetime,os
E=Path(__file__).resolve().parent;p=json.loads((E/'assignment-plan.json').read_text());O=Path(p['owned_root'])
assert not (O/'one-public-run.lock').exists()
cleanup=json.loads((E/'owned-cleanup.json').read_text());assert len(cleanup['records'])==2 and all(not r['running_after'] for r in cleanup['records'])
records=[]
for run in p['case_sources']:
    R=O/'runs'/run;statefile=R/'run-state.json';state=json.loads(statefile.read_text())
    state.update(status='CLOSED_BLOCKED_BEFORE_OWNERSHIP' if run=='counting-wording-control' else 'CLOSED_OWNERSHIP_AND_RECHECK_PASSED',closed_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
    statefile.write_text(json.dumps(state,indent=2)+'\n')
    roots=[R/n for n in ['project','checkpoints','logs','meter']]
    files=[R/n for n in ['run-state.json','public-invocations.jsonl','phase-budget-events.jsonl']]
    for root in roots:
        for f in root.rglob('*'):
            assert not f.is_symlink()
            if f.is_file():files.append(f)
    for f in sorted(files):
        assert f.is_file() and f.stat().st_uid==os.getuid()
        f.chmod(f.stat().st_mode&0o777&~0o222)
        records.append({'run':run,'path':str(f.relative_to(O)),'sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'bytes':f.stat().st_size,'mode':f.stat().st_mode&0o777})
    for root in roots:
        for d in sorted([root,*[f for f in root.rglob('*') if f.is_dir()]],reverse=True):d.chmod(d.stat().st_mode&0o777&~0o222)
dest=O/'public-evidence-manifest.json';dest.write_text(json.dumps(records,indent=2)+'\n');dest.chmod(0o400)
(E/'public-evidence-index.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'root':str(O),'manifest':str(dest),'manifest_sha256':hashlib.sha256(dest.read_bytes()).hexdigest(),'files':len(records),'records':records},indent=2)+'\n')
print(json.dumps({'sealed_files':len(records),'manifest':str(dest)}))
