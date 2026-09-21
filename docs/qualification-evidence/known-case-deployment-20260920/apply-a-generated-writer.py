"""Fixture administrator application of the exact public generated handoff.
Does not change business rows, RLS predicates, existing roles, policy or receipts.
"""
from pathlib import Path
import os,json,subprocess,hashlib,secrets,datetime
os.umask(0o077)
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/known-case-deployment-7be82c7-20260920/main-A')
f=json.loads((r/'fixture.json').read_text());container=f['container'];info=json.loads(subprocess.check_output(['docker','inspect',container]))[0]
assert info['Config']['Labels']['synapsor.task']=='known-case-deployment-20260920' and info['State']['Running']
h=r/'project/.synapsor/writer-handoffs/review-g98XgF';req=json.loads((h/'requirements.json').read_text());role=req['suggested_role'];assert role=='runner_writer_c3155f745588' and req['outcomes']==['release.clear_assessment']
expected="((center_id = current_setting('synapsor.center_id'::text, true)) AND (coordinator_id = current_setting('synapsor.coordinator_id'::text, true)))"
for rel in req['relations']:
 assert rel['row_security']=={'enabled':True,'forced':True}
 assert len(rel['policies'])==1
 p=rel['policies'][0];assert p['command']=='ALL' and p['roles']==['public'] and p['permissive'] and p['using_expression']==expected and p['check_expression']==expected
sql=(h/'grants.sql').read_bytes()
p=subprocess.run(['docker','exec','-i',container,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','stageb_a'],input=sql,capture_output=True)
(r/'private/admin-grants.stdout').write_bytes(p.stdout);(r/'private/admin-grants.stderr').write_bytes(p.stderr);assert p.returncode==0
# The generated handoff explicitly leaves LOGIN/password provisioning to owner.
password=secrets.token_urlsafe(32)
auth=f'ALTER ROLE "{role}" LOGIN PASSWORD \'{password}\';\n'
p2=subprocess.run(['docker','exec','-i',container,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','stageb_a'],input=auth.encode(),capture_output=True);assert p2.returncode==0
(r/'private/admin-login.stdout').write_bytes(p2.stdout)
env=json.loads((r/'private/operator-environment.json').read_text());assert list(env)==['DATABASE_URL']
env['SYNAPSOR_DATABASE_WRITE_URL']=f'postgresql://{role}:{password}@127.0.0.1:{f["database_destination"]["port"]}/stageb_a'
(r/'private/operator-environment.json').write_text(json.dumps(env)+'\n')
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'generated_sql_sha256':hashlib.sha256(sql).hexdigest(),'grant_exit':p.returncode,'authentication_exit':p2.returncode,'new_role':role,'reader_unchanged':True,'source_rows_changed':False,'RLS_changed':False,'business_schema_changed':False,'receipt_mode':'runner_ledger','review_note':'Generator said simple scope not recognized. Owner inspected actual single PUBLIC ALL USING/WITH CHECK exact trusted center/principal equalities, enabled+forced; already applies to new role. Applied generated grants unaltered; no filter repair/policy replacement. Actual Runner writer verification still required.','writer_verified':False}
(r/'ADMIN-APPLICATION.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
