"""Full bidirectional file/mode/directory/symlink verification; no writable opens."""
from pathlib import Path
import hashlib,json,os,stat,datetime,sys
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/blocked-closure-4b22b46-20260920');root=r/'sealed-starts';manifest=root/'manifest.json';baseline=json.loads(manifest.read_text());records=[]
for p in sorted(root.rglob('*')):
 if p==manifest:continue
 mode=stat.S_IMODE(p.lstat().st_mode);entry={'path':str(p.relative_to(root)),'mode':mode}
 if p.is_symlink():entry.update(kind='symlink',target=os.readlink(p))
 elif p.is_dir():entry.update(kind='directory')
 elif p.is_file():entry.update(kind='file',bytes=p.stat().st_size,sha256=hashlib.sha256(p.read_bytes()).hexdigest())
 else:raise AssertionError('Unexpected entry type')
 records.append(entry)
assert records==baseline['files'],'Sealed entries changed (including additions/removals/modes)'
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'entries':len(records),'manifest_sha256':hashlib.sha256(manifest.read_bytes()).hexdigest(),'result':'unchanged','direction':'both','mode_and_symlink_targets_checked':True}
label=sys.argv[1];assert label in ['before-operations','final'];p=r/('seals-full-'+label+'.json');assert not p.exists();p.write_text(json.dumps(result,indent=2));print(json.dumps(result))
