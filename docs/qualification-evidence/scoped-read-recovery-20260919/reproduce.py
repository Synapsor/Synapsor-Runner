"""Owned, local reproduction of the supplied 26-case matrix; no registry pulls."""
import hashlib, json, os, pathlib, secrets, subprocess, sys, time, uuid

REPO = pathlib.Path(__file__).resolve().parents[3]
ROOT = pathlib.Path(os.environ.get('SYNAPSOR_READ_REPRO_ROOT', '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/scoped-read-recovery-515d260-20260919')).resolve()
PACKAGE = pathlib.Path('/home/sandesh-tiwari/Desktop/Synapsor Tutorials/onboarding-ux-experiments-20260917/exp5-unseen-domain/REPRO-PACKAGE')
os.umask(0o077)
ROOT.mkdir(parents=True, exist_ok=True)

def run(args, **kw):
    return subprocess.run(args, text=True, capture_output=True, check=True, **kw)

if sys.argv[1] == 'setup':
    assert not (ROOT/'database-private.json').exists() and not (ROOT/'postgres.env').exists(), 'Use a new owned evidence root; preserve existing fixtures'
    tag = 'j5j6-' + uuid.uuid4().hex[:12]
    password = secrets.token_hex(24)
    secret = ROOT / 'postgres.env'
    secret.write_text('POSTGRES_PASSWORD=' + password + '\nPOSTGRES_DB=refundlab\n')
    cid = run(['docker', 'run', '--pull', 'never', '-d', '--name', tag, '--label', 'synapsor.task=' + tag,
               '--env-file', str(secret), '-p', '127.0.0.1::5432', 'postgres:17']).stdout.strip()
    (ROOT/'created-containers.jsonl').open('a').write(json.dumps({'container':cid,'tag':tag})+'\n')
    for _ in range(80):
        if subprocess.run(['docker','exec',cid,'pg_isready','-h','127.0.0.1','-U','postgres','-d','refundlab'], stdout=subprocess.DEVNULL).returncode == 0: break
        time.sleep(.25)
    port = run(['docker','port',cid,'5432/tcp']).stdout.strip().split(':')[-1]
    def sql(contents):
        return run(['docker','exec','-i',cid,'psql','-U','postgres','-d','refundlab','-v','ON_ERROR_STOP=1'], input=contents)
    sql("CREATE ROLE refunds_trial_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD '"+password+"';")
    sql((PACKAGE/'source-dump/schemas.sql').read_text())
    for path in sorted((PACKAGE/'schemas').glob('*.sql')): sql(path.read_text())
    sql('GRANT USAGE ON SCHEMA returns_ops, refunds TO refunds_trial_reader; GRANT SELECT ON ALL TABLES IN SCHEMA returns_ops, refunds TO refunds_trial_reader;')
    (ROOT/'database-private.json').write_text(json.dumps({'container':cid,'tag':tag,'reader_url':f'postgres://refunds_trial_reader:{password}@127.0.0.1:{port}/refundlab','admin_url':f'postgres://postgres:{password}@127.0.0.1:{port}/refundlab'}))
    (ROOT/'database-identity.json').write_text(json.dumps({'container':cid,'tag':tag,'port':port,'image':run(['docker','inspect','--format','{{.Image}}',cid]).stdout.strip(),'rows':'schema-only; no historical source rows'} ,indent=2))
    print('Owned PostgreSQL fixture prepared: '+tag)
elif sys.argv[1] == 'matrix':
    attempt = sys.argv[2]
    out = ROOT/(attempt+'-work' if attempt=='trace-cli' else attempt)
    out.mkdir(exist_ok=False)
    db = json.loads((ROOT/'database-private.json').read_text())
    for name in ['home','tmp','var-tmp']: (out/name).mkdir()
    env = {'PATH':os.environ['PATH'],'HOME':str(out/'home'),'NO_COLOR':'1','NODE_NO_WARNINGS':'1','TMPDIR':'/var/tmp','DATABASE_URL':db['reader_url']}
    results=[]
    runner=[str(REPO/'bin/synapsor-runner')]
    if attempt=='installed':
        if os.environ.get('SYNAPSOR_READ_RUNNER'):
            artifact=pathlib.Path(os.environ['SYNAPSOR_READ_RUNNER']).resolve();assert artifact.is_file()
        else:
            run(['node',str(ROOT/'frozen/freeze-repair.mjs'),'--verify'])
            artifact=ROOT/'frozen/installed/node_modules/@synapsor/runner/dist/runner.mjs'
        runner=['node',str(artifact)]
    schemas = sys.argv[3:4] or ['returns_ops','refunds']+[p.stem for p in sorted((PACKAGE/'schemas').glob('*.sql'))]
    for schema in schemas:
        project = out/schema; project.mkdir()
        command = ['bwrap','--die-with-parent','--ro-bind','/','/','--bind',str(out),str(out),'--bind',str(out/'tmp'),'/tmp','--bind',str(out/'var-tmp'),'/var/tmp','--bind',str(project),'/tmp/project','--proc','/proc','--dev','/dev','--chdir','/tmp/project',*runner,'boundary','draft','--from-env','DATABASE_URL','--schema',schema,'--project-root','.','--json']
        if attempt == 'trace-cli':
            command[5:5] = ['--ro-bind',str(ROOT/'auto-boundary-trace.ts'),str(REPO/'apps/runner/src/auto-boundary.ts'),'--bind',str(ROOT/'trace-cli'),str(ROOT/'trace-cli')]
        preflight = command[:command.index(runner[0])] + [str(REPO/'node_modules/.bin/tsx'),'-e',"import {resolveSynapsorProject} from '"+str(REPO/'apps/runner/src/project-resolution.ts')+"'; resolveSynapsorProject().then(p=>{if(p) throw Error('Unexpected ancestor store'); console.log('Fresh project: no effective external store');});"]
        check=run(preflight,env=env)
        (out/(schema+'.preflight')).write_text(check.stdout)
        start=time.monotonic()
        result=subprocess.run(command,env=env,capture_output=True,text=True,timeout=90)
        (out/(schema+'.stdout')).write_text(result.stdout); (out/(schema+'.stderr')).write_text(result.stderr)
        entry={'schema':schema,'exit':result.returncode,'seconds':round(time.monotonic()-start,3)}
        results.append(entry); print(json.dumps(entry),flush=True)
        (out/'results.json').write_text(json.dumps(results,indent=2))
    (out/'source.json').write_text(json.dumps({'head':run(['git','rev-parse','HEAD'],cwd=REPO).stdout.strip(),'diff_sha256':hashlib.sha256(run(['git','diff','HEAD'],cwd=REPO).stdout.encode()).hexdigest(),'runner':runner,'command':'boundary draft --from-env DATABASE_URL --schema <schema> --project-root . --json'},indent=2))
