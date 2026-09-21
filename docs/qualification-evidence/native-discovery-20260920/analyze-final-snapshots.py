"""Read only saved snapshots; never invokes Runner or opens the live stores."""
from pathlib import Path
import json, datetime

r = Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/native-discovery-3d02c0b-20260920/main-A')
e = Path(__file__).parent
s = r / 'state-readbacks'
a = json.loads((s / 'pre-edit-control.json').read_text())
b = json.loads((s / 'edit-save-observed-control.json').read_text())
c = json.loads((s / 'final-stopped-control.json').read_text())

def program(d, pointer):
    ref = next(x['revision_id'] for x in d[pointer] if x['kind'] == 'action')
    return ref, json.loads(next(x['content_json'] for x in d['control_policy_revisions'] if x['revision_id'] == ref))['authority']['authority']

def diff(a, b, p=''):
    if type(a) != type(b):
        return [{'path': p, 'before': a, 'after': b}]
    if isinstance(a, dict):
        return sum([diff(a.get(k), b.get(k), p + '/' + k) for k in sorted(set(a) | set(b))], [])
    if isinstance(a, list):
        return sum([diff(a[i] if i < len(a) else None, b[i] if i < len(b) else None, p + '/' + str(i)) for i in range(max(len(a), len(b)))], [])
    return [] if a == b else [{'path': p, 'before': a, 'after': b}]

old, x = program(a, 'control_policy_active')
new, y = program(c, 'control_policy_drafts')
deltas = diff(x, y)
core = [d for d in deltas if not (d['path'].endswith('digest') or d['path'].endswith('activated_at'))]
assert [d['path'] for d in core] == ['/rules/0/effect_envelope/allowed_fields/1/maximum', '/rules/0/rule/inputs/0/maximum', '/rules/0/rule/require/expressions/7/right/value', '/rules/0/rule/x-runner-discovery/summary']
assert all(d['before'] == 7 and d['after'] == 5 for d in core[:3])
assert x['approval_classes'] == y['approval_classes']
assert x['catalog'] == y['catalog']
assert a['control_policy_active'] == b['control_policy_active'] == c['control_policy_active']
assert (s / 'pre-edit-source.json').read_bytes() == (s / 'edit-save-observed-source.json').read_bytes() == (s / 'final-stopped-source.json').read_bytes()
changed = [k for k in a if a[k] != c[k]]
unchanged = [k for k in a if a[k] == c[k]]
business_tables = ['proposals', 'approvals', 'worker_queue', 'writeback_receipts', 'idempotency_receipts']
for k in business_tables:
    assert k in unchanged, k
result = {
    'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'public_resume': 'FAIL: immediate same pause, exit 0; no provider review call, reason not established',
    'disabled_exact_program_diff': 'PASS', 'old_active_revision': old, 'new_disabled_revision': new,
    'compiled_semantic_changes': core, 'derived_changes': [d for d in deltas if d not in core],
    'source_row_count': 38, 'source_unchanged_across_edit_and_resume': True,
    'all_active_pointers_unchanged': True, 'approval_classes_and_catalog_unchanged': True,
    'all_tables_count': len(a), 'unchanged_tables': unchanged, 'changed_tables_preedit_to_final': changed,
    'changed_tables_saved_edit_to_final': [k for k in b if b[k] != c[k]],
    'business_counts': {k: len(c[k]) for k in business_tables},
    'old_unstarted_work': 'retained, not dispatched; handling after publication NOT RUN',
    'publication': 'NOT RUN', 'new_rule_execution': 'NOT RUN',
    'reason_not_diagnosed': 'A missing prerequisite/session state may cause the pause; no source-level cause claimed without trace',
    'raw_snapshots': str(s), 'terminal': str(r / 'operator-captures/terminal-009.log'),
    'postprocessing_correction': 'An initial offline inventory assertion used nonexistent writeback_queue instead of actual worker_queue. It failed before writing a result. Corrected against captured table inventory only; no new application operation, provider call, changed snapshot or extra live harness attempt.'
}
(r / 'EDIT-STOP-RESULT.json').write_text(json.dumps(result, indent=2) + '\n')
(e / 'MAIN-EDIT-STOP-RESULT.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'semantic_changes': len(core), 'changed_tables': changed, 'resume_changed_tables': result['changed_tables_saved_edit_to_final'], 'business_counts': result['business_counts']}))
