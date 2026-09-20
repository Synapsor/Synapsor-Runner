"""Apply inspected generated provisioning to this task's disposable source only.
Existing matching writer roles are retained; missing roles use the exact generated CREATE ROLE.
No business rows or policies are changed. No worker is started.
"""
from pathlib import Path
import os,json,hashlib,subprocess,secrets,re
os.umask(0o077)
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/effect-continuation-f83209f-20260919')
x=json.loads((r/'database-private.json').read_text());cid=x['container']
assert subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "synapsor.task"}}',cid],text=True).strip()==x['tag']
def sql(text,dbname='releaselab'):
 return subprocess.run(['docker','exec','-i',cid,'psql','-U','postgres','-d',dbname,'-v','ON_ERROR_STOP=1','-At'],input=text,text=True,capture_output=True,check=True)
# Separate unchanged missing-infrastructure source before applying anything.
assert not (r/'provisioned.json').exists()
if not sql("select datname from pg_database where datname='pendinglab';",'postgres').stdout.strip():sql('CREATE DATABASE pendinglab TEMPLATE releaselab;', 'postgres')
plan=json.loads((r/'public/deployment/generated-writer-plan.json').read_text());role=plan['plan']['suggested_role'];assert re.fullmatch(r'runner_writer_[a-f0-9]{12}',role)
posture=sql("select rolsuper,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls from pg_roles where rolname='"+role+"';").stdout.strip();assert posture in ['', 'f|f|f|f|f|f'],posture
folder=r/'public/deployment/project/.synapsor/writer-handoffs'/Path(plan['directory']).name
original=(folder/'grants.sql').read_text()
assert original.count('CREATE ROLE ')==1
reviewed='\n'.join(line for line in original.splitlines() if not (posture and line.startswith('CREATE ROLE ')))+'\n'
(r/'owned-reviewed-provisioning.sql').write_text(reviewed)
result=sql(reviewed);(r/'provisioning.log').write_text(result.stdout+result.stderr)
secret=secrets.token_hex(24);sql('ALTER ROLE "'+role+'" LOGIN PASSWORD \''+secret+"';")
from urllib.parse import urlparse
port=urlparse(x['admin_url']).port
(r/'writer-private.json').write_text(json.dumps({plan['plan']['writer_env']:f'postgres://{role}:{secret}@127.0.0.1:{port}/releaselab'}))
(r/'provisioned.json').write_text(json.dumps({'container':cid,'database':'releaselab','mode':'owned administrator application of generated narrow grants/receipt objects','original_sql_sha256':hashlib.sha256(original.encode()).hexdigest(),'applied_sql_sha256':hashlib.sha256(reviewed.encode()).hexdigest(),'only_sql_adaptation':('CREATE ROLE omitted after matching posture' if posture else 'None: generated SQL applied unchanged')+'; login/password configured separately','writer_role':role,'writer_reference':plan['plan']['writer_env'],'business_rows_changed':False,'worker_started':False,'missing_infrastructure_database':'pendinglab'},indent=2))
print('Applied reviewed narrow receipt/writer setup in owned source; independent missing-infrastructure database retained. No worker.')
