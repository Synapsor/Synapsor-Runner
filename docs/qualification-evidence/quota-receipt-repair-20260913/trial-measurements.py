"""Summarize existing bounded observer records. No application or provider call."""
from pathlib import Path
import json,datetime
E=Path(__file__).resolve().parent
O=Path(json.loads((E/'assignment-plan.json').read_text())['owned_root'])
def time(value):return datetime.datetime.fromisoformat(value.replace('Z','+00:00'))
def union(intervals):
 merged=[]
 for start,end in sorted(intervals):
  if merged and start<=merged[-1][1]:merged[-1][1]=max(end,merged[-1][1])
  else:merged.append([start,end])
 return sum((end-start).total_seconds() for start,end in merged)
records=[]
for R in sorted((O/'runs').iterdir()):
 state=json.loads((R/'run-state.json').read_text())
 if not state['first_public_start']:continue
 inv=[json.loads(l) for l in (R/'public-invocations.jsonl').read_text().splitlines()]
 events=[json.loads(l) for l in (R/'meter/events.jsonl').read_text().splitlines()]
 attempts={e['index']:e for e in events if e['type']=='transport_attempt'}
 completions={e['index']:e for e in events if e['type']=='response_complete'}
 starts=[];intervals=[]
 for e in inv:
  if e['event']=='start':starts.append(time(e['at']))
  if e['event']=='exit':intervals.append((starts.pop(0),time(e['at'])))
 waits=[(time(attempts[i]['at']),time(e['at'])) for i,e in completions.items()]
 purposes=[]
 for p in sorted((R/'meter').glob('input-*.json')):
  request=json.loads(p.read_text())['request'];tools=request.get('tools',[])
  names=[t.get('name',t.get('function',{}).get('name')) for t in tools]
  choice=request.get('tool_choice');purposes.append({'capture':p.name,'model':request.get('model'),'tool_choice':choice,'available_tools':names})
 records.append({'run':R.name,'classification':state['classification'],'artifact_tree':state['artifact_tree'],
  'first_public_start':state['first_public_start'],'initial_deadline':state['initial_deadline'],
  'prior_authoring_calls':state['prior_authoring_calls'],'new_authoring_calls':len(attempts),
  'maximum_initial_calls':state['maximum_initial_calls'],'reserved_editing_calls':state['reserved_editing_calls'],
  'complete_response_captures':len(completions),'transport_errors':[e for e in events if e['type']=='transport_error'],
  'cli_exits':[e['code'] for e in inv if e['event']=='exit'],'cli_still_running':bool(starts),
  'completed_cli_process_wall_seconds':union(intervals),'first_start_to_last_exit_seconds':(intervals[-1][1]-time(state['first_public_start'])).total_seconds() if intervals else None,
  'provider_transport_wait_seconds':union(waits) if len(attempts)==len(completions) else None,
  'recorded_complete_provider_wait_seconds':union(waits),'provider_wait_definition':'transport attempt through complete response body; incomplete/error responses prevent a complete total',
  'hands_on_seconds':None,'first_reviewable_draft_seconds':None,'first_verified_receipt_seconds':None,
  'edit_to_review_seconds':None,'edit_to_changed_behavior_seconds':None,
  'measurement_limits':'Wall time includes coordinator evidence/review and pauses; not a human usability measure. Missing measurements are unknown, not zero. A zero CLI exit is not successful qualification.',
  'request_roles':purposes})
(E/'trial-measurements.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'runs':records},indent=2)+'\n')
print(json.dumps([{'run':r['run'],'calls':r['new_authoring_calls'],'prior':r['prior_authoring_calls'],'running':r['cli_still_running']} for r in records]))
