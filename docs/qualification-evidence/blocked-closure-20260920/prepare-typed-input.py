"""Prepare public disabled-draft input from the new export and the known rule.
No stored authority, binding, approval, receipt or history is copied/edited.
"""
from pathlib import Path
import json,hashlib,sys
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/blocked-closure-4b22b46-20260920')
case=sys.argv[1];assert case in ['r0','r1','t0','t1'];root=r/'operational'/case/'project'
export=root/'export.json';out=root/'reviewed-input.json';assert not out.exists()
d=json.loads(export.read_text())
p=Path('/home/sandesh-tiwari/Desktop/Synapsor Tutorials/software-model-free-20260915/artifacts/authored.json')
known=json.loads(p.read_text());assert len(known['actions'])==1
assert known['actions'][0]['outcome']=='release.seal_candidate'
d['actions']=known['actions']
# Explicit operator-prepared access choices, submitted to the documented typed
# validator and then separately reviewed in the public terminal.
d['read']['resources']=[
 {'resource_id':'release_ops.build_candidates','include':True,
  'withhold_from_model_fields':['candidate_id','security_hold','slot_id','version'],
  'private_model_fields':['candidate_id','security_hold','slot_id','version'],
  'keep_out_fields':['internal_finding','principal_id','tenant_id'],
  'filterable_fields':['application_name','candidate_ref','candidate_state'],
  'sortable_fields':['application_name','candidate_ref','candidate_state'],
  'groupable_fields':['application_name','candidate_state'], 'aggregate_measures':[], 'count_distinct_fields':[]},
 {'resource_id':'release_ops.release_slots','include':True,
  'withhold_from_model_fields':['slot_id','version'],'private_model_fields':['slot_id','version'],
  'keep_out_fields':['tenant_id','principal_id'],
  'filterable_fields':['slot_ref','slot_state'],'sortable_fields':['slot_ref','slot_state'],
  'groupable_fields':['slot_state'],'aggregate_measures':[],'count_distinct_fields':[]},
 {'resource_id':'release_ops.build_checks','include':True,
  'withhold_from_model_fields':['check_id','candidate_id','check_kind','check_state','elapsed_seconds','version'],
  'private_model_fields':['check_id','candidate_id','check_kind','check_state','elapsed_seconds','version'],
  'keep_out_fields':['tenant_id','principal_id','private_check_note'],
  'filterable_fields':[],'sortable_fields':[],'groupable_fields':[],'aggregate_measures':[],'count_distinct_fields':[]}
]
out.write_text(json.dumps(d,indent=2)+'\n')
(root.parent/'typed-input-provenance.json').write_text(json.dumps({'export_sha256':hashlib.sha256(export.read_bytes()).hexdigest(),'known_rule_file':str(p),'known_rule_file_sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'exact_action_unchanged':d['actions']==known['actions'],'new_export_bindings_unchanged':True,'input_sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'status':'prepared_not_submitted','authority':'none; separate public save/reviews still required'},indent=2))
print('Prepared current-export typed input; no save or activation performed.')
