"""Bounded local checks; originals read-only, only this worktree and owned logs writable."""
from pathlib import Path
import os, subprocess, sys, json, datetime, signal
os.umask(0o077)
repo=Path(__file__).resolve().parents[3]
owned=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/finding9-counter-454a0d2-20260913')
name=sys.argv[1]; command=sys.argv[2:]
assert name and '/' not in name and command
base=['bwrap','--ro-bind','/','/','--bind',str(repo),str(repo),'--bind',str(owned),str(owned),'--bind',str(owned/'tmp'),'/tmp','--bind',str(owned/'var-tmp'),'/var/tmp','--unshare-user','--unshare-net','--unshare-ipc','--cap-drop','ALL','--die-with-parent','--proc','/proc','--dev','/dev','--clearenv','--setenv','PATH',os.environ['PATH'],'--setenv','HOME',str(owned/'offline-home'),'--setenv','COREPACK_HOME','/home/sandesh-tiwari/.cache/node/corepack','--setenv','COREPACK_ENABLE_NETWORK','0','--setenv','npm_config_offline','true','--setenv','VERIFY_PACKED_RUNNER_USE_LOCAL_SPEC','1','--setenv','NO_COLOR','1','--chdir',str(repo),'--']
entry={'command':command,'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'network':'unshared namespace','originals':'read-only root; worktree and owned evidence writable','timeout_seconds':1800}
with (owned/'logs'/f'{name}.log').open('x') as log:
 p=subprocess.Popen(base+command,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
 try: code=p.wait(timeout=1800)
 except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGTERM);code=p.wait(timeout=20);entry['timed_out']=True
entry.update(exit_code=code,completed_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
(owned/'logs'/f'{name}.json').write_text(json.dumps(entry,indent=2)+'\n')
print(json.dumps(entry));raise SystemExit(code)
