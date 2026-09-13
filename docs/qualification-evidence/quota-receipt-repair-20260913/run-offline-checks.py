from pathlib import Path
import os,json,subprocess,tempfile,datetime,signal,sys
resume = False
os.umask(0o077)
repo=Path('/home/sandesh-tiwari/Desktop/C++/synapsor-runner')
e=repo/'docs/qualification-evidence/quota-receipt-repair-20260913'
owned=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/quota-receipt-454a0d2-20260913')
home=owned/'offline-home'
assert (home/'.npm/_cacache').is_dir()
for name in ['package-tmp','package-var-tmp']:(owned/name).mkdir(exist_ok=True)
plan={'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'network':'unshared network namespace; npm offline; writable disposable cache copy','home':str(home),'commands':[]}
base=['bwrap','--ro-bind','/','/','--bind',str(repo),str(repo),'--bind',str(owned),str(owned),'--bind',str(owned/'package-tmp'),'/tmp','--bind',str(owned/'package-var-tmp'),'/var/tmp','--ro-bind',str(repo/'docs/qualification-evidence'),str(repo/'docs/qualification-evidence'),'--bind',str(e),str(e),'--unshare-user','--unshare-net','--unshare-ipc','--cap-drop','ALL','--die-with-parent','--proc','/proc','--dev','/dev','--clearenv','--setenv','PATH',os.environ['PATH'],'--setenv','NO_COLOR','1','--setenv','TERM','xterm-256color','--setenv','COLUMNS','140','--setenv','LINES','42','--setenv','LANG','C.UTF-8','--setenv','HOME',str(home),'--setenv','COREPACK_HOME','/home/sandesh-tiwari/.cache/node/corepack','--setenv','COREPACK_ENABLE_NETWORK','0','--setenv','npm_config_offline','true','--setenv','VERIFY_PACKED_RUNNER_USE_LOCAL_SPEC','1','--chdir',str(repo),'--']
checks=[('trusted-core',['node','scripts/check-trusted-core-dependencies.mjs']),('licenses',['node','scripts/check-license-content.mjs']),('human-commands',['node','scripts/verify-human-command-surface.mjs']),('dsl-sources',['bash','scripts/verify-dsl-source-paths.sh']),('cursor-plugin',['node','scripts/verify-cursor-plugin.mjs']),('mcp-client-configs',['node','scripts/verify-mcp-client-configs.mjs']),('local-package',['bash','scripts/verify-local-runner.sh']),('bundle-freshness',['node','scripts/verify-local-runner-bundle-freshness.mjs']),('public-commands',['bash','scripts/verify-public-commands.sh']),('packed-offline',['bash','scripts/verify-packed-runner.sh'])]
if resume: checks=checks[6:]
for name,args in checks:
 entry={'name':name,'args':args,'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 with (e/(name+('-attempt2' if resume else '')+'.log')).open('x') as log:
  p=subprocess.Popen(base+args,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  try: code=p.wait(timeout=600)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);code=p.wait();entry['timed_out']=True
 entry.update(exit_code=code,completed_at=datetime.datetime.now(datetime.timezone.utc).isoformat());plan['commands'].append(entry);(e/('offline-package-plan-attempt2.json' if resume else 'offline-package-plan.json')).write_text(json.dumps(plan,indent=2)+'\n');print(json.dumps(entry),flush=True)

 if code:raise SystemExit(code)
