"""Read-only membership/hash verification; never adjusts original or candidate modes."""
from pathlib import Path
import json,hashlib,subprocess,sys,datetime
E=Path(__file__).resolve().parent
R=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-review-5d92ca5-20260920')
OR=R.parent/'source-association-97de715-20260920'
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
label=sys.argv[1];assert label.replace('-','').isalnum()
records=[]
for item in json.loads((E/'BASELINE-RAW-INDEX.json').read_text())['files']:
 p=Path(item['path']);assert sha(p)==item['sha256'];records.append({'path':str(p),'equal':True})
for case,item in json.loads((E/'SEALED-STARTS.json').read_text()).items():
 for name,digest in item['files'].items():
  for root in [Path(item['origin']),R/'sealed-starts'/case]:
   p=root/name;assert sha(p)==digest;records.append({'path':str(p),'equal':True,'mode':oct(p.stat().st_mode&0o777)})
checks=[]
for frozen in [OR/'frozen',R/'frozen']:
 if not (frozen/'installed-artifact-manifest.json').exists():continue
 result=subprocess.run(['node',str(frozen/'freeze-repair.mjs'),'--verify'],capture_output=True,text=True,check=True)
 checks.append({'root':str(frozen),'result':json.loads(result.stdout),'manifest_sha256':sha(frozen/'installed-artifact-manifest.json'),'archive_sha256':sha(frozen/'installed-artifact.tar.gz')})
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'label':label,'captured_inputs_and_original_sealed_archives':records,'complete_installed_tree_checks':checks}
(R/('preservation-'+label+'.json')).write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps({'verified_input_files':len(records),'installed_trees':len(checks),'record':str(R/('preservation-'+label+'.json'))}))
