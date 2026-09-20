"""One observed public 100x30 operator schedule. Every key follows matched state.
No provider, activation, execution-enable, worker or business tool operation.
"""
from pathlib import Path
import pexpect,sys,json,datetime,re
e=Path(__file__).resolve().parent;r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-default-feecc2b-20260919')
case=sys.argv[1];restart=len(sys.argv)>2 and sys.argv[2]=='restart';d=r/'public'/case
attempt=len(list(d.glob('schedule-*.json')))+1;events=[]
p=pexpect.spawn('python3',[str(e/'launch.py'),case],encoding='utf-8',dimensions=(30,100),timeout=45,echo=False)
log=(d/f'pty-{attempt}.log').open('w');p.logfile_read=log
def match(text):
 p.expect_exact(text);events.append({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'observed':text})
def key(value,reason):
 events.append({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'key':value,'reason':reason});p.send(value)
def menu(title):match(title);match('Up/Down Navigate   Enter Select   Esc Back')
def frame(name):
 log.flush();raw=(d/f'pty-{attempt}.log').read_text();s=re.split(r'\x1b\[\d+F',raw)[-1];(d/(name+'.txt')).write_text(re.sub(r'\x1b\[[0-9;?]*[A-Za-z]','',s).replace('\r',''))
def leave_verified():
 key('\x1b','Back from verified Action menu');menu('ACTION BOUNDARY');key('q','Quit without any operation');p.expect(pexpect.EOF);p.close();assert p.exitstatus==0
try:
 menu('ACTION BOUNDARY');key('\x1b[B','Select existing verified Action');match('> Verified Action Boundary');key('\r','Inspect existing authority')
 menu('VERIFIED ACTION BOUNDARY');key('\x1b[B','Select Review supervised execution');match('> Review supervised execution for release.seal_candidate');key('\r','Receipt/setup review only')
 if restart:
  menu('Review saved receipt setup' if case=='R1' else 'Select receipt storage for this outcome');frame('restart-selection');key('\x1b','Cancel selection menu without saving');menu('VERIFIED ACTION BOUNDARY');leave_verified()
 else:
  match('Select receipt storage for this outcome');match('> Source database');match('Up/Down Navigate   Enter Select   Esc Back');frame('retained-intent');key('\r','Retain Source database intent for review')
  fields=[('writer','Dedicated write connection variable','SYNAPSOR_WRITE_RELEASE_SEAL_CANDIDATE_77988288'),('schema','Source receipt schema','release_ops'),('table','Source receipt table','synapsor_writeback_receipts')]
  returned=False
  for field,label,value in fields:
   match(label);match('[Esc Back]:');frame('text-'+field)
   if case=='R2-'+field:
    key('\x1b','Cancel this text prompt');menu('VERIFIED ACTION BOUNDARY');leave_verified();returned=True;break
   if case=='before-'+field:
    key('\r','Blank Enter reproduction at this field');menu('VERIFIED ACTION BOUNDARY');frame('blank-return');leave_verified();returned=True;break
   key(value+'\r' if case.startswith('before-') else '\r','Explicit earlier-field setup' if case.startswith('before-') else 'Submit displayed text default')
  if not returned:
   match('Save this exact receipt setup selection?');match('> No');match('Up/Down Navigate   Enter Select   Esc Back');frame('selection-review')
   if case=='R2-review':
    key('\x1b','Cancel exact selection review');menu('VERIFIED ACTION BOUNDARY');leave_verified()
   else:
    assert case in ['R1','R3'];key('\x1b[A','Select Yes for exact receipt selection only');match('> Yes');match('Save this exact receipt setup selection?');key('\r','Explicitly save selected receipt intent')
    match('Check your write connection');match('> Check the configured write connection');match('Up/Down Navigate   Enter Select   Esc Back');key('\r','Run verifier only')
    if case=='R1':
     match('Writer verification: PASSED');match('Receipt probe: PASSED, rolled back');match('> No');match('Up/Down Navigate   Enter Select   Esc Back');frame('verifier-default-no');key('\r','Decline execution with unchanged default No');menu('VERIFIED ACTION BOUNDARY');leave_verified()
    else:
     match('Execution needs a deployment fix');match('Diagnostic: SEMANTIC_ACTION_WRITER_POSTURE_INVALID');match("> Save and pause this outcome's execution setup");match('Up/Down Navigate   Enter Select   Esc Back');frame('prerequisite-failure');key('\r','Pause blocked setup without changing authorization');menu('ACTION BOUNDARY');key('q','Quit');p.expect(pexpect.EOF);p.close();assert p.exitstatus==0
 result={'status':'completed','case':case,'restart':restart,'exit':p.exitstatus,'keys_and_observations':events,'provider_calls':0}
except Exception as exc:
 result={'status':'failed','case':case,'restart':restart,'error':type(exc).__name__,'keys_and_observations':events,'provider_calls':0}
 if p.isalive():p.terminate(force=True)
 raise
finally:
 log.flush();log.close();(d/f'schedule-{attempt}.json').write_text(json.dumps(result,indent=2))
print(json.dumps({'case':case,'restart':restart,'status':result['status'],'exit':p.exitstatus}))
