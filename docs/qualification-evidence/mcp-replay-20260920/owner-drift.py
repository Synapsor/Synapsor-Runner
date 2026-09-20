"""One predeclared R1 fixture-owner version increment, never a Runner effect.
Requires the fresh R1 proposal already queued/unattempted; no historical store.
"""
from pathlib import Path
import json,subprocess,sqlite3,re,datetime,os
os.umask(0o077)
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/mcp-replay-7be8d2a-20260920');d=r/'operational/r1';out=d/'owner-drift.json';assert not out.exists()
db=json.loads((r/'database-private.json').read_text());assert subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "synapsor.task"}}',db['container']],text=True).strip()==db['tag']
s=json.loads((r/'operational/subjects-private.json').read_text())['r1']['candidate'];key=s['candidate_id'];assert re.fullmatch('[0-9a-f-]{36}',key)
c=sqlite3.connect('file:'+str(d/'project/.synapsor/local.db')+'?mode=ro',uri=True);q=c.execute('select status,attempts from worker_queue').fetchall();c.close();assert q==[('queued',0)]
counters=json.loads((r/'counters.json').read_text());assert counters.get('owner_version_changes',0)==0;assert counters.get('final_deadline');assert datetime.datetime.now(datetime.timezone.utc)<datetime.datetime.fromisoformat(counters['final_deadline'].replace('Z','+00:00'));counters['owner_version_changes']=1;(r/'counters.json').write_text(json.dumps(counters,indent=2))
sql="UPDATE release_ops.build_candidates SET version=version+1 WHERE candidate_id='"+key+"' AND version="+str(int(s['version']))+" RETURNING row_to_json(build_candidates);"
p=subprocess.run(['docker','exec','-i',db['container'],'psql','-U','postgres','-d','r1','-At','-v','ON_ERROR_STOP=1'],input=sql,text=True,capture_output=True);assert p.returncode==0
lines=p.stdout.splitlines();assert lines[-1]=='UPDATE 1';row=json.loads(lines[0]);assert row['version']==s['version']+1
out.write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'actor':'owned fixture administrator','predeclared_change':'candidate version +1 only','before':s,'after':row,'runner_effect':False},indent=2));print('R1 owner version increment recorded separately; no Runner worker invoked.')
