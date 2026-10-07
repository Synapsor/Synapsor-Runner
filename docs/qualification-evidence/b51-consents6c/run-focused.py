import os,sys,json,time,signal,subprocess,shutil
from pathlib import Path
W=Path('/home/sandesh-tiwari/Desktop/C++/synapsor-b51-workspaces/consents6c')
P=Path(__file__).resolve().parent
R=Path('/var/tmp/synapsor-consents6c-restored-owned/decoy-parent/test-root')
name=sys.argv[1]; O=P/name; O.mkdir(mode=0o700)
assert shutil.disk_usage('/').free>8*1024**3
args=sys.argv[2:]
cmd=['unshare','--user','--map-root-user','--net','bash','-c','ip link set lo up && exec "$@"','net',
'bwrap','--ro-bind','/','/','--bind',str(W),str(W),'--bind',str(R),str(R),'--bind',str(P),str(P),'--bind',str(R/'tmp'),'/tmp','--proc','/proc','--dev','/dev','--die-with-parent','--chdir',str(W),
'env','-i','PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin',f'HOME={R}/home',f'TMPDIR={R}/tmp','CI=1','COREPACK_ENABLE_NETWORK=0',
'node',str(W/'node_modules/vitest/vitest.mjs'),'run',*args,'--maxWorkers=1','--minWorkers=1','--testTimeout=20000','--hookTimeout=20000','--reporter=json',f'--outputFile={O}/vitest.json']
(O/'COMMAND.json').write_text(json.dumps(cmd,indent=2)); started=time.time(); reason=None
with (O/'stdout.log').open('w') as out,(O/'stderr.log').open('w') as err:
 p=subprocess.Popen(cmd,stdout=out,stderr=err,start_new_session=True,umask=0o077)
 try:
  while p.poll() is None:
   if shutil.disk_usage('/').free<8*1024**3: reason='FREE_DISK_FLOOR'; break
   if time.time()-started>90: reason='TIMEOUT'; break
   time.sleep(.2)
 finally:
  if p.poll() is None:
   os.killpg(p.pid,signal.SIGINT)
   try:p.wait(timeout=5)
   except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
 live=[]
 for f in Path('/proc').glob('[0-9]*/stat'):
  try:
   row=f.read_text().split(') ',1)[1].split()
   if int(row[2])==p.pid and row[0]!='Z':live.append(int(f.parent.name))
  except (FileNotFoundError,ProcessLookupError,PermissionError):pass
 result={'exit':p.returncode,'stop':reason,'seconds':time.time()-started,'pgid':p.pid,'owned_live':live,'free_bytes':shutil.disk_usage('/').free,'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=W,text=True).strip()}
 (O/'RESULT.json').write_text(json.dumps(result,indent=2));print(json.dumps(result));assert not live
sys.exit(p.returncode or (1 if reason else 0))
