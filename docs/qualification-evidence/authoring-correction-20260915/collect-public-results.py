"""Read exact final snapshots and provider records; never infer completion from exit zero."""
from pathlib import Path
import json,hashlib,datetime
E=Path(__file__).resolve().parent;plan=json.loads((E/'assignment-plan.json').read_text());O=Path(plan['owned_root'])
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
results=[]
for run,selected in plan['case_sources'].items():
 R=O/'runs'/run;baseline=Path(selected['checkpoint_root'])/'project'
 def state(P):
  resume=json.loads((P/'.synapsor/boundary-authoring/resume.json').read_text())
  source=json.loads((P/'.synapsor/boundary-authoring/policy-sources'/(resume['policy_source_session']+'.json')).read_text())
  return resume,source
 _,before=state(baseline)
 rows=[]
 for label in ['business-reviewed','rechecked']:
  checkpoint=R/'checkpoints'/label;resume,source=state(checkpoint/'project')
  oracle=json.loads((E/(run+'-'+label+'-oracle.json')).read_text());readiness=json.loads((E/(run+'-'+label+'-readiness.json')).read_text());difference=json.loads((E/(run+'-'+label+'-project-difference.json')).read_text());snapshot=json.loads((checkpoint/'result.json').read_text())
  newepisodes=[x for x in source.get('coverage_episodes',[]) if x['id'] not in {e['id'] for e in before.get('coverage_episodes',[])}]
  assert readiness['readiness']['ready'] and all(x['assigned'] for x in readiness['ownership'])
  assert difference['active_authority_and_business_configuration_files_unchanged'] and not difference['original_conversation_entries_missing']
  assert snapshot['source_matches_selected_independent_oracle'] and sum(snapshot['source_counts'].values())==104
  changes=[dict(store=l['path'],**t) for l in oracle['ledgers'] for t in l['tables'] if not t['unchanged']]
  rows.append({'label':label,'business_ready':True,'source_digest':oracle['source']['digest'],'coverage_draft_digest':oracle['coverage_draft_digest'],'client_duties':readiness['ownership'],'new_episodes':newepisodes,'application_assignments':oracle['application_assignments'],'ledger_table_changes':changes,'review_bookkeeping_files':[c['path'] for c in difference['changes']],'pending':oracle['pending'],'source_rows':104,'checkpoint':str(checkpoint),'project_manifest_sha256':sha(checkpoint/'project-manifest.json'),'remaining_readiness_items':readiness['readiness'].get('items',[])})
 events=[json.loads(s) for s in (R/'meter/events.jsonl').read_text().splitlines()] if (R/'meter/events.jsonl').exists() else []
 inv=[json.loads(s) for s in (R/'public-invocations.jsonl').read_text().splitlines()]
 captures=[]
 for f in sorted((R/'meter').glob('input-[0-9]*.json')):
  q=json.loads(f.read_text())['request'];out=f.with_name(f.name.replace('input-','output-').replace('.json','.txt'));response=None
  for line in out.read_text().splitlines():
   if line.startswith('data: {'):
    v=json.loads(line[6:])
    if v.get('type')=='response.completed':response=v['response']
  carriers=q.get('input',q.get('messages',[]));feedback=[s for c in carriers if isinstance(c.get('content'),str) for s in c['content'].splitlines() if s.startswith('Correct this structural coverage problem: ')]
  captures.append({'input':str(f),'input_sha256':sha(f),'output':str(out),'output_sha256':sha(out),'model':q['model'],'reasoning':q.get('reasoning'),'store':q.get('store'),'usage':response.get('usage') if response else None,'structural_correction':bool(feedback),'feedback':[json.loads(s.split(': ',1)[1]) for s in feedback]})
 results.append({'run':run,'snapshots':rows,'actual_authoring_calls':sum(e['type']=='transport_attempt' and e.get('pathname')!='/v1/models' for e in events),'structural_correction_requests':sum(c['structural_correction'] for c in captures),'captures':captures,'preflight_exits':[i['code'] for i in inv if i['event']=='preflight'],'cli_exits':[i['code'] for i in inv if i['event']=='exit'],'public_invocations':str(R/'public-invocations.jsonl'),'terminal_logs':[str(p) for p in sorted((R/'logs').glob('*terminal*'))]})
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'artifact_tree':plan['artifact_tree'],'results':results,'actual_final_calls':sum(r['actual_authoring_calls'] for r in results),'final_ceiling':25,'reserved_restart_calls':6,'development_calls':1,'actual_cost_usd':None,'cost_note':'No billed monetary amount in captured provider response; token usage retained. No monetary total invented.','independent_grok_B':'PENDING EXTERNAL REVIEW','original_stage_b':'ATTEMPTED NOT PASSED'}
(E/'PRIMARY-RESULTS.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'calls':result['actual_final_calls'],'runs':[{'run':r['run'],'calls':r['actual_authoring_calls'],'corrections':r['structural_correction_requests'],'ready':[s['business_ready'] for s in r['snapshots']]} for r in results]}))
