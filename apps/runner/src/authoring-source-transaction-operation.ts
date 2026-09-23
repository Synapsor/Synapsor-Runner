import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import type { BoundaryReviewInteractiveSession } from './boundary-cli-picker.js';
import { activePolicySource, loadPolicySources, policySourceSavedDigest, savePolicySources,
  type PolicySourceSession } from './authoring-policy-source.js';
import { assessReceiptCouplingCapability, receiptCouplingInterpretation, receiptCouplingPaths } from './authoring-obligation-review.js';
import { currentSourceTransactionReview, makeSourceTransactionReview, sourceTransactionContext,
  sourceTransactionMappings,sourceTransactionPreparedContext,sourceTransactionReviewIdentity } from './authoring-source-transaction-review.js';
import type { ProjectAuthorityMutationPermit } from './project-authority-mutation.js';

/** The existing saved-source CAS and authority coordination make the local
 * decision attributable. No model request, coverage acceptance or Action edit. */
export async function localSourceTransactionReview(input: {
  projectRoot: string; sources: PolicySourceSession; session: BoundaryReviewInteractiveSession; actor: string;
  revisitCurrent?: boolean;
  currentDraft: () => unknown;
  assertCurrent: (permit?: ProjectAuthorityMutationPermit) => Promise<void>;
  coordinated: (operation: (permit: ProjectAuthorityMutationPermit) => Promise<void>) => Promise<void>;
}) {
  const source = activePolicySource(input.sources);
  if (!source) throw new Error('SOURCE_TRANSACTION_REVIEW_SOURCE_UNAVAILABLE: Reopen the current complete policy.');
  let expected = await policySourceSavedDigest(input.projectRoot, input.sources.id);
  if (canonicalJsonDigest(await loadPolicySources(input.projectRoot, input.sources.id)) !== canonicalJsonDigest(input.sources))
    throw new Error('POLICY_SOURCE_CHANGED: Reopen the current saved source before recording an interpretation.');
  const assertCurrent = async (permit?: ProjectAuthorityMutationPermit) => {
    await input.assertCurrent(permit);
    if (await policySourceSavedDigest(input.projectRoot, input.sources.id) !== expected)
      throw new Error('POLICY_SOURCE_CHANGED: A competing source or decision was saved. No interpretation was overwritten.');
  };
  await assertCurrent();
  const draft = input.currentDraft(), context = sourceTransactionContext(draft);
  if (!context || !/^sha256:[a-f0-9]{64}$/u.test(context.store_digest ?? '')
    || context.source_session !== input.sources.id
    || canonicalJsonDigest(context) !== canonicalJsonDigest(sourceTransactionPreparedContext(input.sources,context.store_digest,source.digest)))
    throw new Error('SOURCE_TRANSACTION_REVIEW_BINDING_UNAVAILABLE: The exact current saved project/source binding is required.');
  const current = currentSourceTransactionReview(source,draft,input.sources);
  if (current && !input.revisitCurrent) return {state:'confirmed' as const, changed:false,
    summary:`Current operator interpretation ${current.digest} remains applicable to this policy and Action identity. The complete implementation is rechecked separately.`};
  // An explicit revisit can retract an earlier interpretation even after an
  // implementation edit made the current compiled mapping unavailable.
  const available=sourceTransactionMappings(draft);
  const mappings=available.length ? available : current && input.revisitCurrent
    ? [{action:current.action,required_effects:current.required_effects,
      required_receipt:current.required_receipt,relation:current.relation}] : [];
  if (!mappings.length) return {state:'capability_unavailable' as const,changed:false,
    summary:'The current Action does not expose a complete supported effect/receipt mapping for this interpretation. Source meaning remains pending; inspect the disabled Action separately. No model call was made.'};
  const selected = mappings.length === 1 ? mappings[0]! : (() => undefined)();
  let mapping = selected;
  if (!mapping) {
    const choice = await input.session.chooseOption?.('SELECT EXACT ACTION FOR SOURCE TRANSACTION REVIEW',[
      {value:'pending',label:'Keep pending; do not infer a requirement'},
      ...mappings.map((entry,index)=>({value:String(index),label:`${entry.action.name} · ${entry.action.outcome}`}))
    ],{initialValue:'pending',reviewOnly:true,displayContext:true});
    if (!choice || choice === 'pending') return {state:'pending' as const,changed:false,summary:'Transaction interpretation left pending. No model call was made.'};
    mapping = mappings[Number(choice)];
  }
  if (!mapping) throw new Error('SOURCE_TRANSACTION_REVIEW_TARGET_INVALID: No interpretation was saved.');
  const reviewId=sourceTransactionReviewIdentity({source_session:input.sources.id,source_digest:source.digest,
    store_digest:context.store_digest!,action:mapping.action});
  const priorConflict=(input.sources.source_transaction_reviews??[]).some(record=>
    record.id===reviewId && record.decision==='conflicting');
  const fullPolicy = source.text.split(/\r\n|\r|\n/u).map((line,index)=>`${index+1}: ${line}`);
  const range = await input.session.promptText('Policy line or range that states this exact transaction requirement (Esc keeps pending)',{
    context:[`Full current attached policy: ${source.name} v${source.version} (${source.digest}).`,...fullPolicy]});
  if (range === undefined) return {state:'pending' as const,changed:false,summary:'Transaction interpretation left pending. No model call was made.'};
  const match = /^(\d+)(?:\s*-\s*(\d+))?$/u.exec(range.trim());
  const start = Number(match?.[1]), end = Number(match?.[2] ?? match?.[1]);
  if (!match || start < 1 || end < start || end > source.lines || end-start > 60)
    throw new Error('SOURCE_TRANSACTION_REVIEW_RANGE_INVALID: Choose an exact current source range of at most 61 lines. No interpretation was saved.');
  const excerpt = source.text.split(/\r\n|\r|\n/u).slice(start-1,end).join('\n');
  const effects = mapping.required_effects.map((effect,index)=>
    `${index+1}. ${effect.role} ${effect.operation} ${effect.resource} via ${effect.binding}; fields ${effect.fields.join(', ')}; exact assignment ${effect.assignment_digest}`);
  let capability = 'Compiled transaction capability: not established by the current exact review evidence.';
  try {
    const passage = {start,end,disposition:'implemented' as const,responsibility:'runner' as const,issue_kind:'coverage_link' as const,
      receipt_component:'source_transaction_coupling' as const,interpretation:receiptCouplingInterpretation(mapping.action.outcome),
      draft_paths:receiptCouplingPaths(mapping.action.outcome)};
    if (assessReceiptCouplingCapability(passage,source,draft)) capability='Compiled transaction capability: current exact effect/receipt contract supported; setup, permission, observation and readback are separate.';
  } catch { /* A capability refusal never creates policy meaning. */ }
  const details=[`Full policy: ${source.name} v${source.version}; use the displayed source range and /details to inspect all text.`,
    `Exact excerpt, lines ${start}-${end}: ${excerpt}`,`Selected Action: ${mapping.action.name} · ${mapping.action.outcome}; source ${mapping.action.source}.`,
    ...effects,`Required ${mapping.required_receipt.mode} writeback receipt for ${mapping.action.outcome}.`,
    'Proposed source interpretation: all listed business effects and that receipt commit or roll back together in one source transaction.',
    capability,
    ...(priorConflict?['A conflicting interpretation is already recorded for this unchanged source and Action. It cannot be overridden by another local confirmation; a changed source or separate owner clarification is required.']:[]),
    'This records attributed policy meaning only. It does not change active rules, grants, receipt setup, execution permission, or source data.'];
  input.session.rememberDetails?.('SOURCE TRANSACTION REQUIREMENT', [...fullPolicy,...details]);
  const choice = await input.session.chooseOption?.('CONFIRM SOURCE TRANSACTION MEANING',[
    ...(input.revisitCurrent && current
      ? [{value:'cancel',label:'Cancel revisit; keep the current confirmed interpretation'},
        {value:'withdraw',label:'Withdraw the current confirmation; leave this requirement pending'}]
      : [{value:'pending',label:'Keep pending — no interpretation established'}]),
    ...(!priorConflict?[{value:'confirmed',label:'Confirm this exact unconditional source requirement'}]:[]),
    {value:'deferred',label:'Needs clarification or is not this interpretation'},
    {value:'conflicting',label:'Conflicting source meaning; withdraw this confirmation'},
  ],{initialValue:input.revisitCurrent && current?'cancel':'pending',reviewOnly:true,displayContext:true,context:details});
  if (!choice || choice === 'cancel') return {state:current?'confirmed' as const:'pending' as const,changed:false,
    summary:current?'Revisit cancelled; the existing confirmed interpretation remains in force. No model call was made.':'Transaction interpretation left pending. No model call was made.'};
  if (choice === 'pending') return {state:'pending' as const,changed:false,summary:'Transaction interpretation left pending. No model call was made.'};
  if (choice !== 'confirmed' && choice !== 'deferred' && choice !== 'conflicting' && choice !== 'withdraw')
    throw new Error('SOURCE_TRANSACTION_REVIEW_DECISION_INVALID: No interpretation was saved.');
  if (choice === 'confirmed' && priorConflict)
    throw new Error('SOURCE_TRANSACTION_REVIEW_CONFLICT: A conflicting interpretation is already recorded for this unchanged source and Action. No new confirmation was saved.');
  if (choice === 'confirmed' && !available.length)
    throw new Error('SOURCE_TRANSACTION_REVIEW_CAPABILITY_UNAVAILABLE: The current implementation mapping is incomplete. The prior meaning can be deferred or marked conflicting, but cannot be newly confirmed against an unavailable mapping.');
  if (!await input.session.confirm('Save this exact source interpretation decision?',{defaultValue:false,context:details}))
    return {state:'pending' as const,changed:false,summary:'Transaction interpretation not saved. No model call was made.'};
  await assertCurrent();
  const latest = [...(input.sources.source_transaction_reviews ?? [])].reverse().find(record=>
    record.source_digest===source.digest && record.source_session===input.sources.id
    && canonicalJsonDigest(record.action)===canonicalJsonDigest(mapping.action)
    && record.store_digest===context.store_digest);
  const decision=choice==='withdraw'?'pending':choice;
  const record = makeSourceTransactionReview({source,session:input.sources.id,store:context.store_digest!,start,end,mapping,
    actor:input.actor,decision,previous:latest});
  const prepared=canonicalJsonDigest(draft), staged=structuredClone(input.sources);
  staged.source_transaction_reviews=[...(staged.source_transaction_reviews??[]),record];
  await input.coordinated(async permit=>{
    await assertCurrent(permit);
    if (canonicalJsonDigest(input.currentDraft())!==prepared)
      throw new Error('SOURCE_TRANSACTION_REVIEW_CONTEXT_CHANGED: The selected Action, source or receipt context changed. No stale decision was saved.');
    await savePolicySources(input.projectRoot,staged,{expectedDigest:expected,permit});
    expected=canonicalJsonDigest(staged);
  });
  Object.assign(input.sources,staged);
  return {state:decision,changed:true,summary:`Saved new attributed ${decision} source interpretation ${record.digest}. This is not implementation or observed receipt evidence.`};
}
