"""Verify original bytes and sealed starts; never open an application or store writable."""
from pathlib import Path
import json,hashlib,datetime,sys,subprocess
E=Path(__file__).resolve().parent
plan=json.loads((E/'assignment-plan.json').read_text());O=Path(plan['owned_root'])
label=sys.argv[1];assert label in ['before-final','closure']
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'label':label,'captures':[],'projects':[]}
for r in json.loads((E/'capture-index.json').read_text())['records']:
    current=sha(Path(r['path']))
    external=Path(r['path']).suffix=='.md'
    if not external:assert current==r['sha256'],r['path']
    report['captures'].append({**r,'current_sha256':current,'unchanged':current==r['sha256'],
        'handling':'Independent authored updates reported separately; original recorded hash retained.' if external else 'Immutable captured evidence'})
for provider in ['terra','grok']:
    manifest=json.loads((O/'original-observations'/provider/'project-readonly-manifest.json').read_text())
    root=Path(manifest['root']);records=manifest['records']
    assert sorted(str(p.relative_to(root)) for p in root.rglob('*') if p.is_file())==sorted(r['path'] for r in records)
    for r in records:
        f=root/r['path'];assert not f.is_symlink() and sha(f)==r['sha256'] and f.stat().st_mode&0o777==r['mode'],str(f)
    report['projects'].append({'provider':provider,'root':str(root),'files':len(records),'bytes_and_modes_unchanged':True})
for key,selected in plan['case_sources'].items():
    root=Path(selected['root'])/'runs'/selected['run']/'checkpoints'/selected['checkpoint']
    records=json.loads((root/'project-manifest.json').read_text());project=root/'project'
    assert sorted(str(p.relative_to(project)) for p in project.rglob('*') if p.is_file())==sorted(r['path'] for r in records)
    for r in records:assert sha(project/r['path'])==r['sha256']
    report['projects'].append({'case':key,'checkpoint':str(root),'files':len(records),'bytes_unchanged':True})
clean=json.loads((E/'clean-starts.json').read_text());root=Path(clean['root'])
assert sha(root/'MANIFEST.json')==clean['manifest_sha256']
records=json.loads((root/'MANIFEST.json').read_text())
assert sorted(str(p.relative_to(root)) for p in root.rglob('*') if p.name!='MANIFEST.json')==sorted(r['path'] for r in records)
for r in records:
    f=root/r['path'];assert not f.is_symlink() and f.stat().st_mode&0o777==r['mode']
    if r['kind']=='file':assert sha(f)==r['sha256']
report['clean_starts']={'entries':len(records),'manifest_sha256':clean['manifest_sha256'],'unchanged':True}
old=O.parent/'obligation-readiness-666fc5a-20260915/frozen/freeze-repair.mjs'
report['prior_installed']=json.loads(subprocess.check_output(['node',str(old),'--verify'],text=True))
assert report['prior_installed']['installed_tree_sha256']=='8c75b859c4220585ccb07fb28723c3c27fed9881417740f61310938481658362'
(E/('preservation-'+label+'.json')).write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'label':label,'originals_verified':True,'clean_start_entries':len(records),'prior_installed_tree':report['prior_installed']['installed_tree_sha256']}))
