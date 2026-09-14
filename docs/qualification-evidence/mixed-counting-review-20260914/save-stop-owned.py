"""Save final task-owned PostgreSQL state, then stop only verified containers."""
from pathlib import Path
import datetime
import hashlib
import json
import subprocess
import os
import sys

os.umask(0o077)
E = Path(__file__).resolve().parent
O = Path(json.loads((E / 'assignment-plan.json').read_text())['owned_root'])
assert not (O / 'one-public-run.lock').exists()
closure = O / 'closure'
closure.mkdir(exist_ok=True)
records = []
for R in sorted((O / 'runs').iterdir()):
    if len(sys.argv)>1 and R.name != sys.argv[1]: continue
    saved_record = closure / R.name / 'stop-result.json'
    if saved_record.exists():
        record=json.loads(saved_record.read_text()); current=json.loads(subprocess.check_output(['docker','inspect',record['container']]))[0]
        assert current['Id']==record['container_id'] and not current['State']['Running']
        records.append(record); continue
    connection = json.loads((R / 'private/connection.json').read_text())
    name = connection['container']
    info = json.loads(subprocess.check_output(['docker', 'inspect', name]))[0]
    assert info['Id'] == connection['container_id']
    assert info['Config']['Labels']['synapsor.qualification'] == connection['label'] == 'mixed-counting-review-20260914'
    assert info['HostConfig']['NetworkMode'] == 'none'
    assert info['State']['Running']
    invocations = [json.loads(s) for s in ((R / 'public-invocations.jsonl').read_text() if (R / 'public-invocations.jsonl').exists() else '').splitlines()]
    assert len([x for x in invocations if x['event'] == 'start']) == len([x for x in invocations if x['event'] == 'exit'])
    for item in json.loads((R / 'frozen-input-manifest.json').read_text())['records']:
        assert hashlib.sha256((R / item['path']).read_bytes()).hexdigest() == item['sha256']
    destination = closure / R.name
    destination.mkdir()
    (destination / 'container-before.json').write_text(json.dumps(info, indent=2) + '\n')
    with (destination / 'source.dump').open('xb') as target:
        subprocess.run(['docker', 'exec', name, 'pg_dump', '-U', 'postgres', '-Fc', connection['database']], stdout=target, check=True, timeout=60)
    with (destination / 'postgres.log').open('xb') as target:
        subprocess.run(['docker', 'logs', name], stdout=target, stderr=subprocess.STDOUT, check=True, timeout=30)
    before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in destination.iterdir()}
    stopped = subprocess.run(['docker', 'stop', '--time', '10', name], capture_output=True, text=True, timeout=30)
    after = json.loads(subprocess.check_output(['docker', 'inspect', name]))[0]
    assert stopped.returncode == 0 and not after['State']['Running'] and after['Id'] == info['Id']
    (destination / 'container-after.json').write_text(json.dumps(after, indent=2) + '\n')
    records.append({'run': R.name, 'container': name, 'container_id': info['Id'], 'label': connection['label'],
                    'network': 'none', 'saved_before_stop': before, 'stop_exit': stopped.returncode,
                    'running_after': after['State']['Running'], 'original_input_hashes_unchanged': True,
                    'saved_directory': str(destination), 'removed': False})
    (destination/'stop-result.json').write_text(json.dumps(records[-1],indent=2)+'\n')
result = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'records': records,
          'counts_note': 'Actual public CLI and provider invocations retained in each public-invocations.jsonl and meter/events.jsonl. No worker or source execution is scheduled by this assignment.',
          'original_containers_touched': False, 'fixture_directories_removed': False}
(E / ('owned-cleanup-'+sys.argv[1]+'.json' if len(sys.argv)>1 else 'owned-cleanup.json')).write_text(json.dumps(result, indent=2) + '\n')
(closure / 'owned-cleanup.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'stopped': len(records), 'all_exits': [r['stop_exit'] for r in records], 'saved': str(closure)}))
