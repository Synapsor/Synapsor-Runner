"""Save only task-owned state; verify originals before stopping the owned container."""
from pathlib import Path
import json,hashlib,os,subprocess,stat,datetime
os.umask(0o077)
R=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/public-operation-3eb09c4-20260919')
def read(p):return json.loads(p.read_text())
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def verify_files(root,items,typed=False):
    for rel,v in items.items():
        p=root/rel;s=p.lstat();mode=int(v['mode'],0)if isinstance(v['mode'],str)else v['mode']
        assert stat.S_IMODE(s.st_mode)==mode,str(p)+' mode'
        if 'sha256'in v:assert sha(p)==v['sha256'],str(p)+' content'
        if v.get('type')=='fifo':assert stat.S_ISFIFO(s.st_mode)
    return len(items)
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'originals':{}}
ind=Path('/home/sandesh-tiwari/Desktop/Synapsor Tutorials/independent-verification-20260919')
out['originals']['independent_evidence_files']=verify_files(ind,read(R/'independent-evidence-before.json'))
tourn=Path('/home/sandesh-tiwari/Desktop/Synapsor Tutorials/onboarding-ux-experiments-20260917/tourn-project')
out['originals']['tournament_files']=verify_files(tourn,read(R/'tournament-original-before.json'))
archive=read(R/'software-archive-before.json');assert sha(Path(archive['path']))==archive['sha256'];out['originals']['software_archive_sha256']=archive['sha256']
out['reviewer_starts']={}
for n,v in read(R/'reviewer-starts-before.json').items():out['reviewer_starts'][n]=verify_files(R/'public'/n/'project',v['files'])
out['reviewer_starts']['tournament-reviewer']=verify_files(R/'public/tournament-reviewer/project',read(R/'tournament-reviewer-start.json')['files'],True)
for name,d in [('old',R.parent/'scoped-read-recovery-515d260-20260919/frozen'),('new',R/'frozen')]:
    p=subprocess.run(['node',str(d/'freeze-repair.mjs'),'--verify'],capture_output=True,text=True,check=True)
    (R/(name+'-installation-after.log')).write_text(p.stdout+p.stderr);out[name+'_installation']=json.loads(p.stdout)
saved=R/'saved-state';saved.mkdir(exist_ok=True)
db=read(R/'database-private.json');cid=db['container']
assert subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "synapsor.task"}}',cid],text=True).strip()==db['tag']
out['database_dumps']={}
for n in ['refundlab','releaselab','tournamentlab']:
    p=saved/(n+'.dump');assert not p.exists()
    with p.open('wb')as f:subprocess.run(['docker','exec',cid,'pg_dump','-U','postgres','-Fc',n],stdout=f,check=True)
    out['database_dumps'][n]={'path':str(p),'sha256':sha(p),'bytes':p.stat().st_size}
with (saved/'roles.sql').open('wb')as f:subprocess.run(['docker','exec',cid,'pg_dumpall','-U','postgres','--roles-only','--no-role-passwords'],stdout=f,check=True)
out['project_archives']={}
for n in ['removal-final','optional-final','software-final-read','tournament-final-catalog','runtime-primary','runtime-secondary','m4-final-action','m4-final-w','software-reviewer','removal-reviewer','tournament-reviewer']:
    p=saved/(n+'.tgz');assert not p.exists()
    subprocess.run(['tar','-czf',str(p),'-C',str(R/'public'/n),'project'],check=True)
    p.chmod(0o400);out['project_archives'][n]={'path':str(p),'sha256':sha(p),'bytes':p.stat().st_size}
(R/'preservation-and-saved-state.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps({'originals':'verified unchanged','old_and_new_installations':'verified unchanged','reviewer_starts':out['reviewer_starts'],'database_dumps':list(out['database_dumps']),'project_archives':len(out['project_archives']),'container_stop':'not yet executed'}))
