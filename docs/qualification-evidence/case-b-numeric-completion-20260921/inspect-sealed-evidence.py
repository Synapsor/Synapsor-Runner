#!/usr/bin/env python3
"""Read-only archive/protocol inspection; never opens a live fixture or sends MCP."""
import argparse
import collections
import hashlib
import json
from pathlib import Path
import sqlite3
import tarfile


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ledger(path):
    with tarfile.open(path) as archive:
        names = [n for n in archive.getnames() if n.endswith('/.synapsor/local.db')]
        assert len(names) == 1
        assert not any(n.endswith('/.synapsor/local.db-wal') for n in archive.getnames())
        db = sqlite3.connect(':memory:')
        db.deserialize(archive.extractfile(names[0]).read())
        db.execute('PRAGMA query_only=ON')
        return db


def inspect(start, final, captures):
    before, after = ledger(start), ledger(final)
    tables = ['proposals', 'approvals', 'proposal_events', 'worker_queue',
              'writeback_jobs', 'writeback_receipts', 'idempotency_receipts']
    history = {}
    for table in tables:
        old = set(before.execute(f'SELECT * FROM "{table}"').fetchall())
        new = set(after.execute(f'SELECT * FROM "{table}"').fetchall())
        history[table] = {'original_rows': len(old), 'final_rows': len(new),
                          'original_complete_rows_retained': old <= new}
    before.close()
    after.close()
    sessions, counts = [], collections.Counter()
    for path in captures:
        requests, calls = {}, []
        for line in path.read_text().splitlines():
            entry = json.loads(line)
            body = entry.get('body')
            if isinstance(body, str):
                try:
                    body = json.loads(body)
                except json.JSONDecodeError:
                    continue
            if not isinstance(body, dict):
                continue
            if entry['kind'] == 'request' and body.get('method') == 'tools/call':
                requests[body['id']] = (entry['at'], body['params'])
            if entry['kind'] != 'response' or body.get('id') not in requests:
                continue
            at, params = requests.pop(body['id'])
            result = body['result']
            structured = result.get('structuredContent')
            texts = [c['text'] for c in result.get('content', []) if c.get('type') == 'text']
            text_body = json.loads(texts[0]) if len(texts) == 1 else None
            row = {'at': at, 'tool': params['name'],
                   'isError': result.get('isError', False),
                   'text_structured_equal': structured is not None and structured == text_body}
            counts[params['name']] += 1
            if params['name'] == 'app.describe_actions':
                row['arguments'] = params['arguments']
                row['approval_information'] = structured.get('approval_information')
            calls.append(row)
        assert not requests, 'Unanswered tool request in saved capture'
        sessions.append({'path': str(path), 'sha256': digest(path), 'calls': calls})
    return {'method': 'Sealed archives in query-only in-memory SQLite; saved JSON-RPC only',
            'start_archive_sha256': digest(start), 'final_archive_sha256': digest(final),
            'history': history, 'sessions': sessions, 'counts': dict(counts),
            'all_text_structured_equal': all(c['text_structured_equal'] for s in sessions for c in s['calls']),
            'limitations': [
                'Historical-row preservation from original start to final is not a per-replay full-table snapshot comparison.',
                'source_database_changed on a stored request describes its historical effect; it is not evidence of a new replay effect.',
                'No provider response or native model interpretation was tested.']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--start', required=True, type=Path)
    parser.add_argument('--final', required=True, type=Path)
    parser.add_argument('--capture', action='append', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(inspect(args.start, args.final, args.capture), indent=2))
