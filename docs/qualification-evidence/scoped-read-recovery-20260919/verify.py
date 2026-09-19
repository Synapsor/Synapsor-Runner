import hashlib,json,os,pathlib,subprocess,sys,time,signal
REPO=pathlib.Path(__file__).resolve().parents[3]
ROOT=pathlib.Path(os.environ.get('SYNAPSOR_READ_REPRO_ROOT','/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/scoped-read-recovery-515d260-20260919')).resolve()
os.umask(0o077)
name=sys.argv[1]; command=sys.argv[2:]
for p in ['test-home','test-tmp','test-var-tmp']:(ROOT/p).mkdir(exist_ok=True)
env={'PATH':os.environ['PATH'],'HOME':str(ROOT/'test-home'),'NO_COLOR':'1','TMPDIR':'/var/tmp','NODE_NO_WARNINGS':'1','COREPACK_ENABLE_NETWORK':'0','COREPACK_HOME':'/home/sandesh-tiwari/.cache/node/corepack','TERM':'xterm','COLUMNS':'100','LINES':'30'}
args=['bwrap','--die-with-parent','--ro-bind','/','/','--bind',str(ROOT),str(ROOT),'--bind',str(ROOT/'test-tmp'),'/tmp','--bind',str(ROOT/'test-var-tmp'),'/var/tmp','--bind',str(REPO),str(REPO),'--proc','/proc','--dev','/dev','--chdir',str(REPO)]
if name.startswith('nullable-catalog-hypothesis'):
 args+=['--ro-bind',str(ROOT/'hypothesis/boundary-review-mutation.ts'),str(REPO/'apps/runner/src/boundary-review-mutation.ts')]
if name=='nullable-catalog-hypothesis02':
 args+=['--ro-bind',str(ROOT/'hypothesis/boundary-cli.test.ts'),str(REPO/'apps/runner/src/boundary-cli.test.ts')]
if name=='nullable-terminal-trace':
 args+=['--ro-bind',str(ROOT/'hypothesis/boundary-cli-trace.test.ts'),str(REPO/'apps/runner/src/boundary-cli.test.ts')]
if name=='nullable-catalog-correction03':
 args+=['--ro-bind',str(ROOT/'hypothesis/boundary-review-mutation03.ts'),str(REPO/'apps/runner/src/boundary-review-mutation.ts')]
if name=='nullable-preexisting-fresh-control':
 args+=['--ro-bind',str(ROOT/'hypothesis/boundary-cli.test.ts'),str(REPO/'apps/runner/src/boundary-cli.test.ts')]
if name in ['nullable-baseline','nullable-preexisting-fresh-control']:
 files=subprocess.check_output(['git','diff','--name-only','515d260','HEAD','--','apps/runner/src'],cwd=REPO,text=True).splitlines()
 for rel in files:
  if not rel.endswith('.ts') or '.test.' in rel:continue
  target=ROOT/'baseline-complete-overlay'/rel;target.parent.mkdir(parents=True,exist_ok=True)
  target.write_bytes(subprocess.check_output(['git','show','515d260:'+rel],cwd=REPO));args+=['--ro-bind',str(target),str(REPO/rel)]
if name.endswith('-before'):
 for rel in ['apps/runner/src/read-relationship-review.ts','apps/runner/src/boundary-authoring-resume.ts','apps/runner/src/boundary-commands.ts']:
  target=ROOT/'baseline-overlay'/rel;target.parent.mkdir(parents=True,exist_ok=True)
  target.write_bytes(subprocess.check_output(['git','show','515d260:'+rel],cwd=REPO));args+=['--ro-bind',str(target),str(REPO/rel)]
def source_digest():
 files=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','apps','packages','scripts','package.json','pnpm-lock.yaml'],cwd=REPO,text=True).splitlines()
 return hashlib.sha256(json.dumps([(p,hashlib.sha256((REPO/p).read_bytes()).hexdigest()) for p in sorted(set(files)) if (REPO/p).is_file()]).encode()).hexdigest()
if name.startswith('postgres-'):
 db=json.loads((ROOT/'database-private.json').read_text())
 from urllib.parse import urlparse
 u=urlparse(db['admin_url']);assert u.hostname=='127.0.0.1' and u.path=='/refundlab'
 label=subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "synapsor.task"}}',db['container']],text=True).strip()
 assert label==db['tag']
 env['SYNAPSOR_TEST_POSTGRES_URL']=db['admin_url']
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
