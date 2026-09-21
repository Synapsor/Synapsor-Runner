"""Read-only existing account balance. Never prints or records credentials."""
from pathlib import Path
import urllib.request,json,datetime,sys,os
os.umask(0o077)
label=sys.argv[1];assert label.replace('-','').isalnum()
key=None
for line in Path('/home/sandesh-tiwari/Desktop/Customer Service With Synapsor Runner/.env').read_text().splitlines():
 if '=' in line and line.split('=',1)[0].strip()=='OPENROUTER_API_KEY':
  key=line.split('=',1)[1].strip().strip('"').strip("'")
assert key
request=urllib.request.Request('https://openrouter.ai/api/v1/credits',headers={'Authorization':'Bearer '+key})
with urllib.request.urlopen(request,timeout=30) as response:data=json.load(response)['data']
remaining=float(data['total_credits'])-float(data['total_usage'])
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'remaining_usd':remaining,'purpose':'Existing account read-only balance; zero authoring/runtime calls, no purchase'}
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-review-5d92ca5-20260920')
(r/('balance-'+label+'.json')).write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
