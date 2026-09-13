from pathlib import Path
import sqlite3,json,subprocess,hashlib,shutil,sys,datetime
root=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/finding9-counter-454a0d2-20260913');project=root/'fixture/project';name=sys.argv[1];assert '/' not in name
out=root/'checkpoints'/name;out.mkdir();shutil.copytree(project,out/'project')
cid=json.loads((root/'fixture/container.json').read_text())['id'];container=json.loads(subprocess.check_output(['docker','inspect',cid],text=True))[0]
assert container['Id']==cid and container['Config']['Labels']['synapsor.qualification']=='finding9-counter-20260913' and container['HostConfig']['NetworkMode']=='none'
source={}
for table in ['carriers','accounts','dock_slots','shipments']:
 sql=f"SELECT coalesce(json_agg(t ORDER BY id),'[]'::json) FROM public.{table} t;"
 source[table]=json.loads(subprocess.check_output(['docker','exec',cid,'psql','-X','-At','-U','postgres','-d','freightlab','-c',sql],text=True))
(out/'source.json').write_text(json.dumps(source,sort_keys=True,indent=2)+'\n')
(out/'source.sql').write_bytes(subprocess.check_output(['docker','exec',cid,'pg_dump','-U','postgres','-d','freightlab']))
con=sqlite3.connect(f'file:{project}/.synapsor/local.db?mode=ro',uri=True);tables=[r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")];records={}
for table in tables:
 records[table]=con.execute('SELECT * FROM "'+table.replace('"','""')+'" ORDER BY rowid').fetchall()
con.close()
ledger=json.dumps(records,sort_keys=True,default=lambda b:b.hex() if isinstance(b,bytes) else str(b))
(out/'ledger.json').write_text(ledger+'\n')
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'name':name,'source_sha256':hashlib.sha256(json.dumps(source,sort_keys=True).encode()).hexdigest(),'ledger_sha256':hashlib.sha256(ledger.encode()).hexdigest(),'tables':{k:len(v) for k,v in records.items()}}
(out/'summary.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
