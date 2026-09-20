"""Begin the predeclared final window exactly once, after freeze verification."""
from pathlib import Path
import json,subprocess,datetime,os,hashlib
os.umask(0o077)
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/effect-continuation-f83209f-20260919')
subprocess.run(['node',str(r/'frozen/freeze-repair.mjs'),'--verify'],check=True)
m=r/'final-meter';m.mkdir()
old=r.parent/'public-operation-3eb09c4-20260919/final-meter/runtime-private-values.json'
# Same preserved synthetic source; permits public returned values and schema enums.
# Private rows/values and concrete identity remain pre-send sentinels.
private=json.loads(old.read_text())+list(json.loads((r/'runtime-private.json').read_text()).values())
(m/'private-values.json').write_text(json.dumps(sorted(set(private))))
now=datetime.datetime.now(datetime.timezone.utc)
plan={'started_at':now.isoformat(),'deadline':(now+datetime.timedelta(minutes=90)).isoformat(),'maximum_attempts':16,'initial_ceiling':12,'reserved_restart_recovery':4,'read_response_ceiling':6,'spend_ceiling_usd':5,'hosts':['openrouter.ai'],'private_values_file':str(m/'private-values.json'),'capture_sanitized_inputs':True,'model':'openai/gpt-5.6-terra','adapter':'OpenRouter chat','no_fallback':True,'no_payload_substitution':True,'inherited_runtime_sentinels_sha256':hashlib.sha256(old.read_bytes()).hexdigest()}
(m/'plan.json').write_text(json.dumps(plan,indent=2));print(json.dumps({k:v for k,v in plan.items() if k!='private_values_file'}))
