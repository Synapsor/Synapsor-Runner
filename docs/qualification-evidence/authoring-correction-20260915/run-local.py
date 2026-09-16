from pathlib import Path
import os,json,subprocess,datetime,signal,sys
os.umask(0o077)
repo=Path(__file__).resolve().parents[3];e=Path(__file__).resolve().parent;plan=json.loads((e/'assignment-plan.json').read_text());owned=Path(plan['owned_root'])
name=sys.argv[1];args=sys.argv[2:];pg=False
final_pg=bool(args and args[0]=='--pg-final')
reload_pg=bool(args and args[0]=='--pg-reload')
if args and args[0] in ['--pg','--pg-final','--pg-reload']:pg=True;args=args[1:]
assert name.replace('-','').replace('_','').isalnum()
environment=owned/'test-environments'/name;environment.mkdir(parents=True)
for part in ['home','tmp','var-tmp']:(environment/part).mkdir()
observations=e/name;observations.mkdir()
base=['bwrap','--ro-bind','/','/','--bind',str(repo),str(repo),'--bind',str(owned),str(owned),'--bind',str(environment/'tmp'),'/tmp','--bind',str(environment/'var-tmp'),'/var/tmp']
base+=['--ro-bind',str(repo/'docs/qualification-evidence'),str(repo/'docs/qualification-evidence'),'--bind',str(e),str(e)]
base+=['--ro-bind',str(repo/'apps/runner/src/semantic-admission-publication.qualification.ts'),str(repo/'apps/runner/src/semantic-admission-publication.qualification.ts')]
base+=['--unshare-user','--unshare-net','--unshare-ipc','--cap-drop','ALL','--die-with-parent','--proc','/proc','--dev','/dev','--clearenv']
env={'PATH':os.environ['PATH'],'COREPACK_HOME':'/home/sandesh-tiwari/.cache/node/corepack','COREPACK_ENABLE_NETWORK':'0','LANG':'C.UTF-8','HOME':str(environment/'home'),'TERM':'xterm-256color','COLUMNS':'140','LINES':'42','NO_COLOR':'1','SYNAPSOR_TEST_EVIDENCE_DIR':str(observations)}
if pg:
 fixture=json.loads((owned/('private/live-postgres-reload.json' if reload_pg else 'private/live-postgres-final.json' if final_pg else 'private/live-postgres.json')).read_text())
 assert fixture['required_schema_table_transaction_lock_permissions']
 info=json.loads(subprocess.check_output(['docker','inspect',fixture['name']]))[0]
 assert info['Id']==fixture['id'] and info['State']['Running']
 assert info['Config']['Labels']['synapsor.qualification']==fixture['label']=='authoring-correction-20260915'
 assert info['HostConfig']['NetworkMode']=='none'
 from urllib.parse import urlparse,parse_qs
 destination=urlparse(fixture['connectionString']);query=parse_qs(destination.query)
 assert destination.scheme in ['postgres','postgresql'] and not destination.hostname
 assert query.get('host')==[fixture['socket']] and destination.path=='/'+fixture['database']
 base+=['--ro-bind',fixture['socket'],fixture['socket']];env['SYNAPSOR_TEST_POSTGRES_URL']=fixture['connectionString']
for k,v in env.items():base+=['--setenv',k,v]
base+=['--chdir',str(repo),'--']
entry={'name':name,'args':args,'owned_postgres_database_url_enabled':pg,'creation_umask':'0077','started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),'source_diff_sha256':__import__('hashlib').sha256(subprocess.check_output(['git','diff','HEAD'],cwd=repo)).hexdigest(),'environment':str(environment),'observations':str(observations)}
source_files=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','--','apps','packages','scripts'],cwd=repo,text=True).splitlines()
source_records={f:__import__('hashlib').sha256((repo/f).read_bytes()).hexdigest() for f in source_files if (repo/f).is_file() and (repo/f).suffix in ['.ts','.tsx','.js','.mjs','.cjs','.json','.sh']}
source_manifest=e/(name+'-source.json');source_manifest.write_text(json.dumps(source_records,sort_keys=True,indent=2)+'\n');entry['source_manifest_sha256']=__import__('hashlib').sha256(source_manifest.read_bytes()).hexdigest()
(e/(name+'-exit.json')).write_text(json.dumps(entry,indent=2)+'\n')
with (e/(name+'.log')).open('x') as log:
 child=subprocess.Popen(base+args,stdout=log,stderr=subprocess.STDOUT,start_new_session=True);entry['pid']=child.pid
 (e/(name+'-exit.json')).write_text(json.dumps(entry,indent=2)+'\n')
 try:code=child.wait(timeout=3600 if name in ['stable-full','stable-full02','stable-full03'] else 1200)
 except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);code=child.wait();entry['timed_out']=True
after_files=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','--','apps','packages','scripts'],cwd=repo,text=True).splitlines()
after={f:__import__('hashlib').sha256((repo/f).read_bytes()).hexdigest() for f in after_files if (repo/f).is_file() and (repo/f).suffix in ['.ts','.tsx','.js','.mjs','.cjs','.json','.sh']};(e/(name+'-source-after.json')).write_text(json.dumps(after,sort_keys=True,indent=2)+'\n');entry['source_unchanged']=after==source_records
entry.update(exit_code=code,completed_at=datetime.datetime.now(datetime.timezone.utc).isoformat());(e/(name+'-exit.json')).write_text(json.dumps(entry,indent=2)+'\n');print(json.dumps(entry),flush=True)

raise SystemExit(code)
