"""Restore the genuine published intermediate and matching owned source fixtures."""
from pathlib import Path
import json,subprocess,secrets,os,tarfile,re,hashlib,time,shutil
os.umask(0o077)
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-default-feecc2b-20260919')
old=r.parent/'effect-continuation-f83209f-20260919';tag='receipt-default-feecc2b-20260919'
assert not (r/'database-private.json').exists()
def run(args,**kw):return subprocess.run(args,capture_output=True,check=True,**kw)
password=secrets.token_hex(24)
existing=subprocess.run(['docker','inspect',tag],capture_output=True,text=True)
if existing.returncode==0:
 info=json.loads(existing.stdout)[0];assert info['Config']['Labels']['synapsor.task']==tag
 cid=info['Id'];password=next(x.split('=',1)[1] for x in info['Config']['Env'] if x.startswith('POSTGRES_PASSWORD='))
 (r/'prepare-first-attempt.json').write_text(json.dumps({'exit':1,'cause':'pg_isready reached bootstrap Unix socket before final post-init restart; no roles or data restored','correction':'TCP readiness plus actual psql before restoration; same label-verified task container'}))
else:cid=run(['docker','run','-d','--name',tag,'--label','synapsor.task='+tag,'--memory','1g','--cpus','2','-e','POSTGRES_PASSWORD='+password,'-p','127.0.0.1::5432','postgres:17']).stdout.decode().strip()
for _ in range(60):
 if subprocess.run(['docker','exec',cid,'pg_isready','-h','127.0.0.1','-U','postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
 time.sleep(.25)
def db(args,**kw):return run(['docker','exec','-i',cid]+args,**kw)
roles=(old/'saved-final/roles-no-passwords.sql').read_text()
for role in re.findall(r'^CREATE ROLE (\w+);',roles,re.M):
 if role=='postgres':continue
 sql='CREATE ROLE '+role+';\n'+next(line for line in roles.splitlines() if line.startswith('ALTER ROLE '+role+' '))
 assert 'PASSWORD' not in sql
 db(['psql','-U','postgres','-v','ON_ERROR_STOP=1'],input=sql.encode())
for name in ['releaselab','pendinglab','reviewgate']:
 db(['createdb','-U','postgres',name])
 if name!='reviewgate':db(['pg_restore','-U','postgres','-d',name,'--exit-on-error'],input=(old/'saved-final'/(name+'.dump')).read_bytes())
reader=secrets.token_hex(24);writer=secrets.token_hex(24)
db(['psql','-U','postgres','-v','ON_ERROR_STOP=1'],input=("ALTER ROLE release_trial_reader PASSWORD '"+reader+"';\nALTER ROLE runner_writer_4d0d5ef340b9 PASSWORD '"+writer+"';").encode())
port=run(['docker','port',cid,'5432/tcp']).stdout.decode().strip().split(':')[-1]
state={'tag':tag,'container':cid,'reader_url':f'postgres://release_trial_reader:{reader}@127.0.0.1:{port}/releaselab','admin_url':f'postgres://postgres:{password}@127.0.0.1:{port}/releaselab'}
(r/'database-private.json').write_text(json.dumps(state));(r/'writer-private.json').write_text(json.dumps({'SYNAPSOR_WRITE_RELEASE_SEAL_CANDIDATE_77988288':f'postgres://runner_writer_4d0d5ef340b9:{writer}@127.0.0.1:{port}/releaselab'}))
(r/'postgres-tests-private.json').write_text(json.dumps({**state,'admin_url':state['admin_url'].removesuffix('/releaselab')+'/reviewgate'}))
names=['before-writer','before-schema','before-table','R1','R2-writer','R2-schema','R2-table','R2-review','R3']
archive=old/'post-publication-controls/published-before-setup.tgz'
for name in names:
 d=r/'public'/name;d.mkdir(parents=True)
 with tarfile.open(archive) as t:t.extractall(d,filter='data')
 for p in d.rglob('*'):
  if not p.is_symlink():p.chmod(0o700 if p.is_dir() else 0o600)
 for p in ['home','tmp','var-tmp']:(d/p).mkdir()
for dbname in ['releaselab','pendinglab']:
 counts=db(['psql','-U','postgres','-d',dbname,'-At','-c','select (select count(*) from release_ops.build_candidates),(select count(*) from release_ops.release_slots),(select count(*) from release_ops.build_checks)']).stdout.decode().strip()
 assert counts=='116|116|272'
shutil.copytree(old/'offline-home',r/'offline-home')
(r/'fixture-identity.json').write_text(json.dumps({'archive':str(archive),'archive_sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'cases':names,'source_rows':504,'source_dumps':[str(old/'saved-final'/x) for x in ['releaselab.dump','pendinglab.dump']],'new_business_permissions':False,'fresh_local_passwords_only':True},indent=2))
print('Nine isolated whole-project copies; two restored 504-row sources and one owned control test database; zero workers.')
