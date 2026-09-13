"""Hash preserved originals; never modify their content or protection modes."""
from pathlib import Path
import datetime
import hashlib
import json
import os
import stat
import sys

E = Path(__file__).resolve().parent
P = E.parent / 'authoring-review-repair-20260913'
plan = json.loads((E / 'assignment-plan.json').read_text())
O = Path(plan['owned_root'])
previous = Path(plan['previous_root'])

def entry(path):
    s = os.lstat(path)
    result = {'path': str(path), 'mode': stat.S_IMODE(s.st_mode), 'type': stat.S_IFMT(s.st_mode)}
    if stat.S_ISREG(s.st_mode):
        with open(path, 'rb') as source:
            result.update(size=s.st_size, sha256=hashlib.file_digest(source, 'sha256').hexdigest())
    elif stat.S_ISLNK(s.st_mode):
        result['target'] = os.readlink(path)
    return result

def snapshot(roots):
    records = []
    for root in roots:
        records.append(entry(root))
        if Path(root).is_dir():
            for directory, dirs, files in os.walk(root, followlinks=False):
                records.extend(entry(Path(directory) / name) for name in sorted(dirs + files))
    return records

name = sys.argv[1]
if name == 'start':
    old = json.loads((previous / 'preservation-start.json').read_text())
    roots = old['roots'] + [str(previous), str(P)]
    records = snapshot(roots)
    current = {r['path']: r for r in records}
    external = json.loads((P / 'external-finding-update.json').read_text())
    changes = [r['path'] for r in old['entries'] if current.get(r['path']) != r]
    assert changes == [external['external_update']['path']]
    assert current[changes[0]] == external['external_update']
    baseline = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'roots': roots, 'entries': records,
                'prior_baseline': str(previous / 'preservation-start.json'),
                'acknowledged_prior_external_delta': external}
    with (O / 'preservation-start.json').open('x') as target:
        target.write(json.dumps(baseline, indent=2) + '\n')
    result = {'at': baseline['at'], 'entries': len(records), 'prior_external_delta_retained': changes, 'unexpected_prior_changes': []}
else:
    baseline = json.loads((O / 'preservation-start.json').read_text())
    current = {r['path']: r for r in snapshot(baseline['roots'])}
    old = {r['path']: r for r in baseline['entries']}
    result = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'entries': len(old),
              'changed': [p for p, r in old.items() if current.get(p) != r], 'added': [p for p in current if p not in old]}
with (E / f'preservation-{name}.json').open('x') as target:
    target.write(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
assert not result.get('changed') and not result.get('added')
