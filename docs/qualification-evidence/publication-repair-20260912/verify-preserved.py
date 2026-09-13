from pathlib import Path
import json,os,stat,hashlib,datetime,sys
E=Path(__file__).resolve().parent
O=Path(json.loads((E/'assignment-plan.json').read_text())['owned_root'])
baseline=json.loads((O/'preservation-start.json').read_text())
def entry(p):
 s=os.lstat(p);d={'path':str(p),'mode':stat.S_IMODE(s.st_mode),'type':stat.S_IFMT(s.st_mode)}
 if stat.S_ISREG(s.st_mode):
  with open(p,'rb') as f:h=hashlib.file_digest(f,'sha256').hexdigest()
  d.update(size=s.st_size,sha256=h)
 elif stat.S_ISLNK(s.st_mode):d['target']=os.readlink(p)
 return d
records=[]
for root in baseline['roots']:
 records.append(entry(root))
 if Path(root).is_dir():
  for d,dirs,files in os.walk(root,followlinks=False):records.extend(entry(Path(d)/name) for name in sorted(dirs+files))
old={x['path']:x for x in baseline['entries']};now={x['path']:x for x in records}
changed=[k for k in old if old[k]!=now.get(k)];added=[k for k in now if k not in old]
result={'verified_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'baseline':str(O/'preservation-start.json'),'protected_entries':len(baseline['entries']),'observed_entries':len(records),'changed':changed,'added':added}
name=sys.argv[1] if len(sys.argv)>1 else 'preservation-final'
for p in [O/(name+'.json'),E/(name+'.json')]:
 with p.open('x') as f:f.write(json.dumps(result,indent=2)+'\n')
print(json.dumps(result));assert not changed and not added
