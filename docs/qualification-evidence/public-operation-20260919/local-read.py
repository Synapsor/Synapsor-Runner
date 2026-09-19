import pathlib,subprocess,json,os,sys,termios,fcntl,struct,shlex
R=pathlib.Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/public-operation-3eb09c4-20260919');repo=pathlib.Path(__file__).resolve().parents[3]
name=sys.argv[1];d=R/'public'/name;assert (d/'project').is_dir();os.umask(0o077)
for x in ['home','tmp','var-tmp']:(d/x).mkdir(exist_ok=True)
logical='/home/sandesh-tiwari/Desktop/Synapsor Tutorials/onboarding-ux-experiments-20260917/exp5-unseen-domain/baseline-real-flow/project'
db=json.loads((R/'database-private.json').read_text());env={'PATH':os.environ['PATH'],'HOME':str(d/'home'),'TMPDIR':'/var/tmp','NO_COLOR':'1','TERM':'xterm-256color','NODE_NO_WARNINGS':'1','DATABASE_URL':db['reader_url']}
base=['bwrap','--die-with-parent','--ro-bind','/','/','--bind',str(d),str(d),'--bind',str(d/'tmp'),'/tmp','--bind',str(d/'var-tmp'),'/var/tmp','--bind',str(d/'project'),logical,'--proc','/proc','--dev','/dev','--chdir',logical]
pre=subprocess.run(base+[str(repo/'node_modules/.bin/tsx'),str(repo/'docs/qualification-evidence/scoped-read-recovery-20260919/public-preflight.mts'),logical,str(d/'project')],capture_output=True,text=True,env=env);(d/'preflight.json').write_text(json.dumps({'exit':pre.returncode,'stdout':pre.stdout,'stderr':pre.stderr}));assert pre.returncode==0
runner=['node',str(R.parent/'scoped-read-recovery-515d260-20260919/frozen/installed/node_modules/@synapsor/runner/dist/runner.mjs')] if name=='removal-before' else [str(repo/'bin/synapsor-runner')]
operation=sys.argv[2:];assert operation[:2] in [['boundary','rescan'],['boundary','review']]
fcntl.ioctl(sys.stdout.fileno(),termios.TIOCSWINSZ,struct.pack('HHHH',30,100,0,0));idx=len(list(d.glob('terminal-*.log')))+1
result=subprocess.run(['script','-qefc',shlex.join(base+runner+operation),'--log-out',str(d/f'terminal-{idx}.log')],env=env)
(d/f'exit-{idx}.json').write_text(json.dumps({'exit':result.returncode,'command':base+runner+operation,'environment_keys':list(env)}));sys.exit(result.returncode)
