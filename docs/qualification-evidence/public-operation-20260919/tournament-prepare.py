"""Owned software preparation; whole-directory mount preserves exact store identity."""
import pathlib,json,subprocess,os,sys,shlex,termios,fcntl,struct
os.umask(0o077)
r=pathlib.Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/public-operation-3eb09c4-20260919');repo=pathlib.Path(__file__).resolve().parents[3];d=r/'public/tournament-final-catalog';root=d/'project'
m=json.loads((root/'.synapsor/control-policy/migration.json').read_text());logical=str(pathlib.Path(m['target']['path']).parents[1]);assert logical=='/home/sandesh-tiwari/Desktop/Synapsor Tutorials/onboarding-ux-experiments-20260917/tourn-project'
for x in ['home','tmp','var-tmp']:(d/x).mkdir(exist_ok=True)
db=json.loads((r/'tournament-restoration/database-private.json').read_text());env={'PATH':os.environ['PATH'],'HOME':str(d/'home'),'TMPDIR':'/var/tmp','NO_COLOR':'1','TERM':'xterm-256color','NODE_NO_WARNINGS':'1','DATABASE_URL':db['reader_url']}
base=['bwrap','--die-with-parent','--ro-bind','/','/','--bind',str(d),str(d),'--bind',str(d/'tmp'),'/tmp','--bind',str(d/'var-tmp'),'/var/tmp','--bind',str(root),logical,'--proc','/proc','--dev','/dev','--chdir',logical]
pre=subprocess.run(base+[str(repo/'node_modules/.bin/tsx'),str(repo/'docs/qualification-evidence/scoped-read-recovery-20260919/public-preflight.mts'),logical,str(root)],capture_output=True,text=True,env=env);(d/'preflight.json').write_text(json.dumps({'exit':pre.returncode,'stdout':pre.stdout,'stderr':pre.stderr}));assert pre.returncode==0,pre.stderr
args=sys.argv[1:];assert args[:2] in [['boundary','rescan'],['boundary','review'],['action','review'],['boundary','activate']]
fcntl.ioctl(sys.stdout.fileno(),termios.TIOCSWINSZ,struct.pack('HHHH',30,100,0,0));idx=len(list(d.glob('terminal-*.log')))+1
result=subprocess.run(['script','-qefc',shlex.join(base+[str(repo/'bin/synapsor-runner')]+args),'--log-out',str(d/f'terminal-{idx}.log')],env=env)
(d/f'exit-{idx}.json').write_text(json.dumps({'exit':result.returncode,'args':args,'environment_keys':list(env)}));sys.exit(result.returncode)
