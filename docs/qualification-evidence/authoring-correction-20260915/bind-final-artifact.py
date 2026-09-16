"""Bind prepared harness metadata to the verified candidate; never rewrite project bindings."""
from pathlib import Path
import json,hashlib,subprocess,datetime
E=Path(__file__).resolve().parent;repo=E.parents[2]
plan=json.loads((E/'assignment-plan.json').read_text());O=Path(plan['owned_root']);F=Path(plan['frozen_root'])
manifest=json.loads((F/'installed-artifact-manifest.json').read_text())
verified=json.loads(subprocess.check_output(['node',str(F/'freeze-repair.mjs'),'--verify'],text=True))
assert verified['installed_tree_sha256']==manifest['installed_tree_sha256']
assert verified['installed_tree_sha256']!='ff9a030cdb353ec56b9f4f048d40df60e3bb49f77d224eac675ba2b4c1a29568'
assert json.loads((E/'stable-full03-exit.json').read_text())['exit_code']==0
archive=F/'source-checkpoint.tar.gz';assert not archive.exists()
subprocess.run(['git','archive','--format=tar.gz','--output='+str(archive),manifest['source_commit']],cwd=repo,check=True)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        **{k:manifest[k] for k in ['product_commit','test_commit','source_commit','installed_root','installed_tree_sha256','runner_version','spec_version','package_lock_sha256','node','tarballs']},
        'entries':len(manifest['records']),
        'manifest':str(F/'installed-artifact-manifest.json'),'manifest_sha256':sha(F/'installed-artifact-manifest.json'),
        'installed_archive':str(F/'installed-artifact.tar.gz'),'archive_sha256':sha(F/'installed-artifact.tar.gz'),
        'source_archive':str(archive),'source_archive_sha256':sha(archive),'before_public_verify':verified}
for run in plan['case_sources']:
    file=O/'runs'/run/'run-state.json';state=json.loads(file.read_text())
    assert state['artifact_tree'] is None and state['status']=='PREPARED_AWAITING_FINAL_CANDIDATE'
    state.update(artifact_tree=manifest['installed_tree_sha256'],artifact_directory=str(F),status='PREPARED_FOR_FINAL_REVIEW')
    file.write_text(json.dumps(state,indent=2)+'\n')
plan.update(artifact_tree=manifest['installed_tree_sha256'],status='FROZEN_READY_FOR_PRIMARY_FINAL',next_step='Direct-Review B, explicit counting/client ownership, save/restart/recheck; small settled-A control')
(E/'assignment-plan.json').write_text(json.dumps(plan,indent=2)+'\n')
(E/'final-artifact.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
