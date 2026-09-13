from pathlib import Path
import json, os, subprocess, datetime
os.umask(0o077)
E=Path(__file__).resolve().parent;repo=E.parents[2];O=Path(json.loads((E/'assignment-plan.json').read_text())['owned_root']);F=O/'development-frozen'
args=['bwrap','--ro-bind','/','/','--bind',str(O),str(O),'--bind',str(O/'package-tmp'),'/tmp','--bind',str(O/'package-var-tmp'),'/var/tmp','--unshare-user','--unshare-net','--unshare-ipc','--cap-drop','ALL','--die-with-parent','--proc','/proc','--dev','/dev','--clearenv','--setenv','NO_COLOR','1','--setenv','PATH',os.environ['PATH'],'--setenv','HOME',str(O/'offline-home'),'--setenv','COREPACK_HOME','/home/sandesh-tiwari/.cache/node/corepack','--setenv','COREPACK_ENABLE_NETWORK','0','--setenv','npm_config_offline','true','--chdir',str(repo),'--','node',str(F/'freeze-repair.mjs'),'--install','--development']
start=datetime.datetime.now(datetime.timezone.utc).isoformat()
with (F/'freeze-command.log').open('x') as log:r=subprocess.run(args,stdout=log,stderr=subprocess.STDOUT,timeout=600)
(E/'development-freeze-exit.json').write_text(json.dumps({'started_at':start,'completed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exit':r.returncode,'log':str(F/'freeze-command.log'),'classification':'development installation only, not stable qualification'},indent=2)+'\n')
print((F/'freeze-command.log').read_text()[-2500:]);raise SystemExit(r.returncode)
