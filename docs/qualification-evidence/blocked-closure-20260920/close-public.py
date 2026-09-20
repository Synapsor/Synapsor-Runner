"""Bounded public operator commands. Reads IDs only from owned actual state.
Does not create, edit or assert producer/approval/authority records.
"""
from pathlib import Path
import json,subprocess,sys,time
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/blocked-closure-4b22b46-20260920');e=Path(__file__).resolve().parent
case,operation=sys.argv[1:];assert case in ['r0','r1'];assert operation in ['preview','decline','eof','interrupt','confirm','repeat','inspect','status']
d=r/'operational'/case;state=d/('state-refused' if case=='r1' else 'state-applied');items=json.loads((state/'worker_queue.json').read_text());assert len(items)==1;pid=items[0]['proposal_id']
args=['worker','close-blocked',pid,'--config','synapsor.actions.runner.json'];label='closure-'+operation
if operation=='preview':args+=['--json']
elif operation=='inspect':args=['worker','dead-letter','show',pid,'--config','synapsor.actions.runner.json','--json']
elif operation=='status':args=['worker','status','--config','synapsor.actions.runner.json','--capability','release.seal_candidate','--json']
else:
 a=json.loads((d/'closure-preview.log').read_text());assert a['proposal_id']==pid
 args+=['--confirm','--assessment',a['assessment_digest'],'--reason','Resolve the proven rolled-back attempt; retain failure and allowance','--identity','recovery_operator','--identity-key',str(d/'operator-private/recovery.pem')]
 if operation in ['decline','eof','interrupt']:
  assert case=='r1' and a['status']=='available'
  p=subprocess.Popen(['python3',str(e/'terminal-session.py'),case,label,*args],stdout=(d/(label+'-driver.log')).open('x'),stderr=subprocess.STDOUT)
  control=d/('terminal-'+label)/'commands.jsonl'
  for _ in range(100):
   if control.exists():break
   if p.poll() is not None:raise RuntimeError('Terminal did not start')
   time.sleep(.05)
  assert control.exists() and not control.read_text();commands=json.loads((e/('gestures-close-'+operation+'.json')).read_text());control.write_text(''.join(json.dumps(x)+'\n' for x in commands))
  code=p.wait(timeout=60);result=json.loads((control.parent/'result.json').read_text());print(json.dumps({'operation':operation,'driver_exit':code,'public_result':result}));raise SystemExit(code)
 args+=['--yes','--json']
p=subprocess.run(['python3',str(e/'run-public.py'),case,label,*args]);raise SystemExit(p.returncode)
