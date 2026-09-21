"""Hash the bounded handoff. No application opens, provider calls or store writes."""
from pathlib import Path
import hashlib, json, datetime

evidence = Path(__file__).resolve().parent
raw = Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/published-review-discovery-ed32e38-20260921')
records = {}

def add(path, expected=None):
    path = Path(path).resolve()
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    actual = digest.hexdigest()
    if expected is not None:
        assert actual == expected, str(path)
    records[str(path)] = {'path': str(path), 'sha256': actual, 'bytes': path.stat().st_size}

for path in sorted(evidence.iterdir()):
    if path.is_file() and path.name not in ['EVIDENCE-INDEX.json', 'delivery.json']:
        add(path)

for run in json.loads((evidence / 'GATE-INDEX.json').read_text())['runs']:
    add(run['log'], run['log_sha256'])
    add(run['exit_record'], run['exit_record_sha256'])
for plan in json.loads((evidence / 'OFFLINE-GATE-INDEX.json').read_text()):
    add(evidence / plan['plan'], plan['sha256'])
    for command in plan['commands']:
        add(command['log'], command['log_sha256'])

for name in ['MAIN-A-RESULT.json', 'INDEPENDENT-ACCEPTANCE.json']:
    for item in json.loads((evidence / name).read_text())['evidence']:
        add(item['path'], item['sha256'])
blocker = json.loads((evidence / 'INDEPENDENT-BUSINESS-BLOCKER.json').read_text())
for item in blocker['identical_provider_envelopes'] + [blocker['private_full_record']]:
    add(item['path'], item['sha256'])

for name in ['PRESERVATION.json', 'MAIN-CLEANUP.json', 'EVIDENCE-SECRET-SCAN.json',
             'BACKUP-DESTINATION-VERIFIED.json', 'INDEPENDENT-FOLLOWUP-INTERRUPTION.json',
             'INDEX-SEAL-REFUSAL.json',
             'shared/provider-budget-ledger-final.json',
             'shared/provider-preflight-MAIN-A-REVIEW.json',
             'shared/provider-preflight-TESTER-A-REVIEW.json',
             'restoration-checks/main-A-final/RESULT.json']:
    add(raw / name)

for location in ['untouched-starts/main-A', 'owned-final-states/main-A-reproduction',
                 'owned-final-states/main-A-development', 'owned-final-states/main-A-final',
                 'owned-final-states/gate']:
    root = raw / location
    add(root / 'manifest.json')
    for item in json.loads((root / 'manifest.json').read_text())['files']:
        add(root / item['file'], item['sha256'])
    if (root / 'cleanup.json').exists():
        add(root / 'cleanup.json')

candidate = json.loads((evidence / 'CANDIDATE.json').read_text())
add(candidate['manifest'], candidate['manifest_sha256'])
add(candidate['archive'], candidate['archive_sha256'])
financial = json.loads((evidence / 'FINAL-FINANCIAL-RESULT.json').read_text())
add(financial['ledger'], financial['ledger_sha256'])

index = {'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
         'candidate_tree': candidate['installed_tree_sha256'],
         'status': 'Bounded repair delivery; independent BUSINESS blocked; native continuation not run',
         'records': sorted(records.values(), key=lambda item: item['path']),
         'unavailable_historical_references': json.loads((evidence / 'INDEPENDENT-ACCEPTANCE.json').read_text()).get('unavailable_historical_references', []),
         'privacy': 'Raw captures, stores, source/ACL archives and credentials remain in private owned roots. Hashing does not grant runtime disclosure.',
         'self_hash': 'Stored separately in delivery.json; this index deliberately does not hash itself.'}
target = evidence / 'EVIDENCE-INDEX.json'
target.write_text(json.dumps(index, indent=2) + '\n')
print(json.dumps({'index': str(target), 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
                  'records': len(records)}))
