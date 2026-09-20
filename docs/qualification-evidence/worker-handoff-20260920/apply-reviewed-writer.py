"""Fixture administrator applies exact already-reviewed generated instructions.
No authority setters. No source rows changed. Credentials stay in owned private
configuration and are supplied only to this case's launcher.
"""
from pathlib import Path
from urllib.parse import urlparse
import json,subprocess,sys,hashlib,secrets,re,datetime,os
os.umask(0o077)
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/worker-handoff-63aa664-20260920')
case,relative,approved_sql_sha=sys.argv[1:];assert case in ['w1','w2'];d=r/'operational'/case;root=d/'project';handoff=(root/relative).resolve();assert handoff.is_relative_to(root)
out=d/'administrator-provisioning.json';assert not out.exists()
plan=json.loads((handoff/'requirements.json').read_text());sql=(handoff/'grants.sql').read_text();assert hashlib.sha256(sql.encode()).hexdigest()==approved_sql_sha
assert re.fullmatch('runner_writer_[a-f0-9]{12}',plan['suggested_role']);role=plan['suggested_role'];assert plan['outcome']=='release.seal_candidate';assert plan['engine']=='postgres'
assert set(x['relation'] for x in plan['relations'])=={'release_ops.build_candidates','release_ops.release_slots','release_ops.build_checks','release_ops.synapsor_writeback_receipts'}
assert plan['receipt_setup']['schema']=='release_ops' and plan['receipt_setup']['table']=='synapsor_writeback_receipts'
assert re.fullmatch('[A-Z_][A-Z0-9_]+',plan['writer_env']) and plan['writer_env']!='DATABASE_URL'
db=json.loads((r/'database-private.json').read_text());assert subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "synapsor.task"}}',db['container']],text=True).strip()==db['tag']
def run(query):
 p=subprocess.run(['docker','exec','-i',db['container'],'psql','-U','postgres','-d',case,'-At','-v','ON_ERROR_STOP=1'],input=query,text=True,capture_output=True)
 if p.returncode:raise RuntimeError('Owned administrator operation failed; no credential output retained')
 return p.stdout
# Exact generated CREATE ROLE transaction refuses any existing shared role.
answer=run(sql);(d/'administrator-grants-output.txt').write_text(answer)
password=secrets.token_hex(24);run('ALTER ROLE "'+role+'" LOGIN PASSWORD \''+password+'\';')
settings=json.loads((r/'operational-private.json').read_text());u=urlparse(settings[case]['reader_url']);assert u.hostname=='127.0.0.1' and u.path=='/'+case
settings[case]['writer']={plan['writer_env']:f'postgres://{role}:{password}@{u.hostname}:{u.port}/{case}'};(r/'operational-private.json').write_text(json.dumps(settings))
posture=json.loads(run("SELECT row_to_json(t) FROM (SELECT rolname,rolsuper,rolbypassrls,rolinherit,rolcanlogin FROM pg_roles WHERE rolname='"+role+"') t;"))
assert not posture['rolsuper'] and not posture['rolbypassrls'] and not posture['rolinherit'] and posture['rolcanlogin']
grants=json.loads(run("SELECT coalesce(json_agg(t),'[]') FROM (SELECT table_schema,table_name,column_name,privilege_type FROM information_schema.column_privileges WHERE grantee='"+role+"' ORDER BY 1,2,3,4) t;"))
row={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'case':case,'generated_sql_sha256':approved_sql_sha,'requirements_sha256':hashlib.sha256((handoff/'requirements.json').read_bytes()).hexdigest(),'plan':plan,'role_posture':posture,'column_grants':grants,'source_rows_changed':False,'receipt_probe':'not performed by administrator provisioning','execution_enabled':False,'credentials':'fresh owned writer; never recorded in this result'}
out.write_text(json.dumps(row,indent=2));print(json.dumps({'case':case,'provisioned_role':role,'source_rows_changed':False,'execution_enabled':False,'writer_reference':plan['writer_env']}))
