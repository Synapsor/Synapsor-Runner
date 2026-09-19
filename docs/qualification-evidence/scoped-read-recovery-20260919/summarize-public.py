"""Read-only correlation of completed public runs, stored state and transport observations."""
from pathlib import Path
import json, hashlib, sqlite3, datetime
R = Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/scoped-read-recovery-515d260-20260919')
def read(p): return json.loads(p.read_text())
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def seconds(s): return datetime.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
meter = R/'final-meter'; attempts=[]
events=[json.loads(l) for l in (meter/'events.jsonl').read_text().splitlines()]
launches=[e for e in events if e['type']=='instrumentation_ready']
for p in sorted(meter.glob('attempt-[0-9]*.json')):
    a=read(p); n=a['index']; inp=meter/f'input-{n:04d}.json'; out=meter/f'output-{n:04d}.txt'
    d=read(inp)['request']; calls={}; usage=None
    for line in out.read_text().splitlines():
        if not line.startswith('data: ') or line[6:]=='[DONE]': continue
        part=json.loads(line[6:]); usage=part.get('usage') or usage
        for choice in part.get('choices',[]):
            for item in choice.get('delta',{}).get('tool_calls',[]):
                call=calls.setdefault(item.get('index',0),{'name':'','arguments':''}); f=item.get('function',{})
                call['name']+=f.get('name','');call['arguments']+=f.get('arguments','')
    decoded=[{'name':c['name'],'arguments':json.loads(c['arguments'])} for c in calls.values()]
    attempts.append({'index':n,'at':a['at'],'pid':a['pid'],'model':d['model'],'max_tokens':d.get('max_tokens'),
        'tool_choice':d.get('tool_choice'),'input':str(inp),'input_sha256':sha(inp),'output':str(out),
        'output_sha256':sha(out),'usage':usage,'calls':decoded})
runs={}
for name in ['final-fresh','final-reopen','final-resume']:
    folder=R/'public'/name; journal=[json.loads(l) for l in (folder/'invocations.jsonl').read_text().splitlines()]
    invocations=[]
    for start,end in zip(journal[::2],journal[1::2]):
        assert end['exit']==0
        # Independent CLI runs overlap while awaiting operator input. Attribute
        # calls to the observed process, never to overlapping wall intervals.
        matches=[e for e in launches if 0<=seconds(e['at'])-start['at']<1]
        assert len(matches)==1, 'Ambiguous process attribution'
        pid=matches[0]['pid'];ns=[a['index'] for a in attempts if a['pid']==pid]
        invocations.append({'start':start['at'],'end':end['at'],'elapsed_seconds':end['at']-start['at'],'exit':end['exit'],
            'pid':pid,'provider_attempts':ns,'command':start['command'],'artifact':start['artifact']})
    state=read(folder/'after-state.json'); resume=state['resume'][0]; entry=state['read_authoring'][0]['entries'][0]
    c=sqlite3.connect('file:'+str(folder/'project/.synapsor/local.db')+'?mode=ro',uri=True)
    active=[dict(zip(['kind','name','revision_id'],row)) for row in c.execute('select kind,name,revision_id from control_policy_active')];c.close()
    assert all(row['kind']=='management' for row in active), 'Unexpected business authority'
    assert resume['pending_read_relationship']=={'resource':'refunds.refund_requests'}
    assert not resume['authority_granted'] and not resume['source_query_executed'] and not resume['source_database_changed']
    assert all(state['tables'][k]['rows']==0 for k in ['proposals','approvals','worker_queue','writeback_receipts','query_audit'])
    result={'invocations':invocations,'active_pointers':active,'resume_stage':resume['stage'],'pending':resume['pending_read_relationship'],
        'no_authority_or_source_query_or_effect':True,'candidate_resources':[x['id'] for x in entry['progress']['candidate']['pack']['resources']],
        'draft_resources':[x['id'] for x in entry['draft']['pack']['resources']], 'outcome':'BLOCKED: original required dependency unavailable; negative recovery only'}
    before=folder/'before-state-with-resume.json'
    if before.exists():
        old=read(before)['read_authoring'][0]['entries'][0]; fields=['pack','budgets','trusted_context','activation']
        result['draft_fields_exact']={k:old['draft'].get(k)==entry['draft'].get(k) for k in fields}
        result['candidate_fields_exact']={k:old['progress']['candidate'].get(k)==entry['progress']['candidate'].get(k) for k in fields}
        a=json.loads(json.dumps(old['progress']['candidate']));b=json.loads(json.dumps(entry['progress']['candidate']))
        ordering=[]
        for x,y in zip(a['pack']['resources'],b['pack']['resources']):
            assert x['id']==y['id']
            if x.get('kept_out_fields')!=y.get('kept_out_fields'):
                ordering.append({'resource':x['id'],'before':x['kept_out_fields'],'after':y['kept_out_fields']})
            x['kept_out_fields']=sorted(x.get('kept_out_fields',[]));y['kept_out_fields']=sorted(y.get('kept_out_fields',[]))
        result['rescan_set_ordering_changes']=ordering
        result['candidate_semantics_equal_after_only_kept_out_set_order']={k:a.get(k)==b.get(k) for k in fields}
        assert all(result['draft_fields_exact'].values()) and all(result['candidate_semantics_equal_after_only_kept_out_set_order'].values())
        result['continuity_check']=str(folder/'continuity-check.json')
    assert invocations[-1]['provider_attempts']==[], 'Restart unexpectedly called provider'
    runs[name]=result
before=read(R/'before-final-source.json');after=read(R/'after-final-source-source.json')
assert before==after, 'Source schema or rows changed'
result={'artifact':read(R/'frozen/installed-artifact-manifest.json')['installed_tree_sha256'],
    'attempt_count':len(attempts),'reported_cost_usd':sum(a['usage']['cost'] for a in attempts),
    'attempts':attempts,'runs':runs,'source_before_after_equal':True,'source':after,
    'measurement_limits':'Invocation elapsed includes tester observation/navigation. Source is schema-only, zero historical rows. Provider usage cost is reported, not independently billed. No positive original-job completion or runtime isolation claim.'}
out=R/'final-public-summary.json';assert not out.exists();out.write_text(json.dumps(result,indent=2))
print(json.dumps({'attempts':result['attempt_count'],'reported_cost_usd':result['reported_cost_usd'],'source_unchanged':True,'output':str(out)}))
