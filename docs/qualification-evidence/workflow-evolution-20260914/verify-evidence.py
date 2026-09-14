"""Read-only verification of this bounded task's indexed immutable evidence."""
from pathlib import Path
import hashlib,json,stat,os
E=Path(__file__).resolve().parent
index=json.loads((E/'EVIDENCE-INDEX.json').read_text())
fail=[]
for entry in index['entries']:
 p=Path(entry['path']) if entry['root']=='absolute' else E/entry['path']
 try:
  s=p.lstat()
  if stat.S_IMODE(s.st_mode)!=entry['mode']:fail.append(str(p)+':mode')
  if entry['type']=='symlink':
   if not p.is_symlink() or os.readlink(p)!=entry['target']:fail.append(str(p)+':link')
  elif not p.is_file() or hashlib.file_digest(p.open('rb'),'sha256').hexdigest()!=entry['sha256']:fail.append(str(p)+':hash')
 except OSError:fail.append(str(p)+':unavailable')
print(json.dumps({'entries':len(index['entries']),'failures':fail,'writes':0,'database_opens':0,'provider_calls':0}))
raise SystemExit(1 if fail else 0)
