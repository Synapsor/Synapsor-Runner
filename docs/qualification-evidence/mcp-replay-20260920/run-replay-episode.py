"""One predeclared installed R1 episode. Stops on any command or oracle failure.
A failed episode is retained, not restarted. Each replay has full logical readbacks.
"""
from pathlib import Path
import json,subprocess,datetime,hashlib,os,copy
os.umask(0o077)
e=Path(__file__).resolve().parent;r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/mcp-replay-7be8d2a-20260920');d=r/'operational/r1'
record=r/'final-episode.json';assert not record.exists();assert (r/'sealed-starts/manifest.json').is_file();assert (r/'tester-restoration.json').is_file()
assert json.loads((r/'tester-restoration.json').read_text())['result']=='PASS'
now=datetime.datetime.now(datetime.timezone.utc)
counters={'final_started_at':now.isoformat(),'final_deadline':(now+datetime.timedelta(seconds=5400)).isoformat(),'request_change':0,'finite_workers':0,'business_effect_transactions':0,'owner_version_changes':0,'closure_commands':0,'provider_calls':0}
assert not (r/'counters.json').exists();(r/'counters.json').write_text(json.dumps(counters,indent=2))
result={'started_at':now.isoformat(),'status':'running','one_episode':True,'provider_calls':0,'steps':[]};record.write_text(json.dumps(result,indent=2))
def run(name,*args):
 assert datetime.datetime.now(datetime.timezone.utc)<datetime.datetime.fromisoformat(counters['final_deadline'])
 command=['node' if name.endswith('.mjs') else 'python3',str(e/name),*map(str,args)]
 p=subprocess.run(command,capture_output=True,text=True,timeout=300)
 n=len(result['steps'])+1;log=r/f'episode-step-{n:02}.log';log.write_text(p.stdout+p.stderr)
 result['steps'].append({'command':command,'exit':p.returncode,'log':str(log),'at':datetime.datetime.now(datetime.timezone.utc).isoformat()});record.write_text(json.dumps(result,indent=2))
 if p.returncode:raise RuntimeError('Command/oracle refused; preserve '+str(log))
def read(label,name):return json.loads((d/('state-'+label)/(name+'.json')).read_text())
def snap(label):run('snapshot-operational.py','r1',label)
def mcp(label,plan):
 f=d/(label+'-plan.json');f.write_text(json.dumps(plan,indent=2));run('public-mcp.mjs','r1',label,f)
 return json.loads((d/('mcp-'+label)/'results.json').read_text())
