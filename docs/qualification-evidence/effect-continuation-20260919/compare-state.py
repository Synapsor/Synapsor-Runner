"""Independent row oracle over previously saved owner snapshots; does not open stores."""
import json,pathlib,sys,hashlib
R=pathlib.Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/effect-continuation-f83209f-20260919')
name,before,after=sys.argv[1:];d=R/'public'/name
B=d/('state-'+before);A=d/('state-'+after)
b=json.loads((B/'manifest.json').read_text());a=json.loads((A/'manifest.json').read_text())
assert a['source']==b['source'],'Business rows changed'
changed=[k for k in b['tables'] if a['tables'][k]!=b['tables'][k]]
application=['approvals','proposals','proposal_events','worker_queue','writeback_jobs','writeback_receipts','idempotency_receipts','writeback_intents','control_policy_budget_accounts','control_policy_budget_entries','control_policy_budget_receipts','control_policy_budget_requests','control_policy_effect_admissions','control_policy_effect_receipts']
for k in application:assert k not in changed,k+' changed without authorization'
for k in ['control_policy_revisions','control_policy_events']:
 old=json.loads((B/(k+'.json')).read_text());new=json.loads((A/(k+'.json')).read_text());assert all(x in new for x in old),'Original '+k+' lost or modified'
# Other changed tables/configuration remain explicitly listed, not silently waived.
config_changes=[k for k in sorted(set(b['config_files'])|set(a['config_files'])) if a['config_files'].get(k)!=b['config_files'].get(k)]
result={'pass_preservation':True,'case':name,'before':before,'after':after,'source_rows':sum(x['rows'] for x in a['source'].values()),'source_unchanged':True,'application_tables_unchanged':application,'all_tables_compared':len(b['tables']),'changed_tables':changed,'changed_configs':config_changes,'original_revision_and_event_rows_retained':True,'changes_require_separate_authority_assessment':True}
(d/('comparison-'+before+'-'+after+'.json')).write_text(json.dumps(result,indent=2));print(json.dumps(result))
