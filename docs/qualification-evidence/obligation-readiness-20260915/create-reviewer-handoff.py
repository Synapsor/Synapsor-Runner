"""Seal a local evidence copy; original captures, packages and stores stay intact."""
from pathlib import Path
import json,shutil,hashlib,os,datetime,subprocess
os.umask(0o077)
E=Path(__file__).resolve().parent;p=json.loads((E/'assignment-plan.json').read_text());O=Path(p['owned_root']);D=O/'reviewer-evidence';D.mkdir()
sha=lambda f:hashlib.sha256(f.read_bytes()).hexdigest()
def ignored(directory,names):
 return [n for n in names if n.endswith('.log') or n.endswith('-source.json') or n.endswith('-source-after.json')]
shutil.copytree(E,D/'report-and-harness',ignore=ignored)
for name in ['verification-logs','verification-source-manifests','clean-starts']:
 shutil.copytree(O/name,D/name)
for label,run in [('A','recovery-tournament-assisted'),('B','counting-wording-control')]:
 R=O/'runs'/run;T=D/'primary'/label;T.mkdir(parents=True)
 for name in ['meter','checkpoints']:shutil.copytree(R/name,T/name)
 (T/'logs').mkdir()
 for f in (R/'logs').glob('final-*.log'):shutil.copy2(f,T/'logs'/f.name)
 for name in ['run-state.json','public-invocations.jsonl','phase-budget-events.jsonl','mount-plan.json']:shutil.copy2(R/name,T/name)
# Original development failures remain accessible in their immutable indexed
# location; retain raw envelopes here, without copying provider credentials.
R=O/'development/terra/runs/counting-wording-control';T=D/'development';T.mkdir()
shutil.copytree(R/'meter',T/'meter');shutil.copy2(R/'public-invocations.jsonl',T/'public-invocations.jsonl')
(T/'logs').mkdir()
for f in (R/'logs').glob('development*-terminal.log'):shutil.copy2(f,T/'logs'/f.name)
records=[]
for f in sorted(D.rglob('*')):
 assert not f.is_symlink()
 if f.is_file():
  # A copied clean start may already be sealed. No original is changed.
  f.chmod(0o400);records.append({'path':str(f.relative_to(D)),'kind':'file','mode':0o400,'bytes':f.stat().st_size,'sha256':sha(f)})
 else:f.chmod(0o500);records.append({'path':str(f.relative_to(D)),'kind':'directory','mode':0o500})
(D/'MANIFEST.json').write_text(json.dumps(records,indent=2)+'\n');(D/'MANIFEST.json').chmod(0o400);D.chmod(0o500)
archive=O/'reviewer-evidence.tar.gz'
subprocess.run(['tar','-czf',str(archive),'-C',str(O),'reviewer-evidence'],check=True);archive.chmod(0o400)
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'root':str(D),'manifest_sha256':sha(D/'MANIFEST.json'),'entries':len(records),'archive':str(archive),'archive_sha256':sha(archive),'artifact_tree':p['artifact_tree'],'scope':'Immutable local evidence, including private synthetic project checkpoints. Do not execute saved queues. Separate final installation and source archive identities are in final-artifact.json. Delivery-only metadata added later is outside this manifest.'}
(E/'reviewer-evidence.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
