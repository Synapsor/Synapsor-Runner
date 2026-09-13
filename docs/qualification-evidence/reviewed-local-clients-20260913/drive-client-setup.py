from pathlib import Path
import os,json,sys,datetime,hashlib,sqlite3,re
import pexpect
os.umask(0o077)
e=Path(__file__).resolve().parent;plan=json.loads((e/'assignment-plan.json').read_text());task=Path(plan['owned_root'])
case,label,context=sys.argv[1:4];owned=task/'runtime'/case;project=owned/'project'
assert context in ['primary','colleague','second-insurer','third-insurer']
source=json.loads((owned/'owner-source-baseline.json').read_text());ref={'primary':'CL-103','colleague':'CL-801','second-insurer':'CL-701','third-insurer':'CL-1001'}[context]
subject=next(r for r in source['claims'] if r['claim_ref']==ref)
values={'tenant':subject['insurer_id'],'principal':subject['adjuster_id']}
private=owned/'setup-evidence';private.mkdir(exist_ok=True)
tag=label+'-'+context;log=private/(tag+'.terminal.log');receipt=private/(tag+'-result.json');assert not log.exists() and not receipt.exists()
def preserved_state():
 db=sqlite3.connect('file:'+str(project/'.synapsor/local.db')+'?mode=ro',uri=True)
 try:
  names=[r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
  rows={n:db.execute('SELECT * FROM "'+n+'"').fetchall() for n in names if n.startswith('control_policy') or n in ['proposals','approvals','worker_queue','writeback_jobs','writeback_receipts']}
  return {n:hashlib.sha256(json.dumps(v,sort_keys=True,default=str).encode()).hexdigest() for n,v in rows.items()}
 finally:db.close()
before=preserved_state();files={f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in (project/'.synapsor').glob('local-test-runtime*.json')}
existing=json.loads((project/'.mcp.json').read_text()) if (project/'.mcp.json').exists() else {}
result={'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'case':case,'label':label,'context_alias':context,'entrypoint':'action review --project-root . -> Continue client setup','controller_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'runtime_driver_sha256':hashlib.sha256((task/'runtime/runtime-driver.mjs').read_bytes()).hexdigest(),'profile_values_in_report':False,'steps':[],'status':'incomplete'}
child=None
with log.open('x') as out:
 try:
  env={'PATH':os.environ['PATH'],'HOME':str(task/'host-home'),'LANG':'C.UTF-8','NO_COLOR':'1','TERM':'xterm-256color','COLUMNS':'140','LINES':'42','SYNAPSOR_CASE':case}
  child=pexpect.spawn('node',[str(task/'runtime/invoke-client-setup.mjs')],env=env,encoding='utf8',timeout=40,dimensions=(42,140));child.logfile_read=out
  result['controller_pid']=os.getpid();result['child_pid']=child.pid
  def expect(text):child.expect_exact(text);result['steps'].append({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'observed':text})
  expect('Q Quit');child.send('\x1b[B\r')
  expect('Continue client setup');child.send('\x1b[A\x1b[A\r')
  expect('CONNECT YOUR CLIENT');child.send('\r')
  expect('CONNECT A LOCAL MCP CLIENT');child.send('\r')
  expect('Local development client identity');child.send('\x1b[B\r')
  expect('Local client label');child.send(label+'\r')
  expect('Review private fixture identity values for this local client?');child.send('y')
  for _ in range(2):
   child.expect(r'Reviewed local (principal|tenant) for [A-Z_]+ \(hidden\) \[Esc Back\]: ')
   role=child.match.group(1);child.send(values[role]+'\r');result['steps'].append({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'hidden_value_entered_for':role})
  expect('Save this exact reviewed identity as a new local client revision?');child.send('y')
  expect('Type yes to continue:');child.send('yes\r')
  expect('Verify this configured client connection now?');child.send('y')
  expect('verified MCP handshake and tool catalog; test connection closed')
  expect('VERIFIED ACTION BOUNDARY');child.send('\x1b')
  expect('Q Quit');child.send('q');child.expect(pexpect.EOF);child.close()
  result['exit_code']=child.exitstatus;assert child.exitstatus==0
  assert preserved_state()==before,'Profile setup changed authority/history/queue/receipt state'
  for name,digest in files.items():assert hashlib.sha256((project/'.synapsor'/name).read_bytes()).hexdigest()==digest,'Existing identity changed'
  now=json.loads((project/'.mcp.json').read_text())
  for name,entry in existing.get('mcpServers',{}).items():assert now['mcpServers'][name]==entry,'Existing launcher changed'
  created=[f for f in (project/'.synapsor').glob('local-test-runtime.'+label+'.*.json') if f.name not in files];assert len(created)==1
  document=json.loads(created[0].read_text());assert all(document['values'][binding['environment']]==values[binding['role']] for binding in document['bindings'])
  reference=created[0].name.removeprefix('local-test-runtime.').removesuffix('.json')
  marker=json.loads((project/'.synapsor'/('claude-code-project-'+reference+'.json')).read_text());assert now['mcpServers'][marker['server_name']]['args'][-1]=='.synapsor/'+created[0].name
  result.update(status='passed_operator_create_install_launch',reference=reference,existing_entries_preserved=len(existing.get('mcpServers',{})),existing_identity_files_preserved=len(files),authority_history_unchanged=True)
  profiles_path=owned/'reviewed-clients.json';profiles=json.loads(profiles_path.read_text()) if profiles_path.exists() else {};assert context not in profiles;profiles[context]=reference;profiles_path.write_text(json.dumps(profiles,indent=2)+'\n')
 except Exception as error:
  result.update(status='failed_or_incomplete',error_type=type(error).__name__)
  if child and child.isalive():child.send('\x03');child.close(force=True)
 finally:
  result['completed_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();receipt.write_text(json.dumps(result,indent=2)+'\n')
# Verify hidden input was not echoed into terminal capture before sharing any summary.
raw=log.read_text();result['identity_values_absent_from_terminal']=all(v not in raw for v in values.values());receipt.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result));raise SystemExit(0 if result['status'].startswith('passed') and result['identity_values_absent_from_terminal'] else 1)
