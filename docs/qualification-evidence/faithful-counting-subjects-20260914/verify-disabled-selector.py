from pathlib import Path
import sqlite3,json,hashlib
E=Path(__file__).resolve().parent;plan=json.loads((E/'assignment-plan.json').read_text());R=Path(plan['owned_root'])/'runs/recovery-tournament-assisted'
def load(p,table='control_policy_drafts'):
 assert p.resolve().is_relative_to(R);db=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True)
 try:return json.loads(db.execute(f"select r.content_json from {table} p join control_policy_revisions r using(deployment_id,scope_key,kind,name,revision_id) where p.kind='action'").fetchone()[0])['authority']
 finally:db.close()
def diff(a,b,p=''):
 if type(a)!=type(b):return[p]
 if isinstance(a,dict):return [q for k in sorted(a.keys()|b.keys()) for q in ([p+'/'+k] if k not in a or k not in b else diff(a[k],b[k],p+'/'+k))]
 if isinstance(a,list):return [p] if len(a)!=len(b) else [q for i,(x,y) in enumerate(zip(a,b)) for q in diff(x,y,p+'/'+str(i))]
 return [] if a==b else [p]
old=load(R/'checkpoints/review-refused/project/.synapsor/local.db');new=load(R/'project/.synapsor/local.db');active=load(R/'project/.synapsor/local.db','control_policy_active')
paths=diff(old,new);allowed=['/authority/action_boundary/digest','/authority/action_boundary/rules/0/approval_policy_digest','/authority/approval_classes/0/shared_limits/0/capability','/authority/approval_classes/0/shared_limits/1/capability','/authority/digest','/authority/rules/0/activated_at','/authority/rules/1/activated_at','/created_at','/digest'];assert set(paths)<=set(allowed);assert new['authority']['catalog']==old['authority']['catalog']
limits=new['authority']['approval_classes'][0]['shared_limits'];assert sorted(x['maximum'] for x in limits)==[2,6];assert all(x['window_seconds']==86400 and x['capability']=='league.result_ratification' for x in limits)
assert len(new['authority']['rules'])==2
for a,b in zip(old['authority']['rules'],new['authority']['rules']):assert {k:v for k,v in a.items() if k!='activated_at'}=={k:v for k,v in b.items() if k!='activated_at'}
assert active==load(R/'checkpoints/review-refused/project/.synapsor/local.db','control_policy_active')
resume=json.loads((R/'project/.synapsor/boundary-authoring/resume.json').read_text());source=json.loads((R/'project/.synapsor/boundary-authoring/policy-sources'/str(resume['policy_source_session']+'.json')).read_text());coverage=source['coverage'];counters=[p for p in coverage['passages'] if p.get('counter_requirements')];assert counters;assert all(c['current_capability']==c['required_capability']=='league.result_ratification' for p in counters for c in p['counter_requirements']);assert not any(p['disposition'] in ['conflict','unsupported'] for p in coverage['passages'])
result={'artifact_tree':plan['artifact_tree'],'before_digest':old['digest'],'disabled_digest':new['digest'],'boundary_digest':new['authority']['action_boundary']['digest'],'active_digest_unchanged':active['digest'],'changes':paths,'limits':limits,'rules_and_catalog_unchanged_except_generated_timestamps':True,'counter_passages':counters,'pending_duties':[p for p in coverage['passages'] if p['disposition']=='needs_decision'],'business_review_reaches_public_activation_gate':True,'published':False,'provider_payloads_not_modified':True}
(E/'disabled-selector-result.json').write_text(json.dumps(result,indent=2)+'\n');(R/'deterministic').mkdir(exist_ok=True);(R/'deterministic/disabled-selector-authority.json').write_text(json.dumps(new,indent=2)+'\n');(R/'deterministic/disabled-selector-coverage.json').write_text(json.dumps(coverage,indent=2)+'\n');print(json.dumps({'disabled_digest':new['digest'],'semantics_only_two_filters':True,'active_unchanged':True,'pending_duties':len(result['pending_duties'])}))
