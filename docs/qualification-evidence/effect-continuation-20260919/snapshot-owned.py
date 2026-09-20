"""Read-only owner oracle for owned fixtures, never a model/tool input."""
from pathlib import Path
import json,sqlite3,hashlib,subprocess,sys,os
os.umask(0o077);r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/effect-continuation-f83209f-20260919');name,label=sys.argv[1:];d=r/'public'/name;p=d/'project';out=d/('state-'+label);out.mkdir()
def enc(v):
 if isinstance(v,bytes):return {'bytes_hex':v.hex()}
 raise TypeError(type(v).__name__)
def save(n,v):
 b=json.dumps(v,sort_keys=True,separators=(',',':'),default=enc).encode();(out/n).write_bytes(b);return hashlib.sha256(b).hexdigest()
c=sqlite3.connect('file:'+str(p/'.synapsor/local.db')+'?mode=ro',uri=True);c.row_factory=sqlite3.Row;c.execute('begin');tables={}
for row in c.execute("select name from sqlite_master where type='table' order by name"):
 t=row[0];rows=[dict(x) for x in c.execute('select * from "'+t.replace('"','""')+'"')];rows.sort(key=lambda x:json.dumps(x,sort_keys=True,default=enc));tables[t]={'rows':len(rows),'sha256':save(t+'.json',rows)}
c.close();manifest={'tables':tables,'config_files':{}}
for f in p.rglob('*'):
 if f.is_file() and f.suffix in ['.json','.yaml','.yml'] and '.synapsor' not in str(f.relative_to(p)) and 'node_modules' not in str(f):manifest['config_files'][str(f.relative_to(p))]=hashlib.sha256(f.read_bytes()).hexdigest()
if True:
 tournament=False;db=json.loads((r/'database-private.json').read_text());assert subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "synapsor.task"}}',db['container']],text=True).strip()==db['tag'];manifest['source']={}
 for t,pk in ([('events','event_id'),('results','result_id')] if tournament else [('release_slots','slot_id'),('build_candidates','candidate_id'),('build_checks','check_id')]):
  q='select coalesce(json_agg(t),\'[]\') from (select * from '+('tournament_ops.' if tournament else 'release_ops.')+t+' order by '+pk+') t';rows=json.loads(subprocess.check_output(['docker','exec',db['container'],'psql','-U','postgres','-d','pendinglab' if name=='pending' else 'releaselab','-At','-c',q],text=True));manifest['source'][t]={'rows':len(rows),'sha256':save('source-'+t+'.json',rows)}
save('manifest.json',manifest);print(json.dumps({'name':name,'label':label,'tables':len(tables),'source_rows':sum(v['rows'] for v in manifest.get('source',{}).values())}))
