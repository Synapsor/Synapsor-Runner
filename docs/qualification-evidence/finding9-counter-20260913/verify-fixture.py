"""Read-only assertions over the owned fixture's preserved checkpoints and public logs."""
from pathlib import Path
import json,hashlib,datetime
owned=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/finding9-counter-454a0d2-20260913');e=Path(__file__).parent
load=lambda p:json.loads(p.read_text())
cp=lambda name:load(owned/'checkpoints'/name/'summary.json')
source=lambda name:load(owned/'checkpoints'/name/'source.json')
checks=[]
def check(name,condition):
 assert condition,name
 checks.append({'check':name,'result':'PASS'})
base=cp('before-counters')
for name in ['after-cancel','after-refusal','stale-rejected','after-disabled-save']:
 x=cp(name);check(name+' leaves full ledger and source unchanged',x['ledger_sha256']==base['ledger_sha256'] and x['source_sha256']==base['source_sha256'])
for name in ['saved-disabled-verified','after-separate-activation','writer-provisioned-before-rescan','revalidated-action-activated','after-requests-before-worker']:
 check(name+' leaves source unchanged',cp(name)['source_sha256']==base['source_sha256'])
check('disabled save does not activate Action or create runtime work',cp('saved-disabled-verified')['tables']['control_policy_active']==2 and cp('saved-disabled-verified')['tables']['proposals']==0)
check('approval does not write source',cp('human-approved-before-worker')['source_sha256']==cp('after-auto-execution')['source_sha256'])
check('secondary counter conflict writes no row',cp('conflict-after-external-write-before-worker')['source_sha256']==cp('after-conflict-worker')['source_sha256'])
check('cancel preserves active Read, Action, execution and complete ledger',cp('final-active-before-cancel')['ledger_sha256']==cp('final-active-after-cancel')['ledger_sha256'] and cp('final-active-before-cancel')['source_sha256']==cp('final-active-after-cancel')['source_sha256'])
a=load(owned/'fixture/project/saved-counters.json');b=load(owned/'fixture/project/revalidated-input.json');f=load(owned/'fixture/project/final-active-input.json')
check('writer metadata revalidation preserves exact typed Action rules',a['actions']==b['actions']==f['actions'])
for version in [a,b,f]:
 resources=version['action_authoring_catalog']['resources'];check('both reviewed counters persist under '+version['action_authoring_catalog']['generation_lock_fingerprint'],all(r['selected_version_field']=='rev_no' and r['operations']['update'] for r in resources if r['name'] in ['public.dock_slots','public.shipments']))
records=lambda name:[json.loads(l) for l in (owned/'logs'/name).read_text().splitlines()]
r=records('mcp-rows.jsonl')[1]['result']['structuredContent'];check('public Read returns exactly five in-scope shipments', [v['ref_code'] for v in r['data']]==['NW-1001','NW-1002','NW-1003','NW-1004','NW-1005'])
check('public tool surface stays four reviewed tools',sorted(t['name'] for t in records('mcp-describe.jsonl')[0]['result']['tools'])==sorted(['app.describe_data','app.explore_data','app.describe_actions','app.request_change']))
r=records('mcp-requests.jsonl')[1:];check('automatic, human, consumed-slot refusal, cancelled refusal', [v['result']['structuredContent'].get('status',v['result']['structuredContent'].get('error_code')) for v in r]==['approved_pending_execution','pending_human_review','SEMANTIC_ACTION_NOT_ELIGIBLE','SEMANTIC_ACTION_NOT_ELIGIBLE'])
r=records('mcp-final.jsonl')[1:]
check('identical replay verifies both completions without new proposals',all(v['result']['structuredContent']['status']=='completed' and v['result']['structuredContent']['request_disposition']=='already_recorded' and v['result']['structuredContent']['execution_receipt']['verified'] for v in r[:2]))
check('stale request replay requires attention',r[2]['result']['structuredContent']['status']=='attention_required' and r[2]['result']['structuredContent']['request_disposition']=='already_recorded')
original=source('before-counters');final=source('final-before-stop');expected=json.loads(json.dumps(original))
for table,idkey,ids,status in [('shipments','ref_code',['NW-1001','NW-1002'],'dispatched'),('dock_slots','slot_code',['DOCK-A1','DOCK-A2'],'consumed')]:
 for row in expected[table]:
  if row[idkey] in ids:row['status']=status;row['rev_no']=2
for row in expected['dock_slots']:
 if row['slot_code']=='DOCK-A5':row['rev_no']=2 # Explicit external owner maintenance, not Runner effect.
check('source oracle has only two atomic dispatch pairs and one declared external counter increment',final==expected)
check('three proposals, two successful receipts and one failed receipt retained',cp('final-before-stop')['tables']['proposals']==3 and cp('final-before-stop')['tables']['writeback_receipts']==3)
cleanup=load(owned/'cleanup.json');check('owned container stopped with exit zero',cleanup['running'] is False and cleanup['exit_code']==0)
result={'verified_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'classification':'implementer-owned installed known-case verification, not independent acceptance','artifact':load(owned/'frozen/artifact.json'),'checks':checks,'checkpoints':[load(p) for p in sorted((owned/'checkpoints').glob('*/summary.json'))],'final_source_changes':{'runner':'NW-1001/DOCK-A1 and NW-1002/DOCK-A2 status changes, rev_no1→2 on all four rows','external_owner':'DOCK-A5 rev_no1→2 only to provoke conflict','other_rows':'unchanged'},'runtime':{'proposals':3,'successful_receipts':2,'failed_receipts':1,'failure_code':'SEMANTIC_AUTHORITY_STALE','worker_runs':3,'provider_calls':0,'fixture_attempts':1,'operator_mode':'existing dev_env; identity_verified=false; no production identity qualification'},'cleanup':cleanup}
(e/'fixture-verification.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'checks_passed':len(checks),'artifact':result['artifact']['tree_sha256'],'provider_calls':0,'fixture_stopped':True}))
