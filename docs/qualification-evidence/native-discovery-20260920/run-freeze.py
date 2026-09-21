from pathlib import Path
import os,subprocess,json
os.umask(0o077)
repo=Path(__file__).resolve().parents[3];e=Path(__file__).resolve().parent
owned=Path("/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/native-discovery-3d02c0b-20260920")
frozen=owned/'frozen';frozen.mkdir(exist_ok=True)
(frozen/'freeze-repair.mjs').write_bytes((e/'freeze-repair.mjs').read_bytes())
(frozen/'product-revision.json').write_bytes((e/'product-revision.json').read_bytes())
args=['bwrap','--ro-bind','/','/','--bind',str(repo),str(repo),'--bind',str(owned),str(owned),'--bind',str(owned/'package-tmp'),'/tmp','--bind',str(owned/'package-var-tmp'),'/var/tmp','--unshare-user','--unshare-net','--unshare-ipc','--cap-drop','ALL','--die-with-parent','--proc','/proc','--dev','/dev','--clearenv','--setenv','NO_COLOR','1','--setenv','PATH',os.environ['PATH'],'--setenv','HOME',str(owned/'offline-home'),'--setenv','COREPACK_HOME','/home/sandesh-tiwari/.cache/node/corepack','--setenv','COREPACK_ENABLE_NETWORK','0','--setenv','npm_config_offline','true','--chdir',str(repo),'--','node',str(frozen/'freeze-repair.mjs'),'--install']
with (frozen/'freeze-command.log').open('w') as out:r=subprocess.run(args,stdout=out,stderr=subprocess.STDOUT,timeout=1200)
print(r.returncode);print((frozen/'freeze-command.log').read_text()[-5000:])
# Separate untouched-start preparation is recorded by this assignment.
raise SystemExit(r.returncode)
