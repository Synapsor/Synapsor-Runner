"""Derive the predeclared negative controls from one real public publication.
Only whole-directory restoration; no pointer, record, config or binding edits.
Run after all deployment CLI handles have closed normally.
"""
from pathlib import Path
import json,subprocess,shutil,os,hashlib,sqlite3
os.umask(0o077)
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/effect-continuation-f83209f-20260919')
s=r/'public/deployment/project';proof=json.loads((r/'public/deployment/inspection-post-publication.json').read_text())
assert proof['active']['authority']['action_boundary']['digest']=='sha256:92ee7d3c1c570fe4db81981d11438ff818448e04e59d775999b3cbf0950a8849'
assert not proof['execution']['enabled'];assert proof['receipt']['selection']['receipts']['authority']=='source_db';assert not proof['receipt']['selection_current']
# Exclusive lock proves the task has closed its local ledger clients before copying.
c=sqlite3.connect(s/'.synapsor/local.db',timeout=1);c.execute('begin exclusive');c.rollback();c.close()
f=r/'post-publication-controls';f.mkdir();archive=f/'published-before-setup.tgz'
subprocess.run(['tar','-czf',str(archive),'-C',str(s.parent),'project'],check=True)
records=[]
for name in ['decline','pending']:
 d=r/'public'/name
 assert not (d/'project-before-publication-control').exists()
 (d/'project').rename(d/'project-before-publication-control')
 shutil.copytree(s,d/'project',symlinks=True)
 records.append({'case':name,'method':'whole-directory copy of genuine public post-publication state','earlier_project_retained':str(d/'project-before-publication-control'),'source_database':'pendinglab' if name=='pending' else 'releaselab'})
archive.chmod(0o400);(f/'manifest.json').write_text(json.dumps({'source_public_state':str(s),'source_state_evidence':str(r/'public/deployment/inspection-post-publication.json'),'archive_sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'controls':records},indent=2))
print('Restored two whole-project controls from the single recorded public publication; no records edited.')
