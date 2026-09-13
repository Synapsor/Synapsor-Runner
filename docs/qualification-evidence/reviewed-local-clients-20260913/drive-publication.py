from pathlib import Path
import os,json,sys,datetime,time,subprocess,hashlib
import pexpect
os.umask(0o077)
e=Path(__file__).resolve().parent;task=Path(json.loads((e/'assignment-plan.json').read_text())['owned_root']);case=sys.argv[1];assert case in ['edit','replacement_first','admission_first']
owned=task/'runtime'/case;runtime=owned/'deterministic';runtime.mkdir(exist_ok=True)
result={'case':case,'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'running','steps':[],'controller_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()};child=None
log=runtime/'publication-operator.terminal.log'
def wait_marker(name,seconds=120):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  p=runtime/(name+'.json')
  if p.exists():return json.loads(p.read_text())
  time.sleep(.05)
 raise TimeoutError('marker '+name)
try:
 wait_marker('operator-review-ready')
 with log.open('x') as out:
  env={'PATH':os.environ['PATH'],'HOME':str(task/'host-home'),'LANG':'C.UTF-8','NO_COLOR':'1','TERM':'xterm-256color','COLUMNS':'140','LINES':'42','SYNAPSOR_CASE':case}
  child=pexpect.spawn('node',[str(task/'runtime/invoke-interactive.mjs'),'action','review','--project-root','.'],env=env,encoding='utf8',timeout=40,dimensions=(42,140));child.logfile_read=out;result['pid']=child.pid
  def expect(text):child.expect_exact(text);result['steps'].append({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'observed':text})
  expect('Q Quit');child.send('\r');expect('Review saved read access');child.send('\r');expect('Keep current active Read Boundary and finish')
  if case=='replacement_first':
   (runtime/'begin-order.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'operator_at':'Read replacement selection; neither Read nor Action replacement committed'})+'\n');wait_marker('publication-ready',12)
  child.send('\x1b[A'*3+'\r');expect('ACTIVATION SUCCEEDED');expect('Activate this exact proposal authority');child.send('\r');expect('Activate verified Action Boundary "reviewed_staging_actions"?');child.send('\x1b[A\r');expect('Q Quit')
  if case=='edit':
   child.send('\x1b[B\r');expect('Review supervised execution for reserve_ops.adjust_claim_reserve');child.send('\x1b[B\r');expect('Check the configured write connection');child.send('\r');expect('Enable supervised source execution for reserve_ops.adjust_claim_reserve?');child.send('\x1b[A\r');expect('Supervised execution enabled for this outcome.');expect('Q Quit')
  child.send('q');child.expect(pexpect.EOF);child.close();assert child.exitstatus==0;result.update(exit_code=child.exitstatus,status='passed_exact_publication_operator')
except Exception as error:
 result.update(status='failed_or_incomplete',error_type=type(error).__name__)
 if child and child.isalive():child.send('\x03');child.close(force=True)
finally:
 result['completed_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();(runtime/'publication-operator-result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
raise SystemExit(0 if result['status'].startswith('passed') else 1)
