"""Documented signed-key config, BEFORE disabled Action save and separate reviews.
No active record, binding, permission, source row or history is injected.
"""
from pathlib import Path
import json,os,subprocess,sys,hashlib,sqlite3
os.umask(0o077)
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/blocked-closure-4b22b46-20260920')
c=sys.argv[1];assert c in ['r0','r1','t0','t1'];d=r/'operational'/c;p=d/'project';private=d/'operator-private';assert not private.exists();assert not (p/'synapsor.actions.runner.json').exists()
f=p/'synapsor.runner.json';before=f.read_bytes();config=json.loads(before);assert not config.get('operator_identity')
db=p/'.synapsor/local.db'
if db.exists():
 conn=sqlite3.connect('file:'+str(db)+'?mode=ro',uri=True)
 tables=[x[0] for x in conn.execute("select name from sqlite_master where type='table'")]
 if 'control_policy_active' in tables:assert conn.execute("select count(*) from control_policy_active where kind in ('read','action','execution')").fetchone()[0]==0
 if 'proposals' in tables:assert conn.execute('select count(*) from proposals').fetchone()[0]==0
 conn.close()
private.mkdir(mode=0o700);(p/'operators').mkdir(mode=0o700)
subprocess.run(['openssl','genpkey','-algorithm','RSA','-pkeyopt','rsa_keygen_bits:2048','-out',str(private/'recovery.pem')],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
subprocess.run(['openssl','pkey','-in',str(private/'recovery.pem'),'-pubout','-out',str(p/'operators/recovery.pub.pem')],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
config['operator_identity']={'provider':'signed_key','apply_roles':['recovery_operator'],'operators':{'recovery_operator':{'public_key_path':'./operators/recovery.pub.pem','roles':['recovery_operator']}}}
f.write_text(json.dumps(config,indent=2)+'\n')
(d/'operator-configuration.json').write_text(json.dumps({'route':'documented signed operator key configuration on new unreviewed runtime config; followed by normal disabled drafting and separate public reviews','before_sha256':hashlib.sha256(before).hexdigest(),'after_sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'public_key_sha256':hashlib.sha256((p/'operators/recovery.pub.pem').read_bytes()).hexdigest(),'provider':'signed_key','private_key':'outside project, mode 0600; not passed to MCP or model','active_records_modified':False},indent=2))
print('Fresh signed operator configured before separate reviews; private key retained outside project.')
