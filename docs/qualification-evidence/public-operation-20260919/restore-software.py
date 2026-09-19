"""Restore the recorded known software baseline into a separate owned database.
No runtime, writer, approvals or source effects are dispatched by this script.
"""
import pathlib,subprocess,json,secrets,os,hashlib
os.umask(0o077)
r=pathlib.Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/public-operation-3eb09c4-20260919');d=r/'software-restoration';db=json.loads((r/'database-private.json').read_text());cid=db['container'];assert subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "synapsor.task"}}',cid],text=True).strip()==db['tag']
def run(args,**kw):return subprocess.run(['docker','exec','-i',cid]+args,capture_output=True,check=True,**kw)
run(['createdb','-U','postgres','releaselab'])
run(['psql','-U','postgres','-d','releaselab','-v','ON_ERROR_STOP=1'],input=b'CREATE ROLE release_trial_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;')
p=pathlib.Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/stage-b-acceptance-674ca78-20260913/fixture-validation/saved-state/stageb_software_release_sealing.dump')
result=run(['pg_restore','-U','postgres','-d','releaselab','--exit-on-error'],input=p.read_bytes());(d/'restore.log').write_bytes(result.stdout+result.stderr)
password=secrets.token_hex(24);run(['psql','-U','postgres','-d','releaselab','-v','ON_ERROR_STOP=1'],input=("ALTER ROLE release_trial_reader PASSWORD '"+password+"';").encode())
port=subprocess.check_output(['docker','port',cid,'5432/tcp'],text=True).strip().split(':')[-1]
(d/'database-private.json').write_text(json.dumps({'container':cid,'reader_url':f'postgres://release_trial_reader:{password}@127.0.0.1:{port}/releaselab','tag':db['tag']}))
counts=run(['psql','-U','postgres','-d','releaselab','-At','-c','select (select count(*) from release_ops.release_slots), (select count(*) from release_ops.build_candidates), (select count(*) from release_ops.build_checks);']).stdout.decode().strip();assert counts=='116|116|272',counts
(d/'restore-result.json').write_text(json.dumps({'dump':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'exit':0,'counts':counts,'classification':'known original synthetic source restoration, not the independent post-execution business state; public revalidation still required','task_owned_container':cid},indent=2));print('Software known original source restored: 116 slots, 116 candidates, 272 checks. Revalidation pending.')
