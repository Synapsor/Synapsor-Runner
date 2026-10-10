import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import type { BoundaryReviewInteractiveSession } from './boundary-cli-picker.js';
import { activePolicySource, loadPolicySources, policySourceSavedDigest, policySourceSavedDigestHeld, savePolicySources, adoptPolicySourceAcknowledgement, PolicySourceChangedError,
  type PolicySourceSaveAcknowledgement, type PolicySourceSession } from './authoring-policy-source.js';
import { assessReceiptCouplingCapability, receiptCouplingInterpretation, receiptCouplingPaths } from './authoring-obligation-review.js';
import { currentSourceTransactionReview, makeSourceTransactionReview, sourceTransactionContext,
  sourceTransactionMappings,sourceTransactionPreparedContext,sourceTransactionReviewIdentity } from './authoring-source-transaction-review.js';
import { makeSourceTransactionScopeReview, sourceTransactionScopeQuestions,
  type SourceTransactionScopeQuestion } from './authoring-source-transaction-scope.js';
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from './project-authority-mutation.js';

/** The existing saved-source CAS and authority coordination make the local
 * decision attributable. No model request, coverage acceptance or Action edit. */
export async function localSourceTransactionReview(input: {
  projectRoot: string; sources: PolicySourceSession; session: BoundaryReviewInteractiveSession; actor: string;
  revisitCurrent?: boolean;
  currentDraft: () => unknown;
  assertCurrent: () => Promise<void>;
  assertCurrentHeld: (permit: ProjectAuthorityMutationPermit) => Promise<void>;
  coordinated: (operation: (permit: ProjectAuthorityMutationPermit) => Promise<void>) => Promise<void>;
}) {
  const source = activePolicySource(input.sources);
  if (!source) throw new Error('SOURCE_TRANSACTION_REVIEW_SOURCE_UNAVAILABLE: Reopen the current complete policy.');
  let expected = await policySourceSavedDigest(input.projectRoot, input.sources.id);
  if (canonicalJsonDigest(await loadPolicySources(input.projectRoot, input.sources.id)) !== canonicalJsonDigest(input.sources))
    throw new Error('POLICY_SOURCE_CHANGED: Reopen the current saved source before recording an interpretation.');
  const checkCurrentHeld = async (permit: ProjectAuthorityMutationPermit) => {
    if (await policySourceSavedDigestHeld(input.projectRoot, input.sources.id, permit) !== expected)
      throw new Error('POLICY_SOURCE_CHANGED: A competing source or decision was saved. No interpretation was overwritten.');
  };
  const assertCurrentHeld = async (permit: ProjectAuthorityMutationPermit) => {
    await input.assertCurrentHeld(permit);
    await checkCurrentHeld(permit);
  };
  const assertCurrent = async () => {
    await input.assertCurrent();
    await withProjectAuthorityMutation(input.projectRoot, checkCurrentHeld);
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
  let sourceSave: PolicySourceSaveAcknowledgement | undefined;
  await input.coordinated(async permit=>{
    await assertCurrentHeld(permit);
    if (canonicalJsonDigest(input.currentDraft())!==prepared)
      throw new Error('SOURCE_TRANSACTION_REVIEW_CONTEXT_CHANGED: The selected Action, source or receipt context changed. No stale decision was saved.');
    sourceSave=await savePolicySources(input.projectRoot,staged,{expectedDigest:expected,permit});
    expected=sourceSave.outcome.reference.revision_digest;
    adoptPolicySourceAcknowledgement(input.sources,sourceSave);
  });
  if (!sourceSave) throw new PolicySourceChangedError();
  return {state:decision,changed:true,sourceSave,summary:`Saved new attributed ${decision} source interpretation ${record.digest}. This is not implementation or observed receipt evidence.`};
}

/** Resolve only a host-identified, current source-range/outcome question. A
 * provider claim can nominate the question, never answer it. */
export async function localSourceTransactionScopeReview(input: {
  projectRoot:string; sources:PolicySourceSession; session:BoundaryReviewInteractiveSession; actor:string;
  question:SourceTransactionScopeQuestion; currentDraft:()=>unknown;
  assertCurrent:()=>Promise<void>;
  assertCurrentHeld:(permit:ProjectAuthorityMutationPermit)=>Promise<void>;
  coordinated:(operation:(permit:ProjectAuthorityMutationPermit)=>Promise<void>)=>Promise<void>;
}) {
  const source=activePolicySource(input.sources);
  if(!source)throw new Error('SOURCE_TRANSACTION_SCOPE_SOURCE_UNAVAILABLE: Reopen the current complete policy.');
  let expected=await policySourceSavedDigest(input.projectRoot,input.sources.id);
  if(canonicalJsonDigest(await loadPolicySources(input.projectRoot,input.sources.id))!==canonicalJsonDigest(input.sources))
    throw new Error('POLICY_SOURCE_CHANGED: Reopen current source and decisions before reviewing scope.');
  const checkCurrentHeld=async(permit:ProjectAuthorityMutationPermit)=>{
    if(await policySourceSavedDigestHeld(input.projectRoot,input.sources.id,permit)!==expected)
      throw new Error('POLICY_SOURCE_CHANGED: A competing source or decision was saved. No scope decision was overwritten.');
  };
  const assertCurrentHeld = async (permit: ProjectAuthorityMutationPermit) => {
    await input.assertCurrentHeld(permit);
    await checkCurrentHeld(permit);
  };
  const assertCurrent = async () => {
    await input.assertCurrent();
    await withProjectAuthorityMutation(input.projectRoot, checkCurrentHeld);
  };
  await assertCurrent();
  const draft=input.currentDraft(),questions=sourceTransactionScopeQuestions(source,draft,input.sources);
  const question=questions.find(entry=>entry.requirement.digest===input.question.requirement.digest
    && entry.action.outcome===input.question.action.outcome
    && entry.action_binding_digest===input.question.action_binding_digest);
  if(!question)throw new Error('SOURCE_TRANSACTION_SCOPE_CONTEXT_CHANGED: This Action/source pairing is no longer current.');
  if(question.current?.decision==='applies'||question.current?.decision==='does_not_apply')
    return {state:question.current.decision,changed:false,summary:'The current attributed scope decision remains recorded; implementation and receipt evidence are checked separately.'};
  const action=(draft as any).actions?.find((entry:any)=>entry?.name===question.action.name&&entry?.outcome===question.action.outcome);
  const effects=[action?.effect,...(action?.effect?.atomic_updates??[])].filter(Boolean);
  const runtime=(draft as any).runner_evidence?.runtime_contract;
  const configuredReceipt=runtime?.receipt_configuration;
  const reviewedIntent=configuredReceipt?.reviewed_intent?.outcomes?.find((entry:any)=>entry?.outcome===question.action.outcome);
  const compiled=(draft as any).runner_evidence?.actions?.[question.action.outcome]?.effect;
  const compiledEffects=[compiled,...(compiled?.atomic_updates??[])];
  const fullPolicy=source.text.split(/\r\n|\r|\n/u).map((line,index)=>`${index+1}: ${line}`);
  const excerpt=source.text.split(/\r\n|\r|\n/u).slice(question.requirement.start-1,question.requirement.end).join('\n');
  const details=[`Current attached policy: ${source.name} v${source.version} (${source.digest}).`,
    `Exact source lines ${question.requirement.start}-${question.requirement.end}: ${excerpt}`,
    `Previously confirmed for ${question.requirement.action.outcome}: ${question.requirement.required_effects.length} exact business effects plus its source_db receipt. This record does not exclude other outcomes.`,
    `New disabled outcome: ${question.action.name} · ${question.action.outcome}; source ${question.action.source}.`,
    ...effects.map((effect:any,index:number)=>`${index?'Companion':'Primary'} update: ${effect.target_resource}; fields ${(effect.allowed_fields??[]).map((field:any)=>field.name).join(', ')||'unavailable'}; assignment ${JSON.stringify(effect.set??{}).slice(0,600)}; maintained version ${compiledEffects[index]?.version_advance?.column??'unavailable'} (${compiledEffects[index]?.version_advance?.strategy??'unavailable'}).`),
    `Configured source receipt authority: ${configuredReceipt?.modes?.find((entry:any)=>entry?.source===question.action.source)?.authority??'unavailable'}; configured destination binding ${configuredReceipt?.source_receipt_destinations?.find((entry:any)=>entry?.source===question.action.source)?.relation_digest??'unavailable'}.`,
    `Outcome-specific reviewed receipt intent: ${reviewedIntent?.status??configuredReceipt?.reviewed_intent?.status??'unavailable'}; mode ${reviewedIntent?.mode??'not current'}; selection_current ${reviewedIntent?.selection_current===true}. Setup, execution authorization, observation and readback remain separate.`,
    'Does this exact source requirement apply to this outcome’s own effect and receipt? An answer records source meaning only and cannot rewrite the original effect count, publish a rule or prove a receipt.',
    ...(effects.length!==question.requirement.required_effects.length
      ?[`The existing clause was confirmed for ${question.requirement.required_effects.length} business effects; this outcome has ${effects.length}. If it applies, the complete required shape still needs an independently supported implementation or a separate policy change.`]:[])];
  input.session.rememberDetails?.('SOURCE TRANSACTION OUTCOME SCOPE',[...fullPolicy,...details]);
  const choice=await input.session.chooseOption?.('SOURCE TRANSACTION SCOPE FOR THIS OUTCOME',[
    {value:'pending',label:'Keep pending — no scope answer yet'},
    {value:'applies',label:'This exact clause applies to this outcome'},
    {value:'does_not_apply',label:'This clause does not apply to this outcome'},
  ],{initialValue:'pending',reviewOnly:true,displayContext:true,context:details});
  if(!choice||choice==='pending')return {state:'pending' as const,changed:false,
    summary:`Scope for ${question.action.outcome} remains pending; active rules are unchanged. Reopen this local decision before another provider-backed review.`};
  if(choice!=='applies'&&choice!=='does_not_apply')throw new Error('SOURCE_TRANSACTION_SCOPE_DECISION_INVALID: No scope answer was saved.');
  if(!await input.session.confirm('Save this exact outcome-scope interpretation?',{defaultValue:false,context:details}))
    return {state:'pending' as const,changed:false,summary:'No scope answer was saved; active rules are unchanged.'};
  await assertCurrent();
  if(canonicalJsonDigest(input.currentDraft())!==canonicalJsonDigest(draft))
    throw new Error('SOURCE_TRANSACTION_SCOPE_CONTEXT_CHANGED: Action or receipt context changed while awaiting confirmation.');
  const record=makeSourceTransactionScopeReview({source,session:input.sources.id,store:question.store_digest,
    requirement:question.requirement,action:question.action,action_binding_digest:question.action_binding_digest,
    decision:choice,actor:input.actor,previous:question.current});
  const staged=structuredClone(input.sources);
  staged.source_transaction_scope_reviews=[...(staged.source_transaction_scope_reviews??[]),record];
  let sourceSave: PolicySourceSaveAcknowledgement | undefined;
  await input.coordinated(async permit=>{
    await assertCurrentHeld(permit);
    if(canonicalJsonDigest(input.currentDraft())!==canonicalJsonDigest(draft))
      throw new Error('SOURCE_TRANSACTION_SCOPE_CONTEXT_CHANGED: No stale scope answer was saved.');
    sourceSave=await savePolicySources(input.projectRoot,staged,{expectedDigest:expected,permit});
    expected=sourceSave.outcome.reference.revision_digest;
    adoptPolicySourceAcknowledgement(input.sources,sourceSave);
  });
  if (!sourceSave) throw new PolicySourceChangedError();
  return {state:choice,changed:true,sourceSave,summary:`Saved attributed ${choice} scope decision for ${question.action.outcome}; active rules remain unchanged. Start a new bounded review only after its current capability and pending duties are checked.`};
}
