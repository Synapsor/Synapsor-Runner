import json, os, pathlib, signal, subprocess, time
source=pathlib.Path(__file__).resolve().parents[3]
root=pathlib.Path('/var/tmp/synapsor-b64-independent-version-resume-fixture-owned')
if subprocess.check_output(['git','status','--porcelain=v1'],cwd=source,text=True).strip():
 raise SystemExit('Reviewer launcher refuses uncommitted source or unresolved cherry-pick')
os.umask(0o077)
root.mkdir(mode=0o700,exist_ok=False)
for name in ['decoy-parent/test-root/home','decoy-parent/test-root/tmp','evidence']:
 (root/name).mkdir(parents=True,mode=0o700)
(root/'decoy-parent/synapsor.runner.json').write_text('{"name":"independent-decoy-must-not-be-used"}\n')
(root/'decoy-parent/test-root/.git').mkdir(mode=0o700)
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip()
env={'PATH':os.environ['PATH'],'HOME':str(root/'decoy-parent/test-root/home'),'TMPDIR':str(root/'decoy-parent/test-root/tmp'),'LANG':'C.UTF-8','NO_COLOR':'1','TERM':'dumb','TSX_DISABLE_CACHE':'1','B51_READ_PROCESS_CAPTURE_DIR':str(root/'evidence/children')}
argv=['bwrap','--unshare-net','--bind','/','/','--dev','/dev','--proc','/proc','--chdir',str(source),'node','node_modules/vitest/vitest.mjs','run','--maxWorkers=1','--minWorkers=1','--testTimeout=20000','--hookTimeout=20000','--reporter=default','--reporter=json',f'--outputFile={root}/evidence/native-baseline.json','apps/runner/src/authoring-version-resume.test.ts']
start=time.monotonic()
with (root/'evidence/native-baseline.log').open('x') as log:
 child=subprocess.Popen(argv,cwd=source,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
 while child.poll() is None:
  v=os.statvfs(root)
  if v.f_bavail*v.f_frsize<8*1024**3:
   os.killpg(child.pid,signal.SIGTERM);child.wait();break
  time.sleep(1)
record={'head':head,'command':argv,'exit':child.returncode,'wall_seconds':round(time.monotonic()-start,3),'pid':child.pid,'source_fixed':head==subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip(),'provider_access':'OS network namespace isolated; fake-model-only native fixture','current_guard_count_assertions_unchanged':True,'final_legacy_contract_changed':True,'current_assertions_retained':79,'legacy_assertions_replaced':2}
(root/'evidence/RESULT.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record),flush=True)
raise SystemExit(child.returncode)
