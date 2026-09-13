from pathlib import Path
import json,hashlib,os
os.umask(0o077)
e=Path(__file__).resolve().parent;plan=json.loads((e/'assignment-plan.json').read_text());owned=Path(plan['owned_root']);runtime=owned/'runtime';runtime.mkdir(exist_ok=True)
files=['runtime-driver.mjs','storage-preflight.mjs','a1-identical.mjs','a2-insurer.mjs','a2-overall.mjs','a3-collections.mjs','a4-contexts.mjs','operator-cli.mjs','prepare-edit.mjs','a5-publication-edit.mjs','check-installed-context.mjs']
records=[]
for name in files:
 b=(e/name).read_bytes();p=runtime/name
 with p.open('xb') as out:out.write(b)
 records.append({'name':name,'sha256':hashlib.sha256(b).hexdigest()})
(runtime/'node_modules').symlink_to(owned/'frozen/installed/node_modules',target_is_directory=True)
(e/'runtime-harness-install.json').write_text(json.dumps({'owned':str(runtime),'sources':records,'dependencies':'new complete immutable installed artifact only'},indent=2)+'\n')
