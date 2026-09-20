"""Prepared exact public gestures; terminal-session sends only at matching observed frames."""
from pathlib import Path
import sys,json
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/mcp-replay-7be8d2a-20260920');e=Path(__file__).resolve().parent
case,label,phase=sys.argv[1:];assert case in ['r0','r1','t0','t1'];assert phase in ['read','activate','administrator','execution']
p=r/'operational'/case/('terminal-'+label)/'commands.jsonl';assert p.exists() and not p.read_text()
commands=json.loads((e/('gestures-'+phase+'.json')).read_text());p.write_text(''.join(json.dumps(c)+'\n' for c in commands))
