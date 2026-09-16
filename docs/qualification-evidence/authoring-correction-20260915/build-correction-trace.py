"""Index actual historical requests and decoded local-HTTP correction requests."""
from pathlib import Path
import json,hashlib,subprocess
E=Path(__file__).resolve().parent;plan=json.loads((E/'assignment-plan.json').read_text());O=Path(plan['owned_root'])
index=json.loads((E/'verification-evidence-index.json').read_text())
records=[]
for adapter in ['openai','openrouter']:
 saved=next(r for r in index['records'] if r['relative_path']==f'stable-full03/{adapter}-actual-http-wire.json')
 requests=json.loads(Path(saved['saved_path']).read_text());request=requests[1]
 carriers=request.get('input',request.get('messages'))
 content=next(c['content'] for c in carriers if c.get('role')=='user' and 'Correct this structural coverage problem:' in str(c.get('content')))
 if not isinstance(content,str):content='\n'.join(x.get('text','') for x in content)
 line=next(s for s in content.splitlines() if s.startswith('Correct this structural coverage problem: '))
 feedback=json.loads(line.split(': ',1)[1]);assert len(feedback['findings'])==5
 assert 'referee_private_note' not in json.dumps(feedback)
 records.append({'adapter':adapter,'classification':'local HTTP/SSE transport, original initial response followed by separately derived complete correction; not a historical provider completion','request_file':saved,'request_index_zero_based':1,'decoded_request_sha256':hashlib.sha256(json.dumps(request,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'feedback':feedback,'strict_result':'complete derived replacement accepted; both original complete replies remain invalid','persistence':'separate same-capture prepared-review test saves only after strict validation and explicit current unverified ownership; restart validates reuse'})
D=O/'prompt-evidence';D.mkdir(exist_ok=True)
prompt=[]
for ref,label in [('3c9dbf1','before'),('77e206a','after')]:
 code=subprocess.check_output(['git','show',ref+':apps/runner/src/authoring-policy-coverage.ts'],text=True)
 begin=code.index('        question: ["Review every nonblank');end=code.index('        providerSystemPrompt:',begin)
 text=code[begin:end];file=D/(label+'-request-template.txt')
 if file.exists():assert file.read_text()==text,'Preserve the prior template; record a new version on actual change'
 else:file.write_text(text);file.chmod(0o400)
 a=code.index('        providerSystemPrompt:',end);b=code.index('        skipRunnerQuestionContext:',a)
 prompt.append({'ref':ref,'template':str(file),'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'static_system_source_sha256':hashlib.sha256(code[a:b].encode()).hexdigest()})
assert prompt[0]['static_system_source_sha256']==prompt[1]['static_system_source_sha256']
result={'historical_inputs':json.loads((E/'capture-index.json').read_text()),'historical_first_rejection':'Missing pointer pre-scan; counter support not evaluated then, not filtered or dropped from an already-created finding. Only the pointer message was transmitted.','historical_replacement':'Pointer, maintenance and deployment grouping corrected; both explicit counter supports still invalid; support mismatch surfaced only after the final response.','old_two_replies_still_invalid':True,'after':records,'prompt_change':prompt,'justification':'Exact pointer-first/support-second captured sequence; batch independent same-validator findings and withhold arbitrary rejected text. No fixture-specific product prompt, preferred message ID or rescue sentence.','comparison_controls':['authoring-counting-positive.test.ts actual post-removal captures: explicit supported decision still validates; old wrong supports remain invalid','obligation-readiness.test.ts earlier exact two-response correction still saves/reloads with deployment/readback pending'],'disclosure':'Coordinates/codes/reasons/repairs are host authored. Candidate context remains the already consented context; no arbitrary rejected private-field name is copied into diagnostic. Opaque stream continuation is not readable UI or correction content.'}
(E/'CORRECTION-DELIVERY-TRACE.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'adapters':len(records),'first_batch_findings':len(records[0]['feedback']['findings']),'system_prompt_unchanged':True}))
