"""Main-owned B development copy. Uses sealed inputs, never tester live state."""
from pathlib import Path
import os,sys,json,subprocess,secrets,time,hashlib,shutil,sqlite3,datetime
os.umask(0o077)
root=Path(sys.argv[1]).resolve();assert not root.exists();root.mkdir()
repo=Path(__file__).resolve().parents[3];e=Path(__file__).resolve().parent
old=Path('/home/sandesh-tiwari/Desktop/Synapsor Tutorials/test-1.8.0/independent-phase-review-20260921/prework-b/input')
expected={'project.tgz':'59e8f8cad6a0d33c6d197d02f5f29d4826569ec95dce6ddd92e58c6032decc0b','home.tgz':'316785fdd01f55f9e377a14591014ae6798fa9181a7bab01075c621fddae1460','native_b.dump':'0209adc471329a7575eb4752502e8a23a1e3ce85b507ed7514c42fa3899defaf','roles-no-password.sql':'d306fc459181bf26b6746b0504062d186137bd351991ecf8159102afd37f0cc7','native_b-schema-acl.sql':'ff528dd9f2630f61dd8c42d9a3a5e1a210c3c42fd14a4706884b94d3dd91e11c','source-readback.json':'c64e9a78f76c0886313a61d82b38150c2fa8418f542b60f6bb705cf9aedd0b1e','acl-readback.json':'57d0dbffaa5afbd621ba08ec854abf5cb14747b14e0eb546f123e1b379aea17e'}
for name,digest in expected.items():assert hashlib.sha256((old/name).read_bytes()).hexdigest()==digest
private=root/'private';private.mkdir();harness=root/'harness';harness.mkdir();meter=root/'authoring-meter';meter.mkdir()
def run(args,data=None):
 r=subprocess.run(args,input=data,capture_output=True)
 if r.returncode:
  (private/f'error-{time.time_ns()}.json').write_text(json.dumps({'command':args[:3],'exit':r.returncode,'stderr':r.stderr.decode(errors='replace')})+'\n');raise RuntimeError('Owned restore failure; private log saved')
 return r.stdout
for name in ['project.tgz','home.tgz']:run(['tar','--no-same-owner','-xzf',str(old/name),'-C',str(root)])
for d in [root/'project',root/'home']:
 for p in [d,*d.rglob('*')]:
  if not p.is_symlink():os.chmod(p,0o700 if p.is_dir() else 0o600)
name='synapsor-phase-'+root.name;db='native_b';admin,reader,writer=[secrets.token_urlsafe(32) for _ in range(3)]
(private/'postgres.env').write_text(f'POSTGRES_PASSWORD={admin}\nPOSTGRES_DB={db}\n')
cid=run(['docker','run','--pull=never','-d','--name',name,'--label','synapsor.task=source-phase-review-20260921','--label','synapsor.role=DEV-B','--env-file',str(private/'postgres.env'),'-p','127.0.0.1::5432','postgres:17']).decode().strip()
(private/'container.json').write_text(json.dumps({'name':name,'id':cid,'owner':'source-phase-review-20260921'})+'\n')
for _ in range(60):
 if 'PostgreSQL init process complete; ready for start up.' in run(['docker','logs',name]).decode() and subprocess.run(['docker','exec',name,'pg_isready','-U','postgres','-d',db],capture_output=True).returncode==0:break
 time.sleep(.5)
