"""Qualification-only controls. No product imports, authority changes or network calls.

Callers supply explicit plans/exports. These helpers never bless differences and
never infer historical observations from a newly prepared test.
"""
from collections import Counter
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat

PHASE_ROLES = {
    'authoring': {'reader', 'provider'}, 'mcp': {'reader'},
    'verifier': {'reader', 'writer'}, 'worker': {'writer'},
    'administrator': {'administrator'},
}
BASE_NAMES = {'PATH', 'HOME', 'TMPDIR', 'NO_COLOR', 'TERM', 'NODE_NO_WARNINGS',
              'LANG', 'LC_ALL'}
CONTEXT_NAMES = {'SYNAPSOR_PRINCIPAL', 'SYNAPSOR_TENANT_ID'}
INSTRUMENT_NAMES = {'NODE_OPTIONS', 'QUALIFICATION_PROVIDER_METER'}
SYSTEM_MOUNTS = {'/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc/ssl/certs',
                 '/etc/resolv.conf', '/etc/hosts', '/etc/localtime'}
FORBIDDEN_FILES = {'.env', '.pgpass', 'pgpass.conf', '.pg_service.conf',
                   'pg_service.conf', '.my.cnf', '.netrc', 'credentials.json',
                   'operator-environment.json', 'setup-environment-retired.json'}


def require(condition, code):
    if not condition:
        raise ValueError(code)


def phase_environment(phase, supplied, credential_roles, *, instrument=None):
    """Reject unreviewed names; caller passes a private phase map, never os.environ.

    credential_roles is the reviewed config-reference inventory (name -> role).
    The independently audited mount plan is required in addition to this check.
    """
    require(phase in PHASE_ROLES, 'PHASE_UNKNOWN')
    require(all(r in {'reader', 'writer', 'provider', 'administrator'}
                for r in credential_roles.values()), 'CREDENTIAL_ROLE_UNKNOWN')
    permitted = BASE_NAMES | CONTEXT_NAMES | {
        n for n, role in credential_roles.items() if role in PHASE_ROLES[phase]}
    require(not (set(supplied) - permitted), 'PHASE_ENV_EXTRA_REFERENCE')
    require(all(isinstance(v, str) for v in supplied.values()), 'ENV_VALUE_INVALID')
    require({'HOME', 'PATH', 'TMPDIR', 'NO_COLOR'} <= supplied.keys(), 'ENV_BASE_MISSING')
    require(supplied['NO_COLOR'] == '1', 'NO_COLOR_REQUIRED')
    result = dict(supplied)
    if instrument:
        require(phase == 'authoring' and set(instrument) <= INSTRUMENT_NAMES,
                'INSTRUMENTATION_PHASE_INVALID')
        require(instrument.get('NODE_OPTIONS', '').startswith('--import=file:'),
                'INSTRUMENTATION_IMPORT_REQUIRED')
        result.update(instrument)
    return result


def audit_mounts(mounts, forbidden_secret_values=()):
    """Audit exact mount roots, not the whole host. Output contains no values.

    Trusted OS roots are readonly and explicitly named. Fixture/installation
    trees must be bounded, contain no sockets, out-of-tree symlinks, credential
    auto-load files or forbidden writer/admin secret material. Fresh /tmp,/run,
    /proc and /dev must be created by the launcher; never host-bound.
    """
    require(bool(mounts), 'MOUNT_PLAN_EMPTY')
    paths = []
    roots = [Path(m['source']).resolve() for m in mounts if not m.get('system')]
    targets = set()
    count = 0
    for item in mounts:
        source, target = Path(item['source']), item['target']
        require(target not in targets, 'MOUNT_TARGET_DUPLICATE')
        targets.add(target)
        require(target not in {'/', '/home', '/var', '/var/tmp', '/tmp', '/run', '/etc', '/proc', '/dev'},
                'MOUNT_OVERBROAD')
        require(item['mode'] in {'ro', 'rw'}, 'MOUNT_MODE_INVALID')
        require(source.exists(), 'MOUNT_SOURCE_MISSING')
        if item.get('system'):
            require(str(source) == target and target in SYSTEM_MOUNTS
                    and item['mode'] == 'ro', 'SYSTEM_MOUNT_INVALID')
            paths.append({'target': target, 'mode': 'ro', 'basis': 'explicit OS root'})
            continue
        nodes = [source]
        if source.is_dir():
            nodes += list(source.rglob('*'))
        require(len(nodes) <= 25000, 'MOUNT_AUDIT_BOUND_EXCEEDED')
        for node in nodes:
            mode = node.lstat().st_mode
            require(not stat.S_ISSOCK(mode) and not stat.S_ISFIFO(mode), 'MOUNT_IPC_FORBIDDEN')
            if node.is_symlink():
                resolved = node.resolve()
                require(any(resolved == root or root in resolved.parents for root in roots),
                        'MOUNT_SYMLINK_ESCAPE')
            if node.is_file():
                # A shipped .env.example is a template, not an automatically
                # loaded credential source. Still scan every byte for secrets.
                require(node.name not in FORBIDDEN_FILES
                        and not (node.name.startswith('.env.') and node.name != '.env.example'),
                        'MOUNT_CREDENTIAL_FILE')
                data = node.read_bytes()
                require(not any(v and v.encode() in data for v in forbidden_secret_values),
                        'MOUNT_FORBIDDEN_SECRET')
                count += 1
        paths.append({'target': target, 'mode': item['mode'], 'basis': 'bounded file/secret audit'})
    return {'mounts': paths, 'files_checked': count, 'forbidden_secret_matches': 0}


