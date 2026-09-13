"""Prepare, but do not execute, one external review smoke from retained harnesses."""
from pathlib import Path
import json, os, hashlib, subprocess, shutil, datetime, ast
os.umask(0o077)
E=Path(__file__).resolve().parent
plan=json.loads((E/'assignment-plan.json').read_text())
PE=E.parent/'reviewed-local-clients-20260913'
O=Path(plan['owned_root'])/'external-review-smoke'
O.mkdir()  # Never restore or repeat in an existing attempt.
H=O/'harness'; H.mkdir(); R=O/'runtime'; R.mkdir(); (O/'host-home').mkdir()
F=Path(plan['prior_owned_root'])/'frozen'
label='stage-a-external-review-20260913'
provenance=[]
def copy(name,destination,changes=()):
    source=PE/name; text=source.read_text()
    for old,new in changes:
        assert old in text,(name,old)
        text=text.replace(old,new)
    destination.write_text(text)
    provenance.append({'source':str(source),'source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'prepared':str(destination),'prepared_sha256':hashlib.sha256(destination.read_bytes()).hexdigest(),'changes':[a for a,b in changes]})
copy('start-local-postgres.mjs',H/'start-local-postgres.mjs',[
 ("import {Pool} from 'pg';", "import {createRequire} from 'node:module';\nconst {Pool}=createRequire("+json.dumps(str(F/'installed/package.json'))+")('pg');"),
 ("const evidence=path.dirname(new URL(import.meta.url).pathname);", "import {fileURLToPath} from 'node:url';\nconst evidence=path.dirname(fileURLToPath(import.meta.url));"),
 ('synapsor-reviewed-clients-', 'synapsor-external-review-'),('reviewed-clients-repair-20260913',label)])
copy('prepare-runtime.mjs',H/'prepare-runtime.mjs',[
 (plan['prior_owned_root'],str(O)),
 ("const artifactRoot=path.join(taskRoot,caseName==='setup_dev'?'development':'frozen');",'const artifactRoot='+json.dumps(str(F))+';'),
 ('reviewed-clients-repair-20260913',label)])
for name in ['drive-client-setup.py','drive-retirement.py']:
    copy(name,H/name)
copy('run-owned.py',H/'run-owned.py',[
 ("artifact=owned/('development' if case=='setup_dev' else 'frozen')",'artifact=Path('+repr(str(F))+')')])
copy('save-and-stop-owned.py',H/'save-and-stop-owned.py',[('reviewed-clients-repair-20260913',label)])
copy('runtime-driver.mjs',R/'runtime-driver.mjs',[
 ("deadline:'2026-09-13T11:39:41.401219+00:00'",'deadline:new Date(Date.now()+60*60000).toISOString()'),
 ('maximum_operations:600','maximum_operations:120'),('plan.worker_invocations<=24','plan.worker_invocations<=0'),
 ('Date.now()+120*60000','Date.now()+60*60000'),('plan.schedules[name]<=2','plan.schedules[name]<=1')])
for name in ['invoke-client-setup.mjs','invoke-interactive.mjs','check-reviewed-contexts.mjs','accounting-contention.mjs']:
    copy(name,R/name)
copy('installed-identity-lifecycle.mjs',R/'installed-identity-lifecycle.mjs',[
 (str(PE/'drive-retirement.py'),str(H/'drive-retirement.py'))])
preflight=E.parent/'structured-save-repair-20260913/storage-preflight.mjs'
assert hashlib.sha256(preflight.read_bytes()).hexdigest()=='f41c22b65c92ac9629a1236a8a189bd46100edd7516dbfc40639b7ed047ebab2'
shutil.copy2(preflight,R/'storage-preflight.mjs')
shutil.copy2(E/'reviewer-allowance-smoke.mjs',R/'reviewer-allowance-smoke.mjs')
(H/'assignment-plan.json').write_text(json.dumps({'owned_root':str(O),'artifact_root':str(F),'review_status':'IN_PROGRESS_EXTERNALLY','smoke':'PREPARED_NOT_EXECUTED','budgets':{'minutes':60,'smokes':1,'known_harness_correction':1,'runtime_operations':120,'workers':0}},indent=2)+'\n')
for p in [*H.glob('*.py')]: ast.parse(p.read_text())
for p in [*H.glob('*.mjs'),*R.glob('*.mjs')]: subprocess.run(['node','--check',str(p)],check=True,capture_output=True)
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'prepared_not_executed','owned_root':str(O),'harness':str(H),'provenance':provenance,'syntax_checks_exit':0,'fixture_started':False,'smoke_executed':False,'independent_result':None}
(O/'preparation.json').write_text(json.dumps(result,indent=2)+'\n')
(E/'reviewer-preparation.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'status':result['status'],'owned_root':str(O),'syntax_checks_exit':0}))
