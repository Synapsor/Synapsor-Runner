"""One predeclared W2 fixture-owner version increment, never a Runner effect.
Requires the fresh W2 proposal already queued/unattempted; no historical store.
"""
from pathlib import Path
import json,subprocess,sqlite3,re,datetime,os
os.umask(0o077)
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/worker-handoff-63aa664-20260920');d=r/'operational/w2';out=d/'owner-drift.json';assert not out.exists()
db=json.loads((r/'database-private.json').read_text());assert subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "synapsor.task"}}',db['container']],text=True).strip()==db['tag']
s=json.loads((r/'operational/subjects-private.json').read_text())['w2']['candidate'];key=s['candidate_id'];assert re.fullmatch('[0-9a-f-]{36}',key)
c=sqlite3.connect('file:'+str(d/'project/.synapsor/local.db')+'?mode=ro',uri=True);q=c.execute('select status,attempts from worker_queue').fetchall();c.close();assert q==[('queued',0)]
sql="UPDATE release_ops.build_candidates SET version=version+1 WHERE candidate_id='"+key+"' AND version="+str(int(s['version']))+" RETURNING row_to_json(build_candidates);"
p=subprocess.run(['docker','exec','-i',db['container'],'psql','-U','postgres','-d','w2','-At','-v','ON_ERROR_STOP=1'],input=sql,text=True,capture_output=True);assert p.returncode==0
lines=p.stdout.splitlines();assert lines[-1]=='UPDATE 1';row=json.loads(lines[0]);assert row['version']==s['version']+1
out.write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'actor':'owned fixture administrator','predeclared_change':'candidate version +1 only','before':s,'after':row,'runner_effect':False},indent=2));print('W2 owner version increment recorded separately; no Runner worker invoked.')
