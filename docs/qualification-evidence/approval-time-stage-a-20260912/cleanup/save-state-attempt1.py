from pathlib import Path
import json,subprocess,hashlib,os,datetime
O=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/approval-time-stage-a-a0942d1-20260912');E=Path('/home/sandesh-tiwari/Desktop/C++/synapsor-runner/docs/qualification-evidence/approval-time-stage-a-20260912');D=O/'cleanup';D.mkdir(exist_ok=False)
run=lambda args:subprocess.run(args,capture_output=True,check=True)
now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
pids=set()
for p in (O/'runtime').glob('*/deterministic/events.jsonl'):
 for line in p.read_text().splitlines():
  event=json.loads(line)
  if event['event'] in ['mcp_process','operator_process','interactive_operator_process']:pids.add(event['pid'])
  if 'host_pid' in event:pids.add(event['host_pid'])
state=[]
for pid in sorted(pids):
 path=Path('/proc')/str(pid)/'cmdline'
 state.append({'pid':pid,'exists':path.exists(),'command':path.read_bytes().replace(b'\0',b' ').decode(errors='replace') if path.exists() else None})
assert all(not s['exists'] for s in state),state
(D/'recorded-processes-before-cleanup.json').write_text(json.dumps({'at':now(),'processes':state},indent=2)+'\n')
containers=[]
for name,expected in [('synapsor-stagea-48dc85de',None),('synapsor-stagea-987b2499',None),('synapsor-stagea-2f2ec662','48a3223e89ba875ca805e74ff24173f34fa3a1b6de85f3b1cbee72f14c9ea739')]:
 raw=run(['docker','inspect',name]).stdout;(D/(name+'-before.json')).write_bytes(raw);c=json.loads(raw)[0]
 assert c['Config']['Labels']['synapsor.qualification']=='approval-time-stage-a-20260912';assert c['HostConfig']['NetworkMode']=='none'
 if expected:assert c['Id']==expected
 containers.append({'name':name,'id':c['Id'],'running':c['State']['Running'],'mounts':c['Mounts'],'initial_exit':c['State']['ExitCode']})
 logs=subprocess.run(['docker','logs','--timestamps',name],capture_output=True);assert logs.returncode==0
 (D/(name+'-before.stdout.log')).write_bytes(logs.stdout);(D/(name+'-before.stderr.log')).write_bytes(logs.stderr)
dumps=O/'runtime/db-dumps';dumps.mkdir(exist_ok=False);records=[]
for db in ['synapsor_stage_a','insurance_stagea_main','insurance_stagea_overall','insurance_stagea_collection']:
 p=dumps/(db+'.sql');data=run(['docker','exec','synapsor-stagea-2f2ec662','pg_dump','-U','postgres','-d',db]).stdout
 assert len(data)>1000 and b'PostgreSQL database dump complete' in data;p.write_bytes(data);os.chmod(p,0o600)
 records.append({'database':db,'path':str(p),'size':len(data),'sha256':hashlib.sha256(data).hexdigest()})
(D/'saved-state.json').write_text(json.dumps({'at':now(),'containers':containers,'database_dumps':records,'recorded_processes_all_exited':True},indent=2)+'\n');print('Saved four complete owned database dumps; all',len(pids),'recorded MCP/worker/driver processes exited; no cleanup performed yet')
