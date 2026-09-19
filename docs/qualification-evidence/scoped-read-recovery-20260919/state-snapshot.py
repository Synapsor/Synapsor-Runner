"""Read-only ledger/content observation; run only while owned CLI is stopped."""
from pathlib import Path
import sqlite3,json,hashlib,sys,os
os.umask(0o077)
root=Path(sys.argv[1]);out=Path(sys.argv[2]);rows={};db=root/'.synapsor/local.db'
if db.exists():
 c=sqlite3.connect('file:'+str(db)+'?mode=ro',uri=True)
 for (name,) in c.execute("select name from sqlite_master where type='table' order by name"):
  values=c.execute('select * from "'+name.replace('"','""')+'"').fetchall()
  serialized=sorted(json.dumps(v,default=lambda v:v.hex() if isinstance(v,bytes) else str(v),sort_keys=True) for v in values)
  rows[name]={'rows':len(values),'sha256':hashlib.sha256(json.dumps(serialized).encode()).hexdigest()}
 docs=[json.loads(j) for (j,) in c.execute("select content_json from control_policy_revisions where kind='management' and name='read_authoring' order by epoch desc limit 1")]
 resume=[json.loads(j) for (j,) in c.execute("select content_json from control_policy_revisions where kind='management' and name='boundary_authoring_resume' order by epoch desc limit 1")]
 c.close()
else:docs=[];resume=[]
files={str(p.relative_to(root)):{'mode':oct(p.stat().st_mode&0o777),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(root.rglob('*')) if p.is_file() and not p.is_symlink()}
resume_path=root/'.synapsor/boundary-authoring/resume.json'
if resume_path.exists():resume=[json.loads(resume_path.read_text())]
assert not out.exists(), 'Preserve previous snapshots'
out.write_text(json.dumps({'project':str(root),'tables':rows,'files':files,'read_authoring':docs,'resume':resume},indent=2))
print(json.dumps({'snapshot':str(out),'tables':len(rows),'files':len(files)}))
