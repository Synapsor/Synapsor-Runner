from pathlib import Path
import os,json,sys,datetime,hashlib
import pexpect
os.umask(0o077)
e=Path(__file__).resolve().parent;task=Path(json.loads((e/'assignment-plan.json').read_text())['owned_root']);case,alias=sys.argv[1:3];owned=task/'runtime'/case
profiles=json.loads((owned/'reviewed-clients.json').read_text());reference=profiles[alias]
active=sorted(p.name.removeprefix('local-test-runtime.').removesuffix('.json') for p in (owned/'project/.synapsor').glob('local-test-runtime.*.json') if not Path(str(p)+'.retired').exists())
index=2+len(active)+active.index(reference)
log=owned/'setup-evidence'/('retire-'+alias+'.terminal.log');result={'case':case,'reference':reference,'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'incomplete','controller_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()};child=None
with log.open('x') as out:
 try:
  env={'PATH':os.environ['PATH'],'HOME':str(task/'host-home'),'LANG':'C.UTF-8','NO_COLOR':'1','TERM':'xterm-256color','COLUMNS':'140','LINES':'42','SYNAPSOR_CASE':case}
  child=pexpect.spawn('node',[str(task/'runtime/invoke-client-setup.mjs')],env=env,encoding='utf8',timeout=40,dimensions=(42,140));child.logfile_read=out;result['pid']=child.pid
  child.expect_exact('Q Quit');child.send('\x1b[B\r');child.expect_exact('Continue client setup');child.send('\x1b[A\x1b[A\r');child.expect_exact('CONNECT YOUR CLIENT');child.send('\r');child.expect_exact('CONNECT A LOCAL MCP CLIENT');child.send('\r')
  child.expect_exact('Local development client identity');child.send('\x1b[B'*index+'\r');child.expect_exact('Retire this exact reference for future launches?');assert 'Reference: '+reference in child.before;child.send('y')
  child.expect_exact('Future launches are retired for '+reference);child.expect_exact('VERIFIED ACTION BOUNDARY');child.send('\x1b');child.expect_exact('Q Quit');child.send('q');child.expect(pexpect.EOF);child.close();assert child.exitstatus==0
  assert (owned/'project/.synapsor'/('local-test-runtime.'+reference+'.json.retired')).exists();result.update(status='passed_public_future_launch_retirement',exit_code=child.exitstatus)
 except Exception as error:
  result.update(status='failed_or_incomplete',error_type=type(error).__name__)
  if child and child.isalive():child.send('\x03');child.close(force=True)
 finally:
  result['completed_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();(owned/'setup-evidence'/('retire-'+alias+'-result.json')).write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result));raise SystemExit(0 if result['status'].startswith('passed') else 1)