def bubblewrap_args(mounts):
    """No inherited host root, home, runtime sockets or descriptors."""
    args = ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc',
            '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run',
            '--dir', '/var', '--tmpfs', '/var/tmp']
    parents = {str(parent) for m in mounts for parent in Path(m['target']).parents
               if str(parent) not in {'/', '/var', '/var/tmp', '/tmp', '/run'}}
    for parent in sorted(parents, key=lambda p: (len(Path(p).parts), p)):
        args += ['--dir', parent]
    for m in mounts:
        args += ['--ro-bind' if m['mode'] == 'ro' else '--bind', m['source'], m['target']]
    return args


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def sql_value(value):
    return {'sqlite_blob_hex': value.hex()} if isinstance(value, bytes) else value


def sqlite_snapshot(path):
    db = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)
    db.execute('PRAGMA query_only=ON')
    db.execute('BEGIN')
    tables = {}
    for name, ddl in db.execute("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").fetchall():
        quoted = '"' + name.replace('"', '""') + '"'
        columns = [r[1] for r in db.execute(f'PRAGMA table_info({quoted})')]
        rows = [[sql_value(v) for v in row] for row in db.execute(f'SELECT * FROM {quoted}')]
        tables[name] = {'ddl': ddl, 'columns': columns, 'rows': sorted(rows, key=canonical)}
    db.rollback()
    db.close()
    return tables


def config_snapshot(root, relative_paths):
    """Explicit complete config inventory; no silent missing-file omission."""
    root = Path(root).resolve()
    result = {}
    for rel in sorted(relative_paths):
        path = (root / rel).resolve()
        require(root in path.parents, 'CONFIG_PATH_ESCAPE')
        require(path.is_file(), 'CONFIG_MISSING')
        data = path.read_bytes()
        result[rel] = {'mode': stat.S_IMODE(path.stat().st_mode),
                       'sha256': hashlib.sha256(data).hexdigest(), 'bytes_hex': data.hex()}
    return result


def config_tree_snapshot(root, excluded_paths=()):
    """Discover membership on every call, including newly added config files.

    Callers declare exact SQLite/log paths separately (with reasons in their
    evidence). No default directory exclusion or expected-change allowlist.
    Symlink content is its target; mount authorization is audited separately.
    """
    root = Path(root).resolve()
    exclusions = [Path(p) for p in excluded_paths]
    require(all(not p.is_absolute() and '..' not in p.parts for p in exclusions),
            'CONFIG_EXCLUSION_INVALID')
    result = {}
    for path in sorted(root.rglob('*')):
        rel = path.relative_to(root)
        if any(rel == p or p in rel.parents for p in exclusions):
            continue
        mode = path.lstat().st_mode
        if stat.S_ISDIR(mode):
            continue
        if stat.S_ISLNK(mode):
            result[str(rel)] = {'kind': 'symlink', 'mode': stat.S_IMODE(mode),
                                'target': os.readlink(path)}
        else:
            require(stat.S_ISREG(mode), 'CONFIG_SPECIAL_FILE')
            data = path.read_bytes()
            result[str(rel)] = {'kind': 'file', 'mode': stat.S_IMODE(mode),
                                'sha256': hashlib.sha256(data).hexdigest(), 'bytes_hex': data.hex()}
    return result


