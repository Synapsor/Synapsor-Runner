from pathlib import Path
import sqlite3,json,sys,hashlib,subprocess
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/scoped-read-recovery-515d260-20260919');attempt=sys.argv[1];records=[]
for x in json.loads((r/attempt/'results.json').read_text()):
 db=r/attempt/x['schema']/'.synapsor/local.db'
 c=sqlite3.connect('file:'+str(db)+'?mode=ro',uri=True)
 row=c.execute("select content_json from control_policy_revisions where kind='management' and name='read_authoring' order by epoch desc limit 1").fetchone()
 d=json.loads(row[0]);v=d['entries'][0];b=v['progress']['candidate']
 records.append({'schema':x['schema'],'exit':x['exit'],'candidate_resources':len(b['pack']['resources']),'draft_resources':len(v['draft']['pack']['resources']),'classification':'metadata-only scaffold' if not b['pack']['resources'] else 'canonical disabled Read','candidate_sha256':hashlib.sha256(json.dumps(b,sort_keys=True).encode()).hexdigest(),'document':d})
 c.close()
(r/attempt/'stored-observations.json').write_text(json.dumps(records,indent=2))
print(json.dumps([{k:v for k,v in x.items() if k!='document'} for x in records],indent=2))
