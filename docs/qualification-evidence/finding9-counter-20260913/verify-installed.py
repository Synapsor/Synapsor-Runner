from pathlib import Path
import os,json,hashlib,datetime
owned=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/finding9-counter-454a0d2-20260913')
frozen=owned/'frozen';manifest=json.loads((frozen/'manifest.json').read_text());root=Path(manifest['root']);records=[]
for directory,dirs,files in os.walk(root,followlinks=False):
 for name in sorted(dirs+files):
  p=Path(directory)/name;entry={'path':str(p.relative_to(root)),'mode':p.lstat().st_mode&0o777}
  if p.is_symlink():entry.update(kind='symlink',target=os.readlink(p))
  elif p.is_dir():entry.update(kind='directory')
  else:entry.update(kind='file',sha256=hashlib.file_digest(p.open('rb'),'sha256').hexdigest(),bytes=p.stat().st_size)
  records.append(entry)
records.sort(key=lambda r:r['path']);digest=hashlib.sha256(json.dumps(records,sort_keys=True).encode()).hexdigest();assert digest==manifest['tree_sha256']
print(json.dumps({'verified_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'entries':len(records),'tree_sha256':digest}))
