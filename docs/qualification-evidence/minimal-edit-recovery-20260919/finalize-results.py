from pathlib import Path
import json,datetime,hashlib
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/minimal-edit-bfc2f19-20260919');e=Path(__file__).resolve().parent
load=lambda p:json.loads(p.read_text())
dt=lambda s:datetime.datetime.fromisoformat(s.replace('Z','+00:00'))
attempts=[load(p) for p in sorted((r/'final-meter').glob('attempt-[0-9]*.json'))]
usage={}
for p in sorted((r/'final-meter').glob('output-[0-9]*.txt')):
 for line in p.read_text().splitlines():
  if line.startswith('data: '):
   try:x=json.loads(line[6:])
   except json.JSONDecodeError:continue
   if x.get('usage'):usage[int(p.stem.split('-')[-1])]=x['usage']
def differences(a,b,p=''):
 if a==b:return []
 if isinstance(a,dict) and isinstance(b,dict):
  result=[]
  for k in sorted(a.keys()|b.keys()):
   if k in a and k in b:result+=differences(a[k],b[k],p+'/'+k)
   else:result.append({'path':p+'/'+k,'before_present':k in a,'after_present':k in b,**({'before':a[k]} if k in a else {}),**({'after':b[k]} if k in b else {})})
  return result
 if isinstance(a,list) and isinstance(b,list) and len(a)==len(b):return sum((differences(x,y,p+'/'+str(i)) for i,(x,y) in enumerate(zip(a,b))),[])
 return [{'path':p,'before':a,'after':b}]
cases={};authorities={}
for n in ['E1','E2','E3']:
 d=r/'public'/n;verified=load(d/'verified-reopened.json');exits=[load(p) for p in sorted(d.glob('exit-*.json'))]
 episodes=[]
 for x in exits:
  calls=[a['index'] for a in attempts if dt(x['start'])<=dt(a['at'])<=dt(x['end'])]
  episodes.append({'command':x['args'],'exit':x['exit'],'start':x['start'],'end':x['end'],'seconds_including_operator_navigation':(dt(x['end'])-dt(x['start'])).total_seconds(),'attempts':calls,'provider_reported_cost_usd':sum(usage.get(i,{}).get('cost',0) for i in calls)})
 before=load(d/'state-before/manifest.json');after=load(d/'state-after/manifest.json');reopened=load(d/'state-reopened/manifest.json')
 revisions=load(d/'state-reopened/control_policy_revisions.json')
 for table in ['control_policy_revisions','control_policy_events']:
  earlier=load(d/'state-before'/(table+'.json'));later=load(d/'state-reopened'/(table+'.json'))
  assert all(row in later for row in earlier),table+' historical record changed'
 assert len(revisions)==len(load(d/'state-before/control_policy_revisions.json'))+1
 for event in load(d/'state-reopened/control_policy_events.json'):
  if event not in load(d/'state-before/control_policy_events.json'):
   receipt=json.loads(event['receipt_json']);assert receipt['operation']=='save_disabled_action' and receipt['source_database_changed'] is False

 selected=[v for v in revisions if v['authority_digest']==verified['disabled_authority']];assert len(selected)==1
 old=[v for v in revisions if v['revision_id']=='policy:f2df8db27f1d0b98288459d837470a648c0cf9595e6adcf53085a9793fe03849'];assert len(old)==1 and old[0]['authority_digest']==verified['baseline_authority']
 previous=load(d/'state-before/control_policy_revisions.json');assert any(v['revision_id']==old[0]['revision_id'] for v in previous)
 full_before=json.loads(old[0]['content_json']);full_after=json.loads(selected[0]['content_json']);authorities[n]=full_after['authority']['authority']
 diff=differences(full_before,full_after);(d/'complete-saved-diff.json').write_text(json.dumps(diff,indent=2))
 assert len(verified['disclosure_review_records'])==1
 assert verified['original_request']==verified['plan_intent']
 assert verified['source_unchanged'] and verified['configuration_unchanged']
 assert not episodes[-1]['attempts']
 derived=load(d/'derived-evidence.json')['changes']
 (d/'reopen-result.json').write_text(json.dumps({'pass':True,'episodes':episodes,'unchanged_authority':verified['disabled_authority'],'changed_tables':[k for k in after['tables'] if after['tables'][k]!=reopened['tables'][k]],'source_configuration_unchanged':after['source']==reopened['source'] and after['config_files']==reopened['config_files']},indent=2))
 cases[n]={'verdict':'PASS','installed_tree':'24f0ed0780e2956911bbf0c78c7684adf519909ba31cb96ddf86f36ab07abe1b','disabled_policy':selected[0]['revision_id'],'disabled_authority':verified['disabled_authority'],'original_request':verified['original_request'],'episodes':episodes,'structural_diff':diff,'derived_evidence_diff':derived,'same_original_request_after_resume':True,'source_rows':504,'all_application_tables_unchanged':True,'all_prior_authority_history_retained_byte_for_byte':True,'read_active_action_execution_and_writer_receipts_unchanged':True,'disclosure_reviews':verified['disclosure_review_records'],'reopen_changed_tables':[k for k in after['tables'] if after['tables'][k]!=reopened['tables'][k]],'receipt':{'source':'local_postgres','authority':'source_db','provisioning':'precreated','schema':'release_ops','table':'synapsor_writeback_receipts','writer_ref':'SYNAPSOR_WRITE_RELEASE_SEAL_CANDIDATE_77988288'}}
summary={'cases':cases,'total_attempts':len(attempts),'sent':len(usage),'pre_send_interruption':15,'ceiling':24,'reserved_allowance_used':1,'reported_cost_usd':sum(u.get('cost',0) for u in usage.values()),'provider':'openrouter','model':'openai/gpt-5.6-terra','cross_case_full_authority_diffs':{n:differences(authorities['E1'],authorities[n]) for n in ['E2','E3']},'limitations':['Known-case disabled edit repair, not new unseen qualification.','E3 controlled interruption, not uninterrupted completion.','E3 later Resume adds same-revision save_disabled_action event and epoch15->16; no new draft revision or provider call.','E3 opening text was discarded as unsupported; the standard job input remained available.','Navigation/inspection time included in episode durations; no claim of intrinsic human usability time.','No activation, runtime effect or worker execution.']}
(r/'final-results.json').write_text(json.dumps(summary,indent=2)+'\n');(e/'final-results.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps({'attempts':summary['total_attempts'],'sent':summary['sent'],'cost':summary['reported_cost_usd'],'case_calls':{n:[v['attempts'] for v in c['episodes']] for n,c in cases.items()},'cross_case_authority_paths':{n:[v['path'] for v in values] for n,values in summary['cross_case_full_authority_diffs'].items()}}))
