"""Public installed CLI, no network, originals and frozen installation read-only."""
from pathlib import Path
import json,os,subprocess,sys,datetime
os.umask(0o077)
owned=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/finding9-counter-454a0d2-20260913')
project=owned/'fixture/project';project.mkdir(exist_ok=True)
logical=Path('/tmp/finding9-project');(owned/'tmp/finding9-project').mkdir(exist_ok=True)
installed=owned/'frozen/installed';cli=installed/'node_modules/.bin/synapsor-runner'
args=sys.argv[1:]
env={'PATH':os.environ['PATH'],'HOME':str(owned/'offline-home'),'NO_COLOR':'1','TERM':'xterm-256color','COLUMNS':'130','LINES':'40','LANG':'C.UTF-8'}
# Identity is backend-owned fixture configuration; never drafted by a model.
for key in ['DATABASE_URL','SYNAPSOR_TENANT_ID','SYNAPSOR_PRINCIPAL','SYNAPSOR_DATABASE_WRITE_URL','SYNAPSOR_WRITE_FREIGHT_DISPATCH_EA9D396C']:
 value=(owned/'fixture'/key)
 if value.is_file():env[key]=value.read_text().strip()
base=['bwrap','--ro-bind','/','/','--bind',str(owned),str(owned),'--ro-bind',str(installed),str(installed),'--bind',str(owned/'tmp'),'/tmp','--bind',str(owned/'var-tmp'),'/var/tmp','--bind',str(owned/'fixture/socket'),'/tmp/pg','--bind',str(project),str(logical),'--unshare-user','--unshare-net','--unshare-ipc','--cap-drop','ALL','--die-with-parent','--proc','/proc','--dev','/dev','--clearenv']
for key,value in env.items():base+=['--setenv',key,value]
base+=['--chdir',str(logical),'--',str(cli),*args]
with (owned/'logs/public-invocations.jsonl').open('a') as f:f.write(json.dumps({'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'args':args,'project':str(project),'network':'none','provider_credentials':'absent'})+'\n')
if sys.stdin.isatty() or args[:2] == ["mcp", "serve"]:
 r=subprocess.run(base)
else:
 r=subprocess.run(base,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%H%M%S%f')
 (owned/'logs'/f'public-{stamp}.stdout').write_bytes(r.stdout)
 (owned/'logs'/f'public-{stamp}.stderr').write_bytes(r.stderr)
 sys.stdout.buffer.write(r.stdout);sys.stderr.buffer.write(r.stderr)
with (owned/'logs/public-invocations.jsonl').open('a') as f:f.write(json.dumps({'completed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'args':args,'exit_code':r.returncode})+'\n')
raise SystemExit(r.returncode)
