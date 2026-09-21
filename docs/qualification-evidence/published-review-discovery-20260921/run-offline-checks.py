from pathlib import Path
import os,json,subprocess,tempfile,datetime,signal,sys,hashlib
phase = sys.argv[1] if len(sys.argv)>1 else "all"
assert phase in ["all", "source", "package"]
resume = True
attempt = sys.argv[2] if len(sys.argv)>2 else "attempt1"
assert attempt in ["attempt1", "attempt2", "attempt3"]
os.umask(0o077)
repo=Path('/home/sandesh-tiwari/Desktop/C++/synapsor-runner')
e=repo/'docs/qualification-evidence/published-review-discovery-20260921'
owned=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/published-review-discovery-ed32e38-20260921')
home=owned/'offline-home'
assert (home/'.npm/_cacache').is_dir()
for name in ['package-tmp','package-var-tmp']:(owned/name).mkdir(exist_ok=True)
plan={'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'network':'unshared network namespace; npm offline; writable disposable cache copy','home':str(home),'commands':[]}
base=['bwrap','--ro-bind','/','/','--bind',str(repo),str(repo),'--bind',str(owned),str(owned),'--bind',str(owned/'package-tmp'),'/tmp','--bind',str(owned/'package-var-tmp'),'/var/tmp','--ro-bind',str(repo/'docs/qualification-evidence'),str(repo/'docs/qualification-evidence'),'--bind',str(e),str(e),'--unshare-user','--unshare-net','--unshare-ipc','--cap-drop','ALL','--die-with-parent','--proc','/proc','--dev','/dev','--clearenv','--setenv','PATH',os.environ['PATH'],'--setenv','NO_COLOR','1','--setenv','TERM','xterm-256color','--setenv','COLUMNS','140','--setenv','LINES','42','--setenv','LANG','C.UTF-8','--setenv','HOME',str(home),'--setenv','COREPACK_HOME','/home/sandesh-tiwari/.cache/node/corepack','--setenv','COREPACK_ENABLE_NETWORK','0','--setenv','npm_config_offline','true','--setenv','VERIFY_PACKED_RUNNER_USE_LOCAL_SPEC','1','--chdir',str(repo),'--']
checks=[('trusted-core',['node','scripts/check-trusted-core-dependencies.mjs']),('licenses',['node','scripts/check-license-content.mjs']),('human-commands',['node','scripts/verify-human-command-surface.mjs']),('dsl-sources',['bash','scripts/verify-dsl-source-paths.sh']),('cursor-plugin',['node','scripts/verify-cursor-plugin.mjs']),('mcp-client-configs',['node','scripts/verify-mcp-client-configs.mjs']),('local-package',['bash','scripts/verify-local-runner.sh']),('bundle-freshness',['node','scripts/verify-local-runner-bundle-freshness.mjs']),('public-commands',['bash','scripts/verify-public-commands.sh']),('packed-offline',['bash','scripts/verify-packed-runner.sh'])]
if phase == 'source':
 checks=checks[:6]
 # These commands read current source and write only disposable fixtures.
 i=base.index('--bind'); assert base[i+1]==str(repo); base[i]='--ro-bind'
elif phase == 'package':
 checks=checks[6:]
 prior=json.loads((e/('offline-package-plan-'+attempt+'.json')).read_text()); assert len(prior['commands'])==6 and all(c['exit_code']==0 for c in prior['commands'])
 plan=prior
def source_digest():
 files=subprocess.check_output(['git','ls-files','apps','packages','scripts','package.json','pnpm-lock.yaml'],cwd=repo,text=True).splitlines()
 return hashlib.sha256(json.dumps([(p,hashlib.sha256((repo/p).read_bytes()).hexdigest()) for p in sorted(set(files)) if (repo/p).is_file()]).encode()).hexdigest()
for name,args in checks:
 before=source_digest()
 entry={'name':name,'args':args,'phase':phase,'source_immutable_during_full_suite':phase=='source','started_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 logs=owned/'offline-logs';logs.mkdir(exist_ok=True)
 with (logs/(name+'-'+attempt+'.log')).open('x') as log:
  p=subprocess.Popen(base+args,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  try: code=p.wait(timeout=600)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);code=p.wait();entry['timed_out']=True
 entry.update(exit_code=code,completed_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),source_before=before,source_after=source_digest());plan['commands'].append(entry);(e/('offline-package-plan-'+attempt+'.json' if resume else 'offline-package-plan.json')).write_text(json.dumps(plan,indent=2)+'\n');print(json.dumps(entry),flush=True)

 if code:raise SystemExit(code)
