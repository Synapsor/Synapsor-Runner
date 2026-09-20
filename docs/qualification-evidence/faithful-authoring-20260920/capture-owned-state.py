"""Owned-fixture readback only. No provider, authority write, or source mutation."""
from pathlib import Path
import os,sys,json,sqlite3,hashlib,subprocess,datetime
os.umask(0o077)
root=Path(sys.argv[1]).resolve(); label=sys.argv[2]
assert label.replace("-", "").isalnum()
fixture=json.loads((root/"fixture.json").read_text())
assert fixture["case"] in ["FAITHFUL-DEV-B","FAITHFUL-MAIN-B"]
container=fixture["container"]
info=json.loads(subprocess.check_output(["docker","inspect",container]))[0]
assert info["Config"]["Labels"]["synapsor.task"]=="faithful-authoring-20260920" and info["State"]["Running"]
project=root/"project"; db=project/".synapsor/local.db"
assert db.is_file()
pre=json.loads((root/"preflight-before-open.json").read_text())
# The authoritative effective-store preflight is preserved separately. This is
# only a read-only snapshot of that owned project after logical-path resolution.
con=sqlite3.connect(db.as_uri()+"?mode=ro",uri=True)
con.row_factory=sqlite3.Row
con.execute("BEGIN")
def safe(value):
 if isinstance(value,bytes): return {"bytes_hex":value.hex()}
 return value
rows={}
for (name,) in con.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall():
 q='"'+name.replace('"','""')+'"'
 records=[{k:safe(row[k]) for k in row.keys()} for row in con.execute("SELECT * FROM "+q)]
 rows[name]=sorted(records,key=lambda x:json.dumps(x,sort_keys=True))
con.rollback();con.close()
sql=Path('/home/sandesh-tiwari/Desktop/Synapsor Tutorials/test-1.8.0/stage-b-two-case-b-operator-20260920/harness/source-snapshot.sql')
source=subprocess.check_output(["docker","exec","-i",container,"psql","-X","-At","-v","ON_ERROR_STOP=1","-U","postgres","-d",fixture["database_destination"]["database"]],input=sql.read_bytes())
out=root/"state-readbacks";out.mkdir(exist_ok=True)
config={str(p.relative_to(project)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(project.rglob("*")) if p.is_file() and p.suffix in [".json",".txt",".md"]}
record={"at":datetime.datetime.now(datetime.timezone.utc).isoformat(),"case":fixture["case"],"source_sha256":hashlib.sha256(source).hexdigest(),"control_logical_sha256":hashlib.sha256(json.dumps(rows,sort_keys=True).encode()).hexdigest(),"table_counts":{k:len(v) for k,v in rows.items()},"config_hashes":config,"read_only":True,"separate_control_source_reads":True}
(out/(label+"-source.json")).write_bytes(source)
(out/(label+"-control.json")).write_text(json.dumps(rows,indent=2)+"\n")
(out/(label+"-summary.json")).write_text(json.dumps(record,indent=2)+"\n")
print(json.dumps(record))
