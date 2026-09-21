"""Owned known-case restoration, no binding rewrites or authority operations.
Credentials are newly generated and written only to private files/stdin.
"""
from pathlib import Path
import os,sys,json,subprocess,secrets,shutil,time,datetime,hashlib
os.umask(0o077)
root=Path(sys.argv[1]).resolve(); entry=Path(sys.argv[2]).resolve(); case=sys.argv[3]
assert case in ['KC-B'] and not root.exists()
old=Path('/home/sandesh-tiwari/Desktop/Synapsor Tutorials/test-1.8.0/stage-b-two-case-b-operator-20260920')
e=Path(__file__).resolve().parent
shared=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/known-case-deployment-7be82c7-20260920/shared'); assert shared.is_dir()
sealed=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/known-case-deployment-7be82c7-20260920/sealed-continuation-starts/B')
root.mkdir(mode=0o700);private=root/'private';private.mkdir();home=root/'home';home.mkdir();meter=root/'authoring-meter';meter.mkdir()
container='synapsor-kc-'+case.lower();db='stageb_b'
admin=secrets.token_urlsafe(32);reader=secrets.token_urlsafe(32)
(private/'postgres.env').write_text(f'POSTGRES_PASSWORD={admin}\nPOSTGRES_DB={db}\n')
def run(args,data=None):
 r=subprocess.run(args,input=data,capture_output=True)
 if r.returncode:
  (private/f'setup-failure-{time.time_ns()}.json').write_text(json.dumps({'command_prefix':args[:3],'exit':r.returncode,'stderr':r.stderr.decode(errors="replace")})+'\n')
  raise RuntimeError(f'Owned fixture operation failed: {args[0:3]}, exit {r.returncode}; stderr retained privately')
 return r.stdout
cid=run(['docker','run','--pull=never','-d','--name',container,'--label','synapsor.task=known-case-deployment-20260920','--label','synapsor.role='+case,'--env-file',str(private/'postgres.env'),'-p','127.0.0.1::5432','postgres:17']).decode().strip()
(private/'container.json').write_text(json.dumps({'name':container,'id':cid,'owner':'known-case-deployment-20260920'})+'\n')
for i in range(60):
 logs=run(['docker','logs',container]).decode()
 # Wait for the final server, not initdb's temporary ready server.
 if 'PostgreSQL init process complete; ready for start up.' in logs:
  ready=subprocess.run(['docker','exec',container,'pg_isready','-U','postgres','-d',db],capture_output=True)
  if ready.returncode==0:break
 time.sleep(0.5)
else:raise RuntimeError('Owned PostgreSQL startup deadline')
port=run(['docker','port',container,'5432/tcp']).decode().strip().rsplit(':',1)[1]
packet=old/'packet/source-only'
roles=(sealed/'roles-without-passwords.sql').read_text()
roles='\n'.join(line for line in roles.splitlines() if not line.startswith(('CREATE ROLE postgres;', 'ALTER ROLE postgres ')))+'\n'
run(['docker','exec','-i',container,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d',db],roles.encode())
run(['docker','exec','-i',container,'pg_restore','--no-owner','-U','postgres','-d',db],(sealed/'source.dump').read_bytes())
run(['docker','exec','-i',container,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d',db],f"ALTER ROLE stageb_reader PASSWORD '{reader}';\n".encode())
snapshot=run(['docker','exec','-i',container,'psql','-X','-At','-v','ON_ERROR_STOP=1','-U','postgres','-d',db],(old/'harness/source-snapshot.sql').read_bytes())
(private/'source-before.json').write_bytes(snapshot)
expected=hashlib.sha256((old/'private/source-before-live.json').read_bytes()).hexdigest()
assert hashlib.sha256(snapshot).hexdigest()==expected,'Restored source differs from historical full rows'
run(['tar','--no-same-owner','-xzf',str(sealed/'whole-project-home.tgz'),'-C',str(root)])
for p in (root/'project').rglob('*'):
 if not p.is_symlink():os.chmod(p,0o700 if p.is_dir() else 0o600)
env={'DATABASE_URL':f'postgresql://stageb_reader:{reader}@127.0.0.1:{port}/{db}'}
(private/'operator-environment.json').write_text(json.dumps(env)+'\n')
logical='/var/tmp/synapsor-new-stageb-20260920-B';harness=root/'harness';harness.mkdir()
for n in ['public-preflight.mjs','project-resolution.mjs']:shutil.copyfile(old/'harness'/n,harness/n)
shutil.copyfile(old/'private/authoring-meter/private-values.json',meter/'private-values.json')
(meter/'phase.json').write_text(json.dumps({'phase':'initial'})+'\n')
(meter/'plan.json').write_text(json.dumps({'case_id':case,'private_values_file':logical+'/authoring-meter/private-values.json','phase_file':logical+'/authoring-meter/phase.json','ledger':str(shared/'provider-budget-ledger.json')},indent=2)+'\n')
sandbox=['--ro-bind','/','/','--dev-bind','/dev','/dev','--proc','/proc','--tmpfs','/tmp','--tmpfs','/var/tmp','--dir',logical]
for name in ['project','home','authoring-meter']:sandbox+=['--dir',logical+'/'+name,'--bind',str(root/name),logical+'/'+name]
sandbox+=['--bind',str(shared),str(shared),'--chdir',logical+'/project','--']
plan={'case_id':case,'owned_root':str(root),'logical_project':logical+'/project','home':logical+'/home','installed_entrypoint':str(entry),'preflight':str(harness/'public-preflight.mjs'),'private_operator_environment':str(private/'operator-environment.json'),'authoring_meter_root':logical+'/authoring-meter','provider_meter':str(e/'provider-meter.mjs'),'artifact_tree':'e81826e022472e8dfa342505418c2a1a1d8442c7a6a0cdb953f5b3075b1d3065','sandbox_args':sandbox}
(root/'LAUNCH-PLAN.json').write_text(json.dumps(plan,indent=2)+'\n')
pre=run(['bwrap']+sandbox+['/usr/bin/node',str(harness/'public-preflight.mjs'),logical+'/project'])
(root/'preflight-before-open.json').write_bytes(pre)
inventory={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'case':case,'container':container,'source_rows':196,'source_sha256':expected,'source_changed':False,'database_destination':{'host':'127.0.0.1','port':int(port),'database':db,'role':'stageb_reader'},'credentials':'fresh private files; no provider/admin credential in project','project':'whole archive; exact original logical path; no binding rewrite','public_operations':0}
(root/'fixture.json').write_text(json.dumps(inventory,indent=2)+'\n');print(json.dumps(inventory))
