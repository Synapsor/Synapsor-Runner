"""Recheck existing account/rate bounds and allocate one declared review episode.
Qualification only; no inference, purchase, product timing or authority operation.
"""
from pathlib import Path
import json,os,sys,urllib.request,datetime,hashlib
os.umask(0o077)
case=sys.argv[1];assert case in ['MAIN-A-REVIEW','TESTER-A-REVIEW']
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/published-review-discovery-ed32e38-20260921');file=r/'shared/provider-budget-ledger.json'
key=None
for line in Path('/home/sandesh-tiwari/Desktop/Customer Service With Synapsor Runner/.env').read_text().splitlines():
 if '=' in line and line.split('=',1)[0].strip()=='OPENROUTER_API_KEY': key=line.split('=',1)[1].strip().strip('\"').strip("'")
assert key
def get(endpoint):
 req=urllib.request.Request('https://openrouter.ai/api/v1/'+endpoint,headers={'Authorization':'Bearer '+key})
 with urllib.request.urlopen(req,timeout=30) as response:return json.load(response)['data']
credit=get('credits');available=float(credit['total_credits'])-float(credit['total_usage']);model=next(x for x in get('models') if x['id']=='openai/gpt-5.6-terra')
pricing=model['pricing'];assert float(pricing['prompt'])<=.0000025 and float(pricing['input_cache_write'])<=.0000025 and float(pricing['completion'])<=.000012
assert all(x['min_prompt_tokens']>=272000 for x in pricing.get('overrides',[]))
now=datetime.datetime.now(datetime.timezone.utc);calls=4 if case=='MAIN-A-REVIEW' else 2;whole=.809*calls
fd=os.open(str(file)+'.lock',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
try:
 state=json.loads(file.read_text());assert not any(x['status']=='LIVE' for x in state['case_allocations']);assert not any(x['case_id']==case for x in state['case_allocations'])
 charged=sum(sum(t.get('cost_usd',t.get('provisional_upper_usd',t['reservation_usd'])) for t in c.get('transports',[]) if not t.get('cost_group'))+sum(t['cost_usd'] for t in c.get('runtime_cost_groups',[])) for c in state['case_allocations'])
 remaining=min(state['spend_ceiling_usd']-charged,available);assert remaining>=whole, 'Whole review/restart reservation not fundable'
 pre={'at':now.isoformat(),'model':model['id'],'pricing':pricing,'available_credit_usd':available,'authorized_remaining_usd':state['spend_ceiling_usd']-charged,'whole_review_reserve_usd':whole,'zero_inference_calls':True}
 (r/'shared'/('provider-preflight-'+case+'.json')).write_text(json.dumps(pre,indent=2)+'\n')
 allocation={'case_id':case,'status':'LIVE','phase_kind':'final','started_at':now.isoformat(),'deadline':(now+datetime.timedelta(hours=3)).isoformat(),'checkpoint1_deadline':(now+datetime.timedelta(hours=2)).isoformat(),'spend_ceiling_usd':whole,'whole_episode_reserved_usd':whole,'models':{'authoring':model['id']},'transport_limits':{'authoring':calls,'runtime':0},'restart_transports_reserved':{'authoring':1},'business_authorized':False,'operation_limits':{'workers':0,'request_change':0,'effects':0},'transports':[]}
 state['case_allocations'].append(allocation);state['status']='LIVE';tmp=Path(str(file)+'.allocation.tmp');tmp.write_text(json.dumps(state,indent=2)+'\n');tmp.replace(file)
finally:os.close(fd);Path(str(file)+'.lock').unlink()
print(json.dumps({'allocated':case,'whole_episode_usd':whole,'authoring_limit':calls,'restart_reserved':1,'native':0,'business_operations':False,'deadline':allocation['deadline']}))
