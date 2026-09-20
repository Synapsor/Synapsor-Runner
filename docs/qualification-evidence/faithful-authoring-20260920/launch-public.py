"""Installed public operator launcher. No internal authority helpers or source writes."""
from pathlib import Path
import os,sys,json,subprocess,shlex,termios,fcntl,struct,datetime
os.umask(0o077)
plan_path=Path(sys.argv[1]).resolve(); plan=json.loads(plan_path.read_text()); args=sys.argv[2:]
assert args and args[0] in ['start']
root=Path(plan['owned_root']); logical=plan['logical_project']; home=Path(plan['home'])
assert root.is_dir() and str(plan_path).startswith(str(root)+'/')
assert logical.startswith('/var/tmp/synapsor-new-stageb-20260920-')
assert Path(plan['installed_entrypoint']).is_file()
env={'PATH':os.environ['PATH'],'HOME':str(home),'TMPDIR':'/var/tmp','NO_COLOR':'1','TERM':'xterm-256color','NODE_NO_WARNINGS':'1'}
connection=json.loads(Path(plan['private_operator_environment']).read_text())
assert not any('ADMIN' in k or 'ROOT' in k for k in connection), 'Administrator credentials are not operator/model environment'
env.update(connection)
sandbox=plan['sandbox_args'];assert sandbox[-1]=='--'
pre=subprocess.run(['bwrap']+sandbox+['/usr/bin/node',plan['preflight'],logical],env=env,capture_output=True,text=True)
out=root/'operator-captures';out.mkdir(exist_ok=True)
i=len(list(out.glob('preflight-*.json')))+1
(out/f'preflight-{i:03}.json').write_text(json.dumps({'exit':pre.returncode,'stdout':pre.stdout,'stderr':pre.stderr},indent=2)+'\n');assert pre.returncode==0,pre.stderr
if args[0] in ['start','action','boundary']:
 key=None
 for line in Path('/home/sandesh-tiwari/Desktop/Customer Service With Synapsor Runner/.env').read_text().splitlines():
  if '=' in line and line.split('=',1)[0].strip()=='OPENROUTER_API_KEY':key=line.split('=',1)[1].strip().strip('\"').strip("'")
 assert key
 env.update(OPENROUTER_API_KEY=key,QUALIFICATION_PROVIDER_METER=plan['authoring_meter_root'],NODE_OPTIONS='--import='+Path(plan['provider_meter']).resolve().as_uri())
fcntl.ioctl(sys.stdout.fileno(),termios.TIOCSWINSZ,struct.pack('HHHH',30,100,0,0))
start=datetime.datetime.now(datetime.timezone.utc).isoformat()
command=['bwrap']+sandbox+['/usr/bin/node',plan['installed_entrypoint']]+args
result=subprocess.run(['script','-qefc',shlex.join(command),'--log-out',str(out/f'terminal-{i:03}.log')],env=env)
(out/f'exit-{i:03}.json').write_text(json.dumps({'start':start,'end':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exit':result.returncode,'args':args,'environment_names':list(env),'PTY':[100,30],'artifact':plan['artifact_tree']},indent=2)+'\n')
sys.exit(result.returncode)
