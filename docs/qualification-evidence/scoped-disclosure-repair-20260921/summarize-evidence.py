"""Write an exclusive result index only after gates stop; never rewrite raw evidence."""
from pathlib import Path
import json,hashlib,re,datetime,sys
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/scoped-disclosure-repair-aa3a454-20260921')
e=Path(__file__).resolve().parent
out=Path(sys.argv[1]);assert not out.exists()
items=[]
for p in sorted((r/'gates').glob('*-exit.json')):
 d=json.loads(p.read_text());assert 'exit' in d, f'Gate still running: {p.name}'
 log=p.with_name(p.name.replace('-exit.json','.log'));text=log.read_text(errors='replace')
 summary=[re.sub(r'\x1b\[[0-9;]*m','',line).strip() for line in text.splitlines() if any(s in line for s in ['Test Files','Tests  ','Duration'])][-3:]
 items.append({**d,'summary':summary,'exit_record':str(p),'exit_sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'log':str(log),'log_sha256':hashlib.sha256(log.read_bytes()).hexdigest()})
plans=[]
for p in sorted(e.glob('offline-package-plan-*.json')):
 d=json.loads(p.read_text());plans.append({'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),**d})
out.write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'gates':items,'offline':plans,'provider_calls':0,'provider_spend_usd':0,'B':'NOT RUN; suspended by amendment'},indent=2)+'\n')
print(out)
