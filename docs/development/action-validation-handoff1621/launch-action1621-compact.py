"""Existing isolated full launcher, without per-step inventories/seals."""
from pathlib import Path
import importlib.util,json,os,shutil,subprocess,time
P=Path(__file__).resolve().parent;D=P/'compact-dev';B=P.parent
record_path=D/'DEV-RECORD.json'
record=json.loads(record_path.read_text());W=Path(record['cwd']);R=Path(record['root']);H=Path(record['home']);T=Path(record['tmp'])
assert record['launch_authorized']is True,'MAIN_LIVE_GATE_RELEASE_REQUIRED'
phase=record['phase'];assert phase in['bundle','full']
assert record['status']in['PREPARED_BUNDLE_NEEDED','BUNDLE_CLOSED'],'ONE_BATCH_ONLY'
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=W,text=True).strip()==record['head']
assert subprocess.check_output(['git','status','--porcelain'],cwd=W,text=True)==''
assert shutil.disk_usage(R).free>=8589934592
assert not(D/('bundle-preparation'if phase=='bundle'else'full-package-run')).exists()
command=['unshare','-Urn','bash','-c','ip link set lo up && exec "$@"','owned-action1621-full','bwrap','--ro-bind','/','/',
 '--bind',str(W),str(W),'--bind',str(P),str(P),'--bind',str(R),str(R),'--die-with-parent','--proc','/proc','--dev','/dev',
 '--chdir',str(W),'--','python3',str(P/'run-native-full-action1621-compact.py')]
files=[Path(__file__),P/'run-native-full-action1621-compact.py',record_path,W/'package.json',
 *[Path(shutil.which(x))for x in['unshare','bash','ip','bwrap','python3','node','corepack']]]
spec=importlib.util.spec_from_file_location('precheck',str(B/'shared-launcher-precheck1082.py'));pc=importlib.util.module_from_spec(spec);spec.loader.exec_module(pc)
pc.precheck(command,dry_command=['node','--version'],files=files,directories=[str(W),str(P),str(D),str(R),str(H),str(T)],
 python_scripts=[str(Path(__file__)),str(P/'run-native-full-action1621-compact.py')],python_modules=['json','subprocess'],cwd=str(W))
# Same observable sole-heavy check; Main also coordinates Tester priority.
heavy=[]
for f in Path('/proc').glob('[0-9]*/cmdline'):
 try:
  pid=int(f.parent.name)
  if pid==os.getpid():continue
  args=[x.decode(errors='replace')for x in f.read_bytes().split(b'\0')if x];labels=[]
  if any(Path(x).name.startswith('run-native-full')and Path(x).name.endswith('.py')for x in args):labels.append('native-full-wrapper')
  if any(Path(x).name in['pnpm','pnpm.cjs']for x in args)and'test'in args:labels.append('native-package-test')
  if any('vitest'in x for x in args)and any(x.startswith('--maxWorkers=')and x!='--maxWorkers=1'for x in args):labels.append('multiworker-vitest')
  if labels:
   stat=(f.parent/'stat').read_text().rsplit(')',1)[1].split();heavy.append({'pid':pid,'pgid':int(stat[2]),'start':int(stat[19]),'state':stat[0],'classes':labels})
 except(FileNotFoundError,ProcessLookupError,PermissionError):pass
assert not heavy,'OTHER_HEAVY_PRESENT_NO_LAUNCH'
env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':str(H),'TMPDIR':str(T),'COREPACK_ENABLE_NETWORK':'0','npm_config_offline':'true'}
start=time.monotonic()
with(D/(phase+'-OUTER.stdout')).open('x')as out,(D/(phase+'-OUTER.stderr')).open('x')as err:
 p=subprocess.Popen(command,cwd=W,env=env,stdout=out,stderr=err,start_new_session=True)
 stat=(Path('/proc')/str(p.pid)/'stat').read_text().rsplit(')',1)[1].split()
 print(json.dumps({'outer_pid':p.pid,'pgid':int(stat[2]),'start':int(stat[19]),'head':record['head'],'started':True}),flush=True)
 code=p.wait()
record=json.loads(record_path.read_text())
record.setdefault('outer_stages',{})[phase]={'command':command,'pid':p.pid,'pgid':int(stat[2]),'start':int(stat[19]),'exit':code,'seconds':time.monotonic()-start}
temp=record_path.with_suffix('.tmp');temp.write_text(json.dumps(record,indent=2)+'\n');os.replace(temp,record_path)
print(json.dumps({'exit':code,'seconds':time.monotonic()-start}),flush=True)
raise SystemExit(code)
