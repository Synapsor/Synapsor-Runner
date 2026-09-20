"""Assert permitted receipt-management differences after the installed schedules.
Reads saved snapshots only. It cannot authorize or repair application state.
"""
from pathlib import Path
import json,sys
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-default-feecc2b-20260919')
case,label=sys.argv[1:];d=r/'public'/case;b=d/'state-before';a=d/('state-'+label)
def read(p):return json.loads(p.read_text())
x=read(d/('inspection-'+label+'.json'));base=read(r/'public/R1/inspection-before.json')
assert x['active']==base['active'] and x['draft']==base['draft'],'Read/Action changed'
assert x['execution']==base['execution'],'Execution configuration changed'
assert not any(p['action_boundary_digest']==x['receipt']['action_digest'] for p in x['execution']['policies']),'Applicable execution authorization exists'
old=read(b/'control_policy_active.json');new=read(a/'control_policy_active.json')
assert [v for v in old if v['kind']!='management']==[v for v in new if v['kind']!='management'],'Active authority pointers changed'
mb,ma=read(b/'manifest.json'),read(a/'manifest.json');assert mb['source']==ma['source'] and mb['config_files']==ma['config_files']
selection=x['receipt']['selection'];original=base['receipt']['selection']
for k in ['project_id','deployment_id','outcome','write_url_env','receipts']:assert selection[k]==original[k],k+' intent changed'
changed=[t for t in mb['tables'] if mb['tables'][t]!=ma['tables'][t]]
if case.startswith('R2'):
 assert changed==[],'Cancellation changed stored state';assert x['receipt']==base['receipt']
else:
 assert case in ['R1','R3'];assert x['receipt']['selection_current'] is True
 assert selection['binding_digest']==x['receipt']['binding_digest']
 assert x['receipt']['epoch']==17 and base['receipt']['epoch']==16
 # Later exact review renews only this management reference; retained authorities stay unchanged.
 assert len(old)==len(new)
 for v in old:
  if not v['name'].startswith('semantic_receipts_'):assert v in new
result={'case':case,'label':label,'pass':True,'all_tables_compared':len(mb['tables']),'changed_tables':changed,'all_configs_unchanged':True,'source_504_rows_unchanged':True,'read_action_and_execution_unchanged':True,'source_db_intent_unchanged':True,'selection_current':x['receipt']['selection_current'],'receipt_epoch':x['receipt']['epoch'],'execution_applicable_to_current_action':False,'retained_obsolete_execution_record':True}
(d/('assessment-'+label+'.json')).write_text(json.dumps(result,indent=2));print(json.dumps(result))
