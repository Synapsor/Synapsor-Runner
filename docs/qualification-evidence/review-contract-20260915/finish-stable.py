"""Continue once, only after the existing suite completes successfully."""
from pathlib import Path
import datetime, json, subprocess, time, sys

E = Path(__file__).resolve().parent
repo = E.parents[2]
plan = json.loads((E / 'assignment-plan.json').read_text())
deadline = datetime.datetime.fromisoformat(plan['stable_verification_deadline']).timestamp()
suite = sys.argv[1] if len(sys.argv)>1 else 'stable-full'
assert suite in ['stable-full', 'stable-full02']
suffix = '02' if suite.endswith('02') else ''
events = E / ('stable-continuation'+suffix+'.jsonl')
def log(value):
    with events.open('a') as out:
        out.write(json.dumps({'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), **value}) + '\n')
    print(json.dumps(value), flush=True)
assert not events.exists(), 'Do not duplicate the stable continuation'
log({'event': 'waiting_for_existing_suite', 'suite_exit_record': str(E / (suite+'-exit.json'))})
while True:
    assert time.time() < deadline, 'Declared stable verification deadline exhausted'
    full = json.loads((E / (suite+'-exit.json')).read_text())
    if 'exit_code' in full:
        log({'event': 'existing_suite_finished', 'exit_code': full['exit_code'], 'source_unchanged': full['source_unchanged']})
        assert full['exit_code'] == 0 and full['source_unchanged'], 'Preserve failed suite; no automatic retry or package pass'
        break
    time.sleep(2)
checks = [
    ['python3', str(E / 'run-local.py'), 'stable-types', 'corepack', 'pnpm', 'typecheck'],
    ['python3', str(E / 'run-local.py'), 'postgres-domain', '--pg', 'corepack', 'pnpm', 'exec', 'vitest', 'run',
     'apps/runner/src/authoring-counting-domain.test.ts', 'apps/runner/src/authoring-counting-freshness.test.ts',
     '--maxWorkers=1', '--minWorkers=1', '--testTimeout=30000', '--hookTimeout=120000'],
    ['python3', str(E / 'run-local.py'), 'postgres-review-recovery', '--pg', 'corepack', 'pnpm', 'exec', 'vitest', 'run',
     'apps/runner/src/control-policy-authority-codec.test.ts', '--testNamePattern',
     'postgres validated operator policy transactions.*keeps Action recovery review available with unavailable Read authority:',
     '--maxWorkers=1', '--minWorkers=1', '--testTimeout=30000', '--hookTimeout=120000'],
    ['python3', str(E / 'run-offline-checks.py'), 'all', 'attempt1'],
]
for args in checks:
    assert time.time() < deadline, 'Declared stable verification deadline exhausted'
    log({'event': 'start', 'args': args})
    result = subprocess.run(args, cwd=repo, timeout=max(1, deadline-time.time()))
    log({'event': 'exit', 'args': args, 'exit_code': result.returncode})
    assert result.returncode == 0, 'Preserve failure; do not silently repeat this stage'
log({'event': 'complete', 'suite_launches': 2 if suffix else 1})
