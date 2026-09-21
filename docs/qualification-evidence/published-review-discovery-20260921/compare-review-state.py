"""Read-only comparison of previously captured review-only snapshots."""
import json,sys,hashlib
from pathlib import Path
root=Path(sys.argv[1]);before=sys.argv[2];after=sys.argv[3];out=root/'state-readbacks'
a=json.loads((out/(before+'-control.json')).read_text());b=json.loads((out/(after+'-control.json')).read_text())
x=json.loads((out/(before+'-summary.json')).read_text());y=json.loads((out/(after+'-summary.json')).read_text())
changed_tables=[k for k in sorted(set(a)|set(b)) if a.get(k)!=b.get(k)]
changed_config=[k for k in sorted(set(x['config_hashes'])|set(y['config_hashes'])) if x['config_hashes'].get(k)!=y['config_hashes'].get(k)]
result={'before':before,'after':after,'all_logical_tables_equal':not changed_tables,'tables':len(a),'changed_tables':changed_tables,'source_equal':x['source_sha256']==y['source_sha256'],'source_sha256':y['source_sha256'],'changed_configuration_files':changed_config,'unexpected_configuration_files':[k for k in changed_config if not k.startswith('.synapsor/boundary-authoring/')],'separate_source_control_reads':True,'whole_file_byte_identity_claimed':False}
(out/(before+'-to-'+after+'-difference.json')).write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
assert result['source_equal'] and result['all_logical_tables_equal'] and not result['unexpected_configuration_files'], 'Review-only invariance requires investigation'
