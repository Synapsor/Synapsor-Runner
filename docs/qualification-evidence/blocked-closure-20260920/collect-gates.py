from pathlib import Path
import json,re,hashlib
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/blocked-closure-4b22b46-20260920');e=Path(__file__).resolve().parent
out=[]
for p in sorted(r.glob('*-exit.json')):
 d=json.loads(p.read_text());log=r/(p.name.removesuffix('-exit.json')+'.log');text=log.read_text() if log.exists() else ''
 out.append({'name':p.name.removesuffix('-exit.json'),'exit':d['exit'],'seconds':d.get('seconds'),'command':d.get('command'),'source_before':d.get('source_before'),'source_after':d.get('source_after'),'source_unchanged':d.get('source_before')==d.get('source_after'),'credential_scope':d.get('credentials'),'summary':[x.strip() for x in text.splitlines() if re.match(r'\s*(Test Files|Tests)\s+',x)][-2:],'record':str(p),'record_sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'log':str(log),'log_sha256':hashlib.sha256(log.read_bytes()).hexdigest() if log.exists() else None})
(e/'GATES.json').write_text(json.dumps(out,indent=2)+'\n');print(len(out),'attempts retained')
