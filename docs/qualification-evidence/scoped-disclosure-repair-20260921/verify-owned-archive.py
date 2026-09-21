"""Restore a saved owned archive before cleanup; never run queues or providers."""
from pathlib import Path
import json,os,sys,subprocess,sqlite3,hashlib,datetime
os.umask(0o077)
root=Path(sys.argv[1]).resolve();archive=root.parent/'owned-final-states'/root.name
assert root.name in ['development-A-001','main-A-final'];fixture=json.loads((root/'fixture.json').read_text());name=fixture['container']
info=json.loads(subprocess.check_output(['docker','inspect',name]))[0];owned=json.loads((root/'private/container.json').read_text())
assert info['Id']==owned['id'] and info['Config']['Labels']['synapsor.task']=='scoped-disclosure-repair-20260921'
manifest=json.loads((archive/'manifest.json').read_text())
for item in manifest['files']:assert hashlib.sha256((archive/item['file']).read_bytes()).hexdigest()==item['sha256']
check=root.parent/'restoration-checks'/root.name;check.mkdir(parents=True)
subprocess.run(['tar','--no-same-owner','-xzf',str(archive/'whole-project-home.tgz'),'-C',str(check)],check=True)
def logical(p):
 con=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True);con.row_factory=sqlite3.Row;con.execute('BEGIN');out={}
 for (table,) in con.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall():
  rows=[{k:({'bytes_hex':v.hex()} if isinstance(v,bytes) else v) for k,v in dict(row).items()} for row in con.execute('SELECT * FROM "'+table.replace('"','""')+'"')];out[table]=sorted(rows,key=lambda x:json.dumps(x,sort_keys=True))
 con.rollback();con.close();return out
assert logical(check/'project/.synapsor/local.db')==logical(root/'project/.synapsor/local.db')
config=[]
for p in (root/'project').rglob('*'):
 if p.is_file() and p.suffix in ['.json','.txt','.md']:
  other=check/'project'/p.relative_to(root/'project');assert other.read_bytes()==p.read_bytes();config.append(str(p.relative_to(root/'project')))
db='published_review_archive_check';subprocess.run(['docker','exec',name,'createdb','-U','postgres',db],check=True)
with (archive/'source.dump').open('rb') as f: subprocess.run(['docker','exec','-i',name,'pg_restore','--no-owner','-U','postgres','-d',db],stdin=f,check=True)
sql=Path('/home/sandesh-tiwari/Desktop/Synapsor Tutorials/test-1.8.0/stage-b-two-case-prework-20260920/case-a/FULL-SOURCE-HASH-RECIPE.sql').read_bytes()
read=lambda database:subprocess.check_output(['docker','exec','-i',name,'psql','-X','-At','-v','ON_ERROR_STOP=1','-U','postgres','-d',database],input=sql)
restored=read(db);assert restored==read(fixture['database_destination']['database']);(check/'restored-source.json').write_bytes(restored)
schema=lambda database:subprocess.check_output(['docker','exec',name,'pg_dump','--schema-only','--no-owner','-U','postgres','-d',database])
original_schema=schema(fixture['database_destination']['database']);restored_schema=schema(db)
normalize=lambda value:b'\n'.join(line for line in value.splitlines() if not line.startswith((b'\\restrict ',b'\\unrestrict ')))
assert normalize(original_schema)==normalize(restored_schema),'Restored schema/ACL mismatch'
(check/'restored-source-schema-acl.sql').write_bytes(restored_schema)
home_files=0
for p in (root/'home').rglob('*'):
 if p.is_file():
  assert (check/'home'/p.relative_to(root/'home')).read_bytes()==p.read_bytes();home_files+=1
# Only the explicitly created disposable verification database is removed.
subprocess.run(['docker','exec',name,'dropdb','-U','postgres',db],check=True)
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'archive_manifest_sha256':hashlib.sha256((archive/'manifest.json').read_bytes()).hexdigest(),'all42_control_tables_equal':True,'configuration_files_equal':len(config),'home_files_equal':home_files,'source_schema_and_acl_equal':True,'full38_source_rows_equal':True,'source_sha256':hashlib.sha256(restored).hexdigest(),'provider_worker_application_calls':0,'original_database_mutated':False,'restored_database_created_and_removed':db,'container_left_running':True}
(check/'RESULT.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
