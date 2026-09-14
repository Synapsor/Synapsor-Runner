"""Read-only adjudication of the demonstrated selected-wrapper measurement mismatch."""
from pathlib import Path
import json,hashlib,datetime
E=Path(__file__).resolve().parent
O=Path(json.loads((E/'assignment-plan.json').read_text())['owned_root'])
D=O/'runs/recovery-software/deterministic'
a=json.loads((D/'review-baseline-state.json').read_text())
b=json.loads((D/'review-final-state.json').read_text())
r=json.loads((E/'recovery-software-final-review.json').read_text())
assert r['status']=='failed_or_incomplete' and 'Keep exact saved Action program' in r['error']
assert a['active']==b['active'] and a['config']==b['config']
assert a['ledger']['control_policy_revisions']==b['ledger']['control_policy_revisions']
assert a['authority']['authority']['authority']==b['authority']['authority']['authority']
assert a['authority']['authority']['digest']==b['authority']['authority']['digest']
assert a['authority']['authority']['reviews']==b['authority']['authority']['reviews']
assert a['authority']['authority']['state']=='active' and b['authority']['authority']['state']=='disabled'
matching=[x for x in a['ledger']['control_policy_revisions'] if x['kind']=='action' and json.loads(x['content_json'])==b['authority']]
assert len(matching)==1
for table in ['proposals','approvals','worker_queue','writeback_receipts','writeback_jobs']:
 assert a['ledger'][table]==b['ledger'][table]
assert a['sources']['snapshots']==b['sources']['snapshots']
assert a['sources']['operator_messages']==b['sources']['operator_messages']
assert r['business_review_ready'] and not b['resume'].get('pending_action_revision')
assert any(p.get('application_obligations')==['independent_source_readback'] and p['disposition']=='needs_decision' and p['responsibility']=='application' for p in r['pending_responsibilities'])
assert any(p.get('deployment_prerequisite')=='runner_execution_setup' and 'source_db' in p['interpretation'] and p['disposition']=='needs_decision' for p in r['pending_responsibilities'])
receipt=json.loads((E/'software-after-review-preservation.json').read_text())
assert receipt['status']=='passed_after_review_exact_source_db_bindings_history_source_and_authority'
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'artifact_tree':r['artifact_tree'],'status':'passed_existing_saved_record_selection_and_responsibility_control','original_failed_verifier':'software-public-review-exit.json (exit 1 retained)','cause':'The generic host verifier compared the selected active wrapper with the pre-existing disabled wrapper. Inner business authority, digest and reviews are byte-equivalent JSON; the whole selected disabled record already existed before this run.','selected_existing_revision':matching[0]['revision_id'],'all_stored_policy_revisions_unchanged':True,'active_authority_unchanged':True,'execution_configuration_unchanged':True,'approval_receipt_queue_history_unchanged':True,'same_source_and_source_receipt_preserved':True,'business_review_ready':True,'source_db_and_independent_observation_remain_separate':True,'fresh_writer_worker_or_per_execution_readback_verified':False,'application_rerun_or_status_edits':False,'snapshot_hashes':{n:hashlib.sha256((D/n).read_bytes()).hexdigest() for n in ['review-baseline-state.json','review-final-state.json']}}
(E/'software-wrapper-adjudication.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
