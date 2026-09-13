from pathlib import Path
import hashlib,json,os,sys,datetime
repo=Path(__file__).resolve().parents[3]
owned=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/finding9-counter-454a0d2-20260913')
base=owned.parent
roots=[Path('/home/sandesh-tiwari/Desktop/Synapsor Tutorials/manual-mode-test-20260911'),Path('/home/sandesh-tiwari/Desktop/C++/synapsor-runner/docs/qualification-evidence'),base/'reviewed-local-clients-8d64270-20260913/frozen',base/'authoring-review-repair-9c7219d-20260913/frozen']
records=[]
for root in roots:
 assert root.is_dir(),str(root)
 for directory,dirs,files in os.walk(root,followlinks=False):
  for name in sorted(dirs+files):
   p=Path(directory)/name
   if p.is_symlink():records.append([str(p),'link',os.readlink(p)])
   elif p.is_file():records.append([str(p),'file',hashlib.file_digest(p.open('rb'),'sha256').hexdigest()])
records.sort();digest=hashlib.sha256(json.dumps(records).encode()).hexdigest()
p=owned/'preservation-baseline.json'
if sys.argv[1]=='baseline':p.write_text(json.dumps({'roots':list(map(str,roots)),'sha256':digest,'records':records},indent=2)+'\n')
else:
 old=json.loads(p.read_text());a={r[0]:r for r in old['records']};b={r[0]:r for r in records}
 changes=[name for name in sorted(a.keys()|b.keys()) if a.get(name)!=b.get(name)]
 result={'checked_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'entries':len(records),'sha256':digest,'changes':changes}
 (repo/'docs/qualification-evidence/finding9-counter-20260913/preservation-final.json').write_text(json.dumps(result,indent=2)+'\n')
 assert not changes,changes
print(json.dumps({'entries':len(records),'sha256':digest}))
