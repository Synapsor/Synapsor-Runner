"""Read-only closure of the two stopped public trials; never rerun onboarding.

Uses only the recorded owned container and local SQLite evidence. Saves source
readback, databases and logs before stopping that container. Refuses live trial
processes or database users. Does not delete containers, stores or history.
"""
from pathlib import Path
import datetime, hashlib, json, os, re, shutil, sqlite3, subprocess

os.umask(0o077)
E = Path(__file__).resolve().parent
plan = json.loads((E / 'assignment-plan.json').read_text())
O = Path(plan['owned_root'])
H = O / 'fixture-validation'
meta = json.loads((H / 'postgres-fixture.json').read_text())
out = H / 'final-saved-state'
assert not out.exists(), 'Preserve previous closure; do not rerun it in place'
env = {'PATH': os.environ['PATH'], 'HOME': str(O / 'verification-home'),
       'LANG': 'C.UTF-8', 'NO_COLOR': '1'}
def run(args, **kw):
    return subprocess.run(args, check=True, env=env, **kw)
def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()
def save(p, value):
    with p.open('x') as f:
        json.dump(value, f, indent=2); f.write('\n')
def inspect():
    x = json.loads(run(['docker', 'inspect', meta['name']], capture_output=True, text=True).stdout)[0]
    assert x['Id'] == meta['id']
    assert x['Config']['Labels']['synapsor.qualification'] == 'stage-b-fixture-preparation-20260913'
    assert x['HostConfig']['NetworkMode'] == 'none'
    return x
def psql(db, sql):
    return run(['docker', 'exec', meta['name'], 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                '-U', 'postgres', '-d', db, '-c', sql], capture_output=True, text=True).stdout.strip()
def file_records(root):
    return [{'path': str(p.relative_to(root)), 'bytes': p.stat().st_size,
             'mode': oct(p.stat().st_mode & 0o777), 'sha256': sha(p)}
            for p in sorted(root.rglob('*')) if p.is_file() and not p.is_symlink()]
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
before = inspect(); assert before['State']['Running']
selection = json.loads((E / 'case-selection.json').read_text())['cases']
processes = []
for item in selection:
    C = Path(item['root'])
    inv = [json.loads(l) for l in (C / 'public-invocations.jsonl').read_text().splitlines()]
    assert inv[-1]['event'] == 'exit' and inv[-1]['code'] == 0
    for v in inv:
        if v['event'] == 'owned_process':
            for k in ['pid', 'wrapper_pid']:
                pid = v[k]; alive = (Path('/proc') / str(pid) / 'cmdline').exists()
                processes.append({'case': item['id'], 'pid': pid, 'kind': k, 'alive': alive})
                assert not alive, 'Inspect surviving recorded process; do not kill a reused PID'
    db = 'stageb_' + item['id'].replace('-', '_')
    assert psql(db, 'SELECT current_database()') == db
    assert psql(db, 'SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()') == '0'
out.mkdir()
save(out / 'container-before.json', before)
software = O / 'cases/software-release-sealing'
stop = software / 'checkpoints/budget-stopped'
stop.mkdir(parents=True)
shutil.move(str(software / 'project'), str(stop / 'project'))
for n in ['initial-01.terminal.log', 'initial-01.terminal.log.timing', 'public-invocations.jsonl', 'operator-events.jsonl']:
    shutil.copy2(software / n, stop / n)
