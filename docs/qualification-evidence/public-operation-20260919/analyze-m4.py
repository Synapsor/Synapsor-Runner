from pathlib import Path
import json,sys,copy
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/public-operation-3eb09c4-20260919');name=sys.argv[1];d=r/'public'/name;b=d/'state-before';a=d/'state-after'
def read(p,n):return json.loads((p/(n+'.json')).read_text())
def action(p,kind):
 pointer=next(x for x in read(p,'control_policy_'+kind)if x['kind']=='action');assert pointer['revision_id']
 rev=next(x for x in read(p,'control_policy_revisions')if x['revision_id']==pointer['revision_id'])
 return pointer['revision_id'],json.loads(rev['content_json'])['authority']
def diff(x,y,p=''):
 if type(x)!=type(y):return [{'path':p,'before':x,'after':y}]
 if isinstance(x,dict):return sum([diff(x.get(k),y.get(k),p+'/'+k)for k in sorted(set(x)|set(y))],[])
 if isinstance(x,list):return sum([diff(x[i]if i<len(x)else None,y[i]if i<len(y)else None,p+'/'+str(i))for i in range(max(len(x),len(y)))],[])
 return []if x==y else [{'path':p,'before':x,'after':y}]
old_id,old=action(b,'active');new_id,new=action(a,'drafts');oldrules=old['authority']['rules'];newrules=new['authority']['rules'];changes=diff(oldrules,newrules);expected=copy.deepcopy(oldrules);expected[0]['rule']['require']['expressions'][4]['right']['value']=3
# activated_at is provenance; a disabled replacement must not inherit active state.
for rules in [expected,newrules]:
 for rule in rules:rule.pop('activated_at',None)
assert expected==newrules,'The business rule/effect/private verification diff is larger than declared'
bm=read(b,'manifest');am=read(a,'manifest');changed_tables=[t for t,v in bm['tables'].items()if v!=am['tables'].get(t)]
assert bm['source']==am['source'],'source changed'
oldact=read(b,'control_policy_active');newact=read(a,'control_policy_active')
for x in oldact:
 if x['kind'] in ['action','read','execution']or x['name'].startswith('semantic_receipts_'):assert x in newact,'existing active authority/receipt selection changed'
for t in changed_tables:assert t.startswith('control_policy_'),'application history changed: '+t
out={'status':'passed','before_action':old_id,'disabled_action':new_id,'disabled_state':new['state'],'changed_tables':changed_tables,'source_unchanged':True,'active_read_action_execution_and_receipt_selection_unchanged':True,'rule_diff':changes,'config_files_unchanged':bm['config_files']==am['config_files']}
(d/'semantic-diff.json').write_text(json.dumps(out,indent=2));print(json.dumps({k:v for k,v in out.items()if k!='rule_diff'}))
