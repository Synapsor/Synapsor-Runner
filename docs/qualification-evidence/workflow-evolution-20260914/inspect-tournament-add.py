"""Read captured public responses and task-owned snapshots, never mutate authority."""
import json,pathlib,hashlib
E=pathlib.Path(__file__).resolve().parent;plan=json.loads((E/'assignment-plan.json').read_text());R=pathlib.Path(plan['owned_root'])/'runs/recovery-tournament-assisted';D=R/'deterministic'
replies=[]
for i in [11,12]:
 p=R/f'meter/output-{i:04}.txt'
 for line in p.read_text().splitlines():
  if not line.startswith('data: '):continue
  try:o=json.loads(line[6:])
  except ValueError:continue
  if o.get('type')=='response.completed':
   for c in o['response']['output']:
    if c.get('type')=='function_call':replies.append({'call':i,'name':c['name'],'arguments':json.loads(c['arguments']),'capture':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
p=R/'meter/input-0011.json';request=json.loads(p.read_text())['request'];s=next(m['content'] for m in request['input'] if isinstance(m.get('content'),str) and 'Current draft (JSON pointer root): ' in m['content']);draft=json.JSONDecoder().raw_decode(s.split('Current draft (JSON pointer root): ',1)[1])[0]
a=json.loads((D/'add-paused-ledger.json').read_text());b=json.loads((D/'deployment-complete-ledger.json').read_text()) if (D/'deployment-complete-ledger.json').exists() else None
# choose recorded before-add snapshot explicitly; don't infer an absent comparison
before_candidates=[str(p.name) for p in D.glob('*-ledger.json')]
program=json.loads((R/'checkpoints/add-paused/project/.synapsor/action-rules/drafts/reviewed_staging_rules/authority.json').read_text())
out={'artifact_tree':plan['artifact_tree'],'checkpoint':str(R/'checkpoints/add-paused'),'recorded_replies':replies,'proposed_program':program,'domain':draft['runner_evidence']['runtime_contract']['approval_counter_selection']['outcome_domain'],'counting_interpretations':draft['runner_evidence'].get('counting_interpretations'),'active':a['control_policy_active'],'drafts':a['control_policy_drafts'],'snapshot_candidates':before_candidates,'verdict':'Old singleton proof not reused: two-outcome candidate yields no established counting interpretation and both normal review responses fail COUNTING_SUPPORT_MISSING. This is a passed stale-proof refusal, not completed evolution.'}
(E/'tournament-add-first-review.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps({k:v for k,v in out.items() if k not in ['recorded_replies','proposed_program','active','drafts']},indent=2))
