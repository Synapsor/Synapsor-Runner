"""Owned software preparation; whole-directory mount preserves exact store identity."""
import pathlib,json,subprocess,os,sys,shlex,termios,fcntl,struct
os.umask(0o077)
r=pathlib.Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/public-operation-3eb09c4-20260919');repo=pathlib.Path(__file__).resolve().parents[3];name=sys.argv[1];sys.argv.pop(1);d=r/'public'/name;root=d/'project'
m=json.loads((root/'.synapsor/control-policy/migration.json').read_text());logical=str(pathlib.Path(m['target']['path']).parents[1]);assert logical.endswith('/sw/project2')
for x in ['home','tmp','var-tmp']:(d/x).mkdir(exist_ok=True)
db=json.loads((r/'software-restoration/database-private.json').read_text());env={'PATH':os.environ['PATH'],'HOME':str(d/'home'),'TMPDIR':'/var/tmp','NO_COLOR':'1','TERM':'xterm-256color','NODE_NO_WARNINGS':'1','DATABASE_URL':db['reader_url']}
base=['bwrap','--die-with-parent','--ro-bind','/','/','--bind',str(d),str(d),'--bind',str(d/'tmp'),'/tmp','--bind',str(d/'var-tmp'),'/var/tmp','--bind',str(root),logical,'--proc','/proc','--dev','/dev','--chdir',logical]
pre=subprocess.run(base+[str(repo/'node_modules/.bin/tsx'),str(repo/'docs/qualification-evidence/scoped-read-recovery-20260919/public-preflight.mts'),logical,str(root)],capture_output=True,text=True,env=env);(d/'preflight.json').write_text(json.dumps({'exit':pre.returncode,'stdout':pre.stdout,'stderr':pre.stderr}));assert pre.returncode==0,pre.stderr
meter=r/'development-meter';private={}
for line in pathlib.Path('/home/sandesh-tiwari/Desktop/Customer Service With Synapsor Runner/.env').read_text().splitlines():
 if '=' in line and not line.lstrip().startswith('#'):
  k,v=line.split('=',1)
  if k.strip()=='OPENROUTER_API_KEY':private[k.strip()]=v.strip().strip('\"').strip("'")
assert private.get('OPENROUTER_API_KEY')
env.update(private);env.update(QUALIFICATION_PROVIDER_METER=str(meter),NODE_OPTIONS='--import='+str(repo/'docs/qualification-evidence/scoped-read-recovery-20260919/provider-meter.mjs'))
base[5:5]=['--bind',str(meter),str(meter)]
args=sys.argv[1:];assert args[:2] in [['boundary','review'],['action','review']] or args[0]=='start'
fcntl.ioctl(sys.stdout.fileno(),termios.TIOCSWINSZ,struct.pack('HHHH',30,100,0,0));idx=len(list(d.glob('terminal-*.log')))+1
result=subprocess.run(['script','-qefc',shlex.join(base+(['node',str(r.parent/'scoped-read-recovery-515d260-20260919/frozen/installed/node_modules/@synapsor/runner/dist/runner.mjs')] if name.startswith('m4-before') else [str(repo/'bin/synapsor-runner')])+args),'--log-out',str(d/f'terminal-{idx}.log')],env=env)
(d/f'exit-{idx}.json').write_text(json.dumps({'exit':result.returncode,'args':args,'environment_keys':list(env)}));sys.exit(result.returncode)
