from pathlib import Path
import sys,subprocess,json,datetime,os,re
os.umask(0o077)
e=Path(__file__).resolve().parent;r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/blocked-closure-4b22b46-20260920')
case,label,*args=sys.argv[1:];assert case in ['r0','r1','t0','t1'] and re.fullmatch('[a-z0-9-]+',label)
d=r/'operational'/case;log=d/(label+'.log');assert not log.exists()
record={'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'args':args,'provider_calls':0}
with log.open('x') as out:
 p=subprocess.run(['python3',str(e/'public-launch.py'),case,*args],stdout=out,stderr=subprocess.STDOUT,timeout=120)
record.update(exit=p.returncode,finished_at=datetime.datetime.now(datetime.timezone.utc).isoformat());(d/(label+'-exit.json')).write_text(json.dumps(record,indent=2));print(json.dumps(record));sys.exit(p.returncode)
