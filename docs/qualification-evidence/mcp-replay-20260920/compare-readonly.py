"""Compare complete stored state around a public inspection/preflight refusal."""
from pathlib import Path
import json,sys,datetime
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/mcp-replay-7be8d2a-20260920');case,before,after=sys.argv[1:];assert case in ['r0','r1'];d=r/'operational'/case
b=json.loads((d/('state-'+before)/'manifest.json').read_text());a=json.loads((d/('state-'+after)/'manifest.json').read_text());assert a==b,'State changed; inspect complete snapshots without resetting it'
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'case':case,'before':before,'after':after,'result':'unchanged','all_control_tables':len(a['tables']),'all_source_rows':sum(v['rows'] for v in a['source'].values()),'source_receipts':a['source_receipts'],'configuration_files':a['config_files'],'sqlite_bytes_changed':json.loads((d/('state-'+before)/'storage-bytes.json').read_text())!=json.loads((d/('state-'+after)/'storage-bytes.json').read_text())}
p=d/('readonly-'+before+'-'+after+'.json');assert not p.exists();p.write_text(json.dumps(result,indent=2));print(json.dumps({k:v for k,v in result.items() if k not in ['configuration_files']}))
