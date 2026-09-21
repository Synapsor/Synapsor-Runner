from pathlib import Path
import os,sys,json,hashlib,subprocess,datetime,signal,time
from urllib.parse import urlsplit
os.umask(0o077)
repo=Path(__file__).resolve().parents[3]
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/published-review-discovery-ed32e38-20260921')
name=sys.argv[1];args=sys.argv[2:];pg=bool(args and args[0]=='--pg')
if pg:args=args[1:]
assert name.replace('-','').isalnum()
def source():
 files=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','apps','packages','scripts','package.json','pnpm-lock.yaml'],cwd=repo,text=True).splitlines()
 return {p:hashlib.sha256((repo/p).read_bytes()).hexdigest() for p in sorted(set(files)) if (repo/p).is_file()}
before=source();record={'name':name,'command':args,'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),'source_digest':hashlib.sha256(json.dumps(before,sort_keys=True).encode()).hexdigest(),'credentials':'owned PostgreSQL gate URL only' if pg else 'absent','umask':'0077'}
out=r/'gates';(out/(name+'-source.json')).write_text(json.dumps(before,indent=2)+'\n')
env={'PATH':os.environ['PATH'],'HOME':str(r/'test-home'),'NO_COLOR':'1','LANG':'C.UTF-8','TERM':'xterm-256color','COREPACK_HOME':'/home/sandesh-tiwari/.cache/node/corepack','COREPACK_ENABLE_NETWORK':'0','npm_config_offline':'true'}
if pg:
 f=json.loads((r/'private/gate-postgres.json').read_text());info=json.loads(subprocess.check_output(['docker','inspect',f['name']]))[0]
 assert info['Id']==f['id'] and info['Config']['Labels']['synapsor.task']=='published-review-discovery-20260921' and info['State']['Running']
 published=info['NetworkSettings']['Ports']['5432/tcp'];target=urlsplit(f['url'])
 assert target.hostname=='127.0.0.1' and any(x['HostIp']=='127.0.0.1' and int(x['HostPort'])==target.port for x in published), 'Refresh owned gate connection after container port reassignment; never use an unchecked destination'
 record['database_destination']={'host':target.hostname,'port':target.port,'database':target.path.lstrip('/'),'container_id':f['id']}
 env['SYNAPSOR_TEST_POSTGRES_URL']=f['url']
base=['bwrap','--ro-bind','/','/','--bind',str(repo),str(repo),'--ro-bind',str(repo/'docs/qualification-evidence'),str(repo/'docs/qualification-evidence'),'--bind',str(r),str(r),'--bind',str(r/'test-tmp'),'/tmp','--bind',str(r/'test-var-tmp'),'/var/tmp','--unshare-user','--unshare-ipc','--cap-drop','ALL','--die-with-parent','--proc','/proc','--dev','/dev','--clearenv']
if not pg:base+=['--unshare-net']
for k,v in env.items():base+=['--setenv',k,v]
base+=['--chdir',str(repo),'--']
with (out/(name+'.log')).open('x') as log:
 p=subprocess.Popen(base+args,stdout=log,stderr=subprocess.STDOUT,start_new_session=True);record['pid']=p.pid
 (out/(name+'-exit.json')).write_text(json.dumps(record,indent=2)+'\n')
 try:code=p.wait(timeout=3600 if name.startswith('stable-full') else 1200)
 except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);code=p.wait();record['timed_out']=True
after=source();record.update(exit=code,finished_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),source_unchanged=before==after)
(out/(name+'-exit.json')).write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(record));sys.exit(code)
