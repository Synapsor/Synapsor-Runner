"""Owner-side evidence comparisons; never supplied to a model or public tool."""
from pathlib import Path
import json, hashlib, datetime, collections, re, os, sys
os.umask(0o077)
R=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/public-operation-3eb09c4-20260919')
E=Path(__file__).resolve().parent
def read(p):return json.loads(p.read_text())
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def manifest(n,label):return read(R/'public'/n/('state-'+label)/'manifest.json')
def table(n,label,t):return read(R/'public'/n/('state-'+label)/(t+'.json'))
def content(n,label,kind,pointer='drafts'):
    p=next(x for x in table(n,label,'control_policy_'+pointer)if x['kind']==kind)
    v=next(x for x in table(n,label,'control_policy_revisions')if x['revision_id']==p['revision_id'])
    return p['revision_id'],read_json(v['content_json'])
def read_json(s):return json.loads(s)
def differences(a,b,p=''):
    if type(a)!=type(b):return [{'path':p,'before':a,'after':b}]
    if isinstance(a,dict):return sum([differences(a.get(k),b.get(k),p+'/'+k)for k in sorted(set(a)|set(b))],[])
    if isinstance(a,list):return sum([differences(a[i]if i<len(a)else None,b[i]if i<len(b)else None,p+'/'+str(i))for i in range(max(len(a),len(b)))],[])
    return []if a==b else [{'path':p,'before':a,'after':b}]
