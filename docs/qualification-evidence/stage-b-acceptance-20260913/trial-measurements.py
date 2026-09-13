"""Summarize saved trial telemetry without treating a zero CLI exit as success."""
from pathlib import Path
import datetime, hashlib, json

E = Path(__file__).resolve().parent
O = Path(json.loads((E / 'assignment-plan.json').read_text())['owned_root'])
def stamp(s):
    return datetime.datetime.fromisoformat(s.replace('Z', '+00:00'))
def union_seconds(intervals):
    merged = []
    for a, b in sorted(intervals):
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(b, merged[-1][1])
        else:
            merged.append([a, b])
    return sum((b-a).total_seconds() for a, b in merged)
cases = []
for cid in ['tournament-ratification', 'software-release-sealing']:
    C = O / 'cases' / cid
    inv = [json.loads(l) for l in (C / 'public-invocations.jsonl').read_text().splitlines()]
    events = [json.loads(l) for l in (C / 'meter/events.jsonl').read_text().splitlines()]
    intervals = []; start = None
    for v in inv:
        if v['event'] == 'start': start = stamp(v['at'])
        if v['event'] == 'exit':
            assert start is not None
            intervals.append((start, stamp(v['at']))); start = None
    attempts = {v['index']: v for v in events if v['type'] == 'transport_attempt'}
    completions = {v['index']: v for v in events if v['type'] == 'response_complete'}
    provider_intervals = [(stamp(attempts[i]['at']), stamp(v['at'])) for i, v in completions.items()]
    requested = set(); returned = set(); usages = []
    for p in (C / 'meter').glob('input-*.json'):
        j = json.loads(p.read_text()); requested.add(j['request']['model'])
    for p in (C / 'meter').glob('output-*.txt'):
        for l in p.read_text().splitlines():
            if not l.startswith('data: '): continue
            try: j = json.loads(l[6:])
            except json.JSONDecodeError: continue
            if j.get('type') == 'response.completed':
                r = j['response']; returned.add(r.get('model'))
                usages.append({'capture': p.name, 'usage': r.get('usage')})
    result = {
        'case': cid, 'first_start': intervals[0][0].isoformat(), 'last_exit': intervals[-1][1].isoformat(),
        'cli_exits': [v['code'] for v in inv if v['event'] == 'exit'],
        'cli_process_wall_seconds': union_seconds(intervals),
        'first_start_to_last_exit_seconds': (intervals[-1][1]-intervals[0][0]).total_seconds(),
        'wall_time_includes': 'provider wait, operator review, coordinator/tool/evidence time and pauses; not a human usability measurement',
        'authoring_provider_attempts': len(attempts), 'requested_models': sorted(x for x in requested if x),
        'returned_models_captured': sorted(x for x in returned if x),
        'response_completion_captures': len(completions),
        'provider_transport_wait_seconds': union_seconds(provider_intervals) if len(completions) == len(attempts) else None,
        'provider_wait_definition': 'union of transport attempt through complete response body; not just HTTP headers; tournament completion capture unavailable',
        'complete_response_usage_records': len(usages),
        'hands_on_seconds': None, 'tester_only_measurement_seconds': None,
        'administrator_source_changes': 0, 'writer_setup_or_execution_reviews': 0,
        'first_verified_execution_seconds': None, 'edit_to_review_seconds': None, 'edit_to_changed_behavior_seconds': None,
        'complete_policy_review_ready_seconds': None, 'runtime_provider_calls': 0,
        'runtime_mcp_calls': 0, 'worker_invocations': 0,
        'source_rows_changed': 0, 'policy_attachment_reentries': 0,
        'manual_authority_or_config_edits': 0, 'product_changes': 0,
        'unknown_measurements_are_not_zero': True,
    }
    if cid == 'tournament-ratification':
        result.update(assisted_continuations=1, unaided_provider_calls=16, assisted_provider_calls=8,
                      setup_result='FAILED checkpoint save; assisted resume also stopped',
                      planned_pause_resume='PARTIAL: rules/client/pending question retained; subsequent clarification save failed',
                      ordinary_clarifications=['public result_ref meaning', 'tenant means league; principal is assigned referee; shared caps'],
                      counter_review='one maintained results.version confirmation',
                      repeats='Pending unanswered scope question resumed as expected; no re-entered policy or client choice observed',
                      first_disabled_summary_time='not independently timestamped; retained raw public transcript',
                      navigation=['public /help', 'planned Esc/save-disabled/Q', 'normal resume', 'one labelled assisted normal resume; Esc stop before new answer prompt'])
    else:
        observed = stamp('2026-09-13T08:38:31.984446+00:00')
        result.update(assisted_continuations=0, unaided_provider_calls=50, assisted_provider_calls=0,
                      setup_result='INCOMPLETE at declared initial50-call budget; final draft saved, rules recheck unrun',
                      observed_disabled_review_summary_at=observed.isoformat(),
                      first_disabled_summary_observed_by_seconds=(observed-intervals[0][0]).total_seconds(),
                      review_summary_measurement='upper bound from operator checkpoint, not exact time to complete reviewable policy',
                      planned_edit_pause_resume='BLOCKED before activation; not run',
                      ordinary_clarifications=['entire owned source is synthetic, not a per-row category', 'existing elapsed_seconds NOT NULL/nonnegative source definition'],
                      counter_review='one maintained-counter confirmation covering candidate and slot versions',
                      repeats='Known-elapsed requirement first reported already satisfied, then repeated resolution added explicit non-null child guard',
                      navigation=['Resolve required decisions three times', 'View exact Runner details from unchanged-rule confirmation', 'close synthetic-source clarification unchanged', 'decline unchanged elapsed-rule close', 'Ask model for source-definition reconciliation', 'save-disabled/Q after budget refusal'])
        P = C / 'checkpoints/budget-stopped/project'
        draft = json.loads((P / '.synapsor/action-rules/drafts/reviewed_staging_rules/authority.json').read_text())
        resource = next(r for r in draft['authority']['catalog']['resources'] if r['name'] == 'release_ops.build_checks')
        elapsed = next(f for f in resource['fields'] if f['name'] == 'elapsed_seconds')
        result['saved_catalog_elapsed_seconds'] = elapsed
        result['saved_draft_state'] = draft['state']
        result['saved_authority_sha256'] = hashlib.sha256((P / '.synapsor/action-rules/drafts/reviewed_staging_rules/authority.json').read_bytes()).hexdigest()
    cases.append(result)
with (E / 'trial-measurements.json').open('x') as f:
    json.dump({'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'cases': cases}, f, indent=2); f.write('\n')
print(json.dumps([{'case': v['case'], 'calls': v['authoring_provider_attempts'], 'process_seconds': v['cli_process_wall_seconds'], 'provider_seconds': v['provider_transport_wait_seconds']} for v in cases]))
