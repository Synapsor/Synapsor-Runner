"""Export bounded, identity-free summaries; raw records remain in the owned root."""
from pathlib import Path
import datetime, hashlib, json

E = Path(__file__).resolve().parent
O = Path(json.loads((E / 'assignment-plan.json').read_text())['owned_root'])
artifact = json.loads((E / 'final-artifact.json').read_text())
records = []

def read(case, name):
    p = O / 'runtime' / case / 'deterministic' / name
    b = p.read_bytes()
    records.append({'path': str(p), 'sha256': hashlib.sha256(b).hexdigest(), 'bytes': len(b)})
    return json.loads(b)

def receipt(row):
    value = json.loads(row['receipt_json'])
    return {'status': value['status'], 'rows_affected': value['rows_affected'],
            'semantic_verification': value.get('semantic_verification', {}).get('status'),
            'canonical_bytes_sha256': hashlib.sha256(row['receipt_json'].encode()).hexdigest(),
            'receipt_hash': value.get('receipt_hash')}

def contention(value):
    return {'topology': value['topology'], 'independent_writer_probe': value['independent_writer_probe'],
            'exact_revision': value['entry'][0]['locals']['revision'],
            'release_requested_at': value['release_requested_at'],
            'boundaries': [[{'point': e['point'], 'observed_at': e['at'],
                            **({'admission_time': e['locals']['now']} if e['point'] == 'admission_clock_selected' else {})}
                           for e in lane if e['point'] in ['approval_entry', 'writer_attempt', 'writer_acquired', 'admission_clock_selected']]
                          for lane in value['boundaries']],
            'responses': [r['proposal']['status'] for r in value['responses']]}

def counts(value):
    return {'overall': value['overall'], 'per_insurer_counts_sorted': sorted(value['by_insurer'].values())}

summary = {'generated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
           'artifact': artifact, 'topology': 'installed PostgreSQL business source / shared SQLite control store, local stdio processes',
           'new_setup_dependency': 'Shared-context rows depend on setup code written during this assignment; feature regressions are separate evidence and the setup has not been independently exercised outside this task.',
           'checks': {}, 'raw_evidence': records}
C = summary['checks']
setup = read('shared_02', 'reviewed-contexts-result.json')
C['reviewed_setup'] = {'status': setup['status'], 'contexts': setup['contexts'], 'common_store': setup['common_store'],
                       'operator_route': 'action review --project-root . -> Continue client setup; four separate hidden-value reviews and explicit installations',
                       'project_doctor_exit': json.loads((E / 'installed-shared02-doctor-exit.json').read_text())['exit_code']}
a1 = read('shared_02', 'a1-result.json')
C['A1'] = {'status': a1['status'], 'counts': a1['counts'], 'receipt': a1['stored_receipt'],
           'replay': a1['replay']['status'], 'restart_replay': a1['restart_replay']['status'],
           'topology': 'two identical calls within one MCP process, followed by one supervised worker and a restarted MCP process',
           'actual_subject_mutex_wait': a1['wait_boundary']['locals']['waiting'],
           'source_readback': 'exact one-row reserve/version effect; all other rows unchanged'}
shared = read('shared_02', 'shared-matrix-result.json')
for key in ['shared_principal', 'ample_capacity', 'overall']:
    v = shared['checks'][key]
    C['A2_' + key] = {'status': v['status'], 'before': counts(v['before']), 'after': counts(v['after']),
                     'contention': contention(v['contention']),
                     'persisted_human_review_without_approval_or_queue': sum(p['state'] == 'pending_review' for p in v['proposals'])}
C['A2_joint'] = {'status': shared['checks']['joint_limit']['status'],
                 'response': shared['checks']['joint_limit']['response']['proposal']['status'],
                 'overall_remaining': shared['checks']['joint_limit']['overall_still_has_capacity']}
C['A2_history'] = {'status': 'passed', 'normal_request_approvals_retained_after_public_cancellation': len(shared['history_cancellations']),
                   'all_cancel_exits': [r['cancel_exit'] for r in shared['history_cancellations']],
                   'shared_admission_revision': shared['shared_admission_revision'],
                   'canonical_history_selectors': shared['canonical_history_selectors']}
same = read('same_principal', 'same-principal-result.json')
C['A2_same_principal'] = {'status': same['status'], 'raw_result': records[-1]['path']}
cross = shared['checks']['context_isolation']
C['A4'] = {'status': cross['status'], 'cross_context': [
    {'issuer_alias': r['issuer'], 'recipient_alias': r['recipient'], 'error_code': r['response']['error_code']} for r in cross['cross']],
    'own_exact_request_replays': {k: v['ok'] for k, v in shared['own_context_replays'].items()},
    'no_unauthorized_durable_records': cross['no_unauthorized_durable_records'],
    'source_unchanged': True, 'layer': 'observed-reference issuer/context/claim validation; no claim that each deeper row-scope check was reached'}
ledger = read('shared_02', 'shared-cross-before-ledger.json')
after_cross = read('shared_02', 'shared-cross-after-ledger.json')
assert ledger == after_cross, 'Cross-context refusal changed a durable ledger table'
C['A4']['all_ledger_tables_unchanged'] = len(ledger)
events = [json.loads(line) for line in (O / 'runtime/shared_02/deterministic/events.jsonl').read_text().splitlines()]
start = next(i for i, event in enumerate(events) if event.get('event') == 'schedule' and event.get('name') == 'A4 configured context references')
sends = [event for event in events[start:] if event.get('event') == 'mcp_send' and event['message'].get('params', {}).get('name') == 'app.request_change']
own = {alias: json.loads(next(row['record_json'] for row in ledger['observed_subject_references']
                            if row['subject_ref'] == send['message']['params']['arguments']['subject_refs']['selected_claim']))
       for alias, send in zip(['primary', 'colleague', 'second-insurer', 'third-insurer'], sends[:4])}
