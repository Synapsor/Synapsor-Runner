"""Read-only verification of originals and current candidate before owned cleanup."""
from pathlib import Path
import json,hashlib,stat,os,subprocess,datetime
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/mcp-replay-7be8d2a-20260920')
old=r.parent/'blocked-closure-4b22b46-20260920';review=Path('/home/sandesh-tiwari/Desktop/Synapsor Tutorials/test-1.8.0/recovery-independent-final-review-20260920')
def h(p):return hashlib.sha256(p.read_bytes()).hexdigest()
records=[]
expected=[(old/'frozen/installed-artifact-manifest.json','770a356f7af23a8a010b4129e2a75ed7a07040b637aab9ee9cc2eff4bb6bcca0'),(old/'sealed-starts/manifest.json','479a3117daf3fe0e64cc6a6b436babc7a51f14c68265842f2988a2c0da7e7744'),(review/'captures/t1-first-request.json','bdac9528c3d36324961c95f31a5294bebc2bac66e59f1db4a96d536e3cf083d9'),(review/'captures/t1-old-reference-replay.json','2455368314db7a48ebb6c81b32adeb49e8a680fd2d15ad7a3a8f4d2033ad5a7b'),(review/'MCP-REPLAY-FINDING.md','737c06e8e2343fd4cc62c80c74d1632d5c11879480ee1b66e2b3f52194764c4b'),(review/'REVIEW.md','262c802a2d3ade722d7ae99b7821b8c1df5862f1cb71a0d3635c83f43780be32'),(review/'final-states/manifest.json','a1be26d0a94c94d4233a2c1ded7de32c1acea5961cd496ef964ee2d81f1612fc')]
for p,sha in expected:
 assert h(p)==sha,str(p);records.append({'path':str(p),'sha256':sha})
root=old/'sealed-starts';baseline=json.loads((root/'manifest.json').read_text());actual=[]
for p in sorted(root.rglob('*')):
 if p==root/'manifest.json':continue
 item={'path':str(p.relative_to(root)),'mode':stat.S_IMODE(p.lstat().st_mode)}
 if p.is_symlink():item.update(kind='symlink',target=os.readlink(p))
 elif p.is_dir():item.update(kind='directory')
 else:item.update(kind='file',bytes=p.stat().st_size,sha256=h(p))
 actual.append(item)
assert actual==baseline['files']
installations=[]
for f in [old/'frozen',r/'frozen']:
 installations.append(json.loads(subprocess.check_output(['node',str(f/'freeze-repair.mjs'),'--verify'],text=True)))
m=json.loads((r/'frozen/preflight/manifest.json').read_text())
for x in m['records']:
 p=r/'frozen/preflight'/x['path'];assert h(p)==x['sha256'] and stat.S_IMODE(p.stat().st_mode)==x['mode']
assert h(Path(m['node_executable']))==m['node_sha256']
result={'verified_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'original_files':records,'old_sealed_entries':len(actual),'old_seals_bidirectionally_unchanged':True,'installations':installations,'standalone_preflight_unchanged':True}
out=r/'preservation-final.json';assert not out.exists();out.write_text(json.dumps(result,indent=2));print(json.dumps({'original_files':len(records),'old_sealed_entries':len(actual),'installations':installations,'result':'unchanged'}))
