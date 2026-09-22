import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import Ajv from 'ajv';
import { collectCoverageFeedback, parsePolicyCoverage } from './authoring-policy-coverage.js';
import { recordCoverageFeedbackParent } from './authoring-coverage-feedback.js';
import { createCoverageRepairScope, assembleScopedCoverageReplacement, scopeToolSchema,
  type CoverageRepairCategory, type CoverageRepairContext } from './authoring-scoped-correction.js';

const root = '/runner_evidence/runtime_contract';
const effect = '/runner_evidence/actions/example.action/effect';
const execution = '/runner_evidence/actions/example.action/execution';
const hash = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
function fixture() {
  const text = 'Heading\nThe transaction and receipt requirement.\nUnrelated comparison.\nFooter';
  const context: CoverageRepairContext = {
    source: {version: 1, name: 'example', text, bytes: Buffer.byteLength(text), lines: 4, digest: canonicalJsonDigest(text)},
    messages: [],
    draft: { store_binding: 'store-one', subject: 'action-one', runner_evidence: {
      actions: {'example.action': {effect: {supported: true}, execution: {supported: true}}, 'unselected.action': {effect: {supported: true}}},
      runtime_contract: {receipts: {source_db: true}, receipt_configuration: {mode: 'source_db'}, receipt_read_exclusion: {excluded: true},
        deployment_prerequisites: {runner_execution_setup: {verified: false}},
        application_obligations: {independent_source_readback: {verified: false}}},
    } },
  };
  const parent: {passages: Array<Record<string, any> & {start:number;end:number;draft_paths:string[];disposition:string;interpretation:string}>} = {passages: [
    {start: 1, end: 1, disposition: 'background', interpretation: 'Heading.', draft_paths: []},
    {start: 2, end: 2, disposition: 'implemented', interpretation: 'A mixed receipt claim.', responsibility: 'runner',
      draft_paths: ['/not_present', effect, `${root}/receipt_configuration`, `${root}/receipt_read_exclusion`]},
    {start: 3, end: 3, disposition: 'background', interpretation: 'An unrelated record with no optional citation.', draft_paths: []},
    {start: 4, end: 4, disposition: 'background', interpretation: 'Footer.', draft_paths: []},
  ]};
  const feedback = collectCoverageFeedback(parent, context.source, context.draft, context.messages);
  const scope = createCoverageRepairScope(parent, feedback, context);
  const passage = (interpretation: string, draft_paths: string[]) => ({start: 2, end: 2, disposition: 'implemented', responsibility: 'runner', interpretation, draft_paths});
  const payload = {scope_digest: scope.scope_digest, parent_digest: scope.parent_digest, context: scope.context,
    groups: [{target_id: scope.targets[0]!.target_id, replacements: [
      {category: 'compiled_effect' as CoverageRepairCategory, passage: passage('Compiled effect.', [effect, execution])},
      {category: 'receipt_configuration' as CoverageRepairCategory, passage: passage('Receipt selection.', [`${root}/receipt_configuration`])},
      {category: 'receipt_read_exclusion' as CoverageRepairCategory, passage: passage('Read exclusion.', [`${root}/receipt_read_exclusion`])},
    ]}]};
  const assemble = (replacement: unknown = payload, immediateParent: unknown = parent, current = context) => assembleScopedCoverageReplacement(scope, immediateParent, replacement, current);
  return {context, parent, feedback, scope, payload, assemble};
}
describe('host-scoped unaccepted coverage assembly', () => {
  it('nominates the exact returned feedback and parent, preserving every outside raw record and optional absence', () => {
    const f = fixture(), before = structuredClone(f.parent), result = f.assemble();
    expect(f.feedback.findings.map(f => f.component)).toEqual(['/passages/1/draft_paths/0']);
    expect(f.scope.targets[0]!.members).toEqual([{parent_index: 1, path: '/passages/1', raw_digest: hash(f.parent.passages[1]),
      start: 2, end: 2, finding_ids: [f.feedback.findings[0]!.identity]}]);
    expect(result.assembled.passages).toHaveLength(6);
    expect(result.retained.map(r => result.assembled.passages[r.assembled_index])).toEqual([before.passages[0], before.passages[2], before.passages[3]]);
    expect(result.assembled.passages[4]).not.toHaveProperty('operator_message_id');
    expect(JSON.stringify(result.assembled.passages[4])).toBe(JSON.stringify(before.passages[2]));
    expect(result.audit.raw_parent).toEqual(before); expect(result.audit.raw_replacement).toEqual(f.payload);
    expect(result.audit.assembled).toEqual(result.assembled); expect(result.audit.disposition).toBe('unaccepted_tentative');
    expect(result.audit.outside_digest).toBe(f.scope.outside_digest);
    expect(result.mapping).toEqual([{target_id: f.scope.targets[0]!.target_id, parent_indices: [1], assembled_indices: [1,2,3], source_ranges: [{start: 2,end: 2}]}]);
    expect(f.parent).toEqual(before);
  });
  it('closes transitive overlaps instead of isolating one favorable passage on a shared source range', () => {
    const f = fixture();
    f.parent.passages.push({start: 2,end: 3,disposition: 'background',interpretation: 'Shared range context.',draft_paths: []});
    const feedback = collectCoverageFeedback(f.parent,f.context.source,f.context.draft,f.context.messages);
    const scope = createCoverageRepairScope(f.parent, feedback, f.context);
    expect(scope.targets).toHaveLength(1); expect(scope.targets[0]!.members.map(m => m.parent_index)).toEqual([1,2,4]);
    expect(scope.targets[0]!.source_ranges).toEqual([{start:2,end:3}]);
    expect(scope.outside_digest).toBe(hash([f.parent.passages[0],f.parent.passages[3]]));
  });
  it('distinguishes equal obligation identities at different exact-parent component locations', () => {
    const f=fixture();f.parent.passages.push(structuredClone(f.parent.passages[1]!));
    const feedback=collectCoverageFeedback(f.parent,f.context.source,f.context.draft,f.context.messages);
    expect(feedback.findings).toHaveLength(2);
    expect(feedback.findings[0]!.identity).toBe(feedback.findings[1]!.identity);
    const scope=createCoverageRepairScope(f.parent,feedback,f.context);
    expect(scope.targets[0]!.members.map(p=>p.parent_index)).toEqual([1,4]);
    expect(scope.targets[0]!.findings.map(p=>p.component)).toEqual(['/passages/1/draft_paths/0','/passages/4/draft_paths/0']);
  });
  it('does not label an ordinary group a receipt region from an unchallenged overlapping overview alone', () => {
    const f=fixture();f.parent.passages[1]!.draft_paths=['/not_present',effect];
    f.parent.passages.push({start:2,end:2,disposition:'background',interpretation:'Receipt overview companion.',draft_paths:[`${root}/receipts`]});
    const feedback=collectCoverageFeedback(f.parent,f.context.source,f.context.draft,f.context.messages);
    const scope=createCoverageRepairScope(f.parent,feedback,f.context);
    expect(scope.targets[0]!.receipt_region).toBe(false);
    expect(scope.targets[0]!.allowed_references.ordinary).toEqual([effect,`${root}/receipts`]);
  });
  it.each(['omit','weaken','duplicate'] as const)('rejects %s of an unchallenged overlap dependency even when source coverage remains', mode => {
    const f=fixture();
    const companion={start:2,end:2,disposition:'background',interpretation:'The complete original dependency condition.',draft_paths:[]};
    f.parent.passages.push(companion);
    const feedback=collectCoverageFeedback(f.parent,f.context.source,f.context.draft,f.context.messages);
    const scope=createCoverageRepairScope(f.parent,feedback,f.context);
    expect(scope.targets[0]!.required_retained).toEqual([{parent_index:4,raw_digest:hash(companion)}]);
    const payload:any={...f.payload,scope_digest:scope.scope_digest,parent_digest:scope.parent_digest,
      groups:[{...structuredClone(f.payload.groups[0]),target_id:scope.targets[0]!.target_id}]};
    if(mode==='weaken')payload.groups[0].replacements.push({category:'setup',passage:{...companion,interpretation:'Weaker dependency.'}});
    if(mode==='duplicate')payload.groups[0].replacements.push(...[1,2].map(()=>({category:'setup',passage:companion})));
    expect(()=>assembleScopedCoverageReplacement(scope,f.parent,payload,f.context)).toThrow('COVERAGE_SCOPED_CORRECTION_REFUSED');
    payload.groups[0].replacements=f.payload.groups[0]!.replacements.concat([{category:'setup',passage:companion}] as any);
    expect(assembleScopedCoverageReplacement(scope,f.parent,payload,f.context).assembled.passages).toContainEqual(companion);
  });
  it('refuses a broad source citation that would pull the entire unrelated report into one repair', () => {
    const f=fixture(); f.parent.passages[1]!.start=1;f.parent.passages[1]!.end=4;
    const feedback=collectCoverageFeedback(f.parent,f.context.source,f.context.draft,f.context.messages);
    expect(()=>createCoverageRepairScope(f.parent,feedback,f.context)).toThrow('whole report across distinct source ranges');
  });
  it('can repair a single exact-range report with no unrelated fragments to broaden into', () => {
    const f=fixture();f.context.source.text='The receipt requirement.';f.context.source.lines=1;
    f.context.source.bytes=Buffer.byteLength(f.context.source.text);f.context.source.digest=canonicalJsonDigest(f.context.source.text);
    const parent={passages:[{...f.parent.passages[1]!,start:1,end:1}]};
    const feedback=collectCoverageFeedback(parent,f.context.source,f.context.draft,f.context.messages);
    const scope=createCoverageRepairScope(parent,feedback,f.context);
    expect(scope.targets[0]!.members).toHaveLength(1);expect(scope.outside_digest).toBe(hash([]));
  });
  it('replaces two independently nominated groups once, preserving raw outside order regardless of replacement group order', () => {
    const f = fixture(); f.parent.passages[3]!.draft_paths = ['/also_missing', effect]; f.parent.passages[3]!.disposition = 'implemented';
    const feedback = collectCoverageFeedback(f.parent,f.context.source,f.context.draft,f.context.messages);
    const scope = createCoverageRepairScope(f.parent, feedback, f.context, {ordinaryReferences: [effect]});
    expect(scope.targets).toHaveLength(2);
    const payload = {...f.payload,scope_digest:scope.scope_digest,parent_digest:scope.parent_digest,groups:[
      {target_id:scope.targets[1]!.target_id,replacements:[{category:'ordinary',passage:{start:4,end:4,disposition:'implemented',interpretation:'Effect.',draft_paths:[effect]}}]},
      {...f.payload.groups[0],target_id:scope.targets[0]!.target_id},
    ]};
    const result = assembleScopedCoverageReplacement(scope,f.parent,payload,f.context);
    expect(result.retained.map(r => r.parent_index)).toEqual([0,2]);
    expect(result.assembled.passages.map(p => p.start)).toEqual([1,2,2,2,3,4]);
  });
  it.each(['scope_digest','parent_digest','context'] as const)('rejects the wrong payload %s', key => {
    const f=fixture(); f.payload[key] = canonicalJsonDigest('wrong'); expect(()=>f.assemble()).toThrow('different scope, parent or context');
  });
  it.each(['store','subject','messages','source','source_text'] as const)('rejects changed current %s', change => {
    const f=fixture(), context=structuredClone(f.context);
    if(change==='store') (context.draft as any).store_binding='another';
    if(change==='subject') (context.draft as any).subject='another';
    if(change==='messages') context.messages=['new'];
    if(change==='source') context.source.digest=canonicalJsonDigest('another');
    if(change==='source_text') context.source.text+=' revised';
    expect(()=>f.assemble(f.payload,f.parent,context)).toThrow('context changed');
  });
  it('rejects same-range older parents and outside mutations, including unsolicited counter citations', () => {
    const f=fixture(), parent=structuredClone(f.parent);
    Object.assign(parent.passages[2]!, {counter_requirements:[{path:'/counter',current_capability:null,required_capability:null,operator_message_id:2}]});
    expect(()=>f.assemble(f.payload,parent)).toThrow('exact immediate parent');
    const sameValuesDifferentMemberOrder={passages:f.parent.passages.map(p=>({...Object.fromEntries(Object.entries(p).reverse())}))};
    expect(()=>f.assemble(f.payload,sameValuesDifferentMemberOrder)).toThrow('exact immediate parent');
  });
  it.each(['top','group','component','passage','child'] as const)('rejects unknown %s fields instead of dropping them', location => {
    const f=fixture(), payload:any=structuredClone(f.payload), group=payload.groups[0], entry=group.replacements[0];
    if(location==='top') payload.passages=f.parent.passages;
    if(location==='group') group.path='/passages/2';
    if(location==='component') entry.status='approved';
    if(location==='passage') entry.passage.configuration={mode:'ledger'};
    if(location==='child') entry.passage.evidence_checks=[{path:effect,equals:true,extra:'ignored?'}];
    expect(()=>f.assemble(payload)).toThrow('out-of-scope fields');
  });
  it.each(['missing','duplicate','unrequested','empty'] as const)('rejects %s groups and components', mode => {
    const f=fixture(), payload=structuredClone(f.payload);
    if(mode==='missing') payload.groups=[];
    if(mode==='duplicate') payload.groups.push(payload.groups[0]!);
    if(mode==='unrequested') payload.groups[0]!.target_id='/passages/2';
    if(mode==='empty') payload.groups[0]!.replacements=[];
    expect(()=>f.assemble(payload)).toThrow('COVERAGE_SCOPED_CORRECTION_REFUSED');
  });
  it('rejects duplicate target IDs even when the group count is correct', () => {
    const f=fixture(); f.parent.passages[3]!.draft_paths=['/also_missing'];
    const feedback=collectCoverageFeedback(f.parent,f.context.source,f.context.draft,f.context.messages);
    const scope=createCoverageRepairScope(f.parent,feedback,f.context);
    const group={...f.payload.groups[0],target_id:scope.targets[0]!.target_id};
    expect(()=>assembleScopedCoverageReplacement(scope,f.parent,{...f.payload,scope_digest:scope.scope_digest,parent_digest:scope.parent_digest,groups:[group,group]},f.context)).toThrow('unrequested or duplicated');
  });
  it.each(['range','reference','child_reference','ordinary','category','typed_category'] as const)('rejects out-of-scope %s', mode => {
    const f=fixture(), payload:any=structuredClone(f.payload), entry=payload.groups[0].replacements[0];
    if(mode==='range') entry.passage.end=3;
    if(mode==='reference') entry.passage.draft_paths=['/runner_evidence/actions/unselected.action/effect'];
    if(mode==='child_reference') entry.passage.evidence_checks=[{path:'/outside',equals:true}];
    if(mode==='ordinary') entry.category='ordinary';
    if(mode==='category') entry.category='arbitrary';
    if(mode==='typed_category') entry.passage.receipt_component='source_transaction_coupling';
    expect(()=>f.assemble(payload)).toThrow('COVERAGE_SCOPED_CORRECTION_REFUSED');
  });
  it('retains source coverage and forbids deleting substantive residuals through reclassification', () => {
    const f=fixture(), payload=structuredClone(f.payload);
    for(const entry of payload.groups[0]!.replacements) entry.passage.disposition='background';
    expect(()=>f.assemble(payload)).toThrow('background or overridden');
    payload.groups[0]!.replacements[0]!.passage.disposition='implemented';
    expect(()=>f.assemble(payload)).toThrow('background or overridden');
  });
  it('permits repairing an existing override only with the same source range and exact owner decision', () => {
    const f=fixture();f.context.messages=['An authentic threshold-only override.'];
    f.parent.passages[1]!.draft_paths=['/not_present',effect];f.parent.passages[1]!.disposition='overridden';f.parent.passages[1]!.operator_message_id=1;
    const scope=createCoverageRepairScope(f.parent,collectCoverageFeedback(f.parent,f.context.source,f.context.draft,f.context.messages),f.context);
    const payload={scope_digest:scope.scope_digest,parent_digest:scope.parent_digest,context:scope.context,
      groups:[{target_id:scope.targets[0]!.target_id,replacements:[{category:'ordinary',passage:{...f.parent.passages[1]!,draft_paths:[effect]}}]}]};
    expect(assembleScopedCoverageReplacement(scope,f.parent,payload,f.context).assembled.passages[1]!.operator_message_id).toBe(1);
    Object.assign(payload.groups[0]!.replacements[0]!.passage,{operator_message_id:2});
    expect(()=>assembleScopedCoverageReplacement(scope,f.parent,payload,f.context)).toThrow('background or overridden');
  });
  it('rejects deletion of a line even when another untouched record covers the rest of the source', () => {
    const f=fixture(); f.parent.passages[1]!.end=3; f.parent.passages[2]!.draft_paths=['/also_missing'];
    const feedback=collectCoverageFeedback(f.parent,f.context.source,f.context.draft,f.context.messages);
    const scope=createCoverageRepairScope(f.parent,feedback,f.context);
    expect(()=>assembleScopedCoverageReplacement(scope,f.parent,{...f.payload,scope_digest:scope.scope_digest,parent_digest:scope.parent_digest,
      groups:[{...f.payload.groups[0],target_id:scope.targets[0]!.target_id}]},f.context)).toThrow('deletes part');
  });
  it.each(['global','limited','nonstructural','badidentity','wrongcontext','missingchild','duplicate'] as const)('refuses ambiguous or ineligible %s finding scopes', mode => {
    const f=fixture(), feedback=structuredClone(f.feedback);
    if(mode==='global') feedback.findings[0]!.component='/passages';
    if(mode==='limited') feedback.limited=true;
    if(mode==='nonstructural') feedback.findings[0]!.structural=false;
    if(mode==='badidentity') feedback.findings[0]!.component_identity=canonicalJsonDigest('other');
    if(mode==='wrongcontext') feedback.context=canonicalJsonDigest('other');
    if(mode==='missingchild') feedback.findings[0]!.component='/passages/1/draft_paths/99';
    if(mode==='duplicate') feedback.findings.push(feedback.findings[0]!);
    recordCoverageFeedbackParent(feedback,f.parent); // Synthetic host diagnostic, never provider input.
    expect(()=>createCoverageRepairScope(f.parent,feedback,f.context)).toThrow('COVERAGE_SCOPED_CORRECTION_REFUSED');
  });
  it('refuses a source gap, malformed parent, or serialized imitation of a host scope', () => {
    const f=fixture(), parent=structuredClone(f.parent); parent.passages.pop();
    expect(()=>createCoverageRepairScope(parent,f.feedback,f.context)).toThrow('omits source lines');
    expect(()=>createCoverageRepairScope({...f.parent,status:'ready'},f.feedback,f.context)).toThrow('out-of-scope');
    expect(()=>assembleScopedCoverageReplacement(structuredClone(f.scope),f.parent,f.payload,f.context)).toThrow('original host-created');
    expect(Object.isFrozen(f.scope.targets[0]!.members)).toBe(true);
  });
  it('binds feedback to its exact raw parent even when source ranges and child positions did not change', () => {
    const f=fixture(), parent=structuredClone(f.parent);
    parent.passages[1]!.interpretation='Another unaccepted claim on the same lines.';
    expect(()=>createCoverageRepairScope(parent,f.feedback,f.context)).toThrow('host traversal of this exact immediate parent');
    expect(()=>createCoverageRepairScope(f.parent,structuredClone(f.feedback),f.context)).toThrow('host traversal of this exact immediate parent');
  });
  it('does not let an ordinary reference catalog expand the nominated region to other current fields', () => {
    const f=fixture(); f.parent.passages[1]!.draft_paths=['/not_present',effect];
    const feedback=collectCoverageFeedback(f.parent,f.context.source,f.context.draft,f.context.messages);
    const outside='/runner_evidence/actions/unselected.action/effect';
    const scope=createCoverageRepairScope(f.parent,feedback,f.context,{ordinaryReferences:[effect,execution,outside]});
    expect(scope.targets[0]!.receipt_region).toBe(false);
    expect(scope.targets[0]!.allowed_references.ordinary).toEqual([effect]);
    const payload={scope_digest:scope.scope_digest,parent_digest:scope.parent_digest,context:scope.context,
      groups:[{target_id:scope.targets[0]!.target_id,replacements:[{category:'ordinary',passage:{start:2,end:2,disposition:'implemented',interpretation:'Other effect.',draft_paths:[outside]}}]}]};
    expect(()=>assembleScopedCoverageReplacement(scope,f.parent,payload,f.context)).toThrow('outside its nominated category');
  });
  it('refuses an ordinary missing-reference repair when no current evidence is safely associated', () => {
    const f=fixture(); f.parent.passages[1]!.draft_paths=['/not_present'];
    const feedback=collectCoverageFeedback(f.parent,f.context.source,f.context.draft,f.context.messages);
    expect(()=>createCoverageRepairScope(f.parent,feedback,f.context,{ordinaryReferences:[effect]})).toThrow('No exact current reference');
  });
  it('confines an inspected constraint child to its exact existing parent, and refuses an absent parent', () => {
    const f=fixture();
    const resource='release_ops.build_candidates';
    const selected=`/runner_evidence/source_constraints/resources/${resource}/check_constraints/candidate_ready`;
    const sibling=`/runner_evidence/source_constraints/resources/${resource}/check_constraints/other_rule`;
    (f.context.draft as any).runner_evidence.source_constraints={resources:{[resource]:{check_constraints:{
      candidate_ready:{expression:'candidate_state = ready'},other_rule:{expression:'version > 0'},
    }}}};
    f.parent.passages[1]!.draft_paths=['/not_present'];
    f.parent.passages[1]!.evidence_checks=[{path:`${selected}/expression`,equals:'candidate_state = ready'}];
    const feedback=collectCoverageFeedback(f.parent,f.context.source,f.context.draft,f.context.messages);
    const scope=createCoverageRepairScope(f.parent,feedback,f.context);
    expect(scope.targets[0]!.allowed_references.ordinary).toContain(selected);
    expect(scope.targets[0]!.allowed_references.ordinary).not.toContain(sibling);
    delete (f.context.draft as any).runner_evidence.source_constraints.resources[resource].check_constraints.candidate_ready;
    const current=collectCoverageFeedback(f.parent,f.context.source,f.context.draft,f.context.messages);
    expect(()=>createCoverageRepairScope(f.parent,current,f.context)).toThrow('No exact current reference');
  });
  it('nominates current counter maintenance only below the cited effect, never another outcome', () => {
    const f=fixture();
    const current=`${effect}/atomic_updates/0/source_counter_maintenance`;
    const foreign='/runner_evidence/actions/unselected.action/effect/source_counter_maintenance';
    (f.context.draft as any).runner_evidence.actions['example.action'].effect={
      operation:'update',atomic_updates:[{source_counter_maintenance:{status:'owner_confirmed_operating_prerequisite'}}],
    };
    (f.context.draft as any).runner_evidence.actions['unselected.action'].effect={
      source_counter_maintenance:{status:'owner_confirmed_operating_prerequisite'},
    };
    f.parent.passages[1]!.draft_paths=['/not_present',effect];
    const feedback=collectCoverageFeedback(f.parent,f.context.source,f.context.draft,f.context.messages);
    const scope=createCoverageRepairScope(f.parent,feedback,f.context);
    expect(scope.targets[0]!.allowed_references.ordinary).toContain(current);
    expect(scope.targets[0]!.allowed_references.ordinary).toContain(`${effect}/operation`);
    expect(scope.targets[0]!.allowed_references.ordinary).not.toContain(foreign);
    const payload={scope_digest:scope.scope_digest,parent_digest:scope.parent_digest,context:scope.context,
      groups:[{target_id:scope.targets[0]!.target_id,replacements:[{category:'ordinary',passage:{
        start:2,end:2,disposition:'implemented',interpretation:'Current maintenance.',draft_paths:[foreign],
      }}]}]};
    expect(()=>assembleScopedCoverageReplacement(scope,f.parent,payload,f.context)).toThrow('outside its nominated category');
  });
  it('rejects foreign and absent receipt references even when passed through host options', () => {
    const f=fixture();
    expect(()=>createCoverageRepairScope(f.parent,f.feedback,f.context,{receiptReferences:{compiled_effect:['/runner_evidence/actions/unselected.action/effect']}})).toThrow('expand beyond');
    expect(()=>createCoverageRepairScope(f.parent,f.feedback,f.context,{receiptReferences:{compiled_effect:['/not_present']}})).toThrow('absent from this exact');
  });
  it('derives replacement references only from exact nominated field/resource identities and named setup contracts', () => {
    const f=fixture();
    (f.context.draft as any).runner_evidence.actions['example.action'].scoped_bindings={one:{resource:'table',fields:{private_field:{model_visible:false},other_field:{model_visible:true}}}};
    f.parent.passages[1]!.draft_paths=['/not_present'];
    f.parent.passages[1]!.field_checks=[{resource:'table',field:'private_field',expectation:'private'}];
    const feedback=collectCoverageFeedback(f.parent,f.context.source,f.context.draft,f.context.messages);
    const scope=createCoverageRepairScope(f.parent,feedback,f.context);
    expect(scope.targets[0]!.allowed_references.ordinary).toEqual(['/runner_evidence/actions/example.action/scoped_bindings/one/fields/private_field']);
    f.parent.passages[1]!.field_checks=undefined;delete f.parent.passages[1]!.field_checks;
    f.parent.passages[1]!.deployment_prerequisite='runner_execution_setup';
    const setup=createCoverageRepairScope(f.parent,collectCoverageFeedback(f.parent,f.context.source,f.context.draft,f.context.messages),f.context);
    expect(setup.targets[0]!.allowed_references.ordinary).toEqual([`${root}/deployment_prerequisites/runner_execution_setup`]);
  });
  it('nominates an unnamed writer setup only from a current cited execution and the host mixed-deployment finding', () => {
    const f=fixture();
    (f.context.draft as any).read={};
    (f.context.draft as any).runner_evidence.actions['example.action'].execution.configured_mode='direct_sql';
    const setup=(f.context.draft as any).runner_evidence.runtime_contract.deployment_prerequisites.runner_execution_setup;
    Object.assign(setup,{supported:true,stage:'after_authority_review'});
    f.parent.passages[1]={start:2,end:2,disposition:'needs_decision',responsibility:'deployment',issue_kind:'missing_configuration',
      interpretation:'Writer review remains pending.',draft_paths:['/read',execution]};
    let findingCode='COVERAGE_DEPLOYMENT_COMPONENT_MIXED';
    const refs=()=>{
      const mixed=collectCoverageFeedback(f.parent,f.context.source,f.context.draft,f.context.messages);
      mixed.findings[0]!.code=findingCode;
      recordCoverageFeedbackParent(mixed,f.parent);
      return createCoverageRepairScope(f.parent,mixed,f.context).targets[0]!.allowed_references.ordinary;
    };
    expect(refs()).toContain(`${root}/deployment_prerequisites/runner_execution_setup`);
    setup.supported=false;
    expect(refs()).not.toContain(`${root}/deployment_prerequisites/runner_execution_setup`);
    setup.supported=true;
    (f.context.draft as any).runner_evidence.actions['example.action'].execution.configured_mode='proposal_only';
    expect(refs()).not.toContain(`${root}/deployment_prerequisites/runner_execution_setup`);
    (f.context.draft as any).runner_evidence.actions['example.action'].execution.configured_mode='direct_sql';
    findingCode='COVERAGE_REFERENCE_MISSING';
    expect(refs()).not.toContain(`${root}/deployment_prerequisites/runner_execution_setup`);
  });
  it.each(['omit','unrelated','reclassify'] as const)('rejects %s of a nominated typed field requirement', mode => {
    const f=fixture();f.parent.passages[1]!.draft_paths=['/not_present',effect];
    const check={resource:'table',field:'private_field',expectation:'private'};
    f.parent.passages[1]!.field_checks=[check];
    const scope=createCoverageRepairScope(f.parent,collectCoverageFeedback(f.parent,f.context.source,f.context.draft,f.context.messages),f.context);
    const repaired:any={...f.parent.passages[1],draft_paths:[effect],field_checks:[{...check}]};
    if(mode==='omit')delete repaired.field_checks;
    if(mode==='unrelated')repaired.field_checks[0].field='other_field';
    if(mode==='reclassify')repaired.field_checks[0].expectation='business_visible';
    const payload={scope_digest:scope.scope_digest,parent_digest:scope.parent_digest,context:scope.context,
      groups:[{target_id:scope.targets[0]!.target_id,replacements:[{category:'ordinary',passage:repaired}]}]};
    expect(()=>assembleScopedCoverageReplacement(scope,f.parent,payload,f.context)).toThrow('COVERAGE_SCOPED_CORRECTION_REFUSED');
  });
  it('retains each nominated typed field requirement across an explicit source-range split', () => {
    const f=fixture();f.parent.passages[1]!.end=3;f.parent.passages.splice(2,1);
    const check={resource:'table',field:'private_field',expectation:'private'};
    f.parent.passages[1]!.draft_paths=['/not_present',effect];f.parent.passages[1]!.field_checks=[check];
    const scope=createCoverageRepairScope(f.parent,collectCoverageFeedback(f.parent,f.context.source,f.context.draft,f.context.messages),f.context);
    const payload={scope_digest:scope.scope_digest,parent_digest:scope.parent_digest,context:scope.context,
      groups:[{target_id:scope.targets[0]!.target_id,replacements:[2,3].map(line=>({category:'ordinary',passage:{...f.parent.passages[1],start:line,end:line,draft_paths:[effect]}}))}]};
    expect(assembleScopedCoverageReplacement(scope,f.parent,payload,f.context).assembled.passages.filter(p=>p.field_checks)).toHaveLength(2);
    delete (payload.groups[0]!.replacements[1]!.passage as Record<string,unknown>).field_checks;
    expect(()=>assembleScopedCoverageReplacement(scope,f.parent,payload,f.context)).toThrow('original source association');
  });
  it('retains existing outside counter citation absence byte-for-byte during a receipt repair', () => {
    const f=fixture();
    // Keep the authentic host finding on the receipt group; this raw outside
    // component remains unaccepted and is deliberately not certified here.
    Object.assign(f.parent.passages[2]!,{counter_requirements:[{path:'/counter',current_capability:null,required_capability:null}]});
    recordCoverageFeedbackParent(f.feedback,f.parent);
    const scope=createCoverageRepairScope(f.parent,f.feedback,f.context);
    const payload={...f.payload,parent_digest:scope.parent_digest,scope_digest:scope.scope_digest,
      groups:[{...f.payload.groups[0],target_id:scope.targets[0]!.target_id}]};
    const result=assembleScopedCoverageReplacement(scope,f.parent,payload,f.context);
    const outside=result.assembled.passages[result.retained.find(r=>r.parent_index===2)!.assembled_index]!;
    expect(JSON.stringify(outside)).toBe(JSON.stringify(f.parent.passages[2]));
    expect((outside.counter_requirements as any[])[0]).not.toHaveProperty('operator_message_id');
  });
  it('applies the existing passage and byte ceilings to complete assembly, including retained outside records', () => {
    const f=fixture(), payload=structuredClone(f.payload);
    payload.groups[0]!.replacements=Array.from({length:118},(_,i)=>({...payload.groups[0]!.replacements[0]!,passage:{...payload.groups[0]!.replacements[0]!.passage,interpretation:`Component ${i}`}}));
    expect(()=>f.assemble(payload)).toThrow('120-passage');
    const oversized:any=structuredClone(f.payload);oversized.groups[0].replacements[0].passage.interpretation='x'.repeat(128*1024);
    expect(()=>f.assemble(oversized)).toThrow('argument bound');
  });
  it('does not treat a category label or assembly as validated evidence', () => {
    const f=fixture(), result=f.assemble();
    expect(()=>parsePolicyCoverage(result.assembled,f.context.source,f.context.draft,f.context.messages)).toThrow();
    expect(result.categories).toEqual(f.payload.groups[0]!.replacements.map((entry,i)=>({index:i+1,category:entry.category,target_id:f.scope.targets[0]!.target_id})));
  });
  it('emits a closed schema with exact target/context and category references, and rejects unsolicited paths', () => {
    const f=fixture();
    const passageSchema={type:'object',additionalProperties:false,required:['start','end','disposition','interpretation','draft_paths'],properties:{
      start:{type:'integer'},end:{type:'integer'},disposition:{type:'string'},interpretation:{type:'string'},responsibility:{type:'string'},draft_paths:{type:'array',items:{type:'string'}},
    }};
    const schema=scopeToolSchema(f.scope,passageSchema);
    const validate=new (Ajv as unknown as {new(options:unknown):any})({strict:false}).compile(schema);
    expect(validate(f.payload),JSON.stringify(validate.errors)).toBe(true);
    const changed=structuredClone(f.payload);changed.groups[0]!.replacements[0]!.passage.draft_paths=['/outside'];
    expect(validate(changed)).toBe(false);
    expect(validate({...f.payload,passages:[]})).toBe(false);
    expect(passageSchema.properties.draft_paths).toEqual({type:'array',items:{type:'string'}});
  });
  it('admits exact read-only dependencies through their own unique schema alternative', () => {
    const f=fixture(), companion={start:2,end:2,disposition:'background',interpretation:'Original dependency wording.',draft_paths:[]};
    f.parent.passages.push(companion);
    const scope=createCoverageRepairScope(f.parent,collectCoverageFeedback(f.parent,f.context.source,f.context.draft,f.context.messages),f.context);
    const schema:any=scopeToolSchema(scope,{type:'object',additionalProperties:false,required:['start','end','disposition','interpretation','draft_paths'],properties:{
      start:{type:'integer'},end:{type:'integer'},disposition:{type:'string'},interpretation:{type:'string'},responsibility:{type:'string'},draft_paths:{type:'array',items:{type:'string'}},
    }});
    expect(schema.properties.groups.items.oneOf[0].properties.replacements.items.oneOf.at(-1).properties.passage).toEqual({const:companion});
    const payload={...f.payload,scope_digest:scope.scope_digest,parent_digest:scope.parent_digest,
      groups:[{target_id:scope.targets[0]!.target_id,replacements:[...f.payload.groups[0]!.replacements,{category:'compiled_effect',passage:companion}]}]};
    const validate=new (Ajv as unknown as {new(options:unknown):any})({strict:false}).compile(schema);
    expect(validate(payload),JSON.stringify(validate.errors)).toBe(true);
  });
});