results = []
for item in selection:
    C = Path(item['root']); cfg = json.loads((C / 'case.json').read_text())
    manifest = json.loads((C / 'frozen-input-manifest.json').read_text())
    for rec in manifest['records']:
        assert sha(C / rec['path']) == rec['sha256'], 'Frozen case inputs changed'
    if item['id'] == 'tournament-ratification':
        fail = C / 'checkpoints/unaided-clarification-refusal'
        for rec in json.loads((fail / 'failure.json').read_text())['records']:
            assert sha(fail / rec['path']) == rec['sha256'], 'Original failure changed'
        P = C / 'checkpoints/assisted-stopped/project'
    else:
        P = stop / 'project'
    db = 'stageb_' + item['id'].replace('-', '_')
    facts = json.loads((C / 'private/source-facts.json').read_text()); rows = {}
    assert cfg['schema'].isidentifier()
    for t in cfg['table_order']:
        assert t.isidentifier()
        data = json.loads(psql(db, f'SELECT coalesce(json_agg(t),\'[]\'::json) FROM {cfg["schema"]}.{t} t'))
        key = list(facts[t][0])[0]
        assert sorted(data, key=lambda r: r[key]) == sorted(facts[t], key=lambda r: r[key]), 'Source rows changed'
        rows[t] = data
    readback = out / (item['id'] + '-source-readback.json'); save(readback, rows)
    conn = sqlite3.connect((P / '.synapsor/local.db').as_uri() + '?mode=ro', uri=True)
    try:
        counts = {t: conn.execute('SELECT count(*) FROM ' + t).fetchone()[0]
                  for t in ['proposals', 'approvals', 'worker_queue', 'writeback_receipts']}
        assert all(v == 0 for v in counts.values())
        active = [{'kind': r[0], 'name': r[1], 'revision': r[2]} for r in conn.execute('SELECT kind,name,revision_id FROM control_policy_active')]
        assert all(r['kind'] == 'management' for r in active), 'Unexpected serving authority'
    finally:
        conn.close()
    attempts = list((C / 'meter').glob('attempt-*.json'))
    events = [json.loads(l) for l in (C / 'meter/events.jsonl').read_text().splitlines()]
    responses = [v for v in events if v['type'] == 'response']
    completed = [v for v in events if v['type'] == 'response_complete']
    assert len(attempts) == (24 if item['id'] == 'tournament-ratification' else 50)
    forbidden = json.loads((C / 'private/forbidden-provider-values.json').read_text())
    disclosure = []
    artifacts = sorted((C / 'meter').glob('input-*.json')) + sorted((C / 'meter').glob('output-*.txt'))
    for p in artifacts:
        s = p.read_text(errors='replace')
        assert not any(v and v in s for v in forbidden), 'Private fixture value in provider capture'
        assert not re.search(r'\bsk-(?:proj-|ant-|[A-Za-z0-9]{30})', s), 'Potential provider secret in capture'
        disclosure.append({'path': str(p), 'sha256': sha(p), 'bytes': p.stat().st_size})
    save(out / (item['id'] + '-provider-capture-index.json'), disclosure)
    dump = out / (db + '.dump')
    with dump.open('xb') as f:
        run(['docker', 'exec', meta['name'], 'pg_dump', '-U', 'postgres', '-d', db, '--format=custom'], stdout=f, stderr=subprocess.PIPE)
    listing = run(['docker', 'exec', '-i', meta['name'], 'pg_restore', '--list'], input=dump.read_bytes(), capture_output=True)
    (out / (db + '-contents.txt')).write_bytes(listing.stdout)
    result = {'case': item['id'], 'at': now, 'fixture_inputs_unchanged': True,
              'source_rows_unchanged': True, 'rows': {k: len(v) for k, v in rows.items()},
              'source_readback': str(readback), 'source_readback_sha256': sha(readback),
              'stopped_project': str(P), 'counts': counts, 'current_pointer_records': active,
              'current_pointers_are_management_not_enabled_authority': True,
              'authoring_provider_attempts': len(attempts), 'http_responses': len(responses),
              'http_statuses': sorted(set(v['status'] for v in responses)),
              'complete_response_captures': len(completed), 'runtime_provider_calls': 0,
              'deterministic_mcp_calls': 0, 'worker_invocations': 0,
              'known_private_values_checked': len(forbidden), 'provider_disclosure_matches': 0,
              'dump': str(dump), 'dump_sha256': sha(dump), 'dump_bytes': dump.stat().st_size,
              'pg_restore_list_exit': 0, 'actual_closure_exit': 0}
    save(out / (item['id'] + '-result.json'), result); results.append(result)
    state = json.loads((C / 'trial-state.json').read_text())
    state.update(status='STOPPED_PRODUCT_SETUP_REFUSAL' if item['id'] == 'tournament-ratification' else 'STOPPED_INITIAL_PROVIDER_BUDGET',
                 external_acceptance_result='ACCEPTED_NO_MATERIAL_BLOCKER', authoring_provider_calls=len(attempts),
                 closure_at=now, runtime_provider_calls=0, deterministic_mcp_calls=0, worker_invocations=0)
    (C / 'trial-state.json').write_text(json.dumps(state, indent=2) + '\n')
save(stop / 'saved-file-manifest.json', file_records(stop))
roles = run(['docker', 'exec', meta['name'], 'pg_dumpall', '-U', 'postgres', '--globals-only', '--no-role-passwords'], capture_output=True)
(out / 'roles-no-passwords.sql').write_bytes(roles.stdout)
logs = run(['docker', 'logs', '--timestamps', meta['name']], capture_output=True)
(out / 'postgres.stdout.log').write_bytes(logs.stdout); (out / 'postgres.stderr.log').write_bytes(logs.stderr)
inspect(); run(['docker', 'stop', '--time', '10', meta['name']], capture_output=True)
after = inspect(); assert not after['State']['Running']; save(out / 'container-stopped.json', after)
result = {'at': now, 'actual_exit': 0, 'candidate_tree': plan['candidate_tree'],
          'cases': results, 'owned_processes': processes, 'container': meta['name'], 'container_id': meta['id'],
          'stop_exit': 0, 'running_after': False, 'removed': False, 'logs_saved_before_stop': True,
          'original_resources_touched': False, 'no_worker_executed': True}
save(out / 'result.json', result); save(E / 'final-local-state.json', result)
print(json.dumps({'exit': 0, 'cases': len(results), 'source_unchanged': True, 'saved_dumps': 2,
                  'container_stopped': True, 'authoring_attempts': [r['authoring_provider_attempts'] for r in results]}))
