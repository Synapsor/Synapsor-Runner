"""Fresh known-case source seed only; no copied project, authority or work ledger."""
from pathlib import Path
import os,json,subprocess,hashlib,secrets,csv,io,datetime
os.umask(0o077)
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/blocked-closure-4b22b46-20260920')
original=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/stage-b-acceptance-674ca78-20260913/cases/software-release-sealing')
assert not (r/'operational-private.json').exists()
db=json.loads((r/'database-private.json').read_text());cid=db['container']
assert subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "synapsor.task"}}',cid],text=True).strip()==db['tag']
def psql(name,sql):
 p=subprocess.run(['docker','exec','-i',cid,'psql','-U','postgres','-d',name,'-v','ON_ERROR_STOP=1','-q'],input=sql,text=True,capture_output=True)
 if p.returncode:raise RuntimeError(p.stderr)
 return p.stdout
schema=(original/'schema.sql').read_text();facts=json.loads((original/'private/source-facts.json').read_text())
assert {k:len(v) for k,v in facts.items()}=={'release_slots':116,'build_candidates':116,'build_checks':272}
password=secrets.token_hex(24);private={};records=[]
from urllib.parse import urlparse
port=urlparse(db['admin_url']).port
for i,name in enumerate(['r0','r1','t0','t1']):
 subprocess.run(['docker','exec',cid,'createdb','-U','postgres',name],check=True,capture_output=True)
 ddl=schema if i==0 else '\n'.join(x for x in schema.splitlines() if not x.startswith('CREATE ROLE release_trial_reader'))
 psql(name,ddl)
 for table,rows in facts.items():
  out=io.StringIO();w=csv.writer(out,lineterminator='\n');cols=list(rows[0]);
  for row in rows:w.writerow([str(row[k]).lower() if isinstance(row[k],bool) else row[k] for k in cols])
  sql='COPY release_ops.'+table+' ('+','.join(cols)+') FROM STDIN WITH (FORMAT csv);\n'+out.getvalue()+'\\.\n'
  psql(name,sql)
 p=r/'operational'/name;p.mkdir(parents=True)
 for d in ['project','home','tmp','var-tmp']:(p/d).mkdir()
 (p/'baseline-source.json').write_text(json.dumps(facts,sort_keys=True,indent=2)+'\n')
 private[name]={'reader_url':f'postgres://release_trial_reader:{password}@127.0.0.1:{port}/{name}'}
 counts=psql(name,"SELECT (SELECT count(*) FROM release_ops.release_slots),(SELECT count(*) FROM release_ops.build_candidates),(SELECT count(*) FROM release_ops.build_checks);")
 records.append({'case':name,'database':name,'project':str(p/'project'),'business_counts':{'release_slots':116,'build_candidates':116,'build_checks':272},'baseline_sha256':hashlib.sha256((p/'baseline-source.json').read_bytes()).hexdigest(),'inherited_authority_or_work':False})
psql('postgres',"ALTER ROLE release_trial_reader PASSWORD '"+password+"';")
(r/'operational-private.json').write_text(json.dumps(private))
record={'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'container':cid,'source_schema':str(original/'schema.sql'),'schema_sha256':hashlib.sha256(schema.encode()).hexdigest(),'source_facts':str(original/'private/source-facts.json'),'source_facts_sha256':hashlib.sha256((original/'private/source-facts.json').read_bytes()).hexdigest(),'cases':records,'writer_and_receipt_provisioning':'pending separate public review','provider_calls':0}
(r/'operational-preparation.json').write_text(json.dumps(record,indent=2));print(json.dumps(record,indent=2))
