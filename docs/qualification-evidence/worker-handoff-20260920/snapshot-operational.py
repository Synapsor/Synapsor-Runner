"""Read-only fixture-owner oracle: full control tables, all business rows and source receipts.
Stored receipt_json text is retained byte-for-byte inside the table snapshot.
No result is fed to the model or used as trusted identity/authority.
"""
from pathlib import Path
import json,sqlite3,hashlib,subprocess,sys,os,re
os.umask(0o077)
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/worker-handoff-63aa664-20260920')
case,label=sys.argv[1:];assert case in ['w1','w2'];assert re.fullmatch('[a-z0-9-]+',label)
d=r/'operational'/case;p=d/'project';out=d/('state-'+label);out.mkdir()
def enc(v):
 if isinstance(v,bytes):return {'bytes_hex':v.hex()}
 raise TypeError(type(v).__name__)
def save(n,v):
 b=json.dumps(v,sort_keys=True,separators=(',',':'),default=enc).encode();(out/n).write_bytes(b);return hashlib.sha256(b).hexdigest()
manifest={'tables':{},'config_files':{},'source':{}}
f=p/'.synapsor/local.db'
assert f.is_file() and f.resolve()==f
c=sqlite3.connect('file:'+str(f)+'?mode=ro',uri=True);c.row_factory=sqlite3.Row;c.execute('begin')
for row in c.execute("select name from sqlite_master where type='table' order by name"):
 t=row[0];rows=[dict(x) for x in c.execute('select * from "'+t.replace('"','""')+'"')];rows.sort(key=lambda x:json.dumps(x,sort_keys=True,default=enc));manifest['tables'][t]={'rows':len(rows),'sha256':save(t+'.json',rows)}
c.close()
for f in p.glob('synapsor*.json'):manifest['config_files'][f.name]=hashlib.sha256(f.read_bytes()).hexdigest()
db=json.loads((r/'database-private.json').read_text());assert subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "synapsor.task"}}',db['container']],text=True).strip()==db['tag']
def sql(q):return subprocess.check_output(['docker','exec',db['container'],'psql','-U','postgres','-d',case,'-At','-c',q],text=True)
for t,pk in [('release_slots','slot_id'),('build_candidates','candidate_id'),('build_checks','check_id')]:
 rows=json.loads(sql("select coalesce(json_agg(t),'[]') from (select * from release_ops."+t+' order by '+pk+') t'));manifest['source'][t]={'rows':len(rows),'sha256':save('source-'+t+'.json',rows)}
receipt_tables=sql("select schemaname||'.'||tablename from pg_tables where tablename='synapsor_writeback_receipts' order by 1").splitlines()
manifest['source_receipts']={}
for table in receipt_tables:
 assert re.fullmatch(r'[a-z_]+\.[a-z_]+',table)
 rows=json.loads(sql("select coalesce(json_agg(t),'[]') from (select * from "+table+') t'))
 rows.sort(key=lambda v:json.dumps(v,sort_keys=True));manifest['source_receipts'][table]={'rows':len(rows),'sha256':save('source-receipts.json',rows)}
save('manifest.json',manifest);print(json.dumps({'case':case,'label':label,'tables':len(manifest['tables']),'business_rows':sum(v['rows'] for v in manifest['source'].values()),'source_receipt_rows':sum(v['rows'] for v in manifest['source_receipts'].values())}))
