import hashlib,json,os,pathlib,subprocess,sys,time,signal
REPO=pathlib.Path(__file__).resolve().parents[3]
ROOT=pathlib.Path(os.environ.get('SYNAPSOR_READ_REPRO_ROOT','/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/blocked-closure-4b22b46-20260920')).resolve()
os.umask(0o077)
name=sys.argv[1]; command=sys.argv[2:]
for p in ['test-home','test-tmp','test-var-tmp']:(ROOT/p).mkdir(exist_ok=True)
env={'PATH':os.environ['PATH'],'HOME':str(ROOT/'test-home'),'NO_COLOR':'1','TMPDIR':'/var/tmp','NODE_NO_WARNINGS':'1','COREPACK_ENABLE_NETWORK':'0','COREPACK_HOME':'/home/sandesh-tiwari/.cache/node/corepack','TERM':'xterm','COLUMNS':'100','LINES':'30'}
args=['bwrap','--die-with-parent','--ro-bind','/','/','--bind',str(ROOT),str(ROOT),'--bind',str(ROOT/'test-tmp'),'/tmp','--bind',str(ROOT/'test-var-tmp'),'/var/tmp','--bind',str(REPO),str(REPO),'--proc','/proc','--dev','/dev','--chdir',str(REPO)]
def source_digest():
 files=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','apps','packages','scripts','package.json','pnpm-lock.yaml'],cwd=REPO,text=True).splitlines()
 return hashlib.sha256(json.dumps([(p,hashlib.sha256((REPO/p).read_bytes()).hexdigest()) for p in sorted(set(files)) if (REPO/p).is_file()]).encode()).hexdigest()
if name.startswith('postgres-'):
 db=json.loads((ROOT/'postgres-tests-private.json').read_text())
 from urllib.parse import urlparse
 u=urlparse(db['admin_url']);assert u.hostname=='127.0.0.1' and u.path=='/reviewgate'
 label=subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "synapsor.task"}}',db['container']],text=True).strip()
 assert label==db['tag']
 env['SYNAPSOR_TEST_POSTGRES_URL']=db['admin_url']
if name.endswith("-before"):env["SYNAPSOR_TEST_EVIDENCE_ROOT"]=str(ROOT)
start=time.time();before=source_digest()
record={'command':command,'start':start,'source_before':before,'credentials':'only owned SYNAPSOR_TEST_POSTGRES_URL' if name.startswith('postgres-') else 'absent','umask':'0077'}
(ROOT/(name+'-running.json')).write_text(json.dumps(record,indent=2))
with (ROOT/(name+'.log')).open('x') as log:
 p=subprocess.Popen(args+command,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
 record['pid']=p.pid;(ROOT/(name+'-running.json')).write_text(json.dumps(record,indent=2))
 try: result=p.wait(timeout=5400)
 except subprocess.TimeoutExpired:
  os.killpg(p.pid,signal.SIGTERM);p.wait(timeout=15);result=124
record.update(exit=result,seconds=time.time()-start,source_after=source_digest())
(ROOT/(name+'-exit.json')).write_text(json.dumps(record,indent=2));print(json.dumps(record))
# Propagate the recorded child outcome; older attempts recorded it correctly in
# JSON but accidentally returned Python's default zero to shell orchestration.
sys.exit(result if result >= 0 else 128 - result)
