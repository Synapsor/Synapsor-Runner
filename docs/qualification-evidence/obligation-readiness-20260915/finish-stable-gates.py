"""Wait for the existing suite; run each remaining final-source gate once."""
from pathlib import Path
import json, subprocess, time, datetime, sys, os
os.umask(0o077)
E=Path(__file__).resolve().parent
status=E/'finish-stable-gates.json'
assert not status.exists(), 'Do not restart this sequence implicitly'
state={'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'waiting_for_existing':'stable-full02','steps':[]}
def save():status.write_text(json.dumps(state,indent=2)+'\n')
save()
deadline=time.monotonic()+3600
while True:
    result=json.loads((E/'stable-full02-exit.json').read_text())
    if 'exit_code' in result:break
    assert time.monotonic()<deadline, 'Existing suite wait exhausted'
    time.sleep(1)
state['full_suite_exit']=result['exit_code'];save()
if result['exit_code'] or not result.get('source_unchanged'):
    state['stopped']='Full suite failed/interrupted or source changed; inspect actual result';save();sys.exit(1)
for original in ['postgres-domain','postgres-review-recovery','postgres-obligation']:
    previous=json.loads((E/(original+'-exit.json')).read_text())
    name=original+'-final'
    command=[sys.executable,str(E/'run-local.py'),name,'--pg',*previous['args']]
    state['current']=name;save()
    result=subprocess.run(command)
    state['steps'].append({'name':name,'exit_code':result.returncode});save()
    if result.returncode:sys.exit(result.returncode)
state['current']='offline-package-attempt3';save()
result=subprocess.run([sys.executable,str(E/'run-offline-checks.py'),'package','attempt3'])
state['steps'].append({'name':state['current'],'exit_code':result.returncode})
state['completed_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();save()
sys.exit(result.returncode)
