"""Save final task state before stopping only the label-verified owned container.
No worker or application command is launched. Credentials stay outside outputs.
"""
from pathlib import Path
import datetime,hashlib,json,os,subprocess,sqlite3
os.umask(0o077)
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-default-feecc2b-20260919')
private=json.loads((r/'database-private.json').read_text());cid=private['container'];tag=private['tag']
def run(args,**kw):return subprocess.run(args,capture_output=True,check=True,**kw)
info=json.loads(run(['docker','inspect',cid]).stdout)[0]
assert info['Config']['Labels']['synapsor.task']==tag=='receipt-default-feecc2b-20260919'
out=r/'saved-final';out.mkdir()
def db(args):return run(['docker','exec',cid]+args).stdout
receipt_count=db(['psql','-U','postgres','-d','releaselab','-At','-c','select count(*) from release_ops.synapsor_writeback_receipts']).decode().strip()
assert receipt_count=='0'
missing=db(['psql','-U','postgres','-d','pendinglab','-At','-c',"select to_regclass('release_ops.synapsor_writeback_receipts') is null"]).decode().strip()
assert missing=='t'
for case in json.loads((r/'fixture-identity.json').read_text())['cases']:
 p=r/'public'/case/'project'
 c=sqlite3.connect(p/'.synapsor/local.db',timeout=1);c.execute('begin exclusive');c.rollback();c.close()
 run(['tar','-czf',str(out/(case+'.tgz')),'-C',str(p.parent),'project'])
for database in ['releaselab','pendinglab','reviewgate']:
 (out/(database+'.dump')).write_bytes(db(['pg_dump','-U','postgres','-Fc',database]))
(out/'roles-no-passwords.sql').write_bytes(db(['pg_dumpall','-U','postgres','--roles-only','--no-role-passwords']))
logs=run(['docker','logs',cid]);(out/'docker.log').write_bytes(logs.stdout+logs.stderr)
records=[]
for p in sorted(out.iterdir()):
 p.chmod(0o400);records.append({'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size,'mode':'0400'})
(out/'manifest.json').write_text(json.dumps({'saved_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source_receipts':0,'pending_receipt_relation_absent':True,'records':records},indent=2))
stop=run(['docker','stop','--time','10',cid]);remove=run(['docker','rm',cid])
check=subprocess.run(['docker','inspect',cid],capture_output=True)
assert check.returncode!=0
(r/'cleanup.json').write_text(json.dumps({'completed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'owned_tag':tag,'container_id':cid,'saved_manifest':str(out/'manifest.json'),'stop_exit':stop.returncode,'remove_exit':remove.returncode,'container_absent':True,'source_receipts':0,'worker_started':False},indent=2))
print('Saved nine whole projects and three owned databases; zero source receipts. Label-verified owned container stopped and removed.')
