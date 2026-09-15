"""Read-only original captures/checkpoints and untouched reviewer-start check."""
from pathlib import Path
import json,hashlib,datetime,sys,subprocess
E=Path(__file__).resolve().parent
plan=json.loads((E/'assignment-plan.json').read_text())
label=sys.argv[1];assert label in ['before-final','closure']
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'label':label,'checks':[]}
cap=json.loads((E/'capture-index.json').read_text())
for name,value in cap['capture_sha256'].items():
    f=Path(cap['path'])/'meter'/name
    assert sha(f)==value;report['checks'].append({'path':str(f),'sha256':value})
for key,selected in plan['case_sources'].items():
    root=Path(selected['root'])/'runs'/selected['run']/'checkpoints'/selected['checkpoint']
    records=json.loads((root/'project-manifest.json').read_text());project=root/'project'
    assert sorted(str(p.relative_to(project)) for p in project.rglob('*') if p.is_file())==sorted(r['path'] for r in records)
    for record in records:assert sha(project/record['path'])==record['sha256']
    report['checks'].append({'case':key,'checkpoint':str(root),'project_files':len(records),'verified':True})
clean=json.loads((E/'clean-starts.json').read_text());root=Path(clean['root'])
assert sha(root/'MANIFEST.json')==clean['manifest_sha256']
records=json.loads((root/'MANIFEST.json').read_text())
assert sorted(str(p.relative_to(root)) for p in root.rglob('*') if p.name!='MANIFEST.json')==sorted(r['path'] for r in records)
for r in records:
    f=root/r['path'];assert not f.is_symlink() and f.stat().st_mode&0o777==r['mode']
    if r['kind']=='file':assert sha(f)==r['sha256']
report['clean_starts']={'entries':len(records),'manifest_sha256':clean['manifest_sha256'],'unchanged':True}
old=Path(plan['owned_root']).parent/'provider-response-bounds-1ae76e5-20260915/frozen/freeze-repair.mjs'
report['prior_installed']=json.loads(subprocess.check_output(['node',str(old),'--verify'],text=True))
assert report['prior_installed']['installed_tree_sha256']=='072ab87a11ecde0ec1e0a0928bfc6ba036fede08b6e75cfc073b1de263c631ef'
for r in json.loads((E/'external-baseline.json').read_text()):
    current=sha(Path(r['path']))
    report.setdefault('external_files',[]).append({**r,'current_sha256':current,'unchanged':current==r['sha256'],'handling':'Independent authored report changes must be recorded separately, never overwrite its earlier manifest.'})
(E/('preservation-'+label+'.json')).write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'label':label,'originals_verified':True,'clean_start_entries':len(records),'prior_installed_tree':report['prior_installed']['installed_tree_sha256']}))
