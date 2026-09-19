"""Public CLI, whole-directory restoration and transport-only observation."""
import pathlib,os,sys,json,subprocess,shlex,termios,fcntl,struct,time
REPO=pathlib.Path(__file__).resolve().parents[3]; E=pathlib.Path(__file__).resolve().parent
ROOT=pathlib.Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/scoped-read-recovery-515d260-20260919')
ORIGIN='/home/sandesh-tiwari/Desktop/Synapsor Tutorials/onboarding-ux-experiments-20260917/exp5-unseen-domain/baseline-real-flow/project'
os.umask(0o077)
name=sys.argv[1]; owned=ROOT/'public'/name
assert owned.is_dir(), 'Prepare a new whole-project copy before launch'
phase='development' if name.startswith('development') else 'final'
meter=ROOT/(phase+'-meter'); plan=json.loads((meter/'plan.json').read_text())
assert time.time()<__import__('datetime').datetime.fromisoformat(plan['deadline']).timestamp()
db=json.loads((ROOT/'j6-database-private.json').read_text())
logical='/tmp/project' if name=='final-fresh' else ORIGIN
runner=[str(REPO/'bin/synapsor-runner')]
identity='development source'
if phase=='final':
 manifest=json.loads((ROOT/'frozen/installed-artifact-manifest.json').read_text());identity=manifest['installed_tree_sha256']
 subprocess.run(['node',str(ROOT/'frozen/freeze-repair.mjs'),'--verify'],check=True)
 runner=['node',str(ROOT/'frozen/installed/node_modules/@synapsor/runner/dist/runner.mjs')]
secrets={}
for line in pathlib.Path('/home/sandesh-tiwari/Desktop/Customer Service With Synapsor Runner/.env').read_text().splitlines():
 if '=' in line and not line.lstrip().startswith('#'):
  k,v=line.split('=',1);secrets[k.strip()]=v.strip().strip('"').strip("'")
assert secrets.get('OPENROUTER_API_KEY'), 'Same configured provider credential required'
for d in ['home','tmp','var-tmp']:(owned/d).mkdir(exist_ok=True)
env={'PATH':os.environ['PATH'],'HOME':str(owned/'home'),'NO_COLOR':'1','TERM':'xterm-256color','LANG':'C.UTF-8','COLUMNS':'100','LINES':'30','TMPDIR':'/var/tmp','NODE_NO_WARNINGS':'1','DATABASE_URL':db['reader_url']}
args=['bwrap','--die-with-parent','--ro-bind','/','/','--bind',str(owned),str(owned),'--bind',str(owned/'tmp'),'/tmp','--bind',str(owned/'var-tmp'),'/var/tmp','--bind',str(owned/'project'),logical,'--bind',str(meter),str(meter),'--proc','/proc','--dev','/dev','--chdir',logical]
pre=subprocess.run(args+[str(REPO/'node_modules/.bin/tsx'),str(E/'public-preflight.mts'),logical,str(owned/'project')],env=env,capture_output=True,text=True)
(owned/'preflight.json').write_text(json.dumps({'exit':pre.returncode,'stdout':pre.stdout,'stderr':pre.stderr},indent=2));assert pre.returncode==0,'Effective-store preflight failed'
env.update(OPENROUTER_API_KEY=secrets['OPENROUTER_API_KEY'],QUALIFICATION_PROVIDER_METER=str(meter),NODE_OPTIONS='--import='+str(E/'provider-meter.mjs'))
fcntl.ioctl(sys.stdout.fileno(),termios.TIOCSWINSZ,struct.pack('HHHH',30,100,0,0))
operation=sys.argv[2:] or ['start','--project-root','.','--cli']
assert operation[0]=='start' or operation[:2]==['boundary','rescan'], 'Only declared Read preparation/revalidation commands allowed'
env['QUALIFICATION_PROVIDER_CEILING']='15' if name=='final-fresh' else str(plan['maximum_attempts'])
command=args+runner+operation
with (owned/'invocations.jsonl').open('a') as f:f.write(json.dumps({'at':time.time(),'command':command,'phase':phase,'artifact':identity,'provider':'openrouter/openai/gpt-5.6-terra','environment_names':list(env),'size':[100,30]})+'\n')
index=len(list(owned.glob('terminal-*.log')))+1
result=subprocess.run(['script','-qefc',shlex.join(command),'--log-out',str(owned/f'terminal-{index}.log')],env=env)
with (owned/'invocations.jsonl').open('a') as f:f.write(json.dumps({'at':time.time(),'exit':result.returncode})+'\n')
sys.exit(result.returncode)
