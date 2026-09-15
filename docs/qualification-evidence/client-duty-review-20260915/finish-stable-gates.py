"""Continue the existing stable run; never start or silently restart a suite."""
from pathlib import Path
import json, subprocess, time, datetime, sys, os
os.umask(0o077)
E=Path(__file__).resolve().parent
suite=sys.argv[1] if len(sys.argv)>1 else 'stable-full02'
assert suite in ['stable-full02','stable-full03']
statefile=E/('finish-stable-gates.json' if suite=='stable-full02' else 'finish-stable-full03-gates.json')
assert not statefile.exists()
first=json.loads((E/'stable-full-exit.json').read_text())
deadline=datetime.datetime.fromisoformat(first['started_at']).timestamp()+65*60
state={'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'verification_deadline':datetime.datetime.fromtimestamp(deadline,datetime.timezone.utc).isoformat(),'waiting_for_existing':suite,'steps':[]}
def save():statefile.write_text(json.dumps(state,indent=2)+'\n')
save()
while True:
    r=json.loads((E/(suite+'-exit.json')).read_text())
    if 'exit_code' in r:break
    assert time.time()<deadline,'Existing verification allocation exhausted; no reset'
    time.sleep(1)
state['full_suite_exit']=r['exit_code']; save()
if r['exit_code'] or not r.get('source_unchanged'):
    state['stopped']='Stable suite failed/interrupted or source changed; inspect exact saved result';save();sys.exit(1)
for old in ['postgres-domain','postgres-assignment']:
    assert time.time()+180<deadline,'Insufficient remaining declared verification budget'
    earlier=json.loads((E/(old+'-exit.json')).read_text());name=old+'-final'
    state['current']=name;save()
    code=subprocess.run([sys.executable,str(E/'run-local.py'),name,'--pg',*earlier['args']]).returncode
    state['steps'].append({'name':name,'exit_code':code});save()
    if code:sys.exit(code)
assert time.time()+180<deadline,'Insufficient remaining declared verification budget'
state['current']='offline-package-attempt3' if suite=='stable-full03' else 'offline-package-attempt2';save()
code=subprocess.run([sys.executable,str(E/'run-offline-checks.py'),'package','attempt3' if suite=='stable-full03' else 'attempt2']).returncode
state['steps'].append({'name':state['current'],'exit_code':code});state['completed_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();save()
sys.exit(code)
