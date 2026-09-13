from pathlib import Path
import json,subprocess,os,hashlib,datetime,stat
os.umask(0o077)
e=Path(__file__).resolve().parent;owned=Path(json.loads((e/'assignment-plan.json').read_text())['owned_root']);out=owned/'cleanup';out.mkdir();ev=e/'cleanup';ev.mkdir()
f=json.loads((e/'postgres-fixture.json').read_text());home=owned/'host-home';env={'PATH':os.environ['PATH'],'HOME':str(home),'LANG':'C.UTF-8','NO_COLOR':'1'}
def command(args,**kw):return subprocess.run(args,env=env,check=True,**kw)
def inspect():
 d=json.loads(command(['docker','inspect',f['name']],capture_output=True,text=True).stdout)[0]
 assert d['Id']==f['id'];assert d['Config']['Labels']['synapsor.qualification']=='reviewed-clients-repair-20260913';assert d['HostConfig']['NetworkMode']=='none';return d
before=inspect();assert before['State']['Running'];(out/'container-before.json').write_text(json.dumps(before,indent=2)+'\n')
# Only recorded assignment PIDs are inspected. Never kill a PID just because it exists.
pids={}
for p in list(e.glob('*-exit.json')) + list((owned/'runtime').glob('*/setup-evidence/*-result.json')) + list((owned/'runtime').glob('*/deterministic/publication-operator-result.json')):
 d=json.loads(p.read_text())
 if isinstance(d.get('pid'),int):pids[d['pid']]=str(p)
for p in list((owned/'runtime').glob('*/deterministic/events.jsonl'))+list((owned/'reproduction').glob('*/deterministic/events.jsonl')):
 for line in p.read_text().splitlines():
  d=json.loads(line)
  if d.get('event') in ['mcp_process','operator_process','interactive_operator_process']:pids[d['pid']]=str(p)
processes=[]
for pid,record in pids.items():
 p=Path('/proc')/str(pid)/'cmdline'
 try:args=p.read_bytes().replace(b'\0',b' ').decode(errors='replace')
 except FileNotFoundError:args=None
 processes.append({'pid':pid,'record':record,'running':args is not None,'command':args})
# All application and test operations have completed. A live recorded process
# is an unexpected prerequisite for cleanup; preserve its identity and stop here.
(out/'recorded-processes.json').write_text(json.dumps(processes,indent=2)+'\n')
live=[p for p in processes if p['running']];assert not live, f'Recorded process still exists; investigate before cleanup: {[p["pid"] for p in live]}'
logs=command(['docker','logs','--timestamps',f['name']],capture_output=True)
(out/'postgres.stdout.log').write_bytes(logs.stdout);(out/'postgres.stderr.log').write_bytes(logs.stderr)
owners=[json.loads(p.read_text()) for lane in ['reproduction','runtime'] for p in (owned/lane).glob('*/ownership.json')]
dbs=[f['fixture_database']]+sorted({owner['database'] for owner in owners})
dumps=[]
for db in dbs:
 dest=out/(db+'.dump')
 with dest.open('xb') as file:command(['docker','exec',f['name'],'pg_dump','-U','postgres','-d',db,'--format=custom'],stdout=file,stderr=subprocess.PIPE)
 listing=command(['docker','exec','-i',f['name'],'pg_restore','--list'],input=dest.read_bytes(),capture_output=True)
 (out/(db+'-dump-contents.txt')).write_bytes(listing.stdout)
 dumps.append({'database':db,'path':str(dest),'bytes':dest.stat().st_size,'sha256':hashlib.sha256(dest.read_bytes()).hexdigest(),'pg_restore_list_exit':0})
roles=command(['docker','exec',f['name'],'pg_dumpall','-U','postgres','--globals-only','--no-role-passwords'],capture_output=True);(out/'roles-without-passwords.sql').write_bytes(roles.stdout)
state=[]
for root in [Path(owner['owned']) for owner in owners]:
 if not root.is_dir() or root.name=='node_modules' or not (root/'ownership.json').is_file():continue
 for p in sorted((root/'project/.synapsor').rglob('*')):
  if p.is_file() and p.suffix in ['.db','.sqlite']:
   state.append({'path':str(p),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
(out/'saved-state.json').write_text(json.dumps({'saved_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'dumps':dumps,'sqlite_files_retained_in_owned_directories':state,'role_passwords_exported':False},indent=2)+'\n')
# Save and validate the exact current container identity again immediately before stop.
inspect();stop=command(['docker','stop','--time','10',f['name']],capture_output=True,text=True);after=inspect();assert not after['State']['Running'];(out/'container-stopped.json').write_text(json.dumps(after,indent=2)+'\n')
result={'stopped_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'container_name':f['name'],'container_id':f['id'],'stop_exit_code':0,'running_after':after['State']['Running'],'removed':False,'recorded_processes_checked':len(processes),'recorded_test_application_processes_running':0,'owned_sqlite_and_failure_directories':'retained; no further workers','dumps':dumps,'original_resources_touched':False,'logs_saved_before_stop':True}
(out/'cleanup-result.json').write_text(json.dumps(result,indent=2)+'\n')
for name in ['recorded-processes.json','saved-state.json','cleanup-result.json']:(ev/name).write_bytes((out/name).read_bytes())
print(json.dumps(result))