result={'collected_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'state':{},'removal':{},'edit':{}}
names=['removal-final','optional-final','software-final-read','tournament-final-catalog','runtime-primary','runtime-secondary','m4-final-action','m4-final-w']
for n in names:
    a,b=manifest(n,'before'),manifest(n,'after')
    changed=[t for t in a['tables']if a['tables'][t]!=b['tables'].get(t)]
    assert a.get('source')==b.get('source'),n+' source changed'
    assert a['config_files']==b['config_files'],n+' configuration changed'
    active_before,active_after=table(n,'before','control_policy_active'),table(n,'after','control_policy_active')
    authority=lambda rows:[x for x in rows if not(x['kind']=='management'and x['name']=='read_authoring')]
    assert authority(active_before)==authority(active_after),n+' active authority changed'
    allowed={'evidence_bundles','explore_budget_reservations','explore_privacy_releases','observed_subject_references','query_audit','sqlite_sequence'}
    assert all(t.startswith('control_policy_') or t in allowed for t in changed),(n,changed)
    result['state'][n]={'all_tables_compared':len(a['tables']),'changed_tables':changed,'source_rows':sum(v['rows']for v in a.get('source',{}).values()),'source_unchanged':True,'config_unchanged':True,'active_authority_unchanged':True,'business_history_unchanged':True,'management_pointer_changes':differences(active_before,active_after)}
for n in ['removal-final','optional-final']:
    before_id,a=content(n,'before','read');after_id,b=content(n,'after','read')
    aa={x['id']for x in a['boundary']['pack']['resources']};bb={x['id']for x in b['boundary']['pack']['resources']}
    assert aa-bb=={'refunds.customers'}and not bb-aa
    result['removal'][n]={'before_revision':before_id,'after_revision':after_id,'removed':['refunds.customers'],'active_unchanged':True,'frame':str(R/'public'/n/'decision-frame.txt'),'host_policy_association':'unknown','post_restart_still_disabled':True}
for n in ['m4-final-action','m4-final-w']:
    aid,a=content(n,'before','action','active');bid,b=content(n,'after','action')
    old,new=a['authority']['authority']['rules'],b['authority']['authority']['rules']
    diff=differences(old,new)
    assert old[0]['effect_envelope']==new[0]['effect_envelope']
    assert table(n,'after','control_policy_drafts')==table(n,'reopened','control_policy_drafts')
    result['edit'][n]={'verdict':'FAILED','active_revision':aid,'disabled_revision':bid,'state':b['authority']['state'],'rule_diff':diff,'atomic_effect_envelope_preserved':True,'draft_retained_on_reopen':True,'requested_threshold':3,'actual_threshold':new[0]['rule']['require']['expressions'][4]['right']['value'],'reasons':['verification model_visible metadata differs from baseline']+(['requested threshold not changed during recovery']if n.endswith('action')else[])}
# Independently corroborate the permitted rows against the fixture owner readback.
identity=read(R/'software-restoration/runtime-private.json')
rows=read(R/'public/software-final-read/state-before/source-build_candidates.json')
own=[x for x in rows if x['tenant_id']==identity['SYNAPSOR_TENANT_ID'] and x['principal_id']==identity['SYNAPSOR_PRINCIPAL']]
assert len(own)==29
records=read(R/'public/software-final-read/protocol-result-2.json')
actual=records[3]['response']['structuredContent']['data']
assert sorted((x['candidate_ref'],x['application_name'],x['candidate_state'])for x in actual)==sorted((x['candidate_ref'],x['application_name'],x['candidate_state'])for x in own)
agg=records[4]['response']['structuredContent'];counts=collections.Counter(x['candidate_state']for x in own)
assert agg['data']==[{'candidate_state':k,'count':v}for k,v in counts.items()if v>=5]
assert agg['privacy']['suppressed_groups']==sum(v<5 for v in counts.values())
cells=[x['security_hold']for x in records[10]['response']['structuredContent']['data']]
assert all(isinstance(x,str)and x.startswith('[withheld:')for x in cells)
result['read_oracle']={'exact_own_rows':29,'other_context_rows_excluded':len(rows)-len(own),'aggregate_matches_owner_readback':True,'suppressed_groups':agg['privacy']['suppressed_groups'],'withheld_cells':len(cells),'distinct_withheld_tokens':len(set(cells)),'note':'Legacy active reviewed analysis remains unchanged; these are equality-linkable withheld tokens, NOT a new unlinkable RUNNER ONLY qualification.'}
for n in ['runtime-primary','runtime-secondary']:
    status=read(R/'public'/n/'last-protocol-status.json')
    result[n]=status
    if status.get('successful_read'):
        ev=[read_json(x)for x in (R/'public'/n/'protocol.jsonl').read_text().splitlines()]
        reads=[x['message']['result']['structuredContent']['data']for x in ev if x['type']=='receive'and x.get('message',{}).get('result',{}).get('structuredContent',{}).get('kind')=='rows']
        assert len(reads)==1
        assert sorted((x['candidate_ref'],x['application_name'])for x in reads[0])==sorted((x['candidate_ref'],x['application_name'])for x in own)
        result[n]['owner_readback_match']=True
# Preserve every transport reservation, including the one harness-refused payload.
attempts=[];total=0
for p in sorted((R/'final-meter').glob('attempt-[0-9]*.json')):
    index=int(p.stem.split('-')[1]);ip=R/'final-meter'/f'input-{index:04}.json';op=R/'final-meter'/f'output-{index:04}.txt'
    item={**read(p),'input_sha256':sha(ip)if ip.exists()else None,'output_sha256':sha(op)if op.exists()else None}
    if ip.exists():
        req=read(ip)['request'];item['model']=req['model'];item['tools']=[x.get('function',{}).get('name')for x in req.get('tools',[])]
        item['lane']='runtime'if any(x and x.startswith('app__')for x in item['tools'])else'authoring'
    else:item['lane']='authoring';item['status']='harness refused payload before send; conservatively counted'
    if op.exists():
        text=op.read_text()
        try:objects=[json.loads(text)]
        except json.JSONDecodeError:
            objects=[]
            for line in text.splitlines():
                if line.startswith('data: ')and line[6:]!='[DONE]':
                    try:objects.append(json.loads(line[6:]))
                    except json.JSONDecodeError:pass
        usages=[x['usage']for x in objects if x.get('usage')]
        item['reported_cost_usd']=usages[-1].get('cost')if usages else None
        total+=item['reported_cost_usd']or 0
    attempts.append(item)
assert len(attempts)<=20 and total<10
result['provider']={'reserved_attempts':len(attempts),'complete_captured_responses':sum(x['output_sha256']is not None for x in attempts),'runtime':sum(x['lane']=='runtime'for x in attempts),'authoring_including_refused_payload':sum(x['lane']=='authoring'for x in attempts),'reported_cost_usd':round(total,9),'records':attempts,'no_fallback':True,'new_favorable_restarts':0}
result['protocol_budget']=read(R/'public/protocol-budget.json')
result['artifact']={k:v for k,v in read(R/'frozen/installed-artifact-manifest.json').items()if k not in ['records','node']}
if '--verify' in sys.argv:
    recorded=read(R/'final-results.json')
    comparable=lambda v:{k:x for k,x in v.items()if k!='collected_at'}
    assert comparable(recorded)==comparable(result),'Saved result differs; originals were not modified'
else:
    assert not(R/'final-results.json').exists(),'Existing evidence is immutable; use --verify'
    (R/'final-results.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'state_comparisons':'passed','edit_verdicts':{k:v['verdict']for k,v in result['edit'].items()},'provider_reservations':len(attempts),'reported_cost_usd':round(total,9),'protocol_calls':result['protocol_budget']['calls']}))
