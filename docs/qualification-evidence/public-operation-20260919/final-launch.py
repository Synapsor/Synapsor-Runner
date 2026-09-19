"""Run only the declared public operations on an immutable artifact and owned copy."""
import pathlib,json,subprocess,os,sys,shlex,termios,fcntl,struct
os.umask(0o077)
r=pathlib.Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/public-operation-3eb09c4-20260919');repo=pathlib.Path(__file__).resolve().parents[3];name=sys.argv[1];args=sys.argv[2:];d=r/'public'/name;root=d/'project'
assert name in ['optional-final','removal-final','software-final-read','m4-final-action','m4-final-w','runtime-primary','runtime-secondary']
assert root.is_dir()
subprocess.run(['node',str(r/'frozen/freeze-repair.mjs'),'--verify'],check=True,stdout=subprocess.DEVNULL)
logical='/tmp/project' if name=='optional-final' else str(pathlib.Path(json.loads((root/'.synapsor/control-policy/migration.json').read_text())['target']['path']).parents[1])
for x in ['home','tmp','var-tmp']:(d/x).mkdir(exist_ok=True)
db=json.loads((r/('database-private.json' if name in ['removal-final','optional-final'] else 'software-restoration/database-private.json')).read_text());assert subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "synapsor.task"}}',db['container']],text=True).strip()==db['tag']
env={'PATH':os.environ['PATH'],'HOME':str(d/'home'),'TMPDIR':'/var/tmp','NO_COLOR':'1','TERM':'xterm-256color','NODE_NO_WARNINGS':'1','DATABASE_URL':db['reader_url']}
base=['bwrap','--die-with-parent','--ro-bind','/','/','--bind',str(d),str(d),'--bind',str(d/'tmp'),'/tmp','--bind',str(d/'var-tmp'),'/var/tmp','--bind',str(root),logical,'--proc','/proc','--dev','/dev','--chdir',logical]
pre=subprocess.run(base+[str(repo/'node_modules/.bin/tsx'),str(repo/'docs/qualification-evidence/scoped-read-recovery-20260919/public-preflight.mts'),logical,str(root)],capture_output=True,text=True,env=env);assert pre.returncode==0,pre.stderr
if name.startswith('m4-') or name.startswith('runtime-'):
 meter=r/'final-meter';base[5:5]=['--bind',str(meter),str(meter)]
 for line in pathlib.Path('/home/sandesh-tiwari/Desktop/Customer Service With Synapsor Runner/.env').read_text().splitlines():
  if '=' in line and not line.lstrip().startswith('#'):
   k,v=line.split('=',1)
   if k.strip()=='OPENROUTER_API_KEY':env[k.strip()]=v.strip().strip('\"').strip("'")
 assert env.get('OPENROUTER_API_KEY')
 env.update(QUALIFICATION_PROVIDER_METER=str(meter),QUALIFICATION_PROVIDER_CEILING=os.environ.get('QUALIFICATION_FINAL_CEILING','16'),NODE_OPTIONS='--import='+str(repo/'docs/qualification-evidence/scoped-read-recovery-20260919/provider-meter.mjs'))
if name=='software-final-read' or name.startswith('runtime-'):
 env.update(json.loads((r/'software-restoration/runtime-private.json').read_text()))
 if name.startswith('runtime-'):env['SYNAPSOR_RUNTIME_MODEL']='openai/gpt-5.6-terra' if name=='runtime-primary' else 'x-ai/grok-4.6'
 env['SYNAPSOR_PUBLIC_EVIDENCE']=str(d)
 env['SYNAPSOR_CANDIDATE_ROOT']=str(r/'frozen/installed')
command=['node',str(r/'frozen/installed/node_modules/@synapsor/runner/dist/runner.mjs')]+args
if args==['protocol']:
 assert name=='software-final-read' or name.startswith('runtime-')
 command=['node',str(repo/'docs/qualification-evidence/public-operation-20260919/final-mcp.mjs')]
else:assert args[:2] in [['boundary','draft'],['boundary','rescan'],['boundary','review'],['action','review']] or args[0]=='start'
idx=len(list(d.glob('terminal-*.log')))+1
(d/f'preflight-{idx}.json').write_text(json.dumps({'exit':pre.returncode,'stdout':pre.stdout,'stderr':pre.stderr}))
fcntl.ioctl(sys.stdout.fileno(),termios.TIOCSWINSZ,struct.pack('HHHH',30,100,0,0))
result=subprocess.run(['script','-qefc',shlex.join(base+command),'--log-out',str(d/f'terminal-{idx}.log')],env=env)
(d/f'exit-{idx}.json').write_text(json.dumps({'exit':result.returncode,'args':args,'environment_keys':list(env),'artifact_manifest':str(r/'frozen/installed-artifact-manifest.json')}));sys.exit(result.returncode)
