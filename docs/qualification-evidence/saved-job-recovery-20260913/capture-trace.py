import json,pathlib,subprocess,hashlib
E=pathlib.Path(__file__).resolve().parent;P=json.loads((E/'assignment-plan.json').read_text());O=pathlib.Path(P['previous_root']);N=pathlib.Path(P['owned_root'])
def completed(f):
 out=[]
 for line in f.read_text().splitlines():
  if not line.startswith('data: '):continue
  try:d=json.loads(line[6:])
  except:continue
  if d.get('type')=='response.completed':out+=d['response'].get('output',[])
 return out
r=O/'runs/recovery-tournament-original';f=r/'meter/output-0002.txt'
answer='\n'.join(c['text'] for item in completed(f) if item.get('type')=='message' for c in item.get('content',[]) if c.get('type')=='output_text')
base=r/'checkpoints/stopped-review-prose/project/.synapsor/boundary-authoring/resume.json'
assert base.exists() and 'tenant: maximum' in answer
(N/'captured-resume-input.json').write_text(json.dumps({'checkpoint':json.loads(base.read_text()),'answer':answer},indent=2)+'\n')
oldrev=subprocess.check_output(['git','rev-parse','6671302^'],text=True).strip(); old=subprocess.check_output(['git','show',oldrev+':apps/runner/src/boundary-authoring-resume.ts'],text=True)
a=old.index('function assertNoPrivateRuntimeMaterial(');b=old.index('\nfunction boundaryAuthoringResumeInvalidReason',a);guard=old[a:b].replace('value: unknown','value').replace('): void',')').replace(']!',']').replace('.index!','.index').replace('function assertNoPrivateRuntimeMaterial','export function assertBoundaryAuthoringResumeMaterial')
(N/'original-literal-guard.mjs').write_text(guard)
trace={'original_checkpoint':str(base),'checkpoint_sha256':hashlib.sha256(base.read_bytes()).hexdigest(),'captured_response':str(f),'captured_response_sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'producer':'action-rule-model.ts rememberResponse -> rememberModelAuthoringTurn(session.conversation, operatorMessage, response) -> boundary-commands.ts persistAuthoringResume -> buildBoundaryAuthoringResumeState -> assertBoundaryAuthoringResumeMaterial','field':'conversation[7].answer (reconstructed appended turn; prior turns retained)','category':'model-generated explanation; not operator policy or host-rendered quota','answer':answer,'historical_guard_revision':oldrev,'candidate_note':'The refused checkpoint was not saved. This reconstructs its full last-acknowledged state plus the exact captured response through the actual conversation producer and resume builder, without claiming an unavailable byte-exact rejected file.'}
(E/'checkpoint-producer-trace.json').write_text(json.dumps(trace,indent=2)+'\n')
records=[]
for i in (3,6,8,9,10):
 f=O/f'runs/recovery-tournament-assisted/meter/output-{i:04d}.txt'
 calls=[{'name':v['name'],'arguments':json.loads(v['arguments'])} for v in completed(f) if v.get('type')=='function_call']
 records.append({'path':str(f),'sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'calls':calls})
(E/'selector-producer-trace.json').write_text(json.dumps(records,indent=2)+'\n')
