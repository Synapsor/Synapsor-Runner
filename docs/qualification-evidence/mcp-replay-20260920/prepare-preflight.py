"""Freeze the existing read-only store resolver and preflight, without workspace runtime imports."""
from pathlib import Path
import hashlib,json,os,subprocess
os.umask(0o077)
e=Path(__file__).resolve().parent;repo=e.parents[2]
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/mcp-replay-7be8d2a-20260920')
d=r/'frozen/preflight';d.mkdir()
source=repo/'apps/runner/src/project-resolution.ts';compiled=repo/'apps/runner/dist/project-resolution.js'
assert all('"node:' in x for x in compiled.read_text().splitlines() if x.startswith('import '))
(d/'project-resolution.mjs').write_bytes(compiled.read_bytes())
s=(e/'public-preflight.mts').read_text().replace("'../../../apps/runner/src/project-resolution.js'","'./project-resolution.mjs'").replace('process.argv[2]!','process.argv[2]')
(d/'public-preflight.mjs').write_text(s)
node=Path(subprocess.check_output(['node','-p','process.execPath'],text=True).strip())
records=[]
for p in sorted(d.iterdir()):
 p.chmod(0o400);records.append({'path':p.name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'mode':0o400})
m={'source_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),'source_file':str(source),'source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'compiled_file':str(compiled),'compiled_sha256':hashlib.sha256(compiled.read_bytes()).hexdigest(),'node_executable':str(node),'node_sha256':hashlib.sha256(node.read_bytes()).hexdigest(),'imports':'only node: builtins; no tsx/workspace dependency at execution','records':records}
(d/'manifest.json').write_text(json.dumps(m,indent=2));(d/'manifest.json').chmod(0o400);d.chmod(0o500)
print(json.dumps(m,indent=2))
