"""Public operator route only. Explicit zero-provider, zero-worker environment."""
from pathlib import Path
import os,sys,json,subprocess,shlex,fcntl,termios,struct,datetime
os.umask(0o077);repo=Path(__file__).resolve().parents[3]
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-default-feecc2b-20260919')
case=sys.argv[1];assert case in json.loads((r/'fixture-identity.json').read_text())['cases'];d=r/'public'/case;root=d/'project'
logical=str(Path(json.loads((root/'.synapsor/control-policy/migration.json').read_text())['target']['path']).parents[1]);assert logical.endswith('/sw/project2')
db=json.loads((r/'database-private.json').read_text());assert subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "synapsor.task"}}',db['container']],text=True).strip()==db['tag']
env={'PATH':os.environ['PATH'],'HOME':str(d/'home'),'TMPDIR':'/var/tmp','NO_COLOR':'1','TERM':'xterm-256color','NODE_NO_WARNINGS':'1','DATABASE_URL':db['reader_url'],**json.loads((r/'writer-private.json').read_text())}
if case=='R3':
 for k in ['DATABASE_URL',*json.loads((r/'writer-private.json').read_text())]:env[k]=env[k].removesuffix('/releaselab')+'/pendinglab'
base=['bwrap','--die-with-parent','--ro-bind','/','/','--bind',str(d),str(d),'--bind',str(d/'tmp'),'/tmp','--bind',str(d/'var-tmp'),'/var/tmp','--bind',str(root),logical,'--proc','/proc','--dev','/dev','--chdir',logical]
pre=subprocess.run(base+[str(repo/'node_modules/.bin/tsx'),str(repo/'docs/qualification-evidence/scoped-read-recovery-20260919/public-preflight.mts'),logical,str(root)],capture_output=True,text=True,env=env);assert pre.returncode==0,pre.stderr
frozen=(r.parent/'effect-continuation-f83209f-20260919' if case.startswith('before-') else r)/'frozen'
subprocess.run(['node',str(frozen/'freeze-repair.mjs'),'--verify'],check=True,stdout=subprocess.DEVNULL)
command=['node',str(frozen/'installed/node_modules/@synapsor/runner/dist/runner.mjs'),'action','review','--project-root','.']
idx=len(list(d.glob('terminal-*.log')))+1;(d/f'preflight-{idx}.json').write_text(json.dumps({'exit':pre.returncode,'stdout':pre.stdout,'stderr':pre.stderr}))
fcntl.ioctl(sys.stdout.fileno(),termios.TIOCSWINSZ,struct.pack('HHHH',30,100,0,0));start=datetime.datetime.now(datetime.timezone.utc).isoformat()
p=subprocess.run(['script','-qefc',shlex.join(base+command),'--log-out',str(d/f'terminal-{idx}.log')],env=env)
(d/f'exit-{idx}.json').write_text(json.dumps({'exit':p.returncode,'start':start,'end':datetime.datetime.now(datetime.timezone.utc).isoformat(),'command':command,'environment_keys':list(env),'dimensions':[100,30],'provider_credentials':'absent'}));sys.exit(p.returncode)
