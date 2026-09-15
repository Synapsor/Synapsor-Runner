"""Preserve clean A/B inputs for the independent lane; no application opens."""
from pathlib import Path
import datetime, hashlib, json, os, shutil

os.umask(0o077)
E = Path(__file__).resolve().parent
plan = json.loads((E / 'assignment-plan.json').read_text())
O = Path(plan['owned_root'])
D = O / 'clean-starts'
D.mkdir()
result = []
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
for name, selected in plan['case_sources'].items():
    if name == 'receipt-replay': continue
    old = Path(selected['root']) / 'runs' / selected['run']
    source = Path(selected['checkpoint_root']) if selected.get('checkpoint_root') else old / 'checkpoints' / selected['checkpoint']
    target = D / name
    shutil.copytree(source, target)
    expected = json.loads((source / 'project-manifest.json').read_text())
    project = target / 'project'
    actual = sorted(str(p.relative_to(project)) for p in project.rglob('*') if p.is_file())
    assert actual == sorted(r['path'] for r in expected)
    for record in expected:
        assert sha(project / record['path']) == record['sha256']
    for part in ['source.dump', 'source-readback.json', 'project-manifest.json']:
        assert sha(source / part) == sha(target / part)
    resume = json.loads((project / '.synapsor/boundary-authoring/resume.json').read_text())
    session = json.loads((project / '.synapsor/boundary-authoring/policy-sources' / (resume['policy_source_session'] + '.json')).read_text())
    current = next(s for s in session['snapshots'] if s['version'] == session['active'])
    rows = json.loads((target / 'source-readback.json').read_text())
    decisions = session.get('counting_decisions', [])
    record = {
        'run': name, 'source_checkpoint': str(source), 'copy': str(target),
        'source_digest': current['digest'], 'source_version': current['version'],
        'coverage_source_digest': session.get('coverage', {}).get('source_digest'),
        'counting_decisions_for_current_source': sum(d.get('source_digest') == current['digest'] for d in decisions),
        'pending_job_revision': resume.get('pending_job_revision'),
        'source_counts': {k: len(v) for k, v in rows.items()},
        'project_manifest_sha256': sha(target / 'project-manifest.json'),
        'source_dump_sha256': sha(target / 'source.dump'),
        'source_readback_sha256': sha(target / 'source-readback.json'),
        'provider_calls': 0, 'application_opened': False,
        'primary_trial_decisions_copied': False,
    }
    if name == 'counting-wording-control':
        assert record['source_digest'] == 'sha256:43b32189678511fe66cfa821c92c029270c134152cc2f4d34dc5efbf2aeb69aa'
        assert record['counting_decisions_for_current_source'] == 0
        assert record['coverage_source_digest'] != record['source_digest']
    result.append(record)
records = []
for p in sorted(D.rglob('*')):
    assert not p.is_symlink()
    p.chmod(0o500 if p.is_dir() else 0o400)
    records.append({'path': str(p.relative_to(D)), 'mode': p.stat().st_mode & 0o777,
                    'kind': 'directory' if p.is_dir() else 'file',
                    **({} if p.is_dir() else {'sha256': sha(p), 'bytes': p.stat().st_size})})
manifest = D / 'MANIFEST.json'
manifest.write_text(json.dumps(records, indent=2) + '\n')
manifest.chmod(0o400)
D.chmod(0o500)
summary = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'root': str(D),
           'manifest_sha256': sha(manifest), 'entries': len(records), 'cases': result,
           'purpose': 'Independent secondary starting states; restore new owned whole copies and matching dumps, never run these in place.'}
(E / 'clean-starts.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps({'root': str(D), 'entries': len(records), 'source_counts': [r['source_counts'] for r in result]}))
