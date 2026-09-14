from pathlib import Path
import os,json,datetime,pexpect,re,sys
os.umask(0o077)
run_id=sys.argv[1];assert run_id in ['recovery-tournament-assisted','recovery-software']
E=Path(__file__).resolve().parent;O=Path(json.loads((E/'assignment-plan.json').read_text())['owned_root'])/'runs'/run_id;values=json.loads((O/'private/reviewed-context-inputs.json').read_text())['primary'];log=O/'logs/client-setup-01.ansi';result={'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'entrypoint':'installed action review -> Continue client setup','context':'primary synthetic coordinator','provider_calls':0,'steps':[],'status':'incomplete'}
child=pexpect.spawn('node',[str(E/'run-known-command.mjs'),run_id,'action','review','--project-root','.'],encoding='utf8',timeout=40,dimensions=(45,140))
with log.open('x') as out:
 child.logfile_read=out
 def expect(s):child.expect_exact(s);result['steps'].append(s)
 try:
  expect('Q Quit');child.send('\x1b[B\r');expect('Continue client setup');child.send('\x1b[A\x1b[A\r');expect('Local development client identity');child.send('\r');expect('Type yes to continue:');child.send('yes\r');expect('Use a trusted local test identity for this setup session?');child.send('y')
  for _ in range(2):
   child.expect(r'Trusted local test (principal|tenant) value for [A-Z_]+ \(hidden\) \[Esc Back\]: ');role=child.match.group(1);child.send(values[role+'_id']+'\r');result['steps'].append('hidden reviewed '+role)
  expect('Verify this configured client connection now?');child.send('y');expect('verified MCP handshake and tool catalog; test connection closed');expect('Start the reviewed execution worker here?');child.send('n');expect('VERIFIED ACTION BOUNDARY');child.send('\x1b');expect('Q Quit');child.send('q');child.expect(pexpect.EOF);child.close();result['exit_code']=child.exitstatus;assert child.exitstatus==0;result['status']='passed_public_default_identity_install_and_launch'
 except Exception as e:
  result['error_type']=type(e).__name__;result['last_output']=re.sub(r'\x1b\[[0-9;?]*[A-Za-z]','',str(child.before))[-2500:]
  if child.isalive():child.send('\x03');child.close(force=True)
result['identity_values_absent_from_log']=all(v not in log.read_text() for v in values.values());result['completed_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();(E/(run_id+'-client-setup.json')).write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2));raise SystemExit(0 if result['status'].startswith('passed') and result['identity_values_absent_from_log'] else 1)
