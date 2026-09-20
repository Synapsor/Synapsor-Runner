"""Report exact selected disabled programs from captured logical tables only."""
from pathlib import Path
import sys, json, hashlib, copy, os

os.umask(0o077)
root, label = Path(sys.argv[1]).resolve(), sys.argv[2]
assert root.name in ('main-A', 'main-B', 'dev-B')
base = root / 'state-readbacks'
def selected(label):
    tables = json.loads((base / (label + '-control.json')).read_text())
    revisions = {r['revision_id']: json.loads(r['content_json']) for r in tables['control_policy_revisions']}
    drafts = {p['kind']: {'revision': p['revision_id'], 'record': revisions[p['revision_id']]}
              for p in tables['control_policy_drafts']}
    return tables, drafts
old_tables, old = selected('untouched-final-start')
tables, current = selected(label)
old_authority = old['action']['record']['authority']['authority']
authority = current['action']['record']['authority']['authority']
def without_selectors(classes):
    result = copy.deepcopy(classes)
    for approval in result:
        for limit in approval.get('shared_limits', []): limit.pop('capability', None)
    return result
programs = lambda a: [r['rule'] for r in a['rules']]
effects = lambda a: [r['effect_envelope'] for r in a['rules']]
private = lambda a: [r['verification_boundary'] for r in a['rules']]
business = {k: tables[k] == old_tables[k] for k in tables
            if not k.startswith('control_policy_') and k != 'sqlite_sequence'}
active_business = lambda t: [p for p in t['control_policy_active'] if p['kind'] != 'management']
result = {
    'label': label, 'current_action_revision': current['action']['revision'],
    'current_read_revision': current['read']['revision'],
    'rule_AST_equal': programs(old_authority) == programs(authority),
    'effect_envelopes_equal': effects(old_authority) == effects(authority),
    'private_verification_equal': private(old_authority) == private(authority),
    'approval_classes_equal': old_authority['approval_classes'] == authority['approval_classes'],
    'approval_classes_equal_except_capability': without_selectors(old_authority['approval_classes']) == without_selectors(authority['approval_classes']),
    'read_equal': old['read']['record']['boundary'] == current['read']['record']['boundary'],
    'active_business_authority_equal': active_business(old_tables) == active_business(tables),
    'application_tables_unchanged': business,
    'approval_classes': authority['approval_classes'],
    'rule_AST': programs(authority), 'effect_envelopes': effects(authority),
    'private_verification': private(authority),
    'selected_read': current['read']['record']['boundary'],
    'interpretation': 'Selected disabled records only. No runtime or BUSINESS-readiness inference.'}
out = base / (label + '-program-readback.json')
out.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'path': str(out), 'sha256': hashlib.sha256(out.read_bytes()).hexdigest(),
                  **{k: v for k, v in result.items() if isinstance(v, bool)},
                  'application_tables_unchanged': all(business.values())}))
