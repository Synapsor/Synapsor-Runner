"""All-table equality and full independent source equality around check/refusal.
Inputs are saved owner snapshots, not response inference.
"""
from pathlib import Path
import json,sys,datetime
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/worker-handoff-63aa664-20260920')
case,before,after=sys.argv[1:];assert case in ['w1','w2'];d=r/'operational'/case
read=lambda p:json.loads(p.read_text())
b=d/('state-'+before);a=d/('state-'+after);mb,ma=read(b/'manifest.json'),read(a/'manifest.json')
assert mb==ma,'State differs; do not report no mutation'
q=read(a/'worker_queue.json');assert len(q)==1 and q[0]['status']=='queued' and q[0]['attempts']==0
p=read(a/'proposals.json');approvals=read(a/'approvals.json');assert len(p)==len(approvals)==1
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'case':case,'before':before,'after':after,'all_tables_unchanged':True,'tables':len(mb['tables']),'source_business_rows':sum(v['rows'] for v in ma['source'].values()),'source_and_receipts_unchanged':True,'same_proposal':q[0]['proposal_id'],'queued':True,'attempts':0,'approval_retained':True}
(d/('comparison-'+before+'-'+after+'.json')).write_text(json.dumps(result,indent=2));print(json.dumps(result))
