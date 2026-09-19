"""Compare acknowledged public snapshots without equating whole-ledger bytes."""
from pathlib import Path
import json,sys
before=Path(sys.argv[1]);after=Path(sys.argv[2]);out=Path(sys.argv[3]);a=json.loads(before.read_text());b=json.loads(after.read_text());assert a['resume'] and b['resume'];x=a['resume'][0];y=b['resume'][0]
fields=['job_intent','model','policy_source_session','intended_client','reviewed_version_fields','read_prerequisite_decisions']
checks={k:{'before_present':k in x,'after_present':k in y,'unchanged':x.get(k)==y.get(k)} for k in fields}
for k in ['job_intent','model','policy_source_session','intended_client']:assert k in x and k in y and checks[k]['unchanged'],k
noncontrol=[k for k in a['tables'] if not k.startswith('control_policy_')]
assert all(a['tables'][k]==b['tables'][k] for k in noncontrol),'Unexpected application-ledger change'
policies=[k for k in a['files'] if 'policy-sources/' in k];assert policies and all(a['files'][k]==b['files'].get(k) for k in policies)
result={'before':str(before),'after':str(after),'checks':checks,'source_policy_files_unchanged':policies,'non_control_application_tables_unchanged':noncontrol,'changed_control_tables':[k for k in a['tables'] if a['tables'][k]!=b['tables'][k]],'changed_resume_keys':[k for k in sorted(set(x)|set(y)) if x.get(k)!=y.get(k)],'pending':y.get('pending_read_relationship'),'source_rows_checked_separately':True}
assert not out.exists();out.write_text(json.dumps(result,indent=2));print(json.dumps(result))