else:raise RuntimeError('Owned database startup timeout')
roles='\n'.join(line for line in (old/'roles-no-password.sql').read_text().splitlines() if not line.startswith(('CREATE ROLE postgres;','ALTER ROLE postgres ')))+'\n'
run(['docker','exec','-i',name,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d',db],roles.encode())
run(['docker','exec','-i',name,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d',db],f"ALTER ROLE stageb_reader LOGIN PASSWORD '{reader}';\nALTER ROLE runner_writer_671f93137ce9 LOGIN PASSWORD '{writer}';\nALTER ROLE runner_writer_671f93137ce9 SET statement_timeout='5s';\nALTER ROLE runner_writer_671f93137ce9 SET lock_timeout='2s';\n".encode())
run(['docker','exec','-i',name,'pg_restore','--exit-on-error','-U','postgres','-d',db],(old/'native_b.dump').read_bytes())
port=int(run(['docker','port',name,'5432/tcp']).decode().strip().rsplit(':',1)[1])
env={'DATABASE_URL':f'postgresql://stageb_reader:{reader}@127.0.0.1:{port}/{db}','SYNAPSOR_DATABASE_WRITE_URL':f'postgresql://runner_writer_671f93137ce9:{writer}@127.0.0.1:{port}/{db}'}
(private/'operator-environment.json').write_text(json.dumps(env)+'\n')
logical='/var/tmp/synapsor-new-stageb-20260920-B';shared=root.parent/'shared'
sandbox=['--ro-bind','/','/','--dev-bind','/dev','/dev','--proc','/proc','--tmpfs','/tmp','--tmpfs','/var/tmp','--dir',logical]
for n in ['project','home','authoring-meter']:sandbox+=['--dir',logical+'/'+n,'--bind',str(root/n),logical+'/'+n]
sandbox+=['--bind',str(shared),str(shared),'--chdir',logical+'/project','--']
probes=old.parent/'probes'
shutil.copyfile(probes/'effective-store-preflight.mjs',harness/'public-preflight.mjs')
shutil.copyfile(probes/'project-resolution.mjs',harness/'project-resolution.mjs')
plan={'case_id':'DEV-B','owned_root':str(root),'logical_project':logical+'/project','home':logical+'/home','installed_entrypoint':str(repo/'apps/runner/dist/cli.js'),'development_launcher':str(repo/'bin/synapsor-runner'),'preflight':str(harness/'public-preflight.mjs'),'private_operator_environment':str(private/'operator-environment.json'),'authoring_meter_root':logical+'/authoring-meter','provider_meter':str(e/'provider-meter.mjs'),'artifact_tree':'development checkout; not a frozen candidate','sandbox_args':sandbox,'ledger':str(shared/'provider-budget-ledger.json')}
(root/'LAUNCH-PLAN.json').write_text(json.dumps(plan,indent=2)+'\n')
(root/'preflight-before-open.json').write_bytes(run(['bwrap']+sandbox+['/usr/bin/node',str(harness/'public-preflight.mjs'),logical+'/project']))
con=sqlite3.connect((root/'project/.synapsor/local.db').as_uri()+'?mode=ro',uri=True);con.row_factory=sqlite3.Row;con.execute('BEGIN');tables={}
for (table,) in con.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall():
 rows=[{k:({'bytes_hex':v.hex()} if isinstance(v,bytes) else v) for k,v in dict(row).items()} for row in con.execute('SELECT * FROM "'+table.replace('"','""')+'"')];tables[table]=sorted(rows,key=lambda x:json.dumps(x,sort_keys=True))
con.rollback();con.close();assert len(tables)==42 and sum(len(v) for v in tables.values())==185
(root/'all-table-before.json').write_text(json.dumps(tables,indent=2)+'\n')
(root/'fixture.json').write_text(json.dumps({'case':'KC-B','container':name,'source_rows':196,'source_receipts':1,'database_destination':{'host':'127.0.0.1','port':port,'database':db,'role':'stageb_reader'},'sealed_hashes':expected,'history_kind':'authentic post-effect latest stopped threshold15 edit; no numeric redraft','public_operations':0,'source_restore':'full native_b.dump, complete constraints/RLS/ACLs, no schema overlay','fresh_role_setup':'LOGIN/password on existing scoped roles; writer same 5s statement / 2s lock timeout','created_at':datetime.datetime.now(datetime.timezone.utc).isoformat()},indent=2)+'\n')
print(json.dumps({'root':str(root),'container':name,'port':port,'control_tables':42,'control_rows':185,'effective_store_preflight':'PASS','next':'verify scoped credentials, authentic private identity and complete source/ACL readbacks before any application'}))
