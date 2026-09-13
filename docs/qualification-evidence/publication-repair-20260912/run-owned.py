from pathlib import Path
import os,subprocess,json,sys,datetime,signal
os.umask(0o077)
e=Path(__file__).resolve().parent;plan=json.loads((e/'assignment-plan.json').read_text());owned=Path(plan['owned_root']);home=owned/'host-home';home.mkdir(exist_ok=True)
name=sys.argv[1];args=sys.argv[2:];case=None
if args and args[0]=='--case':case=args[1];args=args[2:]
env={'PATH':os.environ['PATH'],'HOME':str(home),'LANG':'C.UTF-8','NO_COLOR':'1','TERM':'xterm-256color','COLUMNS':'140','LINES':'42'}
if case:env['SYNAPSOR_CASE']=case
manifest=json.loads((owned/'frozen/installed-artifact-manifest.json').read_text())
result={'name':name,'args':args,'case':case,'environment_names':sorted(env),'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'artifact_tree':manifest['installed_tree_sha256'],'source_commit':manifest['source_commit'],'product_commit':manifest['product_commit'],'test_commit':manifest['test_commit']}
with (e/(name+'.log')).open('x') as out:
 p=subprocess.Popen(args,env=env,stdout=out,stderr=subprocess.STDOUT,start_new_session=True);result['pid']=p.pid;(e/(name+'-exit.json')).write_text(json.dumps(result,indent=2)+'\n')
 try:code=p.wait(timeout=180)
 except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGTERM);code=p.wait(timeout=10);result['timeout']=True
result.update(exit_code=code,completed_at=datetime.datetime.now(datetime.timezone.utc).isoformat());(e/(name+'-exit.json')).write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result));raise SystemExit(code)
