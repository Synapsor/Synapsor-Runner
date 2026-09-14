from pathlib import Path
import json,hashlib
E=Path(__file__).resolve().parent;plan=json.loads((E/'assignment-plan.json').read_text());R=Path(plan['previous_root'])/'runs/recovery-tournament-assisted';P=R/'checkpoints/stopped-review-conflict/project'
resume=json.loads((P/'.synapsor/boundary-authoring/resume.json').read_text());sources=json.loads((P/'.synapsor/boundary-authoring/policy-sources'/f"{resume['policy_source_session']}.json").read_text());source=next(s for s in sources['snapshots'] if s['version']==sources['active'])
requests=[];replies=[]
for n in [1,2]:
 request=json.loads((R/f'meter/input-{n:04}.json').read_text())['request'];requests.append(request)
 done=[]
 for line in (R/f'meter/output-{n:04}.txt').read_text().splitlines():
  if not line.startswith('data:'):continue
  try:j=json.loads(line[5:])
  except:continue
  if j.get('type')=='response.output_item.done' and j.get('item',{}).get('name')=='runner__review_policy_coverage':done.append(json.loads(j['item']['arguments']))
 assert len(done)==1;replies.append(done[0])
text=next(m['content'] for m in requests[1]['input'] if 'Current draft (JSON pointer root): ' in m.get('content',''));draft=json.JSONDecoder().raw_decode(text.split('Current draft (JSON pointer root): ',1)[1])[0]
files=[R/f'meter/{f}' for f in ['input-0001.json','output-0001.txt','input-0002.json','output-0002.txt','events.jsonl']]
trace={'raw_files':[{'path':str(f),'sha256':hashlib.sha256(f.read_bytes()).hexdigest()} for f in files],'source':source,'policy_sources':sources,'operator_messages':sources['operator_messages'],'clarifications':[{'turn':i,**t} for i,t in enumerate(resume['conversation']) if t.get('kind')=='clarification'],'requests':requests,'replies':replies,'draft':draft,'pending':resume['pending_action_revision']}
(E/'saved-call-trace.json').write_text(json.dumps(trace,indent=2)+'\n')
fixture={k:trace[k] for k in ['source','policy_sources','operator_messages','clarifications','replies','draft','pending']};fixture['raw_files']=trace['raw_files']
(E.parents[2]/'apps/runner/src/fixtures/counting-review-conflict.json').write_text(json.dumps(fixture,indent=2)+'\n')
print(json.dumps({'source_digest':source['digest'],'source_line_7':source['text'].splitlines()[6],'clarification_turns':[x['turn'] for x in trace['clarifications']],'actions':[a['outcome'] for a in draft['actions']]},indent=2))
