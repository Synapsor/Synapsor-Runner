"""Run with run-local.py for an offline, self-contained installation of this commit."""
from pathlib import Path
import subprocess,json,hashlib,os,datetime
repo=Path(__file__).resolve().parents[3]
owned=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/finding9-counter-454a0d2-20260913')
frozen=owned/'frozen';installed=frozen/'installed'
def run(args,cwd=repo):return subprocess.check_output(args,cwd=cwd,stderr=subprocess.STDOUT,text=True)
def digest(p):return hashlib.file_digest(p.open('rb'),'sha256').hexdigest()
assert run(['git','status','--porcelain']).strip()=='','Commit coherent changes before freezing'
installed.mkdir()
for package,version in [('runner','1.8.0'),('spec','1.11.0')]:
 directory=repo/('apps' if package=='runner' else 'packages')/package
 archive=frozen/f'synapsor-{package}-{version}.tgz'
 (frozen/f'{package}-pack.log').write_text(run(['corepack','pnpm','--config.ignore-scripts=true','pack','--out',str(archive)],directory))
(installed/'package.json').write_text(json.dumps({'name':'finding9-reviewed-counter-install','private':True,'version':'0.0.0','dependencies':{'@synapsor/runner':f'file:{frozen}/synapsor-runner-1.8.0.tgz','@synapsor/spec':f'file:{frozen}/synapsor-spec-1.11.0.tgz'}},indent=2)+'\n')
(frozen/'install.log').write_text(run(['npm','install','--offline','--no-audit','--no-fund'],installed))
(frozen/'dependencies.json').write_text(run(['npm','ls','--all','--json'],installed))
for name in ['cli.js','runner.mjs','authoring.mjs','runtime.mjs','shadow.mjs']:
 assert digest(installed/f'node_modules/@synapsor/runner/dist/{name}')==digest(repo/f'apps/runner/dist/{name}'),name
records=[]
for directory,dirs,files in os.walk(installed,followlinks=False):
 for name in sorted(dirs+files):
  p=Path(directory)/name;record={'path':str(p.relative_to(installed)),'mode':p.lstat().st_mode&0o777}
  if p.is_symlink():
   assert p.resolve().is_relative_to(installed)
   record.update(kind='symlink',target=os.readlink(p))
  elif p.is_dir():record.update(kind='directory')
  else:record.update(kind='file',sha256=digest(p),bytes=p.stat().st_size)
  records.append(record)
records.sort(key=lambda r:r['path'])
manifest={'frozen_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source_commit':run(['git','rev-parse','HEAD']).strip(),'root':str(installed),'node':run(['node','--version']).strip(),'entries':len(records),'tree_sha256':hashlib.sha256(json.dumps(records,sort_keys=True).encode()).hexdigest(),'package_lock_sha256':digest(installed/'package-lock.json'),'records':records}
(frozen/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
summary={k:v for k,v in manifest.items() if k!='records'};summary['manifest_sha256']=digest(frozen/'manifest.json')
(frozen/'artifact.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary))