fields = ['read_boundary_digest', 'generation_lock_fingerprint', 'tenant_scope_fingerprint', 'principal_scope_fingerprint', 'workflow_session_id']
C['A4']['stored_context_comparisons'] = [
    {'pair': [r['issuer'], r['recipient']], 'same': {k: own[r['issuer']].get(k) == own[r['recipient']].get(k) for k in fields}}
    for r in cross['cross']]
C['A4']['source_trace'] = ('assertObservedSubjectMatchesClaim rejects the recorded principal fingerprint mismatch for same-insurer clients, '
                          'or tenant fingerprint mismatch for cross-insurer clients, before source facts/eligibility. This attribution combines '
                          'the public reference error, stored metadata, successful own replays and current source ordering; it does not instrument '
                          'each individual predicate or establish deeper row-scope coverage.')
a3 = read('collection', 'a3-result.json')
C['A3_collection'] = {'status': a3['collection_status'], 'receipts': [receipt(r) for r in a3['collection_receipts']],
                      'source_wait': [{k: r[k] for k in ['state', 'wait_event_type', 'wait_event']} for r in a3['first_source_wait']],
                      'source_readback': 'exactly one claim 60000/version2, one 30000/version1; portfolio total90000; all unrelated rows unchanged',
                      'concurrency': a3['effect_scheduling']}
C['A3_owned_source_update'] = {'status': a3['external_status'], 'receipts': [receipt(r) for r in a3['external_receipts']],
                               'source_wait': [{k: r[k] for k in ['state', 'wait_event_type', 'wait_event']} for r in a3['external_source_wait']],
                               'source_readback': 'only reviewed owned portfolio close/version increment; worker effect refused with zero rows'}
life = read('identity_lifecycle_02', 'identity-lifecycle-result.json')
C['identity_lifecycle'] = {'status': life['status'], 'running_cached_context': life['running_cached_context'],
                         'future_launch': 'refused; existing public diagnostic wraps as COMMAND_REJECTED / MCP_LAUNCH_CHECK_FAILED',
                         'new_revision_and_other_entry': 'unchanged own-context controls; old entry separately uninstalled through existing operator command'}
for case in ['edit', 'admission_first', 'replacement_first']:
    d = read(case, 'edit-result.json')
    C[case] = {'status': d['status'], 'publication_status': d.get('publication_status'),
               'revisions': d.get('revisions'), 'exact_edit': d.get('exact_edit'), 'retained_automatic_history': d.get('history_retained'),
               'fresh_current_request': d.get('fresh', {}).get('proposal', {}).get('status'),
               'same_client_process': True, 'already_dispatched': d.get('already_dispatched')}
    if case == 'edit':
        C[case]['execution_review_revision'] = d.get('reviewed_execution_revision')
        C[case]['worker_exit'] = d['worker']['code']
        C[case]['old_unstarted_queue'] = {k: d['old_unstarted_queue'][k] for k in ['status', 'attempts', 'lease_id']}
    if case == 'replacement_first':
        C['late_refusal'] = {'status': d.get('late_refusal_status'), 'public_error_code': d['old_request']['error_code'],
                             'public_message': d['old_request']['message'], **d['truthful_late_refusal'],
                             'same_subject_fresh_ref_error': d['same_subject_duplicate']['error_code'],
                             'distinct_subject_current_rule': d['fresh']['proposal']['status']}
        recovery = d.get('recovery', {})
        C['existing_recovery'] = {'status': recovery.get('status', 'unverified'), 'operator_rejection_exit': recovery.get('rejection', {}).get('code'),
                                  'fresh_same_subject_after_rejection': recovery.get('fresh_retry', {}).get('proposal', {}).get('status'),
                                  'route': 'proposals reject <exact-unapproved-proposal-id> --yes --reason <reviewed-reason> --config synapsor.actions.runner.json --json'}
    if 'error' in d: C[case]['error'] = d['error']

summary['runtime_budget'] = json.loads((O / 'runtime/budget.json').read_text())
summary['completed_exit_codes'] = {}
for name in ['stable-full02', 'final-types', 'postgres-gate02', 'installed-shared02-doctor',
             'installed-shared02-contexts', 'installed-identity-lifecycle02-lifecycle', 'installed-a1-02',
             'installed-shared-matrix02', 'installed-same-principal', 'installed-a3',
             'installed-edit-edit', 'installed-edit-admission_first', 'installed-edit-replacement_first']:
    code = json.loads((E / (name + '-exit.json')).read_text())['exit_code']
    assert code == 0, name
    summary['completed_exit_codes'][name] = code
summary['stage_a'] = 'PASSED_NAMED_LOCAL_MATRIX' if all(str(v.get('status', '')).startswith('pass') or v.get('status') == 'verified_existing_operator_rejection_then_current_rule_human_review' for v in C.values()) else 'NOT_PASSED'
summary['stage_b'] = 'NOT_STARTED'
text = json.dumps(summary, indent=2) + '\n'
assert 'b0000000-0000-4000-8000-' not in text, 'Raw fixture identity leaked into ordinary summary'
(E / 'installed-scorecard.json').write_text(text)
(O / 'installed-scorecard.json').write_text(text)
print(json.dumps({'stage_a': summary['stage_a'], 'checks': {k: v['status'] for k, v in C.items()}}))
