"""Owned whole-project/source restore. No binding edits or saved work execution."""
import pathlib,os,subprocess,json,secrets,tarfile,time,hashlib
os.umask(0o077)
R=pathlib.Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/minimal-edit-bfc2f19-20260919')
OLD=R.parent/'public-operation-3eb09c4-20260919'
def run(args,**kw): return subprocess.run(args,capture_output=True,check=True,**kw)
assert not (R/'database-private.json').exists()
tag='minimal-edit-bfc2f19-20260919'; password=secrets.token_hex(24)
existing=subprocess.run(['docker','inspect',tag],capture_output=True,text=True)
if existing.returncode==0:
 info=json.loads(existing.stdout)[0];assert info['Config']['Labels']['synapsor.task']==tag
 cid=info['Id'];password=next(v.split('=',1)[1] for v in info['Config']['Env'] if v.startswith('POSTGRES_PASSWORD='))
 (R/'fixture-preparation-attempt1.json').write_text(json.dumps({'exit':3,'cause':'historical roles dump includes existing postgres role; ON_ERROR_STOP stopped before source restore','correction':'create only absent task-local dump roles; existing role attributes retained'}))
else:cid=run(['docker','run','-d','--name',tag,'--label','synapsor.task='+tag,'--memory','1g','--cpus','2','-e','POSTGRES_PASSWORD='+password,'-p','127.0.0.1::5432','postgres:17']).stdout.decode().strip()
for i in range(40):
 if subprocess.run(['docker','exec',cid,'pg_isready','-U','postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
 time.sleep(.25)
def db(args,**kw):return run(['docker','exec','-i',cid]+args,**kw)
if not db(['psql','-U','postgres','-At','-c',"select datname from pg_database where datname='releaselab'"]).stdout.strip():db(['createdb','-U','postgres','releaselab'])
# Existing dump references these synthetic local roles, retaining narrow grants.
import re
roles=(OLD/'saved-state/roles.sql').read_text()
existing_roles=set(db(['psql','-U','postgres','-At','-c','select rolname from pg_roles']).stdout.decode().splitlines())
for role in re.findall(r'^CREATE ROLE (\w+);',roles,re.M):
 if role not in existing_roles:
  statement='CREATE ROLE '+role+';\n'+next(line for line in roles.splitlines() if line.startswith('ALTER ROLE '+role+' '))
  assert 'PASSWORD' not in statement
  db(['psql','-U','postgres','-d','releaselab','-v','ON_ERROR_STOP=1'],input=statement.encode())
dump=OLD/'saved-state/releaselab.dump'
res=db(['pg_restore','-U','postgres','-d','releaselab','--exit-on-error'],input=dump.read_bytes());(R/'source-restore.log').write_bytes(res.stdout+res.stderr)
reader=secrets.token_hex(24);db(['psql','-U','postgres','-d','releaselab','-v','ON_ERROR_STOP=1'],input=("ALTER ROLE release_trial_reader PASSWORD '"+reader+"';").encode())
port=run(['docker','port',cid,'5432/tcp']).stdout.decode().strip().split(':')[-1]
(R/'database-private.json').write_text(json.dumps({'tag':tag,'container':cid,'reader_url':f'postgres://release_trial_reader:{reader}@127.0.0.1:{port}/releaselab','admin_url':f'postgres://postgres:{password}@127.0.0.1:{port}/releaselab'}))
counts=db(['psql','-U','postgres','-d','releaselab','-At','-c','select (select count(*) from release_ops.release_slots), (select count(*) from release_ops.build_candidates), (select count(*) from release_ops.build_checks);']).stdout.decode().strip();assert counts=='116|116|272',counts
for name in ['zero-provider','development','E1','E2','E3']:
 d=R/'public'/name;d.mkdir(parents=True)
 with tarfile.open(OLD/'saved-state/software-reviewer.tgz') as t:t.extractall(d,filter='data')
 for p in d.rglob('*'):
  if not p.is_symlink():p.chmod(0o700 if p.is_dir() else 0o600)
 for x in ['home','tmp','var-tmp']:(d/x).mkdir()
(R/'fixture-identity.json').write_text(json.dumps({'source_dump':str(dump),'source_dump_sha256':hashlib.sha256(dump.read_bytes()).hexdigest(),'archive':str(OLD/'saved-state/software-reviewer.tgz'),'archive_sha256':hashlib.sha256((OLD/'saved-state/software-reviewer.tgz').read_bytes()).hexdigest(),'counts':counts,'classification':'original synthetic source rows with preserved historical application state, not a verified post-receipt snapshot','container':cid},indent=2))
print('Owned source and five whole-project copies prepared; 504 original synthetic rows.')