def projection(execution,disposition,status,source):return {'request_disposition':'already_recorded','authorization':{'approval':'automatic','eligibility_basis':'original_request'},'status':status,'execution':'completed' if execution=='applied' else 'queued' if execution=='queued' else 'held','lifecycle':{'execution':execution,'disposition':disposition,'automatic_retry_scheduled':False,'next_retry_at':None},'invocation':{'operation':'returned_existing_request','source_database_changed':False},'source_database_changed':source}
def replay(args,expected):return {'name':'app.request_change','arguments':args,'expected':'ok','replay':True,'expected_projection':expected}
def digest(v):return 'sha256:'+hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
try:
 snap('episode-start')
 requestPlan=json.loads((e/'public-request-plan.json').read_text())
 first=mcp('first-and-queued',requestPlan+[{'operation':'replay_previous_request','expected_projection':projection('queued','open','approved_pending_execution',False)}])
 oldArgs=next(x['step']['arguments'] for x in first if x['step'].get('name')=='app.request_change');snap('queued')
 assert len(read('queued','approvals'))==1 and len(read('queued','proposals'))==1
 assert read('queued','worker_queue')[0]['status']=='queued' and read('queued','worker_queue')[0]['attempts']==0
 assert read('queued','manifest')['source']==read('episode-start','manifest')['source'];assert read('queued','source-receipts')==[]
 run('owner-drift.py');snap('owner-drift')
 assert read('queued','manifest')['tables']==read('owner-drift','manifest')['tables'];assert read('queued','manifest')['config_files']==read('owner-drift','manifest')['config_files']
 owner=json.loads((d/'owner-drift.json').read_text());expect=copy.deepcopy(read('queued','source-build_candidates'));target=next(x for x in expect if x['candidate_id']==owner['before']['candidate_id']);target['version']+=1
 assert expect==read('owner-drift','source-build_candidates')
 for table in ['release_slots','build_checks']:assert read('queued','source-'+table)==read('owner-drift','source-'+table)
 run('finite-worker.py','r1','worker-stale');snap('refused');run('compare-worker.py','r1','owner-drift','refused')
 mcp('before-closure',[replay(oldArgs,projection('failed','blocked','attention_required',False))])
 run('close-public.py','r1','preview');assert json.loads((d/'closure-preview.log').read_text())['status']=='available'
 run('close-public.py','r1','confirm');snap('closed');run('compare-recovery.py','closure','refused','closed')
 mcp('after-closure',[replay(oldArgs,projection('failed','closed','closed',False))])
 fresh=mcp('fresh',requestPlan);freshArgs=next(x['step']['arguments'] for x in fresh if x['step'].get('name')=='app.request_change');assert freshArgs!=oldArgs
 snap('fresh');run('compare-recovery.py','fresh','closed','fresh')
 run('finite-worker.py','r1','worker-fresh');snap('fresh-applied');run('compare-recovery.py','effect','fresh','fresh-applied')
 # Independent hash recomputation: canonical control core and the source adapter's
 # ordered result material have DIFFERENT contracts. Preserve receipt bytes too.
 receipts=read('fresh-applied','writeback_receipts');hashes=[]
 for row in receipts:
  receipt=json.loads(row['receipt_json']);stored=receipt.pop('receipt_hash');assert digest(receipt)==stored
  hashes.append({'status':receipt['status'],'control_receipt_hash':stored,'control_hash_verified':True,'stored_bytes_sha256':hashlib.sha256(row['receipt_json'].encode()).hexdigest()})
  if receipt['status']=='applied':
   material={'job_id':receipt['writeback_job_id'],'status':receipt['status'],'effect_digest':receipt['semantic_verification']['effect_digest'],'atomic_effects':receipt['atomic_effects']}
   computed='sha256:'+hashlib.sha256(json.dumps(material,separators=(',',':'),ensure_ascii=False).encode()).hexdigest();source=read('fresh-applied','source-receipts');assert len(source)==1 and source[0]['result_hash']==computed
   hashes[-1].update(source_result_hash=computed,source_hash_verified=True)
 (d/'receipt-hash-verification.json').write_text(json.dumps(hashes,indent=2))
 mcp('applied-and-old',[replay(freshArgs,projection('applied','open','completed',True)),replay(oldArgs,projection('failed','closed','closed',False))])
 # public-mcp closes the previous stdio child. A separate process loads the same
 # reviewed local context; original opaque arguments retain ordinary TTL/access.
 mcp('restart-old',[replay(oldArgs,projection('failed','closed','closed',False))])
 run('close-public.py','r1','inspect');run('close-public.py','r1','status');snap('final')
 assert read('final','source-build_candidates')==read('fresh-applied','source-build_candidates')
 assert read('final','source-release_slots')==read('fresh-applied','source-release_slots')
 assert read('final','source-build_checks')==read('fresh-applied','source-build_checks')
 assert read('final','writeback_receipts')==read('fresh-applied','writeback_receipts')
 assert read('final','approvals')==read('fresh-applied','approvals')
 counts=json.loads((r/'counters.json').read_text());assert counts['request_change']==8 and counts['finite_workers']==2 and counts['business_effect_transactions']==1 and counts['owner_version_changes']==1 and counts['closure_commands']==4
 result.update(status='passed',counters=counts,receipt_hashes=hashes,topology='single host, PostgreSQL source / SQLite control; six sequential generated stdio MCP processes, queued replay shares initial process, applied+old share one process then explicit restart')
except BaseException as error:
 result.update(status='stopped',error=type(error).__name__,message=str(error));raise
finally:
 result.update(finished_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),elapsed_seconds=(datetime.datetime.now(datetime.timezone.utc)-now).total_seconds());record.write_text(json.dumps(result,indent=2))
print(json.dumps({'status':result['status'],'elapsed_seconds':result['elapsed_seconds'],'counters':result.get('counters')}))
