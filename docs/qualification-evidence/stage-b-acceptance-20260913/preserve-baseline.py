from pathlib import Path
import json,os,stat,hashlib,datetime
E=Path(__file__).resolve().parent
plan=json.loads((E/'assignment-plan.json').read_text()); O=Path(plan['owned_root']); previous=Path(plan['previous_root'])
old=json.loads((previous/'preservation-start.json').read_text())
def entry(p):
 s=os.lstat(p);d={'path':str(p),'mode':stat.S_IMODE(s.st_mode),'type':stat.S_IFMT(s.st_mode)}
 if stat.S_ISREG(s.st_mode):
  with open(p,'rb') as f:h=hashlib.file_digest(f,'sha256').hexdigest()
  d.update(size=s.st_size,sha256=h)
 elif stat.S_ISLNK(s.st_mode):d['target']=os.readlink(p)
 return d
roots=old['roots']+[str(previous),str(E.parent/'reviewed-local-clients-20260913')]
records=[]
for root in roots:
 records.append(entry(root))
 if Path(root).is_dir():
  for d,dirs,files in os.walk(root,followlinks=False):records.extend(entry(Path(d)/n) for n in sorted(dirs+files))
now={x['path']:x for x in records};changed=[x['path'] for x in old['entries'] if now.get(x['path'])!=x]
assert not changed,changed
with (O/'preservation-start.json').open('x') as f:json.dump({'roots':roots,'entries':records},f)
manifest=previous/'frozen/installed-artifact-manifest.json';m=json.loads(manifest.read_text());actual=[]
for x in m['records']:
 p=Path(m['installed_root'])/x['path'];s=p.lstat();r={'path':x['path'],'mode':stat.S_IMODE(s.st_mode),'kind':x['kind']}
 if x['kind']=='symlink':r['target']=os.readlink(p)
 elif x['kind']=='file':
  with open(p,'rb') as f:h=hashlib.file_digest(f,'sha256').hexdigest()
  r.update(bytes=s.st_size,sha256=h)
 assert x==r,x['path']
 actual.append(r)
tree=hashlib.sha256(json.dumps(actual,separators=(',',':'),ensure_ascii=False).encode()).hexdigest();assert tree==m['installed_tree_sha256']
result={'verified_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'original_entries':len(records),'prior_entries_verified':len(old['entries']),'changed':changed,'installed_entries':len(actual),'installed_tree_sha256':tree,'manifest_sha256':hashlib.sha256(manifest.read_bytes()).hexdigest()}
for root in [O,E]:(root/'baseline-preservation.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
