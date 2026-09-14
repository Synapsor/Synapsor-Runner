from pathlib import Path
import json,hashlib,datetime
E=Path(__file__).resolve().parent;plan=json.loads((E/'assignment-plan.json').read_text());R=Path(plan['owned_root'])/'runs/recovery-tournament-assisted'
assert not (Path(plan['owned_root'])/'one-public-run.lock').exists()
base=json.loads((R/'deterministic/review-baseline-state.json').read_text());source=next(s for s in base['sources']['snapshots'] if s['version']==base['sources']['active'])
calls=[]
for p in sorted((R/'meter').glob('input-*.json')):
 request=json.loads(p.read_text())['request'];n=p.stem.split('-')[1];out=R/f'meter/output-{n}.txt';tools=[]
 if out.exists():
  for line in out.read_text().splitlines():
   if not line.startswith('data:'):continue
   try:event=json.loads(line[5:])
   except json.JSONDecodeError:continue
   if event.get('type')=='response.output_item.done' and event.get('item',{}).get('type')=='function_call':tools.append({'name':event['item']['name'],'arguments':json.loads(event['item']['arguments'])})
 draft=None
 for m in request.get('input',[]):
  content=m.get('content','')
  if isinstance(content,str) and 'Current draft (JSON pointer root): ' in content:draft=json.JSONDecoder().raw_decode(content.split('Current draft (JSON pointer root): ',1)[1])[0]
 calls.append({'index':int(n),'request':request,'tools':tools,'draft':draft,'response_capture_present':out.exists()})
files=sorted((R/'meter').glob('*'))+sorted((R/'logs').glob('public-*.tty'))+[R/'public-invocations.jsonl']
state=json.loads((R/'run-state.json').read_text());events=[json.loads(x) for x in (R/'meter/events.jsonl').read_text().splitlines()]
trace={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'artifact_tree':state['artifact_tree'],'classification':'Unmodified actual installed public requests and responses; no replacement payloads','raw_files':[{'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in files if p.is_file()], 'source':source,'operator_messages':base['sources']['operator_messages'],'calls':calls,'actual_transport_attempts':sum(x['type']=='transport_attempt' for x in events),'failed_transports':sum(x['type']=='transport_error' for x in events)}
with (E/'installed-public-trace.json').open('x') as f:f.write(json.dumps(trace,indent=2)+'\n')
print(json.dumps({'calls':len(calls),'actual_transports':trace['actual_transport_attempts'],'captured_tools':[t['name'] for c in calls for t in c['tools']]}))
