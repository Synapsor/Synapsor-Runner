"""Wait for this existing suite; never start another. Then run owned gates once."""
from pathlib import Path
import json,subprocess,time,datetime,sys
E=Path(__file__).resolve().parent
full=sys.argv[1] if len(sys.argv)>1 else 'stable-full02';assert full in ['stable-full02','stable-full03']
attempt='attempt3' if full=='stable-full03' else 'attempt2'
start=json.loads((E/'stable-full-exit.json').read_text())['started_at']
deadline=datetime.datetime.fromisoformat(start)+datetime.timedelta(minutes=json.loads((E/'assignment-plan.json').read_text())['budgets_minutes']['stable_verification_freeze'])
record={'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'deadline':deadline.isoformat(),'full_suite':full,'steps':[]}
def live():assert datetime.datetime.now(datetime.timezone.utc)<deadline,'Existing stable budget exhausted; no reset'
while 'exit_code' not in (r:=json.loads((E/(full+'-exit.json')).read_text())):live();time.sleep(5)
assert r['exit_code']==0 and r['source_unchanged'],'Full suite did not pass unchanged; retain result'
commands=[
 ['python3',str(E/'run-local.py'),'postgres-domain','--pg','corepack','pnpm','exec','vitest','run','apps/runner/src/authoring-counting-domain.test.ts','apps/runner/src/authoring-counting-freshness.test.ts','--maxWorkers=1','--minWorkers=1','--testTimeout=20000','--hookTimeout=20000'],
 ['python3',str(E/'run-local.py'),'postgres-assignment','--pg','corepack','pnpm','exec','vitest','run','apps/runner/src/control-policy-authority-codec.test.ts','--testNamePattern','saves and reloads receipt readiness under the existing review lock|postgres validated operator policy transactions.*keeps Action recovery review available with unavailable Read authority:','--maxWorkers=1','--minWorkers=1','--testTimeout=30000','--hookTimeout=120000'],
 ['python3',str(E/'run-offline-checks.py'),'package',attempt]]
for command in commands:
 live();began=datetime.datetime.now(datetime.timezone.utc).isoformat();code=subprocess.run(command).returncode
 record['steps'].append({'command':command,'started_at':began,'exit_code':code,'completed_at':datetime.datetime.now(datetime.timezone.utc).isoformat()})
 (E/('finish-stable-gates-'+full+'.json')).write_text(json.dumps(record,indent=2)+'\n')
 if code:sys.exit(code)
record['completed_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();(E/('finish-stable-gates-'+full+'.json')).write_text(json.dumps(record,indent=2)+'\n')
