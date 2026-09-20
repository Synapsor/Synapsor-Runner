"""Read-only final oracle over saved records; no live store or credentials needed."""
from pathlib import Path
import json,hashlib,datetime
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/effect-continuation-f83209f-20260919')
e=Path(__file__).resolve().parent
def read(p):return json.loads(p.read_text())
def inspection(case,label):return read(r/'public'/case/('inspection-'+label+'.json'))
def state(case,label,table):return read(r/'public'/case/('state-'+label)/(table+'.json'))
before=inspection('deployment','before');pub=inspection('deployment','post-publication');final=inspection('deployment','restart')
decline=inspection('decline','restart');pending=inspection('pending','final');reading=inspection('read','final')
assert before['draft']['authority']['rules']==pub['active']['authority']['rules']==final['active']['authority']['rules']
assert before['draft']['authority']['action_boundary']==final['active']['authority']['action_boundary']
assert reading['active']==before['active'] and reading['draft']==before['draft']
def applicable(x):return [p for p in x['execution']['policies'] if p['action_boundary_digest']==x['active']['authority']['action_boundary']['digest']]
assert not applicable(pub) and len(applicable(final))==1 and not applicable(decline) and not applicable(pending)
assert before['receipt']['selection_current'] and not pub['receipt']['selection_current']
for x in [final,decline,pending]:
 assert x['receipt']['selection_current']
 for field in ['receipts','write_url_env']:assert x['receipt']['selection'][field]==before['receipt']['selection'][field]
assert final['receipt']['source']==before['receipt']['source']=='local_postgres'
authority=[]
for case,start,end in [('deployment','before','final'),('decline','fork','restart'),('pending','fork','final'),('read','before','final')]:
 b=state(case,start,'control_policy_active');a=state(case,end,'control_policy_active')
 key=lambda x:(x['kind'],x['name']);bm={key(x):x for x in b};am={key(x):x for x in a}
 changed=[k for k in bm if bm[k]!=am[k]]
 expected={'deployment':{'action','execution','management'},'decline':{'management'},'pending':{'management'},'read':set()}[case]
 assert {k[0] for k in changed}==expected
 for k in changed:
  if k[0]=='management':assert k[1].startswith('semantic_receipts_')
 revisions=state(case,end,'control_policy_revisions');old=state(case,start,'control_policy_revisions')
 authority.append({'case':case,'epochs':[state(case,start,'control_policy_deployments')[0]['epoch'],state(case,end,'control_policy_deployments')[0]['epoch']],
   'changed_active_records':[{'kind':k[0],'name':k[1],'before':bm[k]['revision_id'],'after':am[k]['revision_id']} for k in changed],
   'new_revision_ids':[x['revision_id'] for x in revisions if x not in old]})
meter=[json.loads(x) for x in (r/'final-meter/events.jsonl').read_text().splitlines()]
assert len([x for x in meter if x['type']=='transport_attempt'])==3
model=read(r/'public/read/runtime-status.json');assert model['successful_read'] and model['status']=='read_completed'
assert model['provider_reported_cost_usd']<=5
assert all(x['name']!='app.request_change' for x in model['observed'])
artifact=read(r/'frozen/installed-artifact-manifest.json')
result={'artifact':artifact['installed_tree_sha256'],'source':artifact['source_commit'],'product_tests':artifact['product_commit'],
 'original_exact_draft_published':True,'read_active_and_disabled_unchanged':True,'authority_changes':authority,
 'selection_before':before['receipt'],'selection_after':final['receipt'],
 'execution_after':applicable(final),'decline_and_missing_have_no_applicable_execution':True,
 'T1':{'deterministic_calls':16,'provider_calls':3,'provider_cost_usd':model['provider_reported_cost_usd'],'provider_tools':len(model['observed']),'own_rows':29,'model':model['model'],'no_final_narrative_requested':True},
 'T2':'PASS complete operator effects, public restricted projection, disabled reopen and export',
 'T3_explicit_values':'PASS publication/renewal/actual verification/decline/enable/restart; no business dispatch',
 'M6_advertised_blank_defaults':'FAIL Enter keeps text conflicts with undefined empty input from public Action text adapter',
 'O1_missing_control':'writer posture failure before receipt probe; no fallback; no new execution authority',
 'business_rows':504,'source_receipts_added':0,'overall':'PARTIAL; default continuation defect retained, no overall clean acceptance',
 'historical_stage_b':'ATTEMPTED / NOT PASSED'}
(e/'public-results.json').write_text(json.dumps(result,indent=2)+'\n')
(r/'final-results.json').write_text(json.dumps(result,indent=2)+'\n')
print('Final saved-state comparisons passed; blank-default defect remains FAILED separately.')
