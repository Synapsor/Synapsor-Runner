"""Verify preserved inputs, save task-owned state, then stop only owned containers."""
from pathlib import Path
import json, hashlib, subprocess, os, datetime, tarfile
os.umask(0o077)
R=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/scoped-read-recovery-515d260-20260919')
P=Path('/home/sandesh-tiwari/Desktop/Synapsor Tutorials/onboarding-ux-experiments-20260917/exp5-unseen-domain/REPRO-PACKAGE')
J=P.parent/'baseline-real-flow/project'
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
old=json.loads((R/'original-package-manifest.json').read_text())
now={str(p.relative_to(P)):{'sha256':digest(p),'mode':oct(p.stat().st_mode&0o777),'size':p.stat().st_size} for p in sorted(P.rglob('*')) if p.is_file()}
assert old==now,'Original reproduction package changed'
checkpoint=json.loads((R/'original-project-checkpoint-manifest.json').read_text())
current=[{'path':str(p.relative_to(J)),'mode':p.stat().st_mode&0o777,'sha256':digest(p)} for p in sorted(J.rglob('*')) if p.is_file()]
assert checkpoint['files']==current,'Original stopped project changed since recorded checkpoint'
closure=R/'closure';closure.mkdir(exist_ok=True)
preservation={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'package_files_unchanged':len(now),
    'original_project_files_unchanged':len(current),'original_project_checkpoint_note':checkpoint['note'],
    'original_package_manifest_sha256':digest(R/'original-package-manifest.json')}
for helper,name in [(R/'frozen/freeze-repair.mjs','candidate'),(R.parent/'authoring-correction-3c9dbf1-20260915/frozen/freeze-repair.mjs','previous')]:
    result=subprocess.run(['node',str(helper),'--verify'],capture_output=True,text=True)
    (closure/(name+'-verification.log')).write_text(result.stdout+result.stderr)
    assert result.returncode==0, name+' installation changed'
    preservation[name]=json.loads(result.stdout.strip())
(closure/'preservation.json').write_text(json.dumps(preservation,indent=2))
archive=closure/'public-projects-and-records.tar.gz';assert not archive.exists()
with tarfile.open(archive,'w:gz') as t:
    for name in ['development-j6','final-fresh','final-reopen','final-resume']:
        folder=R/'public'/name;t.add(folder/'project',arcname=name+'/project')
        for p in folder.iterdir():
            if p.is_file():t.add(p,arcname=name+'/'+p.name)
containers=[]
main=json.loads((R/'database-private.json').read_text())
for cid,tag,databases in [(main['container'],main['tag'],['refundlab','j6_recovery']),('5f5bc075edad670cc2387e40c310ef6b53e1a2cebe5397c65c08b1ed1bb8f157',None,[])]:
    info=json.loads(subprocess.check_output(['docker','inspect',cid],text=True))[0]
    actual=info['Config']['Labels'].get('synapsor.task')
    assert actual and actual.startswith('j5j6-') and (tag is None or actual==tag),'Not task-owned'
    assert info['Name'].lstrip('/')==actual,'Ownership/name mismatch'
    log=subprocess.run(['docker','logs',cid],capture_output=True)
    (closure/(actual+'-container.log')).write_bytes(log.stdout+log.stderr)
    dumps=[]
    for database in databases:
        target=closure/(database+'.sql');assert not target.exists()
        with target.open('wb') as f:subprocess.run(['docker','exec',cid,'pg_dump','-U','postgres','-d',database],stdout=f,check=True)
        dumps.append({'file':str(target),'sha256':digest(target)})
    # No removal: stopped container state remains available for inspection.
    subprocess.run(['docker','stop',cid],check=True,capture_output=True)
    state=subprocess.check_output(['docker','inspect','--format','{{.State.Running}}',cid],text=True).strip()
    assert state=='false'
    containers.append({'id':cid,'name':actual,'owned_label':actual,'running':False,'dumps':dumps,'removed':False})
(closure/'resources.json').write_text(json.dumps({'containers':containers,'public_archive':str(archive),'public_archive_sha256':digest(archive)},indent=2))
print(json.dumps({'preservation':str(closure/'preservation.json'),'resources':str(closure/'resources.json'),'owned_containers_stopped':len(containers)}))
