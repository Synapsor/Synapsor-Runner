from pathlib import Path
import subprocess,json,sys,hashlib,os
os.umask(0o077)
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/scoped-read-recovery-515d260-20260919');db=json.loads((r/'j6-database-private.json').read_text());cid=db['container'];tag=db['tag']
assert subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "synapsor.task"}}',cid],text=True).strip()==tag
name=sys.argv[1];target=r/(name+'-source.sql');assert not target.exists()
sql=subprocess.check_output(['docker','exec',cid,'pg_dump','-U','postgres','-d','j6_recovery','--schema=refunds','--schema=returns_ops','--no-owner','--no-privileges'],text=True)
normalized='\n'.join(l for l in sql.splitlines() if not l.startswith(('\\restrict','\\unrestrict')))+'\n';target.write_text(normalized)
counts=[]
for schema in ['refunds','returns_ops']:
 for table in ['customers','orders','refund_items','refund_requests']:
  n=subprocess.check_output(['docker','exec',cid,'psql','-U','postgres','-d','j6_recovery','-Atc',f'SELECT count(*) FROM {schema}.{table}'],text=True).strip();counts.append({'schema':schema,'table':table,'rows':int(n)})
value={'tag':tag,'database':'j6_recovery','schema_and_rows_sha256':hashlib.sha256(normalized.encode()).hexdigest(),'counts':counts,'original_data':'not captured; these owned restored sources contain zero rows'}
(r/(name+'-source.json')).write_text(json.dumps(value,indent=2));print(json.dumps(value))
