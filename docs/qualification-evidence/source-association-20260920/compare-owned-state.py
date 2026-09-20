"""Compare already captured, task-owned logical readbacks. No database opens."""
from pathlib import Path
import sys, json, hashlib, os

os.umask(0o077)
root = Path(sys.argv[1]).resolve()
before, after = sys.argv[2:4]
assert root.name in ('main-A', 'main-B', 'dev-B')
readbacks = root / 'state-readbacks'
old = json.loads((readbacks / (before + '-control.json')).read_text())
new = json.loads((readbacks / (after + '-control.json')).read_text())
summary = {}
for table in sorted(set(old) | set(new)):
    a, b = old.get(table, []), new.get(table, [])
    if a != b:
        encode = lambda row: json.dumps(row, sort_keys=True)
        aa, bb = {encode(row) for row in a}, {encode(row) for row in b}
        summary[table] = {'before': len(a), 'after': len(b),
                          'removed': [json.loads(x) for x in sorted(aa - bb)],
                          'added': [json.loads(x) for x in sorted(bb - aa)]}
def selected(tables):
    revisions = {r['revision_id']: r for r in tables['control_policy_revisions']}
    return {mode: [{**p, 'content': json.loads(revisions[p['revision_id']]['content_json'])}
                   for p in tables[name]]
            for mode, name in [('active', 'control_policy_active'), ('drafts', 'control_policy_drafts')]}
def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()
out = {'before_label': before, 'after_label': after,
       'source_before': digest(readbacks / (before + '-source.json')),
       'source_after': digest(readbacks / (after + '-source.json')),
       'changed_tables': summary, 'selected_before': selected(old), 'selected_after': selected(new)}
target = readbacks / (before + '-to-' + after + '-difference.json')
target.write_text(json.dumps(out, indent=2) + '\n')
print(json.dumps({'file': str(target), 'sha256': digest(target),
                  'source_equal': out['source_before'] == out['source_after'],
                  'changed_tables': {k: {'before': v['before'], 'after': v['after']}
                                     for k, v in summary.items()}}))
