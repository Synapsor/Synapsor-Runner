from pathlib import Path
import subprocess,os,sys,json,datetime
os.umask(0o077)
E=Path(__file__).resolve().parent;R=E.parents[2];name=sys.argv[1];assert name.replace('-','').isalnum()
O=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/manual-runner-only-75a65f8-20260916');D=O/name;D.mkdir(parents=True)
for x in ['home','tmp','var-tmp']:(D/x).mkdir()
args=['bwrap','--ro-bind','/','/','--bind',str(R),str(R),'--bind',str(O),str(O),'--bind',str(D/'tmp'),'/tmp','--bind',str(D/'var-tmp'),'/var/tmp','--unshare-user','--unshare-net','--unshare-ipc','--cap-drop','ALL','--die-with-parent','--proc','/proc','--dev','/dev','--clearenv']
for k,v in {'PATH':os.environ['PATH'],'HOME':str(D/'home'),'COREPACK_HOME':'/home/sandesh-tiwari/.cache/node/corepack','COREPACK_ENABLE_NETWORK':'0','NO_COLOR':'1','LANG':'C.UTF-8'}.items():args+=['--setenv',k,v]
args+=['--chdir',str(R),'--']+sys.argv[2:]
v={'name':name,'command':sys.argv[2:],'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'log':str(D/'output.log'),'source':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'environment':'network isolated, clear credentials, private HOME/tmp/var-tmp, NO_COLOR, umask0077'}
(D/'source.patch').write_bytes(subprocess.check_output(['git','diff','HEAD']))
with (D/'output.log').open('x') as f:
 try:r=subprocess.run(args,stdout=f,stderr=subprocess.STDOUT,timeout=1200);v['exit_code']=r.returncode
 except subprocess.TimeoutExpired:v['exit_code']='timeout'
v['completed_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();(E/(name+'-result.json')).write_text(json.dumps(v,indent=2)+'\n');print(json.dumps(v));print((D/'output.log').read_text()[-7000:]);sys.exit(v['exit_code'] if isinstance(v['exit_code'],int) else 1)
