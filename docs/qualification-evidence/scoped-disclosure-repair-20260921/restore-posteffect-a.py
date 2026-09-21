"""Owned known-case restoration, no binding rewrites or authority operations.
Credentials are newly generated and written only to private files/stdin.
"""
from pathlib import Path
import os,sys,json,subprocess,secrets,shutil,time,datetime,hashlib
os.umask(0o077)
root=Path(sys.argv[1]).resolve(); entry=Path(sys.argv[2]).resolve(); case=sys.argv[3]
assert case in ['KC-A'] and not root.exists()
old=Path('/home/sandesh-tiwari/Desktop/Synapsor Tutorials/test-1.8.0/stage-b-two-case-prework-20260920/case-a')
e=Path(__file__).resolve().parent
shared=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/published-review-discovery-ed32e38-20260921/shared'); assert shared.is_dir()
sealed=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/published-review-discovery-ed32e38-20260921/owned-final-states/main-A-final')
assert hashlib.sha256((sealed/'manifest.json').read_bytes()).hexdigest()=='887ace2ced2b2a331a69d6a7ec806d52f4ce6e14be0af12a9eb32b54eee6a42f'
for item in json.loads((sealed/'manifest.json').read_text())['files']:
 assert hashlib.sha256((sealed/item['file']).read_bytes()).hexdigest()==item['sha256']
root.mkdir(mode=0o700);private=root/'private';private.mkdir();home=root/'home';home.mkdir();meter=root/'authoring-meter';meter.mkdir()
container='synapsor-published-review-'+root.name;db='stageb_a'
admin=secrets.token_urlsafe(32);reader=secrets.token_urlsafe(32)
(private/'postgres.env').write_text(f'POSTGRES_PASSWORD={admin}\nPOSTGRES_DB={db}\n')
def run(args,data=None):
 r=subprocess.run(args,input=data,capture_output=True)
 if r.returncode:
  (private/f'setup-failure-{time.time_ns()}.json').write_text(json.dumps({'command_prefix':args[:3],'exit':r.returncode,'stderr':r.stderr.decode(errors="replace")})+'\n')
  raise RuntimeError(f'Owned fixture operation failed: {args[0:3]}, exit {r.returncode}; stderr retained privately')
 return r.stdout
cid=run(['docker','run','--pull=never','-d','--name',container,'--label','synapsor.task=scoped-disclosure-repair-20260921','--label','synapsor.role='+case,'--env-file',str(private/'postgres.env'),'-p','127.0.0.1::5432','postgres:17']).decode().strip()
(private/'container.json').write_text(json.dumps({'name':container,'id':cid,'owner':'scoped-disclosure-repair-20260921'})+'\n')
for i in range(60):
 logs=run(['docker','logs',container]).decode()
 # Wait for the final server, not initdb's temporary ready server.
 if 'PostgreSQL init process complete; ready for start up.' in logs:
  ready=subprocess.run(['docker','exec',container,'pg_isready','-U','postgres','-d',db],capture_output=True)
  if ready.returncode==0:break
 time.sleep(0.5)
