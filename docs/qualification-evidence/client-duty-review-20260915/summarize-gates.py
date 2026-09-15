"""Archive completed verification inventories and record real, separate exits."""
from pathlib import Path
import json, hashlib, datetime, os, re, shutil
os.umask(0o077)
E=Path(__file__).resolve().parent
O=Path(json.loads((E/'assignment-plan.json').read_text())['owned_root'])
controller=json.loads((E/'finish-stable-full03-gates.json').read_text())
assert controller.get('completed_at'), 'Do not summarize a running campaign'
records=[]
for f in sorted(E.glob('*-exit.json')):
    r=json.loads(f.read_text())
    assert 'exit_code' in r, 'Incomplete attempt: '+f.name
    log=E/(f.name.removesuffix('-exit.json')+'.log')
    text=log.read_text(errors='replace') if log.exists() else ''
    r['summary_lines']=[s.strip() for s in text.splitlines() if re.match(r'\s*(Test Files|Tests|Duration)\s',s)]
    r['record']=f.name
    records.append(r)
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'product':json.loads((E/'product-revision.json').read_text()),
        'attempts':records,'offline':json.loads((E/'offline-package-plan-attempt3.json').read_text()),
        'first_stable_attempt':'Interrupted after architectural gate failure; child -15, unchanged source, not a completed suite.',
        'full_suite':'stable-full03 only; targeted passes are not aggregated into this result.',
        'provider_calls_during_development':0}
(E/'verification-summary.json').write_text(json.dumps(result,indent=2)+'\n')
D=O/'verification-source-manifests';D.mkdir()
index=[]
for f in sorted([*E.glob('*-source.json'),*E.glob('*-source-after.json')]):
    target=D/f.name;shutil.copy2(f,target);target.chmod(0o400)
    digest=hashlib.sha256(f.read_bytes()).hexdigest()
    assert hashlib.sha256(target.read_bytes()).hexdigest()==digest
    index.append({'name':f.name,'sha256':digest,'bytes':f.stat().st_size,'saved_path':str(target)})
(D/'MANIFEST.json').write_text(json.dumps(index,indent=2)+'\n');(D/'MANIFEST.json').chmod(0o400);D.chmod(0o500)
(E/'source-record-index.json').write_text(json.dumps({'root':str(D),'manifest_sha256':hashlib.sha256((D/'MANIFEST.json').read_bytes()).hexdigest(),'records':index},indent=2)+'\n')
for item in index:(E/item['name']).unlink()
print(json.dumps({'attempts':len(records),'source_manifests':len(index),'archive':str(D)}))
