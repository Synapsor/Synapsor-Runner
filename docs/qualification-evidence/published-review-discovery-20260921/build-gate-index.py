from pathlib import Path
import json,hashlib,re
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/published-review-discovery-ed32e38-20260921');e=Path(__file__).resolve().parent
hashfile=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
results=[]
for p in sorted((r/'gates').glob('*-exit.json')):
 x=json.loads(p.read_text());log=p.with_name(p.name.replace('-exit.json','.log'));s=log.read_text() if log.exists() else ''
 x.update(exit_record=str(p),exit_record_sha256=hashfile(p),log=str(log),log_sha256=hashfile(log) if log.exists() else None,summary=[v.strip() for v in s.splitlines() if re.match(r'^\s*(?:Test Files|Tests|Duration)\s',v)][-3:])
 results.append(x)
(e/'GATE-INDEX.json').write_text(json.dumps({'runs':results,'stable_whole_suite':'stable-full-03','preserved_interrupted_whole_suite':'stable-full-02','preserved_unsuccessful_whole_suite':'stable-full-01','wrong_filter_is_not_a_pass':'store-save-stable-final selected zero tests; exact gate store-save-stable-exact','skip_meaning':'Opt-in or name-filtered tests are not passes; inspect exact commands.'},indent=2)+'\n')
rows=[]
for p in sorted(e.glob('offline-package-plan-attempt*.json')):
 x=json.loads(p.read_text());rows.append({'plan':p.name,'sha256':hashfile(p),'commands':[{**c,'log':str(r/'offline-logs'/(c['name']+'-'+p.stem.split('-')[-1]+'.log')),'log_sha256':hashfile(r/'offline-logs'/(c['name']+'-'+p.stem.split('-')[-1]+'.log'))} for c in x['commands']]})
(e/'OFFLINE-GATE-INDEX.json').write_text(json.dumps(rows,indent=2)+'\n')
print(json.dumps({'runs':len(results),'pending':[x['name'] for x in results if 'exit' not in x],'offline_plans':len(rows)}))
