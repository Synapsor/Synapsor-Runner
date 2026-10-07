"""Original full1600 native command/floor/process loop, compact evidence only.

No product/test/profile changes. Owner speed amendment replaces expansive
inventories and per-step seals with one DEV record plus original native logs.
"""
from pathlib import Path
import hashlib,json,os,shutil,signal,subprocess,sys,time

P=Path(__file__).resolve().parent/'compact-dev'
record_path=P/'DEV-RECORD.json'
os.umask(0o077)
record=json.loads(record_path.read_bytes())
W=Path(record['cwd']);root=Path(record['root']);head=record['head'];floor=8589934592

def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb')as f:
  for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
 return h.hexdigest()
def save():
 temp=record_path.with_suffix('.tmp')
 temp.write_text(json.dumps(record,indent=2)+'\n');os.replace(temp,record_path)
def clean():
 actual=subprocess.check_output(['git','rev-parse','HEAD'],cwd=W,text=True).strip()
 status=subprocess.check_output(['git','status','--porcelain'],cwd=W,text=True)
 return {'head':actual,'tracked_and_untracked_clean':status=='','matches_fixed_head':actual==head}

assert record['launch_authorized']is True,'MAIN_RELEASE_REQUIRED'
before=clean();assert before['matches_fixed_head']and before['tracked_and_untracked_clean'],'SOURCE_CHANGED'
assert json.loads((W/'package.json').read_bytes())['scripts']['test']==record['package_test_script']
assert sha(root/'decoy-parent/synapsor.runner.json')==record['isolation']['decoy_sha256']
assert (root/'decoy-parent/test-root/.git').is_dir()
assert shutil.disk_usage(root).free>=floor
phase=record['phase'];assert phase in['bundle','full']
out=P/('bundle-preparation'if phase=='bundle'else'full-package-run');out.mkdir(mode=0o700)
env={'PATH':str(W/'node_modules/.bin')+':/usr/local/bin:/usr/bin:/bin','HOME':record['home'],'TMPDIR':record['tmp'],
 'NO_COLOR':'1','COREPACK_HOME':'/home/sandesh-tiwari/.cache/node/corepack','COREPACK_ENABLE_NETWORK':'0','npm_config_offline':'true'}
assert record['package_test_script'].count('--maxWorkers=8')==1
workers=record['workers'];assert workers in [7,8]
chain=record['package_test_script'].replace('--maxWorkers=8',f'--maxWorkers={workers}',1)
assert chain==record['executed_native_chain']
command=record['bundle_preparation_command']if phase=='bundle'else(['corepack','pnpm','test']if workers==8 else ['corepack','pnpm','exec','sh','-c',chain])
argv=['/usr/bin/time','-v','-o',str(out/'OS-TIME.txt'),*command]
start=time.monotonic();minimum=shutil.disk_usage(root).free;stop=None;observed={};p=None

def row(pid):
 f=Path('/proc')/str(pid);a=(f/'stat').read_text().rsplit(')',1)[1].split()
 return {'pid':pid,'ppid':int(a[1]),'pgid':int(a[2]),'session':int(a[3]),'start':int(a[19]),'uid':f.stat().st_uid,'state':a[0]}
def descendants():
 rows={}
 for f in Path('/proc').glob('[0-9]*/stat'):
  try:r=row(int(f.parent.name));rows[r['pid']]=r
  except(FileNotFoundError,ProcessLookupError,PermissionError):pass
 owned={p.pid};changed=True
 while changed:
  more={pid for pid,r in rows.items()if r['ppid']in owned};changed=bool(more-owned);owned.update(more)
 for pid in owned:
  if pid in rows:observed[(pid,rows[pid]['start'])]=rows[pid]
def live():
 found=[]
 for(pid,tick),old in observed.items():
  try:r=row(pid)
  except(FileNotFoundError,ProcessLookupError,PermissionError):continue
  if r['start']==tick and r['state']!='Z':found.append(r)
 return found
def stopped(sig,frame):raise InterruptedError('OWNER_OR_SIGNAL_STOP:'+str(sig))
for sig in[signal.SIGTERM,signal.SIGHUP,signal.SIGINT]:signal.signal(sig,stopped)
record['source_before']=before;record['status']='BUNDLE_RUNNING'if phase=='bundle'else'FULL_RUNNING';record['start_utc']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
try:
 with(out/'NATIVE.stdout').open('x')as stdout,(out/'NATIVE.stderr').open('x')as stderr:
  p=subprocess.Popen(argv,cwd=W,env=env,stdout=stdout,stderr=stderr,start_new_session=True)
  record['native']={'phase':phase,'command':argv,'environment':env,'identity':row(p.pid),'umask':(Path('/proc')/str(p.pid)/'status').read_text().split('Umask:')[1].splitlines()[0].strip()};save()
  while p.poll()is None:
   descendants();free=shutil.disk_usage(root).free;minimum=min(minimum,free)
   if free<floor:raise RuntimeError('FREE_DISK_FLOOR_BELOW_8GiB')
   time.sleep(.5)
  p.wait();descendants()
except BaseException as e:
 stop={'type':type(e).__name__,'message':str(e)}
finally:
 cleanup=False
 if p is not None:
  descendants()
  if p.poll()is None or live():
   cleanup=True
   # Same actual PID/start ownership discipline as the accepted native wrapper.
   for r in live():
    try:os.kill(r['pid'],signal.SIGTERM)
    except ProcessLookupError:pass
   until=time.monotonic()+5
   while live()and time.monotonic()<until:time.sleep(.1)
   for r in live():
    try:os.kill(r['pid'],signal.SIGKILL)
    except ProcessLookupError:pass
   if p.poll()is None:p.wait(timeout=5)
  remaining=live()
 else:remaining=[]
after=clean()
record.update({'status':'NATIVE_CLOSED','source_after':after,
 'result':{'native_package_exit':None if p is None else p.returncode,'stop':stop,'wall_seconds':time.monotonic()-start,
 'minimum_free_bytes':minimum,'final_free_bytes':shutil.disk_usage(root).free,'owned_live':remaining,
 'observed_owned_pid_start_count':len(observed),'cleanup_needed':cleanup,
 'tracked_source_unchanged':before==after and after['tracked_and_untracked_clean'],
 'end_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
 'stdout_path':str(out/'NATIVE.stdout'),'stderr_path':str(out/'NATIVE.stderr'),
 'stdout_sha256':sha(out/'NATIVE.stdout'),'stderr_sha256':sha(out/'NATIVE.stderr'),
 'post_bundle_sha256':sha(W/'apps/runner/dist/runner.mjs')},
 'verdict':'NATIVE_STAGE_PENDING_ADJUDICATION','open_items':['Bundle mustpass before full; full originalnative&&tails/Reviewer1final pending']})
record['stages'][phase]={'native':record['native'],'result':record['result']}
record['status']='BUNDLE_CLOSED'if phase=='bundle'else'FULL_CLOSED'
save();print(json.dumps(record['result']),flush=True)
sys.exit(0 if p is not None and p.returncode==0 and not stop and not remaining and after==before and after['tracked_and_untracked_clean']else 1)
