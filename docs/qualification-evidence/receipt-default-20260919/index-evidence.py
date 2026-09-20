"""Index public-verification evidence without copying credentials or fixture rows to Git."""
from pathlib import Path
import hashlib,json,stat
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-default-feecc2b-20260919');e=Path(__file__).resolve().parent
files=set()
for pat in ['*-exit.json','*.log','before-results.json','fixture-identity.json','originals.json','preservation-final.json','cleanup.json','backup-verification.json','public/*/terminal-*.log','public/*/pty-*.log','public/*/schedule-*.json','public/*/preflight-*.json','public/*/exit-*.json','public/*/*.txt','public/*/inspection-*.json','public/*/comparison-*.json','public/*/assessment-*.json','public/*/state-*/manifest.json','saved-starts/manifest.json','saved-final/manifest.json','frozen/installed-artifact-manifest.json','frozen/installed-dependency-tree.json','frozen/product-revision.json','frozen/*-command.log','offline/*.log']:
 files.update(p for p in r.glob(pat) if p.is_file())
records=[{'path':str(p.relative_to(r)),'bytes':p.stat().st_size,'mode':oct(stat.S_IMODE(p.stat().st_mode)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(files)]
result={'raw_root':str(r),'provider_calls':0,'independent_acceptance':'PENDING','records':records,'excluded':'private credentials, working HOME/temp directories, restored project contents; full owned archives and database dumps are indexed by saved-final/manifest.json'}
(e/'EVIDENCE-INDEX.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'indexed_files':len(records),'raw_root':str(r)}))
