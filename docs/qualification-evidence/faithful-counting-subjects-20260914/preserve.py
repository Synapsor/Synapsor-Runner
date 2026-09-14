from pathlib import Path
import os,stat,json,hashlib,datetime,sys
E=Path(__file__).resolve().parent;plan=json.loads((E/'assignment-plan.json').read_text());O=Path(plan['owned_root']);previous=Path(plan['previous_root'])
def item(p):
 s=os.lstat(p);r={'path':str(p),'mode':stat.S_IMODE(s.st_mode),'type':stat.S_IFMT(s.st_mode)}
 if stat.S_ISREG(s.st_mode):
  with open(p,'rb') as f:r.update(size=s.st_size,sha256=hashlib.file_digest(f,'sha256').hexdigest())
 elif stat.S_ISLNK(s.st_mode):r['target']=os.readlink(p)
 return r
def walk(roots):
 out={}
 for root in roots:
  out[str(root)]=item(root)
  if Path(root).is_dir():
   for d,dirs,files in os.walk(root,followlinks=False):
    for n in sorted(dirs+files):p=Path(d)/n;out[str(p)]=item(p)
 return out
phase=sys.argv[1];now=datetime.datetime.now(datetime.timezone.utc).isoformat()
if phase=='start':
 old=json.loads((previous/'preservation-start.json').read_text());prior=walk(old['roots']);oldmap={x['path']:x for x in old['entries']};delta={'changed':[p for p,v in oldmap.items() if prior.get(p)!=v],'added':[p for p in prior if p not in oldmap]};
 # Preserve independent review additions as new external evidence; never rewrite the old manifest.
 roots=old['roots']+[str(previous),plan['previous_evidence'],str(Path(plan['acceptance_report']).parent),str(Path.home()/'Desktop/Synapsor Tutorials/workflow-evolution-firstpass-20260914'),str(Path.home()/'Desktop/Synapsor Tutorials/stage-a-acceptance-review-20260913/FINDING9-REVIEW.md'),str(E.parent/'finding9-counter-20260913')];records=walk(roots)
 baseline={'at':now,'roots':roots,'entries':list(records.values()),'prior_external_delta':delta};(O/'preservation-start.json').write_text(json.dumps(baseline,indent=2)+'\n');result={'at':now,'entries':len(records),'prior_external_delta':delta,'protection':'unchanged original modes; enforced read-only root/original bind mounts for all writable test and public launches'}
else:
 baseline=json.loads((O/'preservation-start.json').read_text());old={x['path']:x for x in baseline['entries']};current=walk(baseline['roots']);result={'at':now,'entries':len(old),'changed':[p for p,v in old.items() if current.get(p)!=v],'added':[p for p in current if p not in old]}
with (E/('preservation-'+phase+'.json')).open('x') as f:f.write(json.dumps(result,indent=2)+'\n')
print(json.dumps(result));assert not result.get('changed') and not result.get('added')
