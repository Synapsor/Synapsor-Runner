from pathlib import Path
import os,json,subprocess,datetime,re
os.umask(0o077)
e=Path(__file__).resolve().parent
owned=Path(json.loads((e/'assignment-plan.json').read_text())['owned_root']);frozen=owned/'frozen'
manifest=json.loads((frozen/'installed-artifact-manifest.json').read_text())
root=owned/'installed-smoke';root.mkdir()
for name in ['home','tmp','var-tmp']:(root/name).mkdir()
cli=frozen/'installed/node_modules/@synapsor/runner/dist/cli.js'
base=['bwrap','--ro-bind','/','/','--bind',str(root),str(root),'--bind',str(root/'tmp'),'/tmp','--bind',str(root/'var-tmp'),'/var/tmp','--unshare-user','--unshare-net','--unshare-ipc','--cap-drop','ALL','--die-with-parent','--proc','/proc','--dev','/dev','--clearenv','--setenv','PATH',os.environ['PATH'],'--setenv','HOME',str(root/'home'),'--setenv','NO_COLOR','1','--setenv','TERM','xterm-256color','--chdir',str(root),'--','node',str(cli)]
checks=[]
for route in [['start'],['onboard','db'],['try','ask']]:
 args=route+['--help'];r=subprocess.run(base+args,capture_output=True,text=True,timeout=30)
 (root/('-'.join(route)+'.log')).write_text(r.stdout+r.stderr);assert r.returncode==0
 if route==['start']:assert '--timeout <seconds>' in r.stdout
 checks.append({'args':args,'exit_code':r.returncode})
bundle=(cli.parent/'runner.mjs').read_text()
values={}
for name, expected in {'MAX_PROVIDER_CONTINUATION_BYTES':524288,'MAX_TOOL_ARGUMENT_BYTES':131072,'MAX_PROVIDER_REQUEST_BYTES':1048576,'MAX_PROVIDER_RESPONSE_BYTES':1048576,'MAX_TOOL_CALLS_PER_RESPONSE':4,'MAX_TOOL_CALLS_PER_TURN':8,'MAX_TOOL_ITERATIONS':6,'MAX_AUTHORING_TOOL_ITERATIONS':12,'MAX_AUTHORING_TOOL_CALLS_PER_TURN':24}.items():
 m=re.search(r'var '+name+r' = ([0-9_ *]+);',bundle);assert m,(name,'constant missing from installed bundle')
 value=1
 for part in m[1].replace('_','').split('*'):value*=int(part.strip())
 assert value==expected,(name,value);values[name]=value
assert 'authoringRequestTimeoutSeconds()' in bundle
record={'completed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'artifact_tree_sha256':manifest['installed_tree_sha256'],'result':'PASS','scope':'actual installed help commands and installed byte/constant inspection; transport behavior is source regression evidence, no live cross-vendor journey','provider_calls':0,'database_opened':False,'checks':checks,'installed_constants':values}
(e/'installed-smoke-result.json').write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(record))
