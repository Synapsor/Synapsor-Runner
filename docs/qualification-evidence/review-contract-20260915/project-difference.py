"""Read-only review bookkeeping vs business/configuration preservation oracle."""
from pathlib import Path
import datetime, hashlib, json, sys

E = Path(__file__).resolve().parent
plan = json.loads((E / 'assignment-plan.json').read_text())
run, label = sys.argv[1:3]
assert run in plan['case_sources'] and label.replace('-', '').isalnum()
development = '--development' in sys.argv
R = Path(plan['owned_root'])
if development: R /= 'development'
R = R / 'runs' / run
P = R / 'project'
selected = plan['case_sources'][run]
B = Path(selected['root']) / 'runs' / selected['run'] / 'checkpoints' / selected['checkpoint'] / 'project'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
def files(root):
    result = {}
    for p in root.rglob('*'):
        assert not p.is_symlink()
        if p.is_file(): result[str(p.relative_to(root))] = p
    return result
before, after = files(B), files(P)
changes, rejected = [], []
for rel in sorted(before.keys() | after.keys()):
    a, b = before.get(rel), after.get(rel)
    if a and b and sha(a) == sha(b): continue
    sqlite = bool(a and a.read_bytes()[:16] == b'SQLite format 3\x00')
    review = rel == '.synapsor/boundary-authoring/resume.json' or rel.startswith('.synapsor/boundary-authoring/policy-sources/')
    diagnostic = rel.startswith('.synapsor/boundary-authoring/diagnostics/planning-') and not a
    category = 'SQLite physical bytes; see independent table oracle' if sqlite else 'review bookkeeping' if review else 'new planning diagnostic' if diagnostic else 'UNEXPECTED'
    record = {'path': rel, 'before_sha256': sha(a) if a else None, 'after_sha256': sha(b) if b else None, 'classification': category}
    changes.append(record)
    if category == 'UNEXPECTED' or not b: rejected.append(record)
resrel = '.synapsor/boundary-authoring/resume.json'
oldresume, resume = [json.loads(d[resrel].read_text()) for d in [before, after]]
source_rel = '.synapsor/boundary-authoring/policy-sources/' + oldresume['policy_source_session'] + '.json'
oldsource, source = [json.loads(d[source_rel].read_text()) for d in [before, after]]
source_snapshots_unchanged = oldsource['snapshots'] == source['snapshots']
old_conversation = oldresume.get('conversation', [])
missing_history = [t for t in old_conversation if t not in resume.get('conversation', [])]
result = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'run': run, 'label': label,
          'classification': 'development' if development else 'final installed', 'changes': changes,
          'unexplained_file_changes': rejected, 'source_snapshots_unchanged': source_snapshots_unchanged,
          'original_conversation_entries_missing': len(missing_history),
          'active_authority_and_business_configuration_files_unchanged': not rejected,
          'completed_policy_reviews': resume.get('completed_policy_reviews', []),
          'pending': [k for k, v in resume.items() if k.startswith('pending_') and v is not None],
          'note': 'SQLite byte differences do not establish durable state changes. Pair with review-oracle table hashes and independent source readback.'}
out = E / (run + '-' + label + '-project-difference.json')
with out.open('x') as f: json.dump(result, f, indent=2); f.write('\n')
print(json.dumps({'run': run, 'changed_files': len(changes), 'unexpected': len(rejected), 'source_snapshots_unchanged': source_snapshots_unchanged, 'missing_original_conversation': len(missing_history)}))
assert not rejected and source_snapshots_unchanged and not missing_history
