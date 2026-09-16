from pathlib import Path
import json,hashlib
E=Path(__file__).resolve().parent
O=Path(json.loads((E/'assignment-plan.json').read_text())['owned_root'])
R=O.parent/'client-duty-review-f60dfa1-20260915/runs/counting-wording-control'
records=[];args=[];responses=[];requests=[]
for i in [1,2]:
 inp=R/'meter'/f'input-{i:04d}.json';out=R/'meter'/f'output-{i:04d}.txt'
 q=json.loads(inp.read_text())['request'];requests.append(q)
 response=next(json.loads(l[6:])['response'] for l in out.read_text().splitlines() if l.startswith('data: {') and json.loads(l[6:]).get('type')=='response.completed')
 responses.append(response);args.append(json.loads(next(x['arguments'] for x in response['output'] if x['type']=='function_call')))
 records.extend({'path':str(f),'sha256':hashlib.sha256(f.read_bytes()).hexdigest()} for f in [inp,out])
lines='\n'.join(m.get('content','') for m in requests[0]['input'] if isinstance(m.get('content'),str)).splitlines()
draft=json.loads(next(l.split(': ',1)[1] for l in lines if l.startswith('Current draft (JSON pointer root): ')))
sources=json.loads(next((R/'checkpoints/business-review-stopped/project/.synapsor/boundary-authoring/policy-sources').glob('*.json')).read_text())
fixture={'classification':'Exact complete captured arguments and prepared context; controlled future corrected responses must be labeled derived','sources':sources,'draft':draft,'arguments':args}
f=E.parents[2]/'apps/runner/src/test-fixtures/coverage-correction-captures.json';f.write_text(json.dumps(fixture,indent=2)+'\n')
(O/'baseline').mkdir();(O/'baseline/requests.json').write_text(json.dumps(requests,indent=2)+'\n');(O/'baseline/responses.json').write_text(json.dumps(responses,indent=2)+'\n')
(E/'capture-index.json').write_text(json.dumps({'records':records,'fixture':str(f),'fixture_sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'previous_correction': [l for m in requests[1]['input'] if isinstance(m.get('content'),str) for l in m['content'].splitlines() if l.startswith('Correct this structural')]},indent=2)+'\n')
