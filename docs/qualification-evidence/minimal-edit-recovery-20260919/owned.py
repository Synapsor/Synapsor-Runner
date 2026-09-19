"""Run host-only evidence scripts in owned whole-directory isolation."""
import pathlib,json,subprocess,os,sys
os.umask(0o077);repo=pathlib.Path(__file__).resolve().parents[3];r=pathlib.Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/minimal-edit-bfc2f19-20260919');name=sys.argv[1];d=r/'public'/name;root=d/'project'
logical=str(pathlib.Path(json.loads((root/'.synapsor/control-policy/migration.json').read_text())['target']['path']).parents[1]);assert logical.endswith('/sw/project2')
db=json.loads((r/'database-private.json').read_text());assert subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "synapsor.task"}}',db['container']],text=True).strip()==db['tag']
env={'PATH':os.environ['PATH'],'HOME':str(d/'home'),'TMPDIR':'/var/tmp','NO_COLOR':'1','NODE_NO_WARNINGS':'1','DATABASE_URL':db['reader_url'],'EVIDENCE_ROOT':str(d)}
base=['bwrap','--die-with-parent','--ro-bind','/','/','--bind',str(d),str(d),'--bind',str(d/'tmp'),'/tmp','--bind',str(d/'var-tmp'),'/var/tmp','--bind',str(root),logical,'--proc','/proc','--dev','/dev','--chdir',logical]
pre=subprocess.run(base+[str(repo/'node_modules/.bin/tsx'),str(repo/'docs/qualification-evidence/scoped-read-recovery-20260919/public-preflight.mts'),logical,str(root)],capture_output=True,text=True,env=env);(d/'preflight.json').write_text(json.dumps({'exit':pre.returncode,'stdout':pre.stdout,'stderr':pre.stderr}));assert pre.returncode==0,pre.stderr
p=subprocess.run(base+[str(repo/'node_modules/.bin/tsx'),str(repo/sys.argv[2])]+sys.argv[3:],env=env);sys.exit(p.returncode)
