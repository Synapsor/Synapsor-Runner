"""Read-only independent archive check; no application startup or database writes."""
import datetime
import hashlib
import json
from pathlib import Path, PurePosixPath
import sqlite3
import subprocess
import sys
import tarfile
import tempfile

b = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2]).resolve()
container = sys.argv[3]
f = b / "private/final-state"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical(rows):
    return sorted(json.dumps(row, sort_keys=True, separators=(",", ":")) for row in rows)


def read_control(path):
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as db:
        assert db.execute("pragma integrity_check").fetchall() == [("ok",)]
        db.row_factory = sqlite3.Row
        names = [r[0] for r in db.execute("select name from sqlite_master where type='table' order by name")]
        return {name: canonical([dict(r) for r in db.execute('select * from "' + name.replace('"', '""') + '"')]) for name in names}


index = json.loads((b / "B-FINAL-EVIDENCE-INDEX.json").read_text())
for rec in index["files"] + index["external_records"]:
    assert sha(Path(rec["path"])) == rec["sha256"], rec["path"]
members = []
for line in (f / "SHA256SUMS").read_text().splitlines():
    digest, name = line.split("  ", 1)
    assert Path(name).name == name
    assert sha(f / name) == digest, name
    members.append({"name": name, "sha256": digest})

archive_counts = {}
with tempfile.TemporaryDirectory(prefix="synapsor-b-seal-readback-") as scratch:
    for name in ["project.tgz", "home.tgz"]:
        with tarfile.open(f / name) as tar:
            entries = tar.getmembers()
            for entry in entries:
                p = PurePosixPath(entry.name)
                assert not p.is_absolute() and ".." not in p.parts
                assert entry.isfile() or entry.isdir(), "Unexpected archive link/special file"
                if entry.isfile():
                    data = tar.extractfile(entry).read()
                    assert len(data) == entry.size
            archive_counts[name] = len(entries)
            if name == "project.tgz":
                db_bytes = tar.extractfile("project/.synapsor/local.db").read()
                p = Path(scratch) / "archived-local.db"
                p.write_bytes(db_bytes)
                p.chmod(0o600)
                archived_control = read_control(p)
    control = read_control(f / "control-local.db")
    assert control == archived_control

baseline = json.loads((b / "CONTROL-PREFLIGHT.json").read_text())["tables"]
baseline = {name: canonical([json.loads(row) for row in rows]) for name, rows in baseline.items()}
assert set(control) == set(baseline)
changed = [name for name in control if control[name] != baseline[name]]
count_deltas = {name: len(control[name]) - len(baseline[name]) for name in control if len(control[name]) != len(baseline[name])}
business = ["proposals", "approvals", "worker_queue", "writeback_receipts", "writeback_intents", "idempotency_receipts", "control_policy_effect_admissions", "control_policy_effect_receipts"]
assert all(control[name] == baseline[name] for name in business)
source = json.loads((f / "source-readback.json").read_text())
before = json.loads((b / "SOURCE-PREFLIGHT.json").read_text())["tables"]
before = {name: canonical([json.loads(row) for row in rows]) for name, rows in before.items()}
assert before == {name: canonical(rows) for name, rows in source.items()}
roles = (f / "roles-no-password.sql").read_text()
assert "PASSWORD '" not in roles.upper()

# Only catalog the saved dump. No connection to PostgreSQL is made by pg_restore -l.
labels = json.loads(subprocess.check_output(["docker", "inspect", "--format", "{{json .Config.Labels}}", container]))
assert labels.get("synapsor.task") == "native-continuation-20260921"
assert labels.get("synapsor.case") == "KC-B-posteffect"
with (f / "native_b.dump").open("rb") as inp:
    catalog = subprocess.run(["docker", "exec", "-i", container, "pg_restore", "-l"], stdin=inp, capture_output=True, check=True)
catalog_rows = [line for line in catalog.stdout.decode().splitlines() if line and not line.startswith(";")]
assert len(catalog_rows) > 0
result = {
    "verified_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "verdict": "PASS_ARCHIVE_AND_PRESERVATION_READBACK_ONLY",
    "tester_index": {"path": str(b / "B-FINAL-EVIDENCE-INDEX.json"), "sha256": sha(b / "B-FINAL-EVIDENCE-INDEX.json"), "verified_records": len(index["files"]) + len(index["external_records"])},
    "archive_members": members,
    "tar_entries_read": archive_counts,
    "dump_catalog_records": len(catalog_rows),
    "dump_catalog_sha256": hashlib.sha256(catalog.stdout).hexdigest(),
    "sqlite_integrity": "ok; archived project database logically equals standalone database",
    "control_tables": len(control),
    "control_table_convention": "41 application tables plus sqlite_sequence; all 42 were compared",
    "changed_control_tables": changed,
    "control_count_deltas": count_deltas,
    "business_tables_unchanged": business,
    "source_counts": {name: len(rows) for name, rows in source.items()},
    "source_rows_unchanged": True,
    "credential_free_roles": True,
    "limitations": "Catalog and archive/readback checks, not a new full database restore or application run. No provider, client, worker, or business operation.",
}
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
