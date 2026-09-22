"""Existing review meter allocation activation only. No inference or product edits."""
from pathlib import Path
import os,sys,json,hashlib,datetime,urllib.request
os.umask(0o077)
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/evidence-correction-f0a6fd1-20260922')
signoff=Path(sys.argv[1]); expected=sys.argv[2];start=datetime.datetime.fromisoformat(sys.argv[3].replace('Z','+00:00'));end=datetime.datetime.fromisoformat(sys.argv[4].replace('Z','+00:00'))
assert hashlib.sha256(signoff.read_bytes()).hexdigest()==expected
assert (end-start).total_seconds()==3600 and 0<=(datetime.datetime.now(datetime.timezone.utc)-start).total_seconds()<3600
key=None
for line in Path('/home/sandesh-tiwari/Desktop/Customer Service With Synapsor Runner/.env').read_text().splitlines():
 if '=' in line and line.split('=',1)[0].strip()=='OPENROUTER_API_KEY':key=line.split('=',1)[1].strip().strip('"').strip("'")
assert key
ops=[]
def get(name):
 req=urllib.request.Request('https://openrouter.ai/api/v1/'+name,headers={'Authorization':'Bearer '+key})
 with urllib.request.urlopen(req,timeout=30) as response:
  result=json.load(response)['data'];ops.append({'endpoint':name,'http_status':response.status});return result
credit=get('credits');keyinfo=get('key');model=next(x for x in get('models') if x['id']=='openai/gpt-5.6-terra');p=model['pricing']
assert float(p['prompt'])<=.0000025 and float(p.get('input_cache_write',0))<=.0000025 and float(p['completion'])<=.000012
assert all(x['min_prompt_tokens']>=272000 for x in p.get('overrides',[]))
file=r/'shared/provider-budget-ledger.json';lock=Path(str(file)+'.lock');fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
try:
 state=json.loads(file.read_text());assert state['status']=='RESERVED_NOT_LIVE' and len(state['case_allocations'])==1
 c=state['case_allocations'][0];assert c['case_id']=='TESTER-B-EVIDENCE-REVIEW' and c['status']=='RESERVED' and not c['transports']
 available=credit['total_credits']-credit['total_usage'];limit=keyinfo.get('limit_remaining');required=c['whole_episode_reserved_usd']
 assert required==3.236 and required<=min(available,state['spend_ceiling_usd'],limit if limit is not None else float('inf'))
 assert c['transport_limits']=={'authoring':4,'runtime':0} and c['restart_transports_reserved']=={'authoring':1}
 now=datetime.datetime.now(datetime.timezone.utc).isoformat()
 record={'at':now,'operations':ops,'inference_calls':0,'available_project_credit_usd':available,'key_limit':keyinfo.get('limit'),'key_limit_remaining':limit,'model':model['id'],'pricing':p,'whole_episode_reserved_usd':required,'carried_net_authorization_usd':state['spend_ceiling_usd'],'unknown_prior_liabilities_still_deducted':True,'signoff_path':str(signoff),'signoff_sha256':expected,'start':start.isoformat(),'deadline':end.isoformat()}
 with (r/'ACCESS-PRICING-PREFLIGHT-002.json').open('x') as out:out.write(json.dumps(record,indent=2)+'\n')
 c.update(status='LIVE',started_at=start.isoformat(),deadline=end.isoformat(),checkpoint1_deadline=end.isoformat(),activation_at=now,signoff_path=str(signoff),signoff_sha256=expected)
 state['status']='LIVE';tmp=Path(str(file)+'.activation.tmp');tmp.write_text(json.dumps(state,indent=2)+'\n');tmp.replace(file)
 print(json.dumps({'status':'LIVE','case_id':c['case_id'],'deadline':c['deadline'],'four_transport_reservation':required,'available_project_credit':available,'inference_calls':0}))
finally:os.close(fd);lock.unlink()
