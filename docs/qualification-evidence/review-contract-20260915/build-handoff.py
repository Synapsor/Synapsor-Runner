"""Freeze task-owned evidence after all checks and cleanup; never mutate originals."""
from pathlib import Path
import os,json,hashlib,shutil,subprocess,datetime
os.umask(0o077)
E=Path(__file__).resolve().parent;repo=E.parents[2];plan=json.loads((E/'assignment-plan.json').read_text());O=Path(plan['owned_root']);D=O/'reviewer-handoff'
assert not (O/'one-public-run.lock').exists()
assert subprocess.check_output(['git','status','--porcelain'],cwd=repo,text=True).strip()==''
assert all(not x['running_after'] for x in json.loads((E/'owned-cleanup.json').read_text())['records'])
commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()
D.mkdir();shutil.copytree(E,D/'evidence')
with (D/'repository-delivery.tar').open('xb') as f:subprocess.run(['git','archive','--format=tar',commit],cwd=repo,stdout=f,check=True)
(D/'candidate').mkdir()
for p in sorted((O/'frozen').iterdir()):
 if p.is_file():shutil.copy2(p,D/'candidate'/p.name)
(D/'runs').mkdir()
parts=['project','checkpoints','meter','logs','fixture-state','authoring-input','private','schema.sql','case.json','frozen-input-manifest.json','run-state.json','mount-plan.json','public-invocations.jsonl','phase-budget-events.jsonl']
for R in sorted((O/'runs').iterdir()):
 target=D/'runs'/R.name;target.mkdir()
 for name in parts:
  p=R/name
  if p.is_dir():shutil.copytree(p,target/name)
  elif p.is_file():shutil.copy2(p,target/name)
shutil.copytree(O/'closure',D/'closure')
shutil.copytree(O/'clean-starts',D/'clean-starts')
shutil.copytree(O/'race-reproductions',D/'race-reproductions')
shutil.copytree(O/'development',D/'development')
(D/'original-captures').mkdir()
shutil.copy2(O/'private/exact-routing-captures.json', D/'original-captures/exact-routing-captures.json')
if (O/'fixture-failures').exists():shutil.copytree(O/'fixture-failures',D/'fixture-failures')
for name in ['final-budget.json','preservation-start.json']:
 if (O/name).exists():shutil.copy2(O/name,D/name)
(D/'README.md').write_text(f'''# Private immutable verifier handoff

Delivery commit {commit}. Start with evidence/FINAL-REPORT.md, evidence/REVIEWER-HANDOFF.md and evidence/SCORECARD.json. This is implementer-owned evidence pending independent review. Preserved failures are not replaced by later passes. The candidate archive has its complete file/mode/symlink manifest; repository-delivery.tar contains the committed source/tests/reports. Public captures, owned project checkpoints and matching source dumps are included separately.

Do not run saved projects in place. Restore whole new owned directories and matching dumps through the recorded logical-path isolation and effective-store preflight. Private synthetic identities and source rows are evidence for the local reviewer only, not material to commit or send to an authoring provider. Provider credentials are not included. clean-starts contains the untouched A/B project and matching source snapshots from before the primary trial. Development evidence is separately labelled and must not be used as B starting decisions. Claude owns the already-predeclared secondary model run; we did not execute it. No worker or activation belongs to this review-only task. Historical Stage A is artifact-specific; original Stage B remains NOT PASSED.
''')
records=[]
for p in sorted(D.rglob('*')):
 assert not p.is_symlink(),str(p)
 if p.is_dir():p.chmod(0o500);kind='directory';extra={}
 else:
  p.chmod(0o500 if p.stat().st_mode & 0o111 else 0o400);kind='file';extra={'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
 records.append({'path':str(p.relative_to(D)),'kind':kind,'mode':p.stat().st_mode&0o777,**extra})
manifest=D/'MANIFEST.json';manifest.write_text(json.dumps(records,indent=2)+'\n');manifest.chmod(0o400);D.chmod(0o500)
assert sorted(r['path'] for r in records)==sorted(str(p.relative_to(D)) for p in D.rglob('*') if p!=manifest)
for r in records:
 p=D/r['path'];assert p.stat().st_mode&0o777==r['mode']
 if r['kind']=='file':assert hashlib.sha256(p.read_bytes()).hexdigest()==r['sha256']
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'commit':commit,'root':str(D),'entries':len(records),'manifest_sha256':hashlib.sha256(manifest.read_bytes()).hexdigest(),'verified_both_directions':True,'read_only':True,'reviewer_acceptance':'PENDING INDEPENDENT REVIEW'}
(O/'handoff-delivery.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
