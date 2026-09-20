"""Public from-empty recipe. Prepared gestures execute only on exact observed frames.
Any failure stops this case; no retries, alternate subjects or internal authority setters.
"""
from pathlib import Path
import json,sys,subprocess,hashlib,time,os,datetime
os.umask(0o077)
e=Path(__file__).resolve().parent;r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/mcp-replay-7be8d2a-20260920')
c=sys.argv[1];assert c in ['r0','r1','t0','t1'];d=r/'operational'/c;root=d/'project';assert not (d/'setup-recipe.json').exists()
record={'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'case':c,'route':'public model-free commands and actual PTY confirmations; no active pointer injection','provider_calls':0,'steps':[]}
def run(args):
 p=subprocess.run(args,check=False,capture_output=True,text=True)
 if p.returncode:raise RuntimeError('Preparation command refused; inspect owned captures: '+str(args[:3]))
 return p.stdout
def public(label,args):
 run(['python3',str(e/'run-public.py'),c,label,*args]);record['steps'].append(label);(d/'setup-recipe.json').write_text(json.dumps(record,indent=2))
def terminal(phase,args):
 p=subprocess.Popen(['python3',str(e/'terminal-session.py'),c,phase,*args],stdout=(d/('terminal-'+phase+'-driver.log')).open('x'),stderr=subprocess.STDOUT)
 control=d/('terminal-'+phase)/'commands.jsonl'
 for _ in range(100):
  if control.exists():break
  if p.poll() is not None:raise RuntimeError('Terminal failed before control file')
  time.sleep(.05)
 run(['python3',str(e/'seed-gestures.py'),c,phase,phase])
 try:code=p.wait(timeout=300)
 except subprocess.TimeoutExpired:
  record['blocked_phase']=phase;(d/'setup-recipe.json').write_text(json.dumps(record,indent=2));raise RuntimeError('Prepared gestures did not reach their frame; preserve live bounded PTY for inspection')
 if code:raise RuntimeError('Public review refused in '+phase)
 result=json.loads((d/('terminal-'+phase)/'result.json').read_text());assert result.get('exit')==0 and result.get('signal') is None
 record['steps'].append('terminal-'+phase);(d/'setup-recipe.json').write_text(json.dumps(record,indent=2))
try:
 public('prepare',['onboard','db','--project-root','.','--from-env','DATABASE_URL','--schema','release_ops','--json'])
 run(['python3',str(e/'prepare-operator.py'),c])
 public('operator-config-validation',['config','validate','--config','synapsor.runner.json'])
 public('export',['onboard','db','--project-root','.','--export-draft','export.json','--json'])
 run(['python3',str(e/'prepare-typed-input.py'),c])
 public('dryrun',['onboard','db','--project-root','.','--draft','reviewed-input.json','--dry-run','--json'])
 public('save',['onboard','db','--project-root','.','--draft','reviewed-input.json','--json'])
 terminal('read',['boundary','review','--project-root','.','--access'])
 terminal('activate',['action','review','--project-root','.'])
 selection=['writeback','setup','--config','synapsor.actions.runner.json','--outcome','release.seal_candidate','--receipt-mode','source_db','--write-url-env','SYNAPSOR_WRITE_RECOVERY_'+c.upper(),'--schema','release_ops','--table','synapsor_writeback_receipts','--json']
 public('receipt-preview',selection);preview=json.loads((d/'receipt-preview.log').read_text());assert preview['ok'] and not preview['saved'] and preview['selection']['receipts']['authority']=='source_db'
 public('receipt-selection',[*selection,'--save-selection','--confirm',preview['confirmation']])
 terminal('administrator',['action','review','--project-root','.'])
 plans=list(root.rglob('requirements.json'));assert len(plans)==1;plan=plans[0].parent;sql_sha=hashlib.sha256((plan/'grants.sql').read_bytes()).hexdigest()
 role='runner_writer_'+hashlib.sha256((str(r)+c).encode()).hexdigest()[:12]
 run(['python3',str(e/'apply-reviewed-writer.py'),c,str(plan.relative_to(root)),sql_sha,role])
 terminal('execution',['action','review','--project-root','.'])
 run(['node',str(e/'public-mcp.mjs'),c,'preparation-read',str(e/'public-read-plan.json')])
 results=json.loads((d/'mcp-preparation-read/results.json').read_text());response=results[-1]['response'];v=response.get('structuredContent') or json.loads(next(x['text'] for x in response['content'] if x['type']=='text'))
 selected=json.loads((r/'operational/subjects-private.json').read_text())[c]['candidate']['candidate_ref'];matches=[i for i,row in enumerate(v['data']) if row['candidate_ref']==selected];assert len(matches)==1 and any(x['row_index']==matches[0] for x in v['subjects'])
 public('pre-request-worker-check',['worker','check','--supervised','--config','synapsor.actions.runner.json','--capability','release.seal_candidate','--json'])
 check=json.loads((d/'pre-request-worker-check.log').read_text());assert not check['issues'];(d/'pre-request-worker-check.json').write_text(json.dumps(check,indent=2))
 run(['python3',str(e/'snapshot-operational.py'),c,'pre-request'])
 record.update(status='prepared_not_executed',finished_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),requests=0,worker_runs=0)
except BaseException as error:
 record.update(status='stopped',error=type(error).__name__,message=str(error),finished_at=datetime.datetime.now(datetime.timezone.utc).isoformat());raise
finally:(d/'setup-recipe.json').write_text(json.dumps(record,indent=2))
print(json.dumps(record))
