"""Stored-receipt and all-row oracle for the one R0 effect and one R1 refusal.
No mutation, inferred IDs or response-only success oracle.
"""
from pathlib import Path
import json,sys,hashlib,copy,datetime
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/mcp-replay-7be8d2a-20260920')
case,before,after=sys.argv[1:];assert case in ['r0','r1','t0','t1'];d=r/'operational'/case
read=lambda p:json.loads(p.read_text());b=d/('state-'+before);a=d/('state-'+after)
bm=read(b/'manifest.json');am=read(a/'manifest.json')
assert bm['config_files']==am['config_files']
for table,value in bm['tables'].items():
 if table in {'control_policy_identity','control_policy_deployments','control_policy_revisions','control_policy_active','control_policy_drafts','control_policy_reviews','control_policy_events'}:assert value==am['tables'][table], 'Authority changed: '+table
q=read(a/'worker_queue.json');assert len(q)==1 and q[0]['attempts']==1
assert read(a/'approvals.json')==read(b/'approvals.json'),'Prior approval changed'
assert len(read(a/'approvals.json'))==1
stored=read(a/'writeback_receipts.json');assert len(stored)==1
receipt=json.loads(stored[0]['receipt_json']);assert receipt['proposal_id']==q[0]['proposal_id']
expected={t:read(b/('source-'+t+'.json')) for t in ['build_candidates','release_slots','build_checks']}
if case=='r0':
 assert q[0]['status']=='completed';assert receipt['status']=='applied' and receipt['rows_affected']==2 and receipt['source_database_mutated'] is True
 target=read(r/'operational/subjects-private.json')[case]['candidate'];candidate=next(x for x in expected['build_candidates'] if x['candidate_id']==target['candidate_id'])
 candidate['candidate_state']='sealed';candidate['version']+=1
 slot=next(x for x in expected['release_slots'] if x['slot_id']==candidate['slot_id']);slot['slot_state']='consumed';slot['version']+=1
 source_receipts=read(a/'source-receipts.json');assert len(source_receipts)==1 and source_receipts[0]['status']=='applied' and source_receipts[0]['proposal_id']==q[0]['proposal_id']
 assert source_receipts[0]['job_id']==receipt['writeback_job_id'] and source_receipts[0]['idempotency_key']==receipt['idempotency_key']
 assert source_receipts[0]['semantic_verification_json'] is not None
 kind='one exact two-target source effect, both version advances, source_db idempotency/semantic record and separate canonical control receipt'
else:
 assert (d/'owner-drift.json').is_file()
 assert receipt.get('safe_error_code') == 'SEMANTIC_AUTHORITY_STALE'
 proposals=read(a/'proposals.json');assert len(proposals)==1
 assert q[0]['status']=='blocked' and proposals[0]['state']=='failed'
 assert receipt['status']=='failed' and receipt['rows_affected']==0 and receipt['source_database_mutated'] is False
 assert read(a/'source-receipts.json')==[]
 proof=[e for e in read(a/'proposal_events.json') if e['kind']=='writeback_source_rollback'];assert len(proof)==1
 payload=json.loads(proof[0]['payload_json']);assert payload['producer']=='synapsor.postgres.source_db.rollback.v1' and payload['outcome']=='rollback_acknowledged' and payload['required_roles']==['recovery_operator']
 kind='stale refusal after separately recorded owner version drift; no Runner business effect'
for t,rows in expected.items():assert rows==read(a/('source-'+t+'.json')),t+' differs'
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'case':case,'result':'passed','kind':kind,'source_rows_compared':sum(map(len,expected.values())),'same_proposal':q[0]['proposal_id'],'queue_status':q[0]['status'],'attempts':q[0]['attempts'],'last_error_code':q[0]['last_error_code'],'stored_receipt':receipt,'stored_receipt_bytes_sha256':hashlib.sha256(stored[0]['receipt_json'].encode()).hexdigest(),'approval_retained':True,'source_receipts':read(a/'source-receipts.json'),'atomicity_limit':'Success/readback only; no new crash or commit-uncertainty qualification.'}
(d/'worker-comparison.json').write_text(json.dumps(result,indent=2))
c=read(r/'counters.json');key='business_effect_transactions' if case=='r0' else 'stale_refusals';assert c.get(key,0)==0;c[key]=1;(r/'counters.json').write_text(json.dumps(c,indent=2))
print(json.dumps({k:v for k,v in result.items() if k not in ['stored_receipt','source_receipts','same_proposal']}))
