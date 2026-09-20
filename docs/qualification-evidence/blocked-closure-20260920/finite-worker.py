"""One counted public invocation; no scheduler/retry customization."""
from pathlib import Path
import subprocess,sys
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/blocked-closure-4b22b46-20260920');e=Path(__file__).resolve().parent
case,label,*extra=sys.argv[1:];assert case in ['r0','r1'];assert extra in [[],['--omit-writer']]
args=['python3',str(e/'run-public.py'),case,label,*extra,'worker','run','--supervised','--once','--yes','--config','synapsor.actions.runner.json','--capability','release.seal_candidate','--identity','recovery_operator','--identity-key',str(r/'operational'/case/'operator-private/recovery.pem')]
p=subprocess.run(args);raise SystemExit(p.returncode)
