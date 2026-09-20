"""Installed public commands on fresh owned projects. Never launches historical work."""
from pathlib import Path
import os,sys,json,subprocess,datetime,hashlib
from urllib.parse import urlparse
os.umask(0o077)
e=Path(__file__).resolve().parent;repo=e.parents[2]
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/mcp-replay-7be8d2a-20260920')
case=sys.argv[1];assert case in ['r0','r1','t0','t1'];args=sys.argv[2:];assert args
omit_writer=False
if args[0]=='--omit-writer':omit_writer=True;args=args[1:]
assert args[0] in ['onboard','start','boundary','action','writeback','mcp','worker','proposals','receipts','config']
d=r/'operational'/case;root=d/'project';db=json.loads((r/'database-private.json').read_text())
assert subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "synapsor.task"}}',db['container']],text=True).strip()==db['tag']
settings=json.loads((r/'operational-private.json').read_text())[case];url=urlparse(settings['reader_url']);assert url.hostname=='127.0.0.1' and url.path=='/'+case
frozen=r/'frozen';subprocess.run(['node',str(frozen/'freeze-repair.mjs'),'--verify'],check=True,stdout=subprocess.DEVNULL)
env={'PATH':str(frozen/'installed/node_modules/.bin')+os.pathsep+os.environ['PATH'],'HOME':str(d/'home'),'TMPDIR':'/var/tmp','NO_COLOR':'1','TERM':'xterm-256color','COLUMNS':'100','LINES':'30','NODE_NO_WARNINGS':'1','COREPACK_ENABLE_NETWORK':'0','DATABASE_URL':settings['reader_url']}
if not omit_writer:
 for k,v in settings.get('writer',{}).items():
  u=urlparse(v);assert u.hostname==url.hostname and u.port==url.port and u.path==url.path;env[k]=v
# No provider, administrator, unrelated credentials or inherited identities.
base=['bwrap','--die-with-parent','--ro-bind','/','/','--bind',str(d),str(d),'--bind',str(d/'tmp'),'/tmp','--bind',str(d/'var-tmp'),'/var/tmp','--proc','/proc','--dev','/dev','--chdir',str(root)]
# Standalone hashed copy of the tested resolver; no mutable workspace/tsx import.
pf=frozen/'preflight';pm=json.loads((pf/'manifest.json').read_text())
for item in pm['records']:assert hashlib.sha256((pf/item['path']).read_bytes()).hexdigest()==item['sha256']
assert hashlib.sha256(Path(pm['node_executable']).read_bytes()).hexdigest()==pm['node_sha256']
pre=subprocess.run(base+[pm['node_executable'],str(pf/'public-preflight.mjs'),str(root)],env=env,capture_output=True,text=True)
assert pre.returncode==0,pre.stderr
idx=len(list(d.glob('invocation-*.json')))+1
command=['node',str(frozen/'installed/node_modules/@synapsor/runner/dist/runner.mjs'),*args]
entry={'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'command':command,'environment_keys':list(env),'preflight':json.loads(pre.stdout),'omit_writer':omit_writer,'provider_calls':0,'status':'running'}
record=d/f'invocation-{idx:03}.json';record.write_text(json.dumps(entry,indent=2))
if args[:2]==['worker','run']:
 assert '--once' in args or '--drain' in args,'finite worker only'
 c=json.loads((r/'counters.json').read_text());assert c.get('final_deadline') and datetime.datetime.now(datetime.timezone.utc)<datetime.datetime.fromisoformat(c['final_deadline'].replace('Z','+00:00'));key='finite_workers';c[key]=c.get(key,0)+1;assert c[key]<=4
 (r/'counters.json').write_text(json.dumps(c,indent=2))
if args[0]=='worker' and args[1] in ['close-blocked','status','dead-letter']:
 c=json.loads((r/'counters.json').read_text())
 if c.get('final_started_at'):
  c['closure_commands']=c.get('closure_commands',0)+1;assert c['closure_commands']<=8
  assert datetime.datetime.now(datetime.timezone.utc)<datetime.datetime.fromisoformat(c['final_deadline'].replace('Z','+00:00'))
  (r/'counters.json').write_text(json.dumps(c,indent=2))
p=subprocess.run(base+command,env=env)
entry.update(exit=p.returncode,status='completed',finished_at=datetime.datetime.now(datetime.timezone.utc).isoformat());record.write_text(json.dumps(entry,indent=2));sys.exit(p.returncode)
