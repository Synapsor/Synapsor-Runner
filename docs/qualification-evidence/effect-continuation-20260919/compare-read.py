"""Independent owner check of public outputs against preserved scoped source rows.
Writes only totals, classifications and hashes; concrete scope values stay private.
"""
from pathlib import Path
import json,hashlib
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/effect-continuation-f83209f-20260919');d=r/'public/read'
identity=json.loads((r/'runtime-private.json').read_text());source=json.loads((d/'state-before/source-build_candidates.json').read_text())
allowed={x['candidate_ref']:x for x in source if x['tenant_id']==identity['SYNAPSOR_TENANT_ID'] and x['principal_id']==identity['SYNAPSOR_PRINCIPAL']}
assert len(allowed)==29
pending={};verified=[];placeholders=[];refused=0
for line in (d/'protocol.jsonl').read_text().splitlines():
 e=json.loads(line)
 if e['type']=='send' and e['method']=='tools/call':pending[e['id']]=e['params']
 if e['type']!='receive':continue
 m=e['message'];q=pending.pop(m.get('id'),None)
 if not q:continue
 assert q['name']!='app.request_change'
 response=m.get('result',{});v=response.get('structuredContent')
 if v is None:
  try:v=json.loads('\n'.join(x['text'] for x in response.get('content',[]) if x.get('type')=='text'))
  except (ValueError,TypeError):v={}
 if response.get('isError') or v.get('ok') is False:refused+=1;continue
 plan=q.get('arguments',{}).get('plan',{})
 if q['name']!='app.explore_data' or plan.get('kind')!='rows':continue
 assert plan['resource']=='release_ops.build_candidates'
 rows=v.get('data');assert rows and all('candidate_ref' in x for x in rows)
 for row in rows:
  assert row['candidate_ref'] in allowed, 'Out-of-scope source row'
  original=allowed[row['candidate_ref']]
  assert set(row)<=set(plan['select']) and set(row)<= {'candidate_ref','application_name','candidate_state','security_hold'}
  for field,value in row.items():
   if field=='security_hold':
    assert value != original[field] and not isinstance(value,bool), 'Private value disclosed'
    placeholders.append(json.dumps(value,sort_keys=True))
   else:assert value==original[field], 'Returned value differs from source'
 assert v['source_database_changed'] is False
 verified.append({'returned_rows':len(rows),'columns':list(rows[0]),'all_rows_in_configured_context':True,'public_values_match_source':True})
assert verified and refused>0
# This unchanged legacy revision explicitly grants equality/filter/group analysis.
revisions=json.loads((d/'state-before/control_policy_revisions.json').read_text())
record=next(x for x in revisions if x['revision_id']=='policy:903206814a327ab774aaee2b3683dcc958f646a9a14c7deffba8fd84988d0d37')
boundary=json.loads(record['content_json'])['boundary']
resource=next(x for x in boundary['pack']['resources'] if x['id']=='release_ops.build_candidates')
assert 'security_hold' in resource['model_withheld_fields']
assert resource['filterable_fields']['security_hold'] and 'security_hold' in resource['groupable_fields']
result={'pass':True,'source_row_count':len(source),'own_context_rows':len(allowed),'verified_reads':verified,'refusals':refused,'private_placeholder_cells':len(placeholders),'distinct_private_placeholders':len(set(placeholders)),'equality_analysis_reviewed_in_unchanged_policy':True,'unlinkability_not_claimed':True,'business_tool_dispatches':0}
(d/'read-oracle.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
