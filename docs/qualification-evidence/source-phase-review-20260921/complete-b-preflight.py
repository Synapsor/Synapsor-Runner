from pathlib import Path
import json,sys,shutil,subprocess,sqlite3,datetime,hashlib,os
os.umask(0o077)
root=Path(sys.argv[1]).resolve();plan=json.loads((root/'LAUNCH-PLAN.json').read_text());private=root/'private'
probes=Path('/home/sandesh-tiwari/Desktop/Synapsor Tutorials/test-1.8.0/independent-phase-review-20260921/prework-b/probes')
shutil.copyfile(probes/'effective-store-preflight.mjs',root/'harness/public-preflight.mjs')
shutil.copyfile(probes/'project-resolution.mjs',root/'harness/project-resolution.mjs')
p=subprocess.run(['bwrap']+plan['sandbox_args']+['node',plan['preflight'],plan['logical_project']],capture_output=True);(root/'preflight-before-open.json').write_bytes(p.stdout);assert p.returncode==0,p.stderr.decode()
ident=json.loads(next((root/'project/.synapsor').glob('local-test-runtime.*.json')).read_text());env=json.loads((private/'operator-environment.json').read_text())
assert set(ident['values'])=={'SYNAPSOR_PRINCIPAL','SYNAPSOR_TENANT_ID'}
env.update(ident['values']);(private/'operator-environment.json').write_text(json.dumps(env)+'\n')
con=sqlite3.connect((root/'project/.synapsor/local.db').as_uri()+'?mode=ro',uri=True);con.row_factory=sqlite3.Row;con.execute('BEGIN');tables={}
for (table,) in con.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall():
 rows=[{k:({'bytes_hex':v.hex()} if isinstance(v,bytes) else v) for k,v in dict(row).items()} for row in con.execute('SELECT * FROM "'+table.replace('"','""')+'"')];tables[table]=sorted(rows,key=lambda x:json.dumps(x,sort_keys=True))
con.rollback();con.close();assert len(tables)==42 and sum(len(v) for v in tables.values())==185
(root/'all-table-before.json').write_text(json.dumps(tables,indent=2)+'\n')
from urllib.parse import urlsplit
url=urlsplit(env['DATABASE_URL']);container=json.loads((private/'container.json').read_text());info=json.loads(subprocess.check_output(['docker','inspect',container['name']]))[0]
assert info['Id']==container['id'] and info['Config']['Labels']['synapsor.task']=='source-phase-review-20260921'
assert url.hostname=='127.0.0.1' and any(x['HostIp']=='127.0.0.1' and int(x['HostPort'])==url.port for x in info['NetworkSettings']['Ports']['5432/tcp'])
fixture={'case':'KC-B','container':container['name'],'source_rows':196,'source_receipts':1,'database_destination':{'host':url.hostname,'port':url.port,'database':url.path[1:],'role':url.username},'fresh_role_setup':'fresh passwords and LOGIN for existing two scoped roles, original narrow privileges/5s statement/2s lock timeout','baseline':'latest sealed stopped threshold15 post-effect project, matched full source dump','public_operations':0,'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
(root/'fixture.json').write_text(json.dumps(fixture,indent=2)+'\n')
(root/'PREPARATION-CORRECTION-1.json').write_text(json.dumps({'kind':'development harness correction, no application yet','failure':'Copied A helper correctly rejected B logical root before writable open','correction':'Use the tester supplied B effective-store helper. No project locator or binding edit. Existing owned restore retained.','preflight':'PASS','source':'full original dump; verification follows'},indent=2)+'\n')
print(json.dumps({'preflight':'PASS','tables':42,'rows':185,'identities':'authentic sealed document privately retained','credentials':'own newly generated, never copied from tester'}))
