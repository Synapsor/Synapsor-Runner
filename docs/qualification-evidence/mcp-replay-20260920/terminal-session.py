"""Observed 100x30 public PTY; control file records exact operator gestures.
Only task-owned fresh fixtures. Secret identity input resolves an owned role;
its value is never put in the control file or event log.
"""
from pathlib import Path
import pexpect,sys,json,datetime,re,time,os
os.umask(0o077)
e=Path(__file__).resolve().parent
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/mcp-replay-7be8d2a-20260920')
case,label,*args=sys.argv[1:];assert case in ['r0','r1','t0','t1'];assert re.fullmatch('[a-z0-9-]+',label)
d=r/'operational'/case/('terminal-'+label);d.mkdir();(d/'commands.jsonl').touch()
p=pexpect.spawn('python3',[str(e/'public-launch.py'),case,*args],encoding='utf-8',dimensions=(30,100),timeout=1,echo=False)
log=(d/'terminal.log').open('x');events=[];seen=0;raw='';last_sent_size=-1;start=time.monotonic()
def stamp():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def frame():
 parts=re.split(r'\x1b\[\d+F',raw)
 plain=re.sub(r'\x1b\[[0-9;?]*[A-Za-z]','',parts[-1]).replace('\r','')
 (d/'frame.txt').write_text(plain);return plain
try:
 while time.monotonic()-start<1800:
  try:
   chunk=p.read_nonblocking(65536,timeout=.1);log.write(chunk);log.flush();raw+=chunk;frame()
  except pexpect.TIMEOUT:pass
  except pexpect.EOF:break
  commands=(d/'commands.jsonl').read_text().splitlines()
  for line in commands[seen:]:
   if len(raw)==last_sent_size:break
   c=json.loads(line);current=frame();assert c.get('observed')
   if c['observed'] not in current:break # wait for the exact next public frame
   if 'secret_role' in c:
    data=json.loads((r/'operational/subjects-private.json').read_text())[case]
    assert c['secret_role'] in ['tenant_id','principal_id'];value=data['context'][c['secret_role'].removesuffix('_id')];p.send(str(value)+'\r')
   else:p.send(c['send'])
   events.append({'at':stamp(),**c});seen+=1
   (d/'events.json').write_text(json.dumps(events,indent=2));last_sent_size=len(raw);break
  if not p.isalive():break
 else:raise TimeoutError('bounded operator session expired')
 p.close();assert seen==len((d/'commands.jsonl').read_text().splitlines()), 'unreached operator gesture';result={'exit':p.exitstatus,'signal':p.signalstatus,'finished_at':stamp(),'provider_calls':0,'seconds':time.monotonic()-start}
except BaseException as ex:
 result={'error':type(ex).__name__,'finished_at':stamp(),'seconds':time.monotonic()-start}
 if p.isalive():p.terminate(force=True)
 raise
finally:
 log.close();(d/'result.json').write_text(json.dumps(result,indent=2));frame()
print(json.dumps(result))
