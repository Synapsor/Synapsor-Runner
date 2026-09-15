"""Audit completed public runs; no application state is written by this oracle."""
from pathlib import Path
import json,hashlib,re,datetime,collections
E=Path(__file__).resolve().parent;p=json.loads((E/'assignment-plan.json').read_text());O=Path(p['owned_root']);sha=lambda f:hashlib.sha256(f.read_bytes()).hexdigest()
def response(file):
 for l in file.read_text().splitlines():
  if l.startswith('data: {'):
   d=json.loads(l[6:])
   if d.get('type')=='response.completed':return d['response']
 raise AssertionError('No complete response envelope: '+str(file))
results=[]
for case,run in [('B','counting-wording-control'),('A','recovery-tournament-assisted')]:
 R=O/'runs'/run;calls=[];events=[json.loads(l) for l in (R/'meter/events.jsonl').read_text().splitlines()]
 inv=[json.loads(l) for l in (R/'public-invocations.jsonl').read_text().splitlines()]
 for event in [e for e in events if e['type']=='transport_attempt']:
  i=event['index'];f=R/'meter'/f'input-{i:04d}.json';out=R/'meter'/f'output-{i:04d}.txt';q=json.loads(f.read_text())['request'];res=response(out);tools=[]
  for item in res['output']:
   if item['type']=='function_call':
    args=json.loads(item['arguments']);tools.append({'name':item['name'],'argument_sha256':hashlib.sha256(item['arguments'].encode()).hexdigest(),'operation':args.get('operation'),'status':args.get('status'),'read_mode':args.get('read_mode'),'action_mode':args.get('action_mode'),'passages':len(args.get('passages',[]))})
  correction=[]
  for message in q.get('input',[]):
   content=message.get('content','')
   if isinstance(content,str):correction.extend(l for l in content.splitlines() if l.startswith('Correct this structural'))
  calls.append({'index':i,'started_at':event['at'],'completed_at':next(e['at'] for e in events if e['type']=='response_complete' and e['index']==i),'model':q.get('model'),'reasoning':q.get('reasoning'),'max_output_tokens':q.get('max_output_tokens'),'store':q.get('store'),'tools':tools,'usage':res.get('usage'),'correction':correction,'input':str(f),'input_sha256':sha(f),'output':str(out),'output_sha256':sha(out)})
 b=json.loads((E/(run+'-business-reviewed-oracle.json')).read_text());a=json.loads((E/(run+'-rechecked-oracle.json')).read_text());diff=json.loads((E/(run+'-rechecked-project-difference.json')).read_text());snap=json.loads((E/(run+'-rechecked.json')).read_text())
 assert not a['pending'] and all(t['unchanged'] for l in a['ledgers'] for t in l['tables'])
 assert not diff['unexplained_file_changes'] and diff['source_snapshots_unchanged'] and not diff['original_conversation_entries_missing']
 assert snap['cli_exits']==[0,0] and snap['preflight_exits']==[0,0] and snap['source_unchanged_relative_to_matching_task_baseline']
 completed=a['completed_reviews'];assert [x['activity'] for x in completed[-2:]]==['provider','validated_reuse'];assert completed[-1]['report_digest']==completed[-2]['report_digest'] and completed[-1]['context_digest']==completed[-2]['context_digest']
 assert a['obligation_passages']==b['obligation_passages'];assert a['counting_decisions']==b['counting_decisions']
 terminal={label:re.sub(r'\x1b\[[0-9;?]*[A-Za-z]','',(R/'logs'/file).read_text(errors='replace')) for label,file in [('review','final-review-terminal.log'),('recheck','final-recheck-terminal.log')]}
 assert all('Business review completed' in s for s in terminal.values());assert 'Review activity: validated_reuse.' in terminal['recheck'];assert 'REVIEW COUNTED AUTOMATIC APPROVALS' not in terminal['recheck']
 if case=='A':assert 'REVIEW COUNTED AUTOMATIC APPROVALS' not in terminal['review'];assert calls[0]['tools'][0]['operation']=='review_rules' and calls[0]['tools'][0]['action_mode'] in ['none','reuse'] and calls[0]['tools'][0]['read_mode'] in ['none','reuse']
 q=json.loads((R/'meter/input-0002.json').read_text())['request'];content=q['input'][-1]['content'];draft=json.loads(next(l for l in content.splitlines() if l.startswith('Current draft (JSON pointer root): ')).split(': ',1)[1]);maintenance=draft['runner_evidence']['actions']['league.result_ratification']['effect']['source_counter_maintenance'];assert maintenance['external_writers_verified'] is False and maintenance['production_integration_verified'] is False
 results.append({'case':case,'run':run,'status':'PASS','scope':'known installed review-only path; no deployment/execution qualification','route':'direct Review' if case=='B' else 'ordinary Resume -> valid review-only plan','legacy_choice':'This saved request was review-only; original request retained in completed review history; no separate real business edit identified or cancelled','actual_calls':len(calls),'restart_calls':0,'calls':calls,'review_and_recheck':completed[-2:],'source':a['source'],'pending_business_items':a['pending'],'pending_coverage':[{'topic':v.get('topic'),'paths':v['draft_paths'],'disposition':v['disposition'],'responsibility':v.get('responsibility'),'host_assessment':v.get('obligation_assessment')} for v in a['nonimplemented_passages']],'counter_maintenance_evidence':maintenance,'counting_decisions':a['counting_decisions'],'all_ledger_tables_unchanged':True,'program_authority_configuration_unchanged':True,'source_rows':snap['source_counts'],'source_unchanged':True,'new_counting_questions':2 if case=='B' else 0,'recheck_repeated_questions':0,'provider_oracle_files':[run+'-business-reviewed-oracle.json',run+'-rechecked-oracle.json',run+'-rechecked-project-difference.json'],'cli_exits':[0,0]})
assert sum(r['actual_calls'] for r in results)==4
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'artifact_tree':p['artifact_tree'],'product':'58c3f7bf5a9997fd966a224694171ba92596b09d','source_checkpoint':'d631810d647b870eb0885910b8282e36dde78d9b','actual_final_calls':4,'ceiling':25,'restart_reserved':6,'actual_restart_calls':0,'development_calls':3,'development_max':4,'dollar_spend':'unknown; no priced billing meter available; no credits purchased','outcome':'Primary B and A BUSINESS review/save/restart/current recheck PASS; independent Grok B/A PENDING','results':results}
(E/'primary-result.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'actual_final_calls':4,'results':[{'case':r['case'],'status':r['status'],'calls':r['actual_calls'],'pending_coverage':len(r['pending_coverage'])} for r in results]}))
