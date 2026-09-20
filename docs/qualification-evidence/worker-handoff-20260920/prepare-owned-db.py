from pathlib import Path
import os,json,subprocess,secrets,time
os.umask(0o077)
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/worker-handoff-63aa664-20260920');tag='worker-handoff-63aa664-20260920'
assert not (r/'database-private.json').exists()
def run(args,**kw):return subprocess.run(args,capture_output=True,check=True,**kw)
run(['docker','image','inspect','postgres:17']);password=secrets.token_hex(24)
cid=run(['docker','run','-d','--name',tag,'--label','synapsor.task='+tag,'--cpus','2','--memory','1g','-e','POSTGRES_PASSWORD='+password,'-p','127.0.0.1::5432','postgres:17']).stdout.decode().strip()
for _ in range(100):
 check=subprocess.run(['docker','exec',cid,'pg_isready','-h','127.0.0.1','-U','postgres'],capture_output=True)
 if check.returncode==0:break
 time.sleep(.2)
else:raise RuntimeError('owned database not ready')
port=json.loads(run(['docker','inspect',cid]).stdout)[0]['NetworkSettings']['Ports']['5432/tcp'][0]['HostPort']
run(['docker','exec',cid,'createdb','-U','postgres','reviewgate'])
state={'tag':tag,'container':cid,'admin_url':f'postgres://postgres:{password}@127.0.0.1:{port}/reviewgate'}
(r/'database-private.json').write_text(json.dumps(state));(r/'postgres-tests-private.json').write_text(json.dumps(state));(r/'database-owned.json').write_text(json.dumps({'tag':tag,'container':cid,'image':'postgres:17','scope':'local task-owned reviewgate; fresh operational databases prepared separately','inherited_work':False},indent=2));print(json.dumps({'tag':tag,'container':cid,'database':'reviewgate','credential_values':'private only'}))
