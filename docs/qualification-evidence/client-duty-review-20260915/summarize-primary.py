"""Read-only audit of completed public attempts, including refusals and cancellation."""
from pathlib import Path
import json,hashlib,re,datetime
E=Path(__file__).resolve().parent;p=json.loads((E/'assignment-plan.json').read_text());O=Path(p['owned_root'])
sha=lambda f:hashlib.sha256(f.read_bytes()).hexdigest()
def read_response(f):
    for line in f.read_text().splitlines():
        if line.startswith('data: {'):
            event=json.loads(line[6:])
            if event.get('type')=='response.completed':return event['response']
    raise AssertionError('No completed provider response: '+str(f))
results=[]
for case,run,label in [('B','counting-wording-control','business-review-stopped'),('A','recovery-tournament-assisted','rechecked')]:
    R=O/'runs'/run;events=[json.loads(l) for l in (R/'meter/events.jsonl').read_text().splitlines()]
    inv=[json.loads(l) for l in (R/'public-invocations.jsonl').read_text().splitlines()]
    calls=[]
    for event in events:
        if event['type']!='transport_attempt' or event.get('pathname')=='/v1/models':continue
        i=event['index'];f=R/'meter'/f'input-{i:04d}.json';out=R/'meter'/f'output-{i:04d}.txt'
        q=json.loads(f.read_text())['request'];response=read_response(out);items=[];draft=None;correction=[]
        for msg in q.get('input',[]):
            c=msg.get('content','')
            if isinstance(c,str):
                for line in c.splitlines():
                    if line.startswith('Current draft (JSON pointer root): '):draft=json.loads(line.split(': ',1)[1])
                    if line.startswith('Correct this structural'):correction.append(line)
        for item in response.get('output',[]):
            if item.get('type')=='function_call':
                a=json.loads(item['arguments']);items.append({'name':item['name'],'argument_sha256':hashlib.sha256(item['arguments'].encode()).hexdigest(),
                    'passages':len(a.get('passages',[])),'provider_named_client_duties':sorted({d for v in a.get('passages',[]) for d in v.get('application_obligations',[]) if d in ['customer_selection','status_presentation']})})
        calls.append({'index':i,'started_at':event['at'],'completed_at':next(v['at'] for v in events if v['type']=='response_complete' and v['index']==i),
            'model':q.get('model'),'reasoning':q.get('reasoning'),'max_output_tokens':q.get('max_output_tokens'),'store':q.get('store'),'tools':items,
            'usage':response.get('usage'),'correction':correction,'input':str(f),'input_sha256':sha(f),'output':str(out),'output_sha256':sha(out),
            'actual_prepared_limits':[{'outcome':a['outcome'],'shared_limits':a['approval']['shared_limits']} for a in draft['actions']] if draft else None})
    oracle=json.loads((E/f'{run}-{label}-oracle.json').read_text());diff=json.loads((E/f'{run}-{label}-project-difference.json').read_text())
    readiness=json.loads((E/f'{run}-{label}-readiness.json').read_text());snapshot=json.loads((E/f'{run}-{label}.json').read_text())
    assert all(t['unchanged'] for l in oracle['ledgers'] for t in l['tables'])
    assert not diff['unexplained_file_changes'] and diff['source_snapshots_unchanged'] and not diff['original_conversation_entries_missing']
    assert all(x==0 for x in snapshot['cli_exits']+snapshot['preflight_exits']) and snapshot['source_unchanged_relative_to_matching_task_baseline']
    terminal='\n'.join(f.read_text(errors='replace') for f in (R/'logs').glob('*.log'))
    current_assignments=[a for a in oracle['application_assignments'] if a.get('origin')=='PRODUCT-CLIENT-CONTRACT' and a['source_digest']==oracle['source']['digest'] and a['draft_digest']==oracle['coverage_draft_digest']]
    if case=='A':
        assert readiness['readiness']['ready'] and len(current_assignments)==1
        assert current_assignments[0]['verified'] is False and set(current_assignments[0]['obligations'])=={'customer_selection','status_presentation'}
        before=json.loads((E/f'{run}-ownership-cancelled-readiness.json').read_text());assert not before['readiness']['ready'] and all(not d['assigned'] for d in before['ownership'])
        completed=oracle['completed_reviews'];assert [r['activity'] for r in completed[-2:]]==['validated_reuse','validated_reuse']
        assert completed[-1]['report_digest']==completed[-2]['report_digest'] and completed[-1]['context_digest']==completed[-2]['context_digest']
        recheck=(R/'logs/final-recheck-terminal.log').read_text(errors='replace')
        assert 'Business review completed' in recheck and 'Review activity: validated_reuse.' in recheck
        assert 'CLIENT INTEGRATION RESPONSIBILITIES' not in recheck and 'REVIEW COUNTED AUTOMATIC APPROVALS' not in terminal
        assert len(calls)==1 and not oracle['pending']
        status='PASS after preserved harness-observation cancellation; current public ownership and explicit restart/recheck completed'
    else:
        assert not readiness['readiness']['ready'] and not current_assignments and len(calls)==2
        assert set(oracle['pending'])=={'pending_job_revision','pending_policy_review'}
        assert 'COUNTING_SUPPORT_MISMATCH' in terminal and 'CLIENT INTEGRATION RESPONSIBILITIES' not in terminal
        status='BLOCKED before ownership: initial missing pointer, bounded correction then unsupported counter citation; no further sampling'
    results.append({'case':case,'run':run,'status':status,'route':'matched direct Review; no planning call','calls':calls,'actual_calls':len(calls),
        'source':oracle['source'],'client_duties':oracle.get('client_duties'),'current_intrinsic_assignments':current_assignments,
        'historical_assignment_count':len(oracle['application_assignments'])-len(current_assignments),'readiness':readiness['readiness'],
        'completed_reviews':oracle.get('completed_reviews',[]),'pending_business_work':oracle['pending'],
        'all_ledger_tables_unchanged':True,'source_rows':snapshot['source_counts'],'source_and_authority_configuration_unchanged':True,
        'cli_exits':snapshot['cli_exits'],'checkpoint':snapshot['checkpoint'],'restart_recheck':'PASS, no new call or repeated question' if case=='A' else 'NOT RUN; prerequisite review failed'})
assert sum(r['actual_calls'] for r in results)==3
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'artifact_tree':p['artifact_tree'],
        'outcome':'A ownership/restart PASS; required primary B BLOCKED before ownership; overall acceptance NOT RECOMMENDED',
        'actual_final_calls':3,'ceiling':25,'restart_reserved':6,'actual_restart_calls':0,'development_calls':0,'development_max':4,
        'dollar_spend':'Unknown billing total; declared ceiling15USD, no credits purchased','results':results}
(E/'primary-result.json').write_text(json.dumps(result,indent=2)+'\n')
budget=json.loads((O/'final-budget.json').read_text());budget.update(closed_at=result['at'],actual_calls=3,actual_restart_calls=0,development_calls=0,
    closed_before_deadline=datetime.datetime.now(datetime.timezone.utc)<datetime.datetime.fromisoformat(budget['deadline'].replace('Z','+00:00')),
    remaining_allowance_not_used_for_repeat_sampling=True)
(E/'primary-budget-closure.json').write_text(json.dumps(budget,indent=2)+'\n')
print(json.dumps({'outcome':result['outcome'],'actual_calls':3,'provider_duties':[{r['case']:[c['tools'] for c in r['calls']]} for r in results]}))
