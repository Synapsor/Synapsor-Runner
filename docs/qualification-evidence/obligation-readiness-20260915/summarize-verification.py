"""Summarize actual exits without combining targeted runs into a suite pass."""
from pathlib import Path
import json,re,datetime
E=Path(__file__).resolve().parent
all_runs=[]
for f in sorted(E.glob('*-exit.json')):
 r=json.loads(f.read_text());log=E/(r['name']+'.log')
 s=re.sub(r'\x1b\[[0-9;?]*[A-Za-z]','',log.read_text(errors='replace')) if log.exists() else ''
 summaries=[line.strip() for line in s.splitlines() if re.match(r'^\s*(?:Test Files|Tests|Duration)\s+',line)]
 all_runs.append({'name':r['name'],'exit_code':r.get('exit_code'),'completed_at':r.get('completed_at'),'source_head':r.get('source_head'),'source_manifest_sha256':r.get('source_manifest_sha256'),'source_unchanged':r.get('source_unchanged'),'postgres_control_enabled':r.get('owned_postgres_database_url_enabled'),'command':r.get('args'),'summary':summaries,'log':str(log.resolve())})
final=['stable-full02','stable-types','postgres-domain-final','postgres-review-recovery-final','postgres-obligation-final']
selected=[next(r for r in all_runs if r['name']==name) for name in final]
assert all(r['exit_code']==0 and r['source_unchanged'] for r in selected)
assert len({r['source_manifest_sha256'] for r in selected})==1
checks=json.loads((E/'offline-package-plan-attempt3.json').read_text())['commands']
assert len(checks)==10 and all(c['exit_code']==0 for c in checks)
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'product':'58c3f7bf5a9997fd966a224694171ba92596b09d','final_source_runs':selected,'offline_ten':checks,'all_attempts':all_runs,'qualification':'Tests and packaging only; no installed journey inferred. Incomplete/interrupted prior suite is preserved separately.'}
(E/'verification-summary.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'final_source_runs':[{k:r[k] for k in ['name','exit_code','summary']} for r in selected],'offline':len(checks)}))
