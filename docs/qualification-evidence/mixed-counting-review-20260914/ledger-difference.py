from pathlib import Path
import json,sys
E=Path(__file__).resolve().parent;O=Path(json.loads((E/'assignment-plan.json').read_text())['owned_root']);D=O/'runs/recovery-tournament-assisted/deterministic';label=sys.argv[1];a=json.loads((D/'review-baseline-state.json').read_text());b=json.loads((D/f'review-{label}-state.json').read_text());changes=[]
for name in a['ledger'].keys()|b['ledger'].keys():
 before=a['ledger'].get(name,[]);after=b['ledger'].get(name,[])
 if before!=after:changes.append({'table':name,'before':len(before),'after':len(after),'removed':[r for r in before if r not in after],'added':[r for r in after if r not in before]})
with (E/f'installed-ledger-difference-{label}.json').open('x') as f:f.write(json.dumps(changes,indent=2)+'\n')
print(json.dumps({'changed_tables':[r['table'] for r in changes],'authority_unchanged':a['authority']==b['authority'],'owner_messages_unchanged':a['sources']['operator_messages']==b['sources']['operator_messages']}))
