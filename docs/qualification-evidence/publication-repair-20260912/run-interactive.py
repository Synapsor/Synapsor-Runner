from pathlib import Path
import os,subprocess,json,sys,datetime,shlex
os.umask(0o077)
e=Path(__file__).resolve().parent;owned=Path(json.loads((e/'assignment-plan.json').read_text())['owned_root']);name=sys.argv[1];args=sys.argv[2:]
env={'PATH':os.environ['PATH'],'HOME':str(owned/'host-home'),'LANG':'C.UTF-8','NO_COLOR':'1','TERM':'xterm-256color','COLUMNS':'140','LINES':'42','SYNAPSOR_CASE':'edit'}
result={'name':name,'args':args,'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'environment_names':sorted(env)}
p=subprocess.Popen(['script','--quiet','--return','--flush','--command',shlex.join(args),str(e/(name+'.terminal.log'))],env=env)
result['pid']=p.pid;(e/(name+'-exit.json')).write_text(json.dumps(result,indent=2)+'\n')
code=p.wait(timeout=900);result.update(exit_code=code,completed_at=datetime.datetime.now(datetime.timezone.utc).isoformat());(e/(name+'-exit.json')).write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result));raise SystemExit(code)