def logical_snapshot(control_path, config_root, config_paths, source_export):
    """source_export: complete table -> {columns, rows, ...} owned read-only export.

    The source exporter must attest table inventory independently. Separate store
    reads are NOT a cross-database atomic snapshot; use quiescent per-operation
    measurement and record each capture's start/end.
    """
    require(isinstance(source_export, dict) and bool(source_export), 'SOURCE_EXPORT_MISSING')
    source = {}
    for name, table in source_export.items():
        require(isinstance(table.get('rows'), list) and isinstance(table.get('columns'), list),
                'SOURCE_TABLE_INVALID')
        source[name] = {**table, 'rows': sorted(table['rows'], key=canonical)}
    return {'control': sqlite_snapshot(control_path),
            'config': config_snapshot(config_root, config_paths), 'source': source}


def compare_snapshots(before, after):
    """No expected-difference allowlist; caller must explain every returned delta."""
    differences = []
    for domain in ['control', 'config', 'source']:
        require(domain in before and domain in after, 'SNAPSHOT_DOMAIN_MISSING')
        for name in sorted(set(before[domain]) | set(after[domain])):
            a, b = before[domain].get(name), after[domain].get(name)
            if a == b:
                continue
            delta = {'domain': domain, 'name': name, 'before': a, 'after': b}
            if a is not None and b is not None and domain != 'config':
                old, new = Counter(map(canonical, a['rows'])), Counter(map(canonical, b['rows']))
                delta['removed_rows'] = list((old - new).elements())
                delta['added_rows'] = list((new - old).elements())
            differences.append(delta)
    return differences


def receipt_hash(value, *, control):
    raw = json.dumps(value, sort_keys=control, separators=(',', ':'), ensure_ascii=False)
    return 'sha256:' + hashlib.sha256(raw.encode()).hexdigest()


def require_prepublication_observations(process, observations, *, alive):
    require(alive, 'PERSISTENT_PROCESS_NOT_ALIVE')
    require(set(process) == {'pid', 'start_token', 'session_id'}, 'PROCESS_IDENTITY_INCOMPLETE')
    for kind in ['listing', 'detail', 'read']:
        matches = [o for o in observations if o.get('kind') == kind
                   and o.get('process') == process and o.get('completed') is True
                   and o.get('isError') is False and o.get('response_sha256')]
        require(bool(matches), 'PREPUBLICATION_OBSERVATION_MISSING_' + kind.upper())
    return True


def prepublication_capture_gate(process, records, *, proposed_at, alive):
    """Derive observations from the existing client's captured JSON-RPC pairs.

    Caller must bind this capture to the recorded child PID/start/session and
    verify it is still alive. No publication is performed by this function.
    """
    requests, observations, initialized = {}, [], False
    deadline = datetime.fromisoformat(proposed_at.replace('Z', '+00:00'))
    for record in records:
        body = record.get('body')
        if isinstance(body, str):
            try:
                body = json.loads(body)
            except json.JSONDecodeError:
                continue
        if not isinstance(body, dict):
            continue
        if datetime.fromisoformat(record['at'].replace('Z', '+00:00')) >= deadline:
            continue
        if record['kind'] == 'request' and body.get('method') in {'initialize', 'tools/call'}:
            requests[body['id']] = body
        elif record['kind'] == 'response' and body.get('id') in requests:
            request = requests.pop(body['id'])
            result = body.get('result')
            if not isinstance(result, dict) or body.get('error'):
                continue
            if request['method'] == 'initialize':
                initialized = bool(result.get('protocolVersion'))
                continue
            if not initialized or result.get('isError') is True:
                continue
            structured = result.get('structuredContent')
            if not isinstance(structured, dict) or structured.get('ok') is not True:
                continue
            params = request['params']; tool = params['name']
            if tool == 'app.describe_actions':
                kind = 'detail' if params.get('arguments', {}).get('outcome') else 'listing'
            elif tool == 'app.explore_data':
                kind = 'read'
            else:
                continue
            observations.append({'kind': kind, 'process': process, 'completed': True,
                                 'isError': False,
                                 'response_sha256': hashlib.sha256(canonical(body).encode()).hexdigest()})
    require_prepublication_observations(process, observations, alive=alive)
    return observations


def require_replay_time(*, now, expires_at, operation_bound_seconds, margin_seconds=15):
    require(operation_bound_seconds > 0 and margin_seconds >= 0, 'REPLAY_BOUND_INVALID')
    remaining = (datetime.fromisoformat(expires_at.replace('Z', '+00:00'))
                 - datetime.fromisoformat(now.replace('Z', '+00:00'))).total_seconds()
    require(remaining > operation_bound_seconds + margin_seconds, 'REFERENCE_LIFETIME_INSUFFICIENT')
    return remaining
