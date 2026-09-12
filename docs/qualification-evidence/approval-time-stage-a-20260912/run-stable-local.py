from pathlib import Path
import os,json,subprocess,datetime,signal
repo=Path(__file__).resolve().parents[3]
e=Path(__file__).resolve().parent
owned=Path("/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/approval-time-stage-a-a0942d1-20260912")
environment=owned/'stable-environment';environment.mkdir()
for name in ['home','tmp','var-tmp']:(environment/name).mkdir()
plan={'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'environment':str(environment),'network':'unshared; no database or provider credentials','known_failing_qualification':'publication reproduction stopped and retained separately; no overall qualification pass','commands':[]}
base=['bwrap','--ro-bind','/','/','--bind',str(repo),str(repo),'--bind',str(owned),str(owned),'--bind',str(environment/'tmp'),'/tmp','--bind',str(environment/'var-tmp'),'/var/tmp','--ro-bind',str(repo/'docs/qualification-evidence/atomic-approval-20260912'),str(repo/'docs/qualification-evidence/atomic-approval-20260912'),'--unshare-user','--unshare-net','--unshare-ipc','--cap-drop','ALL','--die-with-parent','--proc','/proc','--dev','/dev','--clearenv','--setenv','PATH',os.environ['PATH'],'--setenv','LANG','C.UTF-8','--setenv','HOME',str(environment/'home'),'--setenv','TERM','xterm-256color','--setenv','COLUMNS','140','--setenv','LINES','42','--setenv','NO_COLOR','1','--chdir',str(repo),'--']
checks=[('stable-types',['node','node_modules/typescript/bin/tsc','-b','--pretty','false']),('stable-full',['node','node_modules/vitest/vitest.mjs','run','--maxWorkers=4','--minWorkers=1','--testTimeout=20000','--hookTimeout=20000','--reporter=default','--reporter=json','--outputFile.json='+str(e/'stable-full.json')])]
for name,args in checks:
 entry={'name':name,'args':args,'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 plan['commands'].append(entry);(e/'stable-local-plan.json').write_text(json.dumps(plan,indent=2)+'\n')
 with (e/(name+'.log')).open('w') as log:
  child=subprocess.Popen(base+args,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  try:code=child.wait(timeout=2700)
  except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);code=child.wait();entry['timed_out']=True
 entry.update(exit_code=code,completed_at=datetime.datetime.now(datetime.timezone.utc).isoformat());(e/'stable-local-plan.json').write_text(json.dumps(plan,indent=2)+'\n');print(json.dumps(entry),flush=True)
 if code:break