else:raise RuntimeError('Owned PostgreSQL startup deadline')
port=run(['docker','port',container,'5432/tcp']).decode().strip().rsplit(':',1)[1]
packet=old/'source-only'
roles=(sealed/'roles-without-passwords.sql').read_text()
roles='\n'.join(line for line in roles.splitlines() if not line.startswith(('CREATE ROLE postgres;', 'ALTER ROLE postgres ')))+'\n'
run(['docker','exec','-i',container,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d',db],roles.encode())
run(['docker','exec','-i',container,'pg_restore','--no-owner','-U','postgres','-d',db],(sealed/'source.dump').read_bytes())
run(['docker','exec','-i',container,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d',db],f"ALTER ROLE newsb_a_reader PASSWORD '{reader}';\n".encode())
snapshot=run(['docker','exec','-i',container,'psql','-X','-At','-v','ON_ERROR_STOP=1','-U','postgres','-d',db],(old/'FULL-SOURCE-HASH-RECIPE.sql').read_bytes())
(private/'source-before.json').write_bytes(snapshot)
expected=hashlib.sha256(Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/published-review-discovery-ed32e38-20260921/main-A-final/state-readbacks/after-restart-source.json').read_bytes()).hexdigest()
assert hashlib.sha256(snapshot).hexdigest()==expected,'Restored source differs from historical full rows'
run(['tar','--no-same-owner','-xzf',str(sealed/'whole-project-home.tgz'),'-C',str(root)])
for p in (root/'project').rglob('*'):
 if not p.is_symlink():os.chmod(p,0o700 if p.is_dir() else 0o600)
writer=secrets.token_urlsafe(32)
run(['docker','exec','-i',container,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d',db],f"ALTER ROLE runner_writer_c3155f745588 PASSWORD '{writer}';\n".encode())
env={'DATABASE_URL':f'postgresql://newsb_a_reader:{reader}@127.0.0.1:{port}/{db}'}
(private/'runtime-environment.json').write_text(json.dumps({'DATABASE_URL':env['DATABASE_URL']})+'\n')
identity=json.loads(next((root/'project/.synapsor/local-test-runtimes').glob('*.json')).read_text()) if (root/'project/.synapsor/local-test-runtimes').exists() else None
(private/'operator-environment.json').write_text(json.dumps(env)+'\n')
logical='/var/tmp/synapsor-new-stageb-20260920-A';harness=root/'harness';harness.mkdir()
for n in ['public-preflight.mjs','project-resolution.mjs']:shutil.copyfile(Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/new-stage-b-d3dbf16-20260920/case-A/live')/n,harness/n)
shutil.copyfile(Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/new-stage-b-d3dbf16-20260920/case-A/private/authoring-private-values.json'),meter/'private-values.json')
(meter/'phase.json').write_text(json.dumps({'phase':'initial'})+'\n')
(meter/'plan.json').write_text(json.dumps({'case_id':case,'private_values_file':logical+'/authoring-meter/private-values.json','phase_file':logical+'/authoring-meter/phase.json','ledger':str(shared/'provider-budget-ledger.json')},indent=2)+'\n')
sandbox=['--ro-bind','/','/','--dev-bind','/dev','/dev','--proc','/proc','--tmpfs','/tmp','--tmpfs','/var/tmp','--dir',logical]
for name in ['project','home','authoring-meter']:sandbox+=['--dir',logical+'/'+name,'--bind',str(root/name),logical+'/'+name]
sandbox+=['--ro-bind',str(shared),str(shared),'--chdir',logical+'/project','--']
plan={'case_id':case,'owned_root':str(root),'logical_project':logical+'/project','home':logical+'/home','installed_entrypoint':str(entry),'preflight':str(harness/'public-preflight.mjs'),'private_operator_environment':str(private/'operator-environment.json'),'authoring_meter_root':logical+'/authoring-meter','provider_meter':str(e/'diagnostic-no-send.mjs'),'artifact_tree':'development checkout; zero-provider restoration only; final installed candidate pending','sandbox_args':sandbox}
manifest=entry.parents[5]/'installed-artifact-manifest.json' if entry.name=='cli.js' else None
if manifest is not None:
 assert manifest.is_file(),'Final installation manifest required'
 plan['artifact_tree']=json.loads(manifest.read_text())['installed_tree_sha256']
(root/'LAUNCH-PLAN.json').write_text(json.dumps(plan,indent=2)+'\n')
pre=run(['bwrap']+sandbox+['/usr/bin/node',str(harness/'public-preflight.mjs'),logical+'/project'])
(root/'preflight-before-open.json').write_bytes(pre)
inventory={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'case':case,'container':container,'source_rows':38,'source_sha256':expected,'source_changed':False,'database_destination':{'host':'127.0.0.1','port':int(port),'database':db,'role':'newsb_a_reader'},'credentials':'fresh private files; no provider/admin credential in project','project':'whole archive; exact original logical path; no binding rewrite','public_operations':0,'start_kind':'sealed continuation: post-publication active five-day authority, applied five-day operation, no Action draft','seal':str(sealed),'manifest_sha256':'887ace2ced2b2a331a69d6a7ec806d52f4ce6e14be0af12a9eb32b54eee6a42f'}
(root/'fixture.json').write_text(json.dumps(inventory,indent=2)+'\n');print(json.dumps(inventory))

import sqlite3
con=sqlite3.connect((root/'project/.synapsor/local.db').as_uri()+'?mode=ro',uri=True);con.row_factory=sqlite3.Row;con.execute('BEGIN');actual={}
for (name,) in con.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall():
 rows=[{k:({'bytes_hex':v.hex()} if isinstance(v,bytes) else v) for k,v in dict(x).items()} for x in con.execute('SELECT * FROM "'+name.replace('"','""')+'"')];actual[name]=sorted(rows,key=lambda x:json.dumps(x,sort_keys=True))
con.rollback();con.close()
original=json.loads(Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/published-review-discovery-ed32e38-20260921/main-A-final/state-readbacks/after-restart-control.json').read_text());assert actual==original,'Whole42table baseline mismatch'
(root/'all-table-before.json').write_text(json.dumps(actual,indent=2)+'\n')
(root/'RESTORE-VERDICT.json').write_text(json.dumps({'all42tables_equal':True,'full38source_rows_equal':True,'post_effect_start':True,'no_authority_binding_rewrite':True})+'\n')
