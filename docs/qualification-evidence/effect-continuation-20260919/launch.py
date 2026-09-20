"""Bounded public edit operations, task-owned copies, no runtime credentials."""
import pathlib,json,subprocess,os,sys,shlex,termios,fcntl,struct,datetime
os.umask(0o077);repo=pathlib.Path(__file__).resolve().parents[3];e=pathlib.Path(__file__).resolve().parent
r=pathlib.Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/effect-continuation-f83209f-20260919')
name=sys.argv[1];assert name in ['baseline','pending','deployment','decline','read'];args=sys.argv[2:];assert args[0] in ['start','action','writeback','boundary','execution','protocol','runtime-read']
d=r/'public'/name;root=d/'project';logical=str(pathlib.Path(json.loads((root/'.synapsor/control-policy/migration.json').read_text())['target']['path']).parents[1]);assert logical.endswith('/sw/project2')
db=json.loads((r/'database-private.json').read_text());assert subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "synapsor.task"}}',db['container']],text=True).strip()==db['tag']
env={'PATH':os.environ['PATH'],'HOME':str(d/'home'),'TMPDIR':'/var/tmp','NO_COLOR':'1','TERM':'xterm-256color','NODE_NO_WARNINGS':'1','DATABASE_URL':db['reader_url']}
if name=='pending':env['DATABASE_URL']=db['reader_url'].removesuffix('/releaselab')+'/pendinglab'
base=['bwrap','--die-with-parent','--ro-bind','/','/','--bind',str(d),str(d),'--bind',str(d/'tmp'),'/tmp','--bind',str(d/'var-tmp'),'/var/tmp','--bind',str(root),logical,'--proc','/proc','--dev','/dev','--chdir',logical]
pre=subprocess.run(base+[str(repo/'node_modules/.bin/tsx'),str(repo/'docs/qualification-evidence/scoped-read-recovery-20260919/public-preflight.mts'),logical,str(root)],capture_output=True,text=True,env=env);assert pre.returncode==0,pre.stderr
if name in ['baseline','deployment','decline','pending'] and (r/'writer-private.json').exists():
 env.update(json.loads((r/'writer-private.json').read_text()))
 if name=='pending':
  for k in json.loads((r/'writer-private.json').read_text()):env[k]=env[k].removesuffix('/releaselab')+'/pendinglab'
if name=='baseline':
 candidate=r.parent/'minimal-edit-bfc2f19-20260919/frozen'
 subprocess.run(['node',str(candidate/'freeze-repair.mjs'),'--verify'],check=True,stdout=subprocess.DEVNULL)
 command=['node',str(candidate/'installed/node_modules/@synapsor/runner/dist/runner.mjs')]+args
elif (r/'frozen/installed').exists():
 subprocess.run(['node',str(r/'frozen/freeze-repair.mjs'),'--verify'],check=True,stdout=subprocess.DEVNULL)
 command=['node',str(r/'frozen/installed/node_modules/@synapsor/runner/dist/runner.mjs')]+args
else:command=[str(repo/'bin/synapsor-runner')]+args
if args in [['protocol'],['runtime-read']]:
 assert name=='read' and (r/'frozen/installed').is_dir()
 env.update(json.loads((r/'runtime-private.json').read_text()))
 env.update(SYNAPSOR_PUBLIC_EVIDENCE=str(d),SYNAPSOR_CANDIDATE_ROOT=str(r/'frozen/installed'))
 budget=r/'public/protocol-budget.json'
 if not budget.exists():budget.write_text(json.dumps({'calls':0,'limit':80}))
 base[5:5]=['--bind',str(budget),str(budget)]
 if args==['runtime-read']:
  meter=r/'final-meter';assert (meter/'plan.json').exists()
  assert not list(meter.glob('attempt-*.json')), 'One ordinary runtime episode only'
  base[5:5]=['--bind',str(meter),str(meter)]
  for line in pathlib.Path('/home/sandesh-tiwari/Desktop/Customer Service With Synapsor Runner/.env').read_text().splitlines():
   if '=' in line and not line.lstrip().startswith('#'):
    k,v=line.split('=',1)
    if k.strip()=='OPENROUTER_API_KEY':env[k.strip()]=v.strip().strip('"').strip("'")
  assert env.get('OPENROUTER_API_KEY')
  env.update(QUALIFICATION_PROVIDER_METER=str(meter),QUALIFICATION_PROVIDER_CEILING='12',NODE_OPTIONS='--import='+str(e/'provider-meter.mjs'),SYNAPSOR_RUNTIME_MODEL='openai/gpt-5.6-terra')
 command=['node',str(e/'final-mcp.mjs')]
idx=len(list(d.glob('terminal-*.log')))+1
(d/f'preflight-{idx}.json').write_text(json.dumps({'exit':pre.returncode,'stdout':pre.stdout,'stderr':pre.stderr}))
fcntl.ioctl(sys.stdout.fileno(),termios.TIOCSWINSZ,struct.pack('HHHH',30,100,0,0));start=datetime.datetime.now(datetime.timezone.utc).isoformat()
result=subprocess.run(['script','-qefc',shlex.join(base+command),'--log-out',str(d/f'terminal-{idx}.log')],env=env)
(d/f'exit-{idx}.json').write_text(json.dumps({'exit':result.returncode,'args':args,'start':start,'end':datetime.datetime.now(datetime.timezone.utc).isoformat(),'environment_keys':list(env),'dimensions':[100,30],'command':command}));sys.exit(result.returncode)
