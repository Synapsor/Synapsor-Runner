"""Independent full-table/source oracle. No writes to the application or source."""
from pathlib import Path
import json,sys,hashlib,copy,datetime
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/blocked-closure-4b22b46-20260920');d=r/'operational/r1'
mode,before,after=sys.argv[1:];assert mode in ['no-change','closure','fresh','effect']
b=d/('state-'+before);a=d/('state-'+after);read=lambda p:json.loads(p.read_text())
bm=read(b/'manifest.json');am=read(a/'manifest.json')
assert bm['config_files']==am['config_files']
for table,value in bm['tables'].items():
 if table in {'control_policy_identity','control_policy_deployments','control_policy_revisions','control_policy_active','control_policy_drafts','control_policy_reviews','control_policy_events'}:assert value==am['tables'][table], 'Authority changed: '+table
changes=[t for t,v in bm['tables'].items() if v!=am['tables'].get(t)]
expected={t:read(b/('source-'+t+'.json')) for t in ['build_candidates','release_slots','build_checks']}
old=read(d/'state-refused/worker_queue.json')[0]['proposal_id'];orig_receipt=read(d/'state-refused/writeback_receipts.json')[0]
assert next(x for x in read(a/'writeback_receipts.json') if x['proposal_id']==old)==orig_receipt
assert next(x for x in read(a/'proposals.json') if x['proposal_id']==old)==read(d/'state-refused/proposals.json')[0]
assert next(x for x in read(a/'writeback_jobs.json') if x['proposal_id']==old)==read(d/'state-refused/writeback_jobs.json')[0]
assert next(x for x in read(a/'approvals.json') if x['proposal_id']==old)==read(d/'state-refused/approvals.json')[0]
q=next(x for x in read(a/'worker_queue.json') if x['proposal_id']==old);assert q['attempts']==1
if mode=='no-change':assert not changes and bm['config_files']==am['config_files']
elif mode=='closure':
 assert set(changes)<= {'worker_queue','proposal_events','sqlite_sequence'} and 'worker_queue' in changes and 'proposal_events' in changes
 assert q['status']=='discarded' and q['terminal_outcome']=='discarded'
 events=read(a/'proposal_events.json');closed=[e for e in events if e['kind']=='writeback_blocked_closed'];assert len(closed)==1
 payload=json.loads(closed[0]['payload_json']);assert payload['identity']['verified'] is True and payload['identity']['provider']=='signed_key' and payload['approval_refunded'] is False
elif mode=='fresh':
 assert q['status']=='discarded';proposals=read(a/'proposals.json');assert len(proposals)==2
 new=next(x for x in proposals if x['proposal_id']!=old);assert new['state']=='approved'
 assert new['proposal_hash']!=read(d/'state-refused/proposals.json')[0]['proposal_hash']
 approvals=read(a/'approvals.json');assert len(approvals)==2 and len({x['proposal_id'] for x in approvals})==2
 assert all(x['action_boundary_name'] for x in approvals)
 assert len(read(a/'writeback_jobs.json'))==1 and len(read(a/'source-receipts.json'))==0
elif mode=='effect':
 assert q['status']=='discarded';qs=read(a/'worker_queue.json');assert len(qs)==2
 new=next(x for x in qs if x['proposal_id']!=old);assert new['status']=='completed' and new['attempts']==1
 recs=read(a/'writeback_receipts.json');assert len(recs)==2
 rec=json.loads(next(x for x in recs if x['proposal_id']!=old)['receipt_json']);assert rec['status']=='applied' and rec['rows_affected']==2 and rec['source_database_mutated'] is True
 assert read(a/'approvals.json')==read(b/'approvals.json')
 target=read(r/'operational/subjects-private.json')['r1']['candidate'];candidate=next(x for x in expected['build_candidates'] if x['candidate_id']==target['candidate_id']);assert candidate['version']==target['version']+1
 candidate['candidate_state']='sealed';candidate['version']+=1
 slot=next(x for x in expected['release_slots'] if x['slot_id']==candidate['slot_id']);slot['slot_state']='consumed';slot['version']+=1
 source=read(a/'source-receipts.json');assert len(source)==1 and source[0]['status']=='applied' and source[0]['proposal_id']==new['proposal_id']
 assert source[0]['job_id']==rec['writeback_job_id'] and source[0]['idempotency_key']==rec['idempotency_key'] and source[0]['semantic_verification_json'] is not None
 c=read(r/'counters.json');assert c['business_effect_transactions']==1;c['business_effect_transactions']=2;(r/'counters.json').write_text(json.dumps(c,indent=2))
for t,rows in expected.items():assert rows==read(a/('source-'+t+'.json')),t+' differs'
if mode!='effect':assert read(a/'source-receipts.json')==read(b/'source-receipts.json')
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'mode':mode,'before':before,'after':after,'result':'passed','changed_control_tables':changes,'all_source_rows_compared':504,'old_attempts':q['attempts'],'old_status':q['status'],'original_failed_receipt_bytes_sha256':hashlib.sha256(orig_receipt['receipt_json'].encode()).hexdigest(),'old_approval_unchanged':True}
p=d/('comparison-'+mode+'-'+before+'-'+after+'.json');assert not p.exists();p.write_text(json.dumps(result,indent=2));print(json.dumps(result))
