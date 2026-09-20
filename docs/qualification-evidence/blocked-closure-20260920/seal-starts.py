"""Seal actual fresh starts. Never reverses a completed source or imports work."""
from pathlib import Path
import json,subprocess,os,hashlib,stat,datetime
os.umask(0o077)
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/blocked-closure-4b22b46-20260920');out=r/'sealed-starts';out.mkdir()
db=json.loads((r/'database-private.json').read_text());cid=db['container'];assert subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "synapsor.task"}}',cid],text=True).strip()==db['tag']
def sql(name,q):return subprocess.check_output(['docker','exec',cid,'psql','-U','postgres','-d',name,'-At','-c',q],text=True)
manifest={'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'provider_calls':0,'cases':{},'image':json.loads(subprocess.check_output(['docker','inspect',cid],text=True))[0]['Image']}
for case in ['r0','r1','t0','t1']:
 d=r/'operational'/case;state=d/'state-pre-request';m=json.loads((state/'manifest.json').read_text());assert sum(x['rows'] for x in m['source'].values())==504
 baseline=json.loads((d/'baseline-source.json').read_text())
 for table,pk in [('build_candidates','candidate_id'),('build_checks','check_id'),('release_slots','slot_id')]:
  rows=baseline[table];actual=json.loads((state/('source-'+table+'.json')).read_text());assert len(rows)==len(actual) and {x[pk]:x for x in rows}=={x[pk]:x for x in actual}, 'Preparation changed business facts: '+case+'/'+table
 for t in ['proposals','approvals','worker_queue','writeback_jobs','writeback_receipts','idempotency_receipts','writeback_intents']:
  assert m['tables'][t]['rows']==0,t
 assert all(v['rows']==0 for v in m['source_receipts'].values()) and len(m['source_receipts'])==1
 config=json.loads((d/'project/synapsor.actions.runner.json').read_text());assert config['operator_identity']['provider']=='signed_key' and config['operator_identity']['apply_roles']==['recovery_operator']
 assert stat.S_IMODE((d/'operator-private/recovery.pem').stat().st_mode)==0o600
 assert not json.loads((d/'pre-request-worker-check.json').read_text())['issues']
 dest=out/case;dest.mkdir()
 subprocess.run(['tar','-czf',str(dest/'project.tgz'),'-C',str(d),'project','home'],check=True)
 subprocess.run(['tar','-czf',str(dest/'operator-private.tgz'),'-C',str(d),'operator-private'],check=True)
 for name,args in [('source-schema.sql',['--schema-only']),('source-data.sql',['--data-only']),('source-complete.sql',[])]:
  with (dest/name).open('wb') as f:subprocess.run(['docker','exec',cid,'pg_dump','-U','postgres','-d',case,*args],check=True,stdout=f)
 role=json.loads((d/'administrator-provisioning.json').read_text())['role_posture']['rolname']
 roles=sql(case,"SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls FROM pg_roles WHERE rolname IN ('release_trial_reader','"+role+"') ORDER BY rolname")
 (dest/'roles.sql').write_text('CREATE ROLE release_trial_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;\nCREATE ROLE "'+role+'" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;\n-- Set fresh passwords outside saved logs. Database dumps retain exact grants.\n')
 (dest/'role-posture.txt').write_text(roles)
 (dest/'receipt-posture.json').write_text(sql(case,"SELECT row_to_json(t) FROM (SELECT c.relkind,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='release_ops' AND c.relname='synapsor_writeback_receipts') t"))
 subprocess.run(['cp','-a',str(state),str(dest/'readback')],check=True)
 (dest/'readiness.json').write_bytes((d/'pre-request-worker-check.json').read_bytes())
 setup=dest/'public-setup';setup.mkdir()
 for original in sorted(d.iterdir()):
  if original.name.startswith('terminal-') or original.name.startswith('invocation-') or original.name in ['administrator-provisioning.json','operator-configuration.json','setup-recipe.json','typed-input-provenance.json','receipt-preview.log','receipt-selection.log']:
   subprocess.run(['cp','-a',str(original),str(setup/original.name)],check=True)
 (dest/'administrator-provisioning.json').write_bytes((d/'administrator-provisioning.json').read_bytes())
 manifest['cases'][case]={'logical_project':str(d/'project'),'database':case,'source_rows':504,'empty_work':True,'control_backend':'SQLite','business_backend':'PostgreSQL','state_manifest_sha256':hashlib.sha256((state/'manifest.json').read_bytes()).hexdigest(),'writer_role':role,'operator_key':'private local synthetic key separately archived; public fresh-key bootstrap required for rotation','public_invocations':[str(x) for x in sorted(d.glob('invocation-*.json'))],'owner':'implementer' if case.startswith('r') else 'independent_tester'}
# Hash every sealed file after enforcing immutable original archives/readbacks.
records=[]
for p in sorted(out.rglob('*')):
 if p.is_file():p.chmod(p.stat().st_mode & ~0o222)
 if p.is_symlink():records.append({'path':str(p.relative_to(out)),'kind':'symlink','mode':stat.S_IMODE(p.lstat().st_mode),'target':os.readlink(p)})
 elif p.is_dir():records.append({'path':str(p.relative_to(out)),'kind':'directory','mode':stat.S_IMODE(p.stat().st_mode)})
 elif p.is_file():records.append({'path':str(p.relative_to(out)),'kind':'file','mode':stat.S_IMODE(p.stat().st_mode),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
manifest['files']=records
(out/'manifest.json').write_text(json.dumps(manifest,indent=2));(out/'manifest.json').chmod(0o400)
print(json.dumps({'sealed':str(out),'manifest_sha256':hashlib.sha256((out/'manifest.json').read_bytes()).hexdigest(),'requests':0,'worker_runs':0,'provider_calls':0}))
