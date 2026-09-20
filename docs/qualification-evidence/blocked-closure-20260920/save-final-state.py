"""Preserve owned finished state BEFORE container cleanup. Not reusable starts."""
from pathlib import Path
import json,subprocess,hashlib,os,datetime,stat
os.umask(0o077)
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/blocked-closure-4b22b46-20260920');out=r/'owned-final-state';out.mkdir();db=json.loads((r/'database-private.json').read_text());cid=db['container']
assert subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "synapsor.task"}}',cid],text=True).strip()==db['tag']
for c in ['r0','r1','t0','t1']:
 d=r/'operational'/c
 for p in d.glob('invocation-*.json'):assert json.loads(p.read_text())['status']=='completed',p.name
 subprocess.run(['tar','-czf',str(out/(c+'-finished-project-private.tgz')),'-C',str(d),'project','home','operator-private'],check=True)
for c in ['r0','r1','t0','t1','reviewgate']:
 with (out/(c+'-source.dump')).open('wb') as f:subprocess.run(['docker','exec',cid,'pg_dump','-U','postgres','-d',c,'-Fc'],check=True,stdout=f)
inspect=json.loads(subprocess.check_output(['docker','inspect',cid],text=True))[0]
record={'saved_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'purpose':'finished-state preservation only; NEVER use R0/R1 as untouched starts','container':cid,'owned_label':db['tag'],'image':inspect['Image'],'ports':inspect['NetworkSettings']['Ports'],'requests_and_effects':json.loads((r/'counters.json').read_text()),'files':[]}
for p in sorted(out.iterdir()):
 if p.is_file():p.chmod(0o400);record['files'].append({'path':p.name,'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'mode':'0400'})
(out/'manifest.json').write_text(json.dumps(record,indent=2));(out/'manifest.json').chmod(0o400);print(json.dumps({'saved':str(out),'manifest_sha256':hashlib.sha256((out/'manifest.json').read_bytes()).hexdigest(),'files':len(record['files'])}))
