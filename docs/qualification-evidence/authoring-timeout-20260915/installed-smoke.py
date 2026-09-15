from pathlib import Path
import os,sys,json,subprocess,pty,select,time,datetime,hashlib
os.umask(0o077)
repo=Path(__file__).resolve().parents[3];e=Path(__file__).resolve().parent
owned=Path(json.loads((e/'assignment-plan.json').read_text())['owned_root']);frozen=owned/'frozen'
manifest=json.loads((frozen/'installed-artifact-manifest.json').read_text())
cli=frozen/'installed/node_modules/@synapsor/runner/dist/cli.js'
root=owned/'installed-smoke-attempt3';root.mkdir()
for name in ['home','tmp','var-tmp']:(root/name).mkdir()
base=['bwrap','--ro-bind','/','/','--bind',str(root),str(root),'--bind',str(root/'tmp'),'/tmp','--bind',str(root/'var-tmp'),'/var/tmp','--unshare-user','--unshare-net','--unshare-ipc','--cap-drop','ALL','--die-with-parent','--proc','/proc','--dev','/dev','--clearenv','--setenv','PATH',os.environ['PATH'],'--setenv','HOME',str(root/'home'),'--setenv','NO_COLOR','1','--setenv','TERM','xterm-256color','--setenv','DATABASE_URL','postgres://fixture:fixture@127.0.0.1:1/unused','--chdir',str(root),'--','node',str(cli)]
remaining='--remaining-onboard' in sys.argv
results=json.loads((e/'installed-smoke-start-results.json').read_text()) if remaining else []
for route in ([['onboard','db']] if remaining else [['start'],['onboard','db']]):
 args=route+['--help'];r=subprocess.run(base+args,capture_output=True,text=True,timeout=30)
 name='-'.join(route)+'-help';(root/(name+'.log')).write_text(r.stdout+r.stderr)
 assert r.returncode==0
 if route==['start']:assert 'Authoring defaults' in r.stdout and '120 seconds for every provider' in r.stdout
 else:assert 'Same current Boundary route as start' in r.stdout and 'onboard db --project-root . --cli' in r.stdout
 results.append({'args':args,'exit_code':r.returncode,'verified':'packaged Start detailed timeout help' if route==['start'] else 'packaged onboard summary points to same current Start route; does not repeat timeout details'})
 for raw in ['0','601','1.5','not-a-number']:
  project=root/('-'.join(route)+'-'+raw);project.mkdir()
  args=route+['--project-root',str(project),'--cli','--timeout',raw]
  master,slave=pty.openpty();child=subprocess.Popen(base+args,stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave)
  data=b'';deadline=time.monotonic()+30
  try:
   while True:
    if time.monotonic()>deadline:child.kill();raise AssertionError('installed invalid-argument command hung')
    ready,_,_=select.select([master],[],[],0.1)
    if ready:
     try:chunk=os.read(master,65536)
     except OSError:break
     if not chunk:break
     data+=chunk
    elif child.poll() is not None:break
   code=child.wait(timeout=5)
  finally:os.close(master)
  text=data.decode(errors='replace');name='-'.join(route)+'-'+raw;(root/(name+'.log')).write_text(text)
  assert code==1,(args,code,text)
  assert 'whole number from 1 through 600' in text,text
  assert list(project.iterdir())==[], 'Invalid timeout changed the new project before refusal'
  results.append({'args':args,'exit_code':code,'verified':'invalid authoring timeout refused before inspection/save','project_unchanged':True})
record={'completed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'artifact_tree_sha256':manifest['installed_tree_sha256'],'harness_attempts':3,'provider_calls':0,'source_database_opened':False,'network':'unshared','result':'PASS','scope':'installed public help and invalid-value diagnostics only; positive transport propagation is composed-test evidence, not a live model run','checks':results}
(e/'installed-smoke-result.json').write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(record))
